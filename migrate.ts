import "dotenv/config";
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});
await db.connect();
try {
  await db.query("select pg_advisory_lock(924088)");
  await db.query(
    "create table if not exists schema_migrations(name text primary key,sha256 text not null,applied_at timestamptz default now())",
  );
  for (const name of (await readdir("supabase/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = await readFile("supabase/migrations/" + name, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const prior = await db.query(
      "select sha256 from schema_migrations where name=$1",
      [name],
    );
    if (prior.rowCount) {
      if (prior.rows[0].sha256 !== hash)
        throw Error("Migration já aplicada foi alterada: " + name);
      continue;
    }
    await db.query("begin");
    try {
      await db.query(sql);
      await db.query(
        "insert into schema_migrations(name,sha256) values($1,$2)",
        [name, hash],
      );
      await db.query("commit");
      console.log("Aplicada:", name);
    } catch (e) {
      await db.query("rollback");
      throw e;
    }
  }
} finally {
  await db.end();
}
