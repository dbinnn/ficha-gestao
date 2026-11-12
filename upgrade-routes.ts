import type { Express } from "express";
import { z } from "zod";
import { pool, admin, tx, lock, touch, HttpError } from "./db.js";
import { fields, labels, groups, pending } from "../shared/domain.js";
import { variation } from "../shared/workflow.js";
import { companiesXlsx, annualXlsx } from "./exports.js";
import { enqueue } from "./jobs.js";
import { diagnosePdf } from "./diagnostics.js";
const id = z.string().uuid();
const version = z.number().int().positive();
const reason = z.string().trim().min(3).max(1000);
function elevated(u: any) {
  if (!["administrador", "supervisor"].includes(u.role))
    throw new HttpError(403, "Ação exclusiva de supervisor ou administrador.");
}
function administrator(u: any) {
  if (u.role !== "administrador")
    throw new HttpError(403, "Ação exclusiva do administrador.");
}
export function upgradeRoutes(app: Express) {
  app.get("/api/system/diagnostics", async (_q, r) => {
    administrator(r.locals.user);
    const tools = await diagnosePdf();
    let database = "Falha de conexão";
    let migration = false;
    try {
      await pool.query("select 1");
      database = "Conectado";
      migration = !!(
        await pool.query("select to_regclass('public.document_jobs') ok")
      ).rows[0].ok;
    } catch {}
    r.json({
      tools,
      database,
      migration,
      reader: process.env.PDF_READER === "openai" ? "openai" : "local",
      apiConfigured: !!process.env.OPENAI_API_KEY,
    });
  });
  app.get("/api/trash", async (_q, r) => {
    administrator(r.locals.user);
    r.json({
      companies: (
        await pool.query(
          "select id,legal_name,cnpj,deleted_at,delete_reason,version from companies where deleted_at is not null order by deleted_at desc",
        )
      ).rows,
      competencies: (
        await pool.query(
          "select c.id,c.year,c.month,c.deleted_at,c.delete_reason,c.version,co.legal_name,co.deleted_at company_deleted from competencies c join companies co on co.id=c.company_id where c.deleted_at is not null order by c.deleted_at desc",
        )
      ).rows,
    });
  });
  app.delete("/api/companies/:id", async (q, r) => {
    administrator(r.locals.user);
    const b = z.object({ version, reason }).parse(q.body);
    await tx(
      r.locals.user.id,
      async (d) => {
        const co = (
          await d.query(
            "select * from companies where id=$1 and deleted_at is null for update",
            [id.parse(q.params.id)],
          )
        ).rows[0];
        if (!co) throw new HttpError(404, "Empresa não encontrada.");
        if (co.version !== b.version)
          throw new HttpError(
            409,
            "Empresa alterada. Atualize antes de excluir.",
          );
        const children = (
          await d.query(
            "select id,status from competencies where company_id=$1 and deleted_at is null order by id for update",
            [co.id],
          )
        ).rows;
        if (children.some((c) => c.status === "fechada"))
          throw new HttpError(
            422,
            "Esta empresa possui competências fechadas. Reabra-as antes de excluir a empresa.",
          );
        await d.query(
          "update document_jobs set status='cancelled',message='Empresa excluída',finished_at=now() where competency_id in (select id from competencies where company_id=$1) and status in ('queued','running')",
          [co.id],
        );
        await d.query(
          "update competencies set deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1 where company_id=$1 and deleted_at is null",
          [co.id, r.locals.user.id, b.reason],
        );
        await d.query(
          "update companies set deleted_at=now(),deleted_by=$2,delete_reason=$3,is_active=false,version=version+1 where id=$1",
          [co.id, r.locals.user.id, b.reason],
        );
      },
      b.reason,
    );
    r.json({ ok: true });
  });
  app.delete("/api/competencies/:id", async (q, r) => {
    elevated(r.locals.user);
    const b = z.object({ version, reason }).parse(q.body);
    await tx(
      r.locals.user.id,
      async (d) => {
        const c = await lock(d, id.parse(q.params.id), b.version);
        await d.query(
          "update document_jobs set status='cancelled',message='Lançamento excluído',finished_at=now() where competency_id=$1 and status in ('queued','running')",
          [c.id],
        );
        await d.query(
          "update competencies set deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1 where id=$1",
          [c.id, r.locals.user.id, b.reason],
        );
      },
      b.reason,
    );
    r.json({ ok: true });
  });
  app.post("/api/trash/:type/:id/restore", async (q, r) => {
    administrator(r.locals.user);
    const b = z.object({ version, reason }).parse(q.body);
    const type = z.enum(["companies", "competencies"]).parse(q.params.type);
    await tx(
      r.locals.user.id,
      async (d) => {
        const row = (
          await d.query(
            `select * from ${type} where id=$1 and deleted_at is not null for update`,
            [id.parse(q.params.id)],
          )
        ).rows[0];
        if (!row)
          throw new HttpError(404, "Registro na lixeira não encontrado.");
        if (row.version !== b.version)
          throw new HttpError(409, "Registro alterado. Atualize a lixeira.");
        await d.query(
          `update ${type} set deleted_at=null,deleted_by=null,delete_reason=null,version=version+1 where id=$1`,
          [row.id],
        );
      },
      b.reason,
    );
    r.json({ ok: true });
  });
  app.get("/api/jobs", async (q, r) => {
    const cid = q.query.competency ? id.parse(q.query.competency) : null;
    r.json(
      (
        await pool.query(
          `select j.id,j.document_id,j.competency_id,j.status,j.progress,j.message,j.attempts,j.created_at,j.finished_at,d.document_type,v.original_filename,c.month,c.year,co.legal_name
   from document_jobs j join competency_documents d on d.id=j.document_id join competency_document_versions v on v.id=j.document_version_id join competencies c on c.id=j.competency_id join companies co on co.id=c.company_id
   where c.deleted_at is null and co.deleted_at is null and ($1::uuid is null or j.competency_id=$1) order by j.created_at desc limit 100`,
          [cid],
        )
      ).rows,
    );
  });
  app.post("/api/documents/:id/process", async (q, r) => {
    const b = z.object({ version }).parse(q.body);
    r.status(202).json(
      await tx(r.locals.user.id, (d) =>
        enqueue(d, r.locals.user.id, id.parse(q.params.id), b.version),
      ),
    );
  });
  app.post("/api/jobs/:id/retry", async (q, r) => {
    const job = (
      await pool.query(
        "select j.*,c.version,d.current_version_id from document_jobs j join competencies c on c.id=j.competency_id join competency_documents d on d.id=j.document_id where j.id=$1",
        [id.parse(q.params.id)],
      )
    ).rows[0];
    if (!job) throw new HttpError(404, "Leitura não encontrada.");
    if (job.document_version_id !== job.current_version_id)
      throw new HttpError(
        409,
        "Este PDF foi substituído. Abra a ficha para processar a versão atual.",
      );
    r.status(202).json(
      await tx(r.locals.user.id, (d) =>
        enqueue(d, r.locals.user.id, job.document_id, job.version),
      ),
    );
  });
  app.post("/api/documents/:id/suggestions", async (q, r) => {
    const b = z
      .object({
        version,
        keys: z.array(z.enum(fields)).min(1).max(21),
        action: z.enum(["accept", "keep"]),
      })
      .parse(q.body);
    await tx(
      r.locals.user.id,
      async (d) => {
        const doc = (
          await d.query(
            "select d.*,v.raw_extracted_data from competency_documents d left join competency_document_versions v on v.id=d.current_version_id where d.id=$1",
            [id.parse(q.params.id)],
          )
        ).rows[0];
        if (!doc) throw new HttpError(404, "Documento não encontrado.");
        const c = await lock(d, doc.competency_id, b.version);
        if (doc.raw_extracted_data?.validation_issues?.length)
          throw new HttpError(
            422,
            "Corrija a identidade do documento antes de aceitar sugestões.",
          );
        for (const key of b.keys) {
          if (!c.ipi_applicable && groups.ipi.includes(key)) continue;
          const f = (
            await d.query(
              "select * from competency_field_values where competency_id=$1 and field_key=$2 for update",
              [c.id, key],
            )
          ).rows[0];
          if (
            !f?.has_suggestion ||
            f.suggested_document_version_id !== doc.current_version_id
          )
            throw new HttpError(
              409,
              "Sugestão substituída ou já resolvida. Atualize a ficha.",
            );
          if (b.action === "accept")
            await d.query(
              "update competency_field_values set confirmed_value=extracted_value,source_document_version_id=suggested_document_version_id,source_type=$2,evidence=suggested_evidence,has_suggestion=false,is_manual_override=false,confirmed_at=null,confirmed_by=null,updated_at=now() where id=$1",
              [f.id, doc.document_type],
            );
          else
            await d.query(
              "update competency_field_values set has_suggestion=false,is_manual_override=true,confirmed_by=$2,confirmed_at=case when confirmed_value is null then null else now() end,updated_at=now() where id=$1",
              [f.id, r.locals.user.id],
            );
        }
        await touch(d, c.id, "aguardando_conferencia");
      },
      b.action === "accept"
        ? "Aceitou sugestão de leitura"
        : "Manteve valor conferido",
    );
    r.json({ ok: true });
  });
  app.get("/api/documents/:id/file", async (q, r) => {
    const v = (
      await pool.query(
        "select v.storage_path from competency_document_versions v join competency_documents d on d.id=v.competency_document_id join competencies c on c.id=d.competency_id join companies co on co.id=c.company_id where v.id=$1 and c.deleted_at is null and co.deleted_at is null",
        [id.parse(q.params.id)],
      )
    ).rows[0];
    if (!v) throw new HttpError(404, "PDF não encontrado.");
    const file = await admin!.storage
      .from("fiscal-documents")
      .download(v.storage_path);
    if (file.error) throw new HttpError(502, "Não foi possível abrir o PDF.");
    r.type("pdf")
      .set("Cache-Control", "no-store")
      .send(Buffer.from(await file.data.arrayBuffer()));
  });
  app.get("/api/companies-export", async (q, r) => {
    const ids = q.query.ids
      ? z.array(id).max(10000).parse(String(q.query.ids).split(","))
      : null;
    const rows = (
      await pool.query(
        "select co.*,p.full_name responsible_name,s.full_name supervisor_name from companies co left join profiles p on p.id=co.responsible_user_id left join profiles s on s.id=co.supervisor_user_id where co.deleted_at is null and ($1::uuid[] is null or co.id=any($1)) order by co.internal_code",
        [ids],
      )
    ).rows;
    r.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .attachment("Empresas-Ficha-Gestao.xlsx")
      .send(await companiesXlsx(rows));
  });
  app.get("/api/reports/:company/:year/excel", async (q, r) => {
    const company = (
      await pool.query(
        "select * from companies where id=$1 and deleted_at is null",
        [id.parse(q.params.company)],
      )
    ).rows[0];
    if (!company) throw new HttpError(404, "Empresa não encontrada.");
    const year = z.coerce
      .number()
      .int()
      .min(2000)
      .max(2200)
      .parse(q.params.year);
    const month = z.coerce
      .number()
      .int()
      .min(0)
      .max(12)
      .parse(q.query.month || 0);
    const rows = (
      await pool.query(
        "select * from vw_monthly_ficha_gestao where company_id=$1 and year=$2 order by month",
        [company.id, year],
      )
    ).rows;
    r.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .attachment("Ficha-Gestao.xlsx")
      .send(await annualXlsx(company, year, rows, month));
  });
  app.get("/api/competencies/:id/comparison", async (q, r) => {
    const row = (
      await pool.query("select * from vw_monthly_ficha_gestao where id=$1", [
        id.parse(q.params.id),
      ])
    ).rows[0];
    if (!row) throw new HttpError(404, "Competência não encontrada.");
    const month = row.month === 1 ? 12 : row.month - 1;
    const year = row.month === 1 ? row.year - 1 : row.year;
    const previous = (
      await pool.query(
        "select * from vw_monthly_ficha_gestao where company_id=$1 and year=$2 and month=$3",
        [row.company_id, year, month],
      )
    ).rows[0];
    r.json({
      previousPeriod: { year, month },
      exists: !!previous,
      rows: fields.map((key) => ({
        key,
        label: labels[key],
        current: row.values[key] ?? null,
        previous: previous?.values[key] ?? null,
        ...variation(row.values[key], previous?.values[key]),
      })),
    });
  });
}
