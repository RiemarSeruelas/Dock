import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
const pgConnectionConfigured = Boolean(firstDefined(
  process.env.DATABASE_URL,
  process.env.PGHOST,
  process.env.PGDATABASE,
  process.env.DB_HOST,
  process.env.DB_NAME,
));
const enabled = process.env.DB_ENABLED === undefined || process.env.DB_ENABLED === ""
  ? pgConnectionConfigured
  : String(process.env.DB_ENABLED).toLowerCase() === "true";
const schema = String(firstDefined(process.env.DB_SCHEMA, process.env.PGSCHEMA, "Dockflow")).trim();
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("DB_SCHEMA must contain only letters, numbers, and underscores");

const quotedSchema = `"${schema}"`;
const table = (name) => `${quotedSchema}."${name}"`;
const memoryTokens = new Map();
let pool = null;
let connected = false;

const poolOptions = () => {
  const sslSetting = String(firstDefined(process.env.DB_SSL, process.env.PGSSL, "false")).toLowerCase();
  const ssl = ["true", "1", "require", "required", "prefer", "verify-ca", "verify-full", "no-verify"].includes(sslSetting)
    ? { rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || "true").toLowerCase() !== "false" }
    : false;
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL, ssl };
  return {
    host: firstDefined(process.env.DB_HOST, process.env.PGHOST),
    port: Number(firstDefined(process.env.DB_PORT, process.env.PGPORT, 5432)),
    database: firstDefined(process.env.DB_NAME, process.env.PGDATABASE),
    user: firstDefined(process.env.DB_USER, process.env.PGUSER),
    password: firstDefined(process.env.DB_PASSWORD, process.env.PGPASSWORD),
    ssl,
  };
};

export const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");

export const database = {
  enabled,
  schema,

  async initialize() {
    if (!enabled) return { enabled: false, connected: false, schema, storage: "memory" };
    pool = new Pool({ ...poolOptions(), max: Number(process.env.DB_POOL_MAX || 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000) });
    pool.on("error", (error) => { connected = false; console.error(`[database] PostgreSQL pool error: ${error.message}`); });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table("refresh_tokens")} (
          id BIGSERIAL PRIMARY KEY,
          token_id UUID NOT NULL UNIQUE,
          token_hash CHAR(64) NOT NULL,
          user_id BIGINT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_ip TEXT,
          user_agent TEXT
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS "refresh_tokens_user_active_idx" ON ${table("refresh_tokens")} (user_id, expires_at) WHERE revoked_at IS NULL`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table("api_request_logs")} (
          id BIGSERIAL PRIMARY KEY,
          request_id UUID NOT NULL,
          occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          method VARCHAR(10) NOT NULL,
          route TEXT NOT NULL,
          status_code SMALLINT NOT NULL,
          duration_ms INTEGER NOT NULL,
          user_id BIGINT,
          user_role VARCHAR(30),
          ip_address TEXT,
          user_agent TEXT,
          error_message TEXT
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS "api_request_logs_time_idx" ON ${table("api_request_logs")} (occurred_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS "api_request_logs_user_idx" ON ${table("api_request_logs")} (user_id, occurred_at DESC)`);
      await client.query(`ALTER TABLE ${table("api_request_logs")} ADD COLUMN IF NOT EXISTS session_key TEXT`);
      await client.query(`ALTER TABLE ${table("api_request_logs")} ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE ${table("api_request_logs")} ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE ${table("api_request_logs")} ADD COLUMN IF NOT EXISTS request_count BIGINT NOT NULL DEFAULT 1`);
      await client.query(`ALTER TABLE ${table("api_request_logs")} ADD COLUMN IF NOT EXISTS success_count BIGINT NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE ${table("api_request_logs")} ADD COLUMN IF NOT EXISTS client_error_count BIGINT NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE ${table("api_request_logs")} ADD COLUMN IF NOT EXISTS server_error_count BIGINT NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE ${table("api_request_logs")} ADD COLUMN IF NOT EXISTS total_duration_ms BIGINT NOT NULL DEFAULT 0`);
      const legacy = await client.query(`
        SELECT COUNT(*)::bigint AS request_count, MIN(occurred_at) AS started_at, MAX(occurred_at) AS last_seen_at,
          COUNT(*) FILTER (WHERE status_code < 400)::bigint AS success_count,
          COUNT(*) FILTER (WHERE status_code BETWEEN 400 AND 499)::bigint AS client_error_count,
          COUNT(*) FILTER (WHERE status_code >= 500)::bigint AS server_error_count,
          COALESCE(SUM(duration_ms), 0)::bigint AS total_duration_ms
        FROM ${table("api_request_logs")} WHERE session_key IS NULL
      `);
      if (Number(legacy.rows[0]?.request_count || 0) > 0) {
        const summary = legacy.rows[0];
        await client.query(`
          INSERT INTO ${table("api_request_logs")} (
            request_id, occurred_at, method, route, status_code, duration_ms, session_key, started_at, last_seen_at,
            request_count, success_count, client_error_count, server_error_count, total_duration_ms, error_message
          ) VALUES ($1, $2, 'SUMMARY', 'Legacy requests', 200, 0, 'legacy-summary', $2, $3, $4, $5, $6, $7, $8, 'Existing request rows collapsed during the session-summary migration')
          ON CONFLICT DO NOTHING
        `, [randomUUID(), summary.started_at, summary.last_seen_at, summary.request_count, summary.success_count, summary.client_error_count, summary.server_error_count, summary.total_duration_ms]);
        await client.query(`DELETE FROM ${table("api_request_logs")} WHERE session_key IS NULL`);
      }
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS "api_request_logs_session_key_idx" ON ${table("api_request_logs")} (session_key) WHERE session_key IS NOT NULL`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table("trial_records")} (
          id BIGSERIAL PRIMARY KEY,
          trial_key VARCHAR(120) NOT NULL UNIQUE,
          status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        INSERT INTO ${table("trial_records")} (trial_key, status, payload, notes)
        VALUES ('database-connection', 'ACTIVE', $1::jsonb, 'Created automatically when DockFlow connected successfully.')
        ON CONFLICT (trial_key) DO UPDATE SET payload = EXCLUDED.payload, status = 'ACTIVE', updated_at = NOW()
      `, [JSON.stringify({ connectedAt: new Date().toISOString(), storage: "PostgreSQL", schema })]);
      const retentionDays = Math.max(1, Number(process.env.API_LOG_RETENTION_DAYS || 90));
      await client.query(`DELETE FROM ${table("api_request_logs")} WHERE COALESCE(last_seen_at, occurred_at) < NOW() - ($1 * INTERVAL '1 day')`, [retentionDays]);
      await client.query(`DELETE FROM ${table("refresh_tokens")} WHERE expires_at < NOW() OR revoked_at < NOW() - INTERVAL '7 days'`);
      await client.query("COMMIT");
      connected = true;
      return { enabled: true, connected: true, schema, storage: "postgresql" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async health() {
    if (!enabled) return { enabled: false, connected: false, schema, storage: "memory" };
    try {
      await pool.query("SELECT 1");
      connected = true;
      return { enabled: true, connected: true, schema, storage: "postgresql" };
    } catch (error) {
      connected = false;
      return { enabled: true, connected: false, schema, storage: "postgresql", error: error.message };
    }
  },

  async saveRefreshToken({ tokenId, tokenHash, userId, expiresAt, ipAddress, userAgent }) {
    if (!enabled) {
      memoryTokens.set(tokenId, { tokenHash, userId, expiresAt: Date.parse(expiresAt), revokedAt: null });
      return;
    }
    await pool.query(`INSERT INTO ${table("refresh_tokens")} (token_id, token_hash, user_id, expires_at, created_ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`, [tokenId, tokenHash, userId, expiresAt, ipAddress || null, userAgent || null]);
  },

  async findRefreshToken(tokenId, tokenHash) {
    if (!enabled) {
      const record = memoryTokens.get(tokenId);
      return Boolean(record && record.tokenHash === tokenHash && !record.revokedAt && record.expiresAt > Date.now());
    }
    const result = await pool.query(`SELECT 1 FROM ${table("refresh_tokens")} WHERE token_id = $1 AND token_hash = $2 AND revoked_at IS NULL AND expires_at > NOW()`, [tokenId, tokenHash]);
    return result.rowCount === 1;
  },

  async revokeRefreshToken(tokenId) {
    if (!tokenId) return;
    if (!enabled) {
      const record = memoryTokens.get(tokenId);
      if (record) record.revokedAt = Date.now();
      return;
    }
    await pool.query(`UPDATE ${table("refresh_tokens")} SET revoked_at = COALESCE(revoked_at, NOW()) WHERE token_id = $1`, [tokenId]);
  },

  async revokeUserRefreshTokens(userId) {
    if (!enabled) {
      for (const record of memoryTokens.values()) if (Number(record.userId) === Number(userId)) record.revokedAt = Date.now();
      return;
    }
    await pool.query(`UPDATE ${table("refresh_tokens")} SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1`, [userId]);
  },

  async logApiRequest(entry) {
    if (!enabled || !connected) return;
    await pool.query(`
      INSERT INTO ${table("api_request_logs")} AS activity (
        request_id, method, route, status_code, duration_ms, user_id, user_role, ip_address, user_agent, error_message,
        session_key, started_at, last_seen_at, request_count, success_count, client_error_count, server_error_count, total_duration_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW(), 1,
        CASE WHEN $4 < 400 THEN 1 ELSE 0 END,
        CASE WHEN $4 BETWEEN 400 AND 499 THEN 1 ELSE 0 END,
        CASE WHEN $4 >= 500 THEN 1 ELSE 0 END, $5)
      ON CONFLICT (session_key) WHERE session_key IS NOT NULL DO UPDATE SET
        request_id = EXCLUDED.request_id,
        occurred_at = NOW(),
        method = EXCLUDED.method,
        route = EXCLUDED.route,
        status_code = EXCLUDED.status_code,
        duration_ms = EXCLUDED.duration_ms,
        user_id = COALESCE(EXCLUDED.user_id, activity.user_id),
        user_role = COALESCE(EXCLUDED.user_role, activity.user_role),
        ip_address = EXCLUDED.ip_address,
        user_agent = EXCLUDED.user_agent,
        error_message = EXCLUDED.error_message,
        last_seen_at = NOW(),
        request_count = activity.request_count + 1,
        success_count = activity.success_count + CASE WHEN EXCLUDED.status_code < 400 THEN 1 ELSE 0 END,
        client_error_count = activity.client_error_count + CASE WHEN EXCLUDED.status_code BETWEEN 400 AND 499 THEN 1 ELSE 0 END,
        server_error_count = activity.server_error_count + CASE WHEN EXCLUDED.status_code >= 500 THEN 1 ELSE 0 END,
        total_duration_ms = activity.total_duration_ms + EXCLUDED.duration_ms
    `, [entry.requestId, entry.method, entry.route, entry.statusCode, entry.durationMs, entry.userId || null, entry.userRole || null, entry.ipAddress || null, entry.userAgent || null, entry.errorMessage || null, entry.sessionKey]);
  },

  async listTrialRecords() {
    if (!enabled) return [];
    const result = await pool.query(`SELECT id, trial_key AS "trialKey", status, payload, notes, created_at AS "createdAt", updated_at AS "updatedAt" FROM ${table("trial_records")} ORDER BY updated_at DESC`);
    return result.rows;
  },

  async upsertTrialRecord({ trialKey, status, payload, notes }) {
    if (!enabled) throw new Error("PostgreSQL is disabled. Set DB_ENABLED=true first.");
    const result = await pool.query(`
      INSERT INTO ${table("trial_records")} (trial_key, status, payload, notes)
      VALUES ($1, $2, $3::jsonb, $4)
      ON CONFLICT (trial_key) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload, notes = EXCLUDED.notes, updated_at = NOW()
      RETURNING id, trial_key AS "trialKey", status, payload, notes, created_at AS "createdAt", updated_at AS "updatedAt"
    `, [trialKey, status, JSON.stringify(payload || {}), notes || null]);
    return result.rows[0];
  },
};
