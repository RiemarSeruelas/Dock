import { readFile } from "node:fs/promises";

const COLLECTIONS = [
  ["users", "users"],
  ["suppliers", "suppliers"],
  ["materials", "materials"],
  ["shipments", "shipments"],
  ["rdsRequests", "rds_requests"],
  ["audit", "audit_events"],
  ["notifications", "notifications"],
  ["importBatches", "import_batches"],
  ["ecosystemMaterials", "ecosystem_materials"],
  ["sapManualRows", "sap_manual_rows"],
  ["aiAgentEvents", "ai_agent_events"],
];

const SINGLETONS = ["version", "settings", "monthlyKpiSent", "sapRows"];
const UPDATE_LOCK = "dockflow-application-state-update";

const rowKey = (row, index) => {
  const candidate = row?.id ?? row?.key ?? row?.shipmentNumber ?? row?.trialKey;
  return candidate === undefined || candidate === null || candidate === "" ? `position:${index}` : String(candidate);
};

const requireState = (value, source) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} does not contain a valid DockFlow state object`);
  return value;
};

export class PostgresStore {
  constructor(database, createInitialState, transforms = {}, options = {}) {
    this.database = database;
    this.createInitialState = createInitialState;
    this.serialize = transforms.serialize || ((state) => state);
    this.deserialize = transforms.deserialize || ((state) => state);
    this.importFile = String(options.importFile || "").trim();
  }

  async initialize() {
    if (!this.database.isConnected()) throw new Error("PostgreSQL is required for APP_STORAGE=postgres but is not connected");
    await this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [UPDATE_LOCK]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.database.tableName("application_state")} (
          state_key TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      for (const [, tableName] of COLLECTIONS) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${this.database.tableName(tableName)} (
            row_key TEXT PRIMARY KEY,
            position INTEGER NOT NULL,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS "${tableName}_position_idx" ON ${this.database.tableName(tableName)} (position)`);
      }
      await client.query(`CREATE INDEX IF NOT EXISTS "users_username_idx" ON ${this.database.tableName("users")} (LOWER(payload->>'username'))`);
      await client.query(`CREATE INDEX IF NOT EXISTS "users_role_idx" ON ${this.database.tableName("users")} ((payload->>'role'))`);
      await client.query(`CREATE INDEX IF NOT EXISTS "shipments_schedule_idx" ON ${this.database.tableName("shipments")} ((payload->>'scheduledDate'), (payload->>'scheduledTime'))`);
      await client.query(`CREATE INDEX IF NOT EXISTS "shipments_status_idx" ON ${this.database.tableName("shipments")} ((payload->>'status'))`);
      await client.query(`CREATE INDEX IF NOT EXISTS "shipments_supplier_idx" ON ${this.database.tableName("shipments")} ((payload->>'supplierId'))`);
      await client.query(`CREATE INDEX IF NOT EXISTS "notifications_user_idx" ON ${this.database.tableName("notifications")} ((payload->>'userId'), (payload->>'createdAt'))`);

      const initialized = await client.query(`SELECT payload FROM ${this.database.tableName("application_state")} WHERE state_key = 'storage_metadata'`);
      if (initialized.rowCount) return;

      const { state, source } = await this.initialState();
      await this.writeState(client, state);
      await client.query(`
        INSERT INTO ${this.database.tableName("application_state")} (state_key, payload)
        VALUES ('storage_metadata', $1::jsonb)
        ON CONFLICT (state_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
      `, [JSON.stringify({ initializedAt: new Date().toISOString(), source })]);
    });
  }

  async initialState() {
    if (this.importFile) {
      try {
        const contents = await readFile(this.importFile, "utf8");
        return { state: this.deserialize(requireState(JSON.parse(contents), this.importFile)), source: `json-import:${this.importFile}` };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return { state: await this.createInitialState(), source: "bootstrap" };
  }

  async read() {
    return this.database.transaction((client) => this.readState(client), { isolation: "repeatable-read", readOnly: true });
  }

  async update(mutator) {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [UPDATE_LOCK]);
      const state = await this.readState(client);
      const result = await mutator(state);
      await this.writeState(client, state);
      return result;
    });
  }

  async readState(client) {
    const state = {};
    const singletonRows = await client.query(`SELECT state_key, payload FROM ${this.database.tableName("application_state")} WHERE state_key = ANY($1::text[])`, [SINGLETONS]);
    for (const row of singletonRows.rows) state[row.state_key] = row.payload;
    for (const [stateKey, tableName] of COLLECTIONS) {
      const rows = await client.query(`SELECT payload FROM ${this.database.tableName(tableName)} ORDER BY position, row_key`);
      state[stateKey] = rows.rows.map((row) => row.payload);
    }
    state.version ??= 12;
    state.settings ??= {};
    state.monthlyKpiSent ??= {};
    state.sapRows ??= {};
    return this.deserialize(state);
  }

  async writeState(client, sourceState) {
    const state = this.serialize(structuredClone(sourceState));
    for (const stateKey of SINGLETONS) {
      const fallback = stateKey === "version" ? 12 : {};
      await client.query(`
        INSERT INTO ${this.database.tableName("application_state")} (state_key, payload)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (state_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
      `, [stateKey, JSON.stringify(state[stateKey] ?? fallback)]);
    }

    for (const [stateKey, tableName] of COLLECTIONS) {
      const rows = Array.isArray(state[stateKey]) ? state[stateKey] : [];
      const records = rows.map((payload, position) => ({ row_key: rowKey(payload, position), position, payload }));
      if (records.length) {
        await client.query(`
          INSERT INTO ${this.database.tableName(tableName)} AS current (row_key, position, payload)
          SELECT incoming.row_key, incoming.position, incoming.payload
          FROM jsonb_to_recordset($1::jsonb) AS incoming(row_key TEXT, position INTEGER, payload JSONB)
          ON CONFLICT (row_key) DO UPDATE SET
            position = EXCLUDED.position,
            payload = EXCLUDED.payload,
            updated_at = NOW()
          WHERE current.position IS DISTINCT FROM EXCLUDED.position OR current.payload IS DISTINCT FROM EXCLUDED.payload
        `, [JSON.stringify(records)]);
      }
      await client.query(`DELETE FROM ${this.database.tableName(tableName)} WHERE NOT (row_key = ANY($1::text[]))`, [records.map((row) => row.row_key)]);
    }
  }
}
