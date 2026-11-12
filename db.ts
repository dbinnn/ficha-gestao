import "dotenv/config";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});
export const configured = !!(
  process.env.DATABASE_URL &&
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
export const admin = configured
  ? createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
  : null;
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function tx<T>(
  actor: string,
  work: (db: pg.PoolClient) => Promise<T>,
  reason = "",
) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(
      "select set_config('app.actor',$1,true),set_config('app.reason',$2,true)",
      [actor, reason],
    );
    const out = await work(db);
    await db.query("commit");
    return out;
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}
export async function lock(
  db: pg.PoolClient,
  id: string,
  version: number,
  closed = false,
) {
  const { rows } = await db.query(
    "select c.* from competencies c join companies co on co.id=c.company_id where c.id=$1 and c.deleted_at is null and co.deleted_at is null for update of c",
    [id],
  );
  const c = rows[0];
  if (!c) throw new HttpError(404, "Competência não encontrada.");
  if (c.version !== version)
    throw new HttpError(
      409,
      "Outra pessoa alterou esta ficha. Recarregue antes de salvar.",
    );
  if (c.status === "fechada" && !closed)
    throw new HttpError(409, "Reabra a competência antes de editar.");
  return c;
}
export async function touch(
  db: pg.PoolClient,
  id: string,
  status = "em_preenchimento",
) {
  await db.query(
    "update competencies set version=version+1,updated_at=now(),status=$2,confirmed_by=null,confirmed_at=null where id=$1",
    [id, status],
  );
}
