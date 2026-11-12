import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { lock } from "../server/db.js";
import { PGlite } from "@electric-sql/pglite";
test("Migrations PostgreSQL: isolamento mensal, RLS, concorrência, auditoria e fechamento", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);create role anon;create role authenticated;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;",
    );
    await db.exec(
      await readFile("supabase/migrations/001_initial.sql", "utf8"),
    );
    await db.exec(
      await readFile("supabase/migrations/004_workflow.sql", "utf8"),
    );
    const uid = "11111111-1111-4111-8111-111111111111";
    await db.query("insert into auth.users(id) values($1)", [uid]);
    await db.query(
      "insert into profiles(id,email,full_name,role) values($1,'teste@invalid.test','Teste isolado','administrador')",
      [uid],
    );
    await db.query("select set_config('app.actor',$1,false)", [uid]);
    const co: any = (
      await db.query(
        "insert into companies(internal_code,legal_name,cnpj,default_tax_regime) values('TEST','Teste isolado','11222333000181','lucro_real') returning *",
      )
    ).rows[0];
    const c: any = (
      await db.query(
        "insert into competencies(company_id,year,month,tax_regime,ipi_applicable) values($1,2026,8,'lucro_real',false) returning *",
        [co.id],
      )
    ).rows[0];
    await assert.rejects(
      db.query(
        "insert into competencies(company_id,year,month,tax_regime,ipi_applicable) values($1,2026,8,'lucro_real',false)",
        [co.id],
      ),
    );
    await db.query(
      "insert into competencies(company_id,year,month,tax_regime,ipi_applicable) values($1,2026,9,'lucro_real',false)",
      [co.id],
    );
    await db.query(
      "insert into competency_field_values(competency_id,field_key,extracted_value,confirmed_value,source_type) values($1,'icms',1000,1000,'icms')",
      [c.id],
    );
    await db.query(
      "update competency_field_values set confirmed_value=1050 where competency_id=$1",
      [c.id],
    );
    const f: any = (
      await db.query(
        "select * from competency_field_values where competency_id=$1",
        [c.id],
      )
    ).rows[0];
    assert.equal(Number(f.extracted_value), 1000);
    assert.equal(Number(f.confirmed_value), 1050);
    assert.equal(
      (await db.query("select * from vw_monthly_ficha_gestao")).rows.length,
      2,
    );
    await db.query(
      "update companies set default_tax_regime='lucro_presumido' where id=$1",
      [co.id],
    );
    assert.equal(
      (
        await db.query<any>("select tax_regime from competencies where id=$1", [
          c.id,
        ])
      ).rows[0].tax_regime,
      "lucro_real",
    );
    await assert.rejects(lock(db as any, c.id, 999));
    const doc: any = (
      await db.query(
        "insert into competency_documents(competency_id,document_type) values($1,'icms') returning *",
        [c.id],
      )
    ).rows[0];
    const v1: any = (
      await db.query(
        "insert into competency_document_versions(competency_document_id,version_number,original_filename,storage_path,file_size,file_hash,uploaded_by) values($1,1,'teste.pdf','test/1.pdf',10,'sha-test',$2) returning *",
        [doc.id, uid],
      )
    ).rows[0];
    const v2: any = (
      await db.query(
        "insert into competency_document_versions(competency_document_id,version_number,original_filename,storage_path,file_size,file_hash,uploaded_by) values($1,2,'teste2.pdf','test/2.pdf',10,'sha-test2',$2) returning *",
        [doc.id, uid],
      )
    ).rows[0];
    await db.query(
      "update competency_documents set current_version_id=$2 where id=$1",
      [doc.id, v2.id],
    );
    assert.equal(
      (
        await db.query(
          "select * from competency_document_versions where competency_document_id=$1",
          [doc.id],
        )
      ).rows.length,
      2,
    );
    await db.query(
      "update competency_field_values set source_document_version_id=$2 where competency_id=$1",
      [c.id, v1.id],
    );
    const sept: any = (
      await db.query("select id from competencies where month=9")
    ).rows[0];
    await assert.rejects(
      db.query(
        "insert into competency_field_values(competency_id,field_key,source_type,source_document_version_id) values($1,'icms','icms',$2)",
        [sept.id, v1.id],
      ),
    );
    const checks = await db.query<any>(
      await readFile("scripts/integridade.sql", "utf8"),
    );
    assert.ok(checks.rows.every((r) => Number(r.falhas) === 0));
    await db.query("update competencies set status='fechada' where id=$1", [
      c.id,
    ]);
    await assert.rejects(
      db.query(
        "update competency_field_values set confirmed_value=0 where competency_id=$1",
        [c.id],
      ),
    );
    await db.query("update profiles set role='colaborador' where id=$1", [uid]);
    await assert.rejects(
      db.query(
        "update competencies set status='em_preenchimento',reopen_reason='Teste' where id=$1",
        [c.id],
      ),
    );
    await db.query("update profiles set role='supervisor' where id=$1", [uid]);
    await db.query(
      "update competencies set status='em_preenchimento',reopen_reason='Teste' where id=$1",
      [c.id],
    );
    assert.ok((await db.query("select * from audit_logs")).rows.length > 5);
    await assert.rejects(db.query("delete from audit_logs"));
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      uid,
    ]);
    assert.equal((await db.query("select * from companies")).rows.length, 1);
    await assert.rejects(db.query("update companies set legal_name='Ataque'"));
    await db.query("select set_config('request.jwt.claim.sub','',false)");
    assert.equal((await db.query("select * from companies")).rows.length, 0);
    await db.exec("reset role");
    await db.exec(
      await readFile("supabase/migrations/003_auth_profiles.sql", "utf8"),
    );
    const fresh = "22222222-2222-4222-8222-222222222222";
    await db.query(
      'insert into auth.users(id,email,raw_user_meta_data) values($1,\'new@invalid.test\',\'{"full_name":"Novo","role":"administrador"}\')',
      [fresh],
    );
    const profile: any = (
      await db.query("select * from profiles where id=$1", [fresh])
    ).rows[0];
    assert.equal(profile.role, "colaborador");
    assert.equal(profile.is_active, false);
  } finally {
    await db.close();
  }
});
