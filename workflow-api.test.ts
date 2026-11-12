import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
process.env.NO_LISTEN = "true";
process.env.DATABASE_URL = "postgres://local.invalid/test";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
const { app } = await import("../server/index.js");
const { pool, admin, tx } = await import("../server/db.js");
const { claimJob, applyResult } = await import("../server/jobs.js");
const adminId = "11111111-1111-4111-8111-111111111111",
  collabId = "22222222-2222-4222-8222-222222222222";
test("API completa: cadastro, upload/fila, sugestões, exclusão, restauração, permissões e relatórios", async () => {
  const db = new PGlite();
  let server: any;
  try {
    await db.exec(
      "create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);create role anon;create role authenticated;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;",
    );
    for (const name of ["001_initial.sql", "004_workflow.sql"])
      await db.exec(await readFile("supabase/migrations/" + name, "utf8"));
    for (const [uid, role] of [
      [adminId, "administrador"],
      [collabId, "colaborador"],
    ]) {
      await db.query("insert into auth.users(id) values($1)", [uid]);
      await db.query(
        "insert into profiles(id,email,full_name,role) values($1,$2,$3,$4)",
        [uid, uid + "@example.invalid", role, role],
      );
    }
    const query = async (sql: string, params: any[] = []) => {
      const r = await db.query(sql, params);
      return { ...r, rowCount: r.rows.length || r.affectedRows };
    };
    (pool as any).query = query;
    (pool as any).connect = async () => ({ query, release() {} });
    (admin!.auth as any).getUser = async (token: string) => ({
      data: { user: { id: token === "collab" ? collabId : adminId } },
      error: null,
    });
    (admin!.storage as any).from = () => ({
      upload: async () => ({ error: null }),
      remove: async () => ({ error: null }),
      download: async () => ({ data: new Blob(["%PDF-test"]), error: null }),
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.on("listening", r));
    const base = "http://127.0.0.1:" + server.address().port + "/api";
    async function request(
      route: string,
      method = "GET",
      body?: any,
      token = "admin",
      expect = 200,
    ) {
      const headers: any = { Authorization: "Bearer " + token };
      if (body && !(body instanceof FormData))
        headers["Content-Type"] = "application/json";
      const res = await fetch(base + route, {
        method,
        headers,
        body:
          body instanceof FormData
            ? body
            : body
              ? JSON.stringify(body)
              : undefined,
      });
      const result = res.headers.get("content-type")?.includes("json")
        ? await res.json()
        : await res.arrayBuffer();
      assert.equal(res.status, expect, JSON.stringify(result));
      return result;
    }
    const company = await request("/companies", "POST", {
      internal_code: "TEST",
      legal_name: "Teste de integração",
      cnpj: "11222333000181",
      default_tax_regime: "lucro_presumido",
      has_ipi: false,
      responsible_user_id: adminId,
      supervisor_user_id: adminId,
      margin_reference: null,
      tax_load_reference: null,
      is_active: true,
    });
    const c = await request("/competencies", "POST", {
      company_id: company.id,
      year: 2026,
      month: 9,
    });
    const initial = await request("/competencies/" + c.id);
    const doc = initial.documents.find((d: any) => d.document_type === "cpp");
    const upload = new FormData();
    upload.set(
      "file",
      new Blob(["%PDF-test"], { type: "application/pdf" }),
      "teste.pdf",
    );
    upload.set("version", c.version);
    await request("/competencies/" + c.id + "/documents/cpp", "POST", upload);
    let jobs = await request("/jobs");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "queued");
    let detail = await request("/competencies/" + c.id);
    await request(
      "/documents/" + doc.id + "/process",
      "POST",
      { version: detail.competency.version },
      "admin",
      202,
    );
    assert.equal((await request("/jobs")).length, 1, "fila não duplica");
    let job = await claimJob(pool);
    assert.ok(job);
    assert.equal(await claimJob(pool), undefined);
    const oldToken = job.claim_token;
    await db.query(
      "update document_jobs set locked_until=now()-interval '1 second' where id=$1",
      [job.id],
    );
    job = await claimJob(pool);
    assert.notEqual(job.claim_token, oldToken);
    assert.equal(job.attempts, 2, "retoma leitura interrompida");

    // A correction made while the PDF is being read must survive application.
    await request("/competencies/" + c.id + "/values", "PUT", {
      version: detail.competency.version,
      values: [
        { key: "cpp", value: "42.00", notes: "Correção durante leitura" },
      ],
    });
    const result = {
      cnpj: company.cnpj,
      year: 2026,
      month: 9,
      document_type: "cpp",
      cfop_table_complete: false,
      cfops: [],
      fields: [
        {
          key: "cpp",
          value: "10050.50",
          page: 2,
          evidence: "Empresa + terceiros",
        },
      ],
      warnings: [],
      reader: "test-local",
    };
    await tx(adminId, (d) => applyResult(d, job, structuredClone(result)));
    detail = await request("/competencies/" + c.id);
    let f = detail.values.find((f: any) => f.field_key === "cpp");
    assert.equal(f.confirmed_value, "42.00");
    assert.equal(f.extracted_value, "10050.50");
    assert.equal(f.has_suggestion, true);
    await request("/documents/" + doc.id + "/suggestions", "POST", {
      version: detail.competency.version,
      keys: ["cpp"],
      action: "keep",
    });
    detail = await request("/competencies/" + c.id);
    assert.equal(
      detail.values.find((f: any) => f.field_key === "cpp").has_suggestion,
      false,
    );
    await request(
      "/documents/" + doc.id + "/process",
      "POST",
      { version: detail.competency.version },
      "admin",
      202,
    );
    job = await claimJob(pool);
    await tx(adminId, (d) => applyResult(d, job, structuredClone(result)));
    detail = await request("/competencies/" + c.id);
    await request("/documents/" + doc.id + "/suggestions", "POST", {
      version: detail.competency.version,
      keys: ["cpp"],
      action: "accept",
    });
    detail = await request("/competencies/" + c.id);
    assert.equal(
      detail.values.find((f: any) => f.field_key === "cpp").confirmed_value,
      "10050.50",
    );

    await request(
      "/documents/" + doc.id + "/process",
      "POST",
      { version: detail.competency.version },
      "admin",
      202,
    );
    job = await claimJob(pool);
    await tx(adminId, (d) =>
      applyResult(d, job, { ...result, cnpj: "12345678000195" }),
    );
    detail = await request("/competencies/" + c.id);
    assert.equal(
      detail.documents.find((d: any) => d.id === doc.id).status,
      "divergencia",
    );
    assert.equal(
      detail.values.find((f: any) => f.field_key === "cpp").confirmed_value,
      "10050.50",
    );
    assert.match(
      detail.documents.find((d: any) => d.id === doc.id).raw_extracted_data
        .validation_issues[0],
      /CNPJ/,
    );
    await request(
      "/documents/" + doc.id + "/review",
      "POST",
      {
        version: detail.competency.version,
        reason: "Divergência validada manualmente",
      },
      "collab",
      403,
    );
    await request("/documents/" + doc.id + "/review", "POST", {
      version: detail.competency.version,
      reason: "Divergência validada manualmente",
    });
    detail = await request("/competencies/" + c.id);
    await request(
      "/companies/" + company.id,
      "DELETE",
      { version: company.version, reason: "Teste" },
      "collab",
      403,
    );
    await request(
      "/competencies/" + c.id,
      "DELETE",
      { version: detail.competency.version, reason: "Teste" },
      "collab",
      403,
    );
    const exported = await request("/companies-export");
    assert.ok(exported.byteLength > 1000);
    const excel = await request("/reports/" + company.id + "/2026/excel");
    assert.ok(excel.byteLength > 1000);
    const comparison = await request("/competencies/" + c.id + "/comparison");
    assert.equal(comparison.exists, false);
    await request("/competencies/" + c.id, "DELETE", {
      version: detail.competency.version,
      reason: "Lançamento de teste",
    });
    assert.equal((await request("/competencies?year=2026")).length, 0);
    await request("/competencies/" + c.id, "GET", undefined, "admin", 404);
    assert.equal(
      (await request("/reports/" + company.id + "/2026")).months.length,
      0,
    );
    let trash = await request("/trash");
    const dead = trash.competencies[0];
    const newC = await request("/competencies", "POST", {
      company_id: company.id,
      year: 2026,
      month: 9,
    });
    await request(
      "/trash/competencies/" + dead.id + "/restore",
      "POST",
      { version: dead.version, reason: "Teste conflito" },
      "admin",
      409,
    );
    await request("/competencies/" + newC.id, "DELETE", {
      version: newC.version,
      reason: "Excluir duplicado",
    });
    await request("/trash/competencies/" + dead.id + "/restore", "POST", {
      version: dead.version,
      reason: "Restaurar teste",
    });
    // Closed periods block company deletion; SQL guard independently protects period deletion.
    await db.query("select set_config('app.actor',$1,false)", [adminId]);
    await db.query("update competencies set status='fechada' where id=$1", [
      c.id,
    ]);
    await request(
      "/companies/" + company.id,
      "DELETE",
      { version: company.version, reason: "Teste fechada" },
      "admin",
      422,
    );
    await request(
      "/competencies/" + c.id,
      "DELETE",
      { version: dead.version + 1, reason: "Teste fechada" },
      "admin",
      409,
    );
    await db.query("select set_config('app.actor',$1,false)", [adminId]);
    await db.query(
      "update competencies set status='em_preenchimento',reopen_reason='Teste reabertura' where id=$1",
      [c.id],
    );
    await request("/companies/" + company.id, "DELETE", {
      version: company.version,
      reason: "Excluir empresa de teste",
    });
    assert.equal((await request("/companies")).length, 0);
    trash = await request("/trash");
    assert.equal(trash.companies.length, 1);
    await request("/trash/companies/" + company.id + "/restore", "POST", {
      version: trash.companies[0].version,
      reason: "Restaurar empresa",
    });
    assert.equal((await request("/companies"))[0].is_active, false);
    assert.equal(
      (await request("/competencies?year=2026")).length,
      0,
      "restaurar empresa não restaura todos os meses automaticamente",
    );
    await assert.rejects(db.query("delete from audit_logs"));
  } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
