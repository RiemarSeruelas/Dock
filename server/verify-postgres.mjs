import { database } from "./db.js";

const applicationTables = [
  "users",
  "suppliers",
  "materials",
  "shipments",
  "rds_requests",
  "audit_events",
  "notifications",
  "import_batches",
  "ecosystem_materials",
  "sap_manual_rows",
];

try {
  const status = await database.initialize();
  if (!status.connected) throw new Error("PostgreSQL is not connected");
  const counts = await database.withClient(async (client) => {
    const output = {};
    for (const tableName of applicationTables) {
      const exists = await client.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) AS present", [database.schema, tableName]);
      if (!exists.rows[0]?.present) {
        output[tableName] = "not initialized";
        continue;
      }
      const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${database.tableName(tableName)}`);
      output[tableName] = Number(result.rows[0].count);
    }
    return output;
  });
  console.log(JSON.stringify({ database: status, applicationRows: counts }, null, 2));
} catch (error) {
  console.error(`DockFlow PostgreSQL verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database.close().catch(() => undefined);
}
