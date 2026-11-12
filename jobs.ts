import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool, admin, tx, lock, touch, HttpError } from "./db.js";
import { extract } from "./extract.js";
import { identityIssues, preserveValue } from "../shared/workflow.js";
export async function enqueue(
  d: pg.PoolClient,
  actor: string,
  documentId: string,
  version: number,
) {
  const doc = (
    await d.query(
      "select d.*,c.version from competency_documents d join competencies c on c.id=d.competency_id where d.id=$1",
      [documentId],
    )
  ).rows[0];
  if (!doc?.current_version_id)
    throw new HttpError(422, "Anexe um PDF antes de processar.");
  const c = await lock(d, doc.competency_id, version);
  if (doc.document_type === "ipi" && !c.ipi_applicable)
    throw new HttpError(422, "IPI não se aplica nesta competência.");
  const existing = (
    await d.query(
      "select * from document_jobs where document_version_id=$1 and status in ('queued','running')",
      [doc.current_version_id],
    )
  ).rows[0];
  if (existing) return existing;
  const snapshot = (
    await d.query(
      "select coalesce(jsonb_object_agg(field_key,updated_at),'{}'::jsonb) snapshot from competency_field_values where competency_id=$1",
      [c.id],
    )
  ).rows[0].snapshot;
  const job = (
    await d.query(
      "insert into document_jobs(document_id,document_version_id,competency_id,requested_by,field_snapshot) values($1,$2,$3,$4,$5) returning *",
      [doc.id, doc.current_version_id, c.id, actor, snapshot],
    )
  ).rows[0];
  await d.query(
    "update competency_documents set status='processando',identity_override=false,reviewed_at=null,reviewed_by=null,updated_at=now() where id=$1",
    [doc.id],
  );
  await d.query(
    "update competency_document_versions set processing_status='queued',processing_error=null where id=$1",
    [doc.current_version_id],
  );
  await touch(d, c.id, "processando");
  return job;
}
export async function claimJob(db: Pick<pg.Pool, "query">) {
  return (
    await db.query(
      `with next as (select id from document_jobs where status='queued' or (status='running' and locked_until<now()) order by created_at for update skip locked limit 1)
 update document_jobs j set status='running',attempts=attempts+1,started_at=now(),locked_until=now()+interval '2 minutes',claim_token=$1,progress=10,message='Lendo PDF' from next where j.id=next.id returning j.*`,
      [randomUUID()],
    )
  ).rows[0];
}
export async function applyResult(d: pg.PoolClient, job: any, result: any) {
  const info = (
    await d.query(
      "select d.*,c.version,c.status competency_status,c.tax_regime,c.year,c.month,co.cnpj,c.deleted_at,co.deleted_at company_deleted from competency_documents d join competencies c on c.id=d.competency_id join companies co on co.id=c.company_id where d.id=$1",
      [job.document_id],
    )
  ).rows[0];
  if (
    !info ||
    info.deleted_at ||
    info.company_deleted ||
    info.competency_status === "fechada" ||
    info.current_version_id !== job.document_version_id
  ) {
    await d.query(
      "update document_jobs set status='cancelled',finished_at=now(),message='Documento substituído, competência fechada ou registro excluído' where id=$1 and claim_token=$2 and status='running'",
      [job.id, job.claim_token],
    );
    return;
  }
  await lock(d, info.competency_id, info.version);
  // Same lock order as uploads/deletions: competency, then job.
  const lease = (
    await d.query(
      "select * from document_jobs where id=$1 and claim_token=$2 and status='running' for update",
      [job.id, job.claim_token],
    )
  ).rows[0];
  if (!lease) return;

  result.validation_issues = identityIssues(result, info);
  const match = result.validation_issues.length === 0;
  const kept: string[] = [];
  if (match) {
    for (const f of result.fields) {
      const field = (
        await d.query(
          "select * from competency_field_values where competency_id=$1 and field_key=$2 for update",
          [info.competency_id, f.key],
        )
      ).rows[0];
      if (!field) continue;
      const protect = preserveValue(field, job.field_snapshot[f.key]);
      if (protect) kept.push(f.key);
      await d.query(
        `update competency_field_values set extracted_value=$3,suggested_document_version_id=$4,suggested_evidence=$5,suggested_page=$6,has_suggestion=$7,
    confirmed_value=case when $7 then confirmed_value else $3::numeric end,
    source_type=case when $7 then source_type else $8 end,
    source_document_version_id=case when $7 then source_document_version_id else $4::uuid end,
    evidence=case when $7 then evidence else $5 end,
    is_manual_override=case when $7 then is_manual_override else false end,
    confirmed_at=case when $7 then confirmed_at else null end,confirmed_by=case when $7 then confirmed_by else null end,updated_at=now()
    where id=$1 and competency_id=$2`,
        [
          field.id,
          info.competency_id,
          f.value,
          job.document_version_id,
          f.evidence,
          f.page,
          protect,
          info.document_type,
        ],
      );
    }
    for (const cfop of result.cfops.filter((x: any) => x.value !== null))
      await d.query(
        "insert into competency_cfop_values(competency_id,document_version_id,cfop,accounting_value,evidence) values($1,$2,$3,$4,$5) on conflict(competency_id,document_version_id,cfop) do update set accounting_value=excluded.accounting_value,evidence=excluded.evidence",
        [
          info.competency_id,
          job.document_version_id,
          cfop.cfop,
          cfop.value,
          cfop.evidence,
        ],
      );
  }
  if (kept.length)
    result.warnings.push(
      `${kept.length} valores já conferidos/alterados foram preservados. Na Conferência, escolha manter o valor ou aceitar a sugestão.`,
    );
  await d.query(
    "update competency_document_versions set raw_extracted_data=$2,processing_status='dados_extraidos',processing_finished_at=now(),processing_error=null,parser_version='3',ai_model=$3 where id=$1",
    [job.document_version_id, result, result.reader || "local"],
  );
  await d.query(
    "update competency_documents set status=$2,identity_override=false,reviewed_at=null,reviewed_by=null,review_reason=null,updated_at=now() where id=$1",
    [job.document_id, match ? "aguardando_conferencia" : "divergencia"],
  );
  await touch(
    d,
    info.competency_id,
    match ? "aguardando_conferencia" : "divergencia",
  );
  await d.query(
    "update document_jobs set status='done',progress=100,message=$2,result=$3,finished_at=now(),locked_until=null where id=$1",
    [
      job.id,
      match
        ? "Leitura concluída; confira os valores"
        : "Divergência: confira CNPJ, competência e tipo",
      { validation_issues: result.validation_issues, preserved_fields: kept },
    ],
  );
}
let working = false;
async function tick() {
  if (working || !admin) return;
  working = true;
  let job: any;
  try {
    job = await claimJob(pool);
    if (!job) return;
    const heartbeat = setInterval(() => {
      pool
        .query(
          "update document_jobs set locked_until=now()+interval '2 minutes' where id=$1 and claim_token=$2 and status='running'",
          [job.id, job.claim_token],
        )
        .catch(() => {});
    }, 20000);
    heartbeat.unref();
    try {
      const info = (
        await pool.query(
          "select v.storage_path,c.tax_regime from competency_document_versions v join competency_documents d on d.id=v.competency_document_id join competencies c on c.id=d.competency_id where v.id=$1",
          [job.document_version_id],
        )
      ).rows[0];
      const actor = (
        await pool.query("select is_active from profiles where id=$1", [
          job.requested_by,
        ])
      ).rows[0];
      if (!actor?.is_active)
        throw new HttpError(
          403,
          "Usuário solicitante inativo. Solicite nova leitura com usuário ativo.",
        );
      const doc = (
        await pool.query(
          "select document_type from competency_documents where id=$1",
          [job.document_id],
        )
      ).rows[0];
      const downloaded = await admin!.storage
        .from("fiscal-documents")
        .download(info.storage_path);
      if (downloaded.error)
        throw new HttpError(
          502,
          "Não foi possível baixar o PDF armazenado. Tente novamente.",
        );
      const result = await extract(
        Buffer.from(await downloaded.data.arrayBuffer()),
        doc.document_type,
        info.tax_regime,
      );
      await tx(job.requested_by, (d) => applyResult(d, job, result));
    } finally {
      clearInterval(heartbeat);
    }
  } catch (e: any) {
    if (job)
      await pool
        .query(
          "update document_jobs set status='error',message=$3,finished_at=now(),locked_until=null where id=$1 and claim_token=$2 and status='running'",
          [
            job.id,
            job.claim_token,
            e instanceof HttpError
              ? e.message
              : "Falha na leitura. Reprocesse o PDF; se persistir, confira o arquivo.",
          ],
        )
        .catch(() => {});
    // No credentials/document contents in logs. Missing migration is shown in diagnostics.
  } finally {
    working = false;
  }
}
export function startWorker() {
  const timer = setInterval(() => void tick(), 2000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
