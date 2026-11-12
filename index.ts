import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pool, admin, configured, tx, lock, touch, HttpError } from "./db.js";
import { fields, groups, pending, cnpjValid } from "../shared/domain.js";
import { upgradeRoutes } from "./upgrade-routes.js";
import { enqueue, startWorker } from "./jobs.js";
import { identityIssues } from "../shared/workflow.js";
import { annualPdf } from "./pdf.js";
export const app = express();
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "connect-src": [
          "'self'",
          "https://*.supabase.co",
          "wss://*.supabase.co",
        ],
        "script-src": ["'self'"],
        "frame-src": ["'self'", "blob:"],
        "object-src": ["'self'", "blob:"],
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 180,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.get("/api/health", (_q, r) =>
  r.json({ status: configured ? "configured" : "setup_required" }),
);
app.use("/api", async (req, res, next) => {
  try {
    if (!configured)
      throw new HttpError(
        503,
        "Configure o arquivo .env e execute as migrations antes de entrar.",
      );
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) throw new HttpError(401, "Entre novamente.");
    const { data, error } = await admin!.auth.getUser(token);
    if (error || !data.user)
      throw new HttpError(401, "Sessão expirada. Entre novamente.");
    const p = await pool.query(
      "select * from profiles where id=$1 and is_active",
      [data.user.id],
    );
    if (!p.rowCount)
      throw new HttpError(403, "Acesso ainda não liberado pelo administrador.");
    res.locals.user = p.rows[0];
    next();
  } catch (e) {
    next(e);
  }
});
const id = z.string().uuid();
const ver = z.coerce.number().int().positive();
const elevated = (u: any) => {
  if (!["administrador", "supervisor"].includes(u.role))
    throw new HttpError(403, "Esta ação exige supervisor ou administrador.");
};
const isAdmin = (u: any) => {
  if (u.role !== "administrador")
    throw new HttpError(403, "Ação exclusiva do administrador.");
};
app.get("/api/me", (_q, r) => r.json(r.locals.user));
app.get("/api/profiles", async (_q, r) =>
  r.json(
    (
      await pool.query(
        "select id,email,full_name,role,is_active from profiles order by full_name",
      )
    ).rows,
  ),
);
const companySchema = z.object({
  internal_code: z.string().trim().min(1).max(40),
  legal_name: z.string().trim().min(2).max(200),
  trade_name: z.string().max(200).default(""),
  cnpj: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .refine(cnpjValid, "CNPJ inválido"),
  default_tax_regime: z.enum([
    "lucro_real",
    "lucro_presumido",
    "simples_nacional",
    "outros",
  ]),
  has_ipi: z.boolean(),
  responsible_user_id: id.nullable(),
  supervisor_user_id: id.nullable(),
  margin_reference: z.preprocess(
    (v) => (v === "" ? null : v),
    z.coerce.number().finite().nullable(),
  ),
  tax_load_reference: z.preprocess(
    (v) => (v === "" ? null : v),
    z.coerce.number().finite().nullable(),
  ),
  is_active: z.boolean(),
});
app.get("/api/companies", async (_q, r) =>
  r.json(
    (
      await pool.query(
        "select * from companies where deleted_at is null order by internal_code",
      )
    ).rows,
  ),
);
app.post("/api/companies", async (q, r) => {
  isAdmin(r.locals.user);
  const b = companySchema.parse(q.body),
    keys = Object.keys(b);
  const result = await tx(
    r.locals.user.id,
    async (d) =>
      (
        await d.query(
          `insert into companies(${keys.join(",")}) values(${keys.map((_, i) => "$" + (i + 1)).join(",")}) returning *`,
          Object.values(b),
        )
      ).rows[0],
  );
  r.json(result);
});
app.put("/api/companies/:id", async (q, r) => {
  isAdmin(r.locals.user);
  const b = companySchema.parse(q.body),
    keys = Object.keys(b);
  const result = await tx(r.locals.user.id, async (d) => {
    const v = await d.query(
      `update companies set ${keys.map((k, i) => k + "=$" + (i + 1)).join(",")},version=version+1,updated_at=now() where id=$${keys.length + 1} and version=$${keys.length + 2} and deleted_at is null returning *`,
      [...Object.values(b), id.parse(q.params.id), ver.parse(q.body.version)],
    );
    if (!v.rowCount)
      throw new HttpError(
        409,
        "Cadastro alterado por outra pessoa. Recarregue.",
      );
    return v.rows[0];
  });
  r.json(result);
});
app.get("/api/competencies", async (q, r) => {
  const year = z.coerce.number().int().min(2000).max(2200).parse(q.query.year);
  const rows = (
    await pool.query(
      `select c.*,co.legal_name,co.cnpj,co.internal_code,co.is_active,p.full_name responsible_name,s.full_name supervisor_name,
 (select count(*)::int from competency_documents d where d.competency_id=c.id and d.status in ('dados_extraidos','aguardando_conferencia','conferido')) processed_documents,
 (select coalesce(jsonb_agg(d),'[]') from competency_documents d where d.competency_id=c.id) docs,
 (select coalesce(jsonb_agg(jsonb_build_object('field_key',f.field_key,'confirmed_value',f.confirmed_value,'confirmed_at',f.confirmed_at,'has_suggestion',f.has_suggestion)),'[]') from competency_field_values f where f.competency_id=c.id) vals
 from competencies c join companies co on co.id=c.company_id left join profiles p on p.id=c.responsible_user_id left join profiles s on s.id=c.supervisor_user_id
 where c.year=$1 and c.deleted_at is null and co.deleted_at is null order by c.month desc,co.internal_code`,
      [year],
    )
  ).rows;
  r.json(
    rows.map(({ docs, vals, ...c }) => ({
      ...c,
      pending: pending(c, docs, vals),
    })),
  );
});
app.post("/api/competencies", async (q, r) => {
  const b = z
    .object({
      company_id: id,
      year: z.number().int().min(2000).max(2200),
      month: z.number().int().min(1).max(12),
    })
    .parse(q.body);
  r.json(
    await tx(r.locals.user.id, async (d) => {
      const co = (
        await d.query(
          "select * from companies where id=$1 and is_active and deleted_at is null for update",
          [b.company_id],
        )
      ).rows[0];
      if (!co) throw new HttpError(404, "Empresa ativa não encontrada.");
      const c = (
        await d.query(
          "insert into competencies(company_id,year,month,tax_regime,ipi_applicable,responsible_user_id,supervisor_user_id) values($1,$2,$3,$4,$5,$6,$7) returning *",
          [
            co.id,
            b.year,
            b.month,
            co.default_tax_regime,
            co.has_ipi,
            co.responsible_user_id,
            co.supervisor_user_id,
          ],
        )
      ).rows[0];
      for (const type of ["icms", "ipi", "pis_cofins", "cpp"])
        await d.query(
          "insert into competency_documents(competency_id,document_type,status) values($1,$2,$3)",
          [
            c.id,
            type,
            type === "ipi" && !co.has_ipi ? "nao_se_aplica" : "pendente",
          ],
        );
      for (const key of fields)
        await d.query(
          "insert into competency_field_values(competency_id,field_key,source_type,confirmed_value,confirmed_by,confirmed_at) values($1,$2,$3,$4,$5,$6)",
          [
            c.id,
            key,
            !co.has_ipi && groups.ipi.includes(key) ? "system" : "manual",
            !co.has_ipi && groups.ipi.includes(key) ? "0" : null,
            !co.has_ipi && groups.ipi.includes(key) ? r.locals.user.id : null,
            !co.has_ipi && groups.ipi.includes(key) ? new Date() : null,
          ],
        );
      return c;
    }),
  );
});
app.get("/api/competencies/:id", async (q, r) => {
  const cid = id.parse(q.params.id);
  const c = (
    await pool.query(
      "select c.*,co.legal_name,co.cnpj from competencies c join companies co on co.id=c.company_id where c.id=$1 and c.deleted_at is null and co.deleted_at is null",
      [cid],
    )
  ).rows[0];
  if (!c) throw new HttpError(404, "Competência não encontrada.");
  const docs = (
    await pool.query(
      "select d.*,v.original_filename,v.processing_error,v.raw_extracted_data,(select jsonb_build_object('status',j.status,'message',j.message,'progress',j.progress) from document_jobs j where j.document_id=d.id order by j.created_at desc limit 1) job from competency_documents d left join competency_document_versions v on v.id=d.current_version_id where d.competency_id=$1 order by d.document_type",
      [cid],
    )
  ).rows;
  const values = (
    await pool.query(
      "select * from competency_field_values where competency_id=$1 order by field_key",
      [cid],
    )
  ).rows;
  const history = (
    await pool.query(
      "select a.*,p.full_name actor from audit_logs a left join profiles p on p.id=a.user_id where a.competency_id=$1 order by a.created_at desc limit 500",
      [cid],
    )
  ).rows;
  const versions = (
    await pool.query(
      "select v.id,v.competency_document_id,v.version_number,v.original_filename,v.uploaded_at,v.processing_status from competency_document_versions v join competency_documents d on d.id=v.competency_document_id where d.competency_id=$1 order by v.uploaded_at desc",
      [cid],
    )
  ).rows;
  r.json({
    competency: c,
    documents: docs,
    values,
    history,
    versions,
    pending: pending(c, docs, values),
  });
});
app.put("/api/competencies/:id/values", async (q, r) => {
  const b = z
    .object({
      version: ver,
      values: z
        .array(
          z.object({
            key: z.enum(fields),
            value: z
              .string()
              .regex(/^-?\d{1,14}(\.\d{1,2})?$/)
              .nullable(),
            notes: z.string().max(2000).default(""),
          }),
        )
        .max(21),
    })
    .parse(q.body);
  await tx(r.locals.user.id, async (d) => {
    const c = await lock(d, id.parse(q.params.id), b.version);
    for (const f of b.values) {
      if (!c.ipi_applicable && groups.ipi.includes(f.key)) continue;
      if (f.key.startsWith("credito_") && Number(f.value) < 0)
        throw new HttpError(422, "Créditos devem ser positivos.");
      await d.query(
        "update competency_field_values set confirmed_value=$3,is_manual_override=extracted_value is distinct from $3::numeric,confirmed_by=$4,confirmed_at=case when $3::numeric is null then null else now() end,notes=$5,updated_at=now() where competency_id=$1 and field_key=$2",
        [c.id, f.key, f.value, r.locals.user.id, f.notes],
      );
    }
    await touch(d, c.id, "aguardando_conferencia");
  });
  r.json({ ok: true });
});
app.post("/api/competencies/:id/ipi", async (q, r) => {
  const b = z
    .object({
      version: ver,
      applicable: z.boolean(),
      reason: z.string().trim().min(3),
    })
    .parse(q.body);
  await tx(
    r.locals.user.id,
    async (d) => {
      const c = await lock(d, id.parse(q.params.id), b.version);
      await d.query("update competencies set ipi_applicable=$2 where id=$1", [
        c.id,
        b.applicable,
      ]);
      await d.query(
        "update competency_documents set status=$2,updated_at=now() where competency_id=$1 and document_type='ipi'",
        [c.id, b.applicable ? "pendente" : "nao_se_aplica"],
      );
      for (const k of groups.ipi)
        await d.query(
          "update competency_field_values set confirmed_value=$3,confirmed_by=$4,confirmed_at=$5,source_type=$6,updated_at=now() where competency_id=$1 and field_key=$2",
          [
            c.id,
            k,
            b.applicable ? null : 0,
            b.applicable ? null : r.locals.user.id,
            b.applicable ? null : new Date(),
            b.applicable ? "manual" : "system",
          ],
        );
      await touch(d, c.id);
    },
    b.reason,
  );
  r.json({ ok: true });
});
app.post("/api/competencies/:id/transition", async (q, r) => {
  elevated(r.locals.user);
  const b = z
    .object({
      version: ver,
      action: z.enum(["confirm", "close", "reopen"]),
      reason: z.string().default(""),
    })
    .parse(q.body);
  await tx(
    r.locals.user.id,
    async (d) => {
      const c = await lock(
        d,
        id.parse(q.params.id),
        b.version,
        b.action === "reopen",
      );
      if (b.action === "reopen") {
        if (c.status !== "fechada" || b.reason.trim().length < 3)
          throw new HttpError(
            422,
            "Informe um motivo para reabrir uma competência fechada.",
          );
        await d.query(
          "update competencies set status='em_preenchimento',version=version+1,reopened_by=$2,reopened_at=now(),reopen_reason=$3,confirmed_at=null,confirmed_by=null,closed_at=null,closed_by=null,updated_at=now() where id=$1",
          [c.id, r.locals.user.id, b.reason],
        );
        return;
      }
      const docs = (
        await d.query(
          "select * from competency_documents where competency_id=$1",
          [c.id],
        )
      ).rows;
      const vals = (
        await d.query(
          "select * from competency_field_values where competency_id=$1",
          [c.id],
        )
      ).rows;
      const p = pending(c, docs, vals);
      if (p.length) throw new HttpError(422, p.join("; "));
      if (b.action === "close" && c.status !== "conferida")
        throw new HttpError(422, "Confirme a competência antes de fechar.");
      await d.query(
        b.action === "confirm"
          ? "update competencies set status='conferida',confirmed_by=$2,confirmed_at=now(),version=version+1,updated_at=now() where id=$1"
          : "update competencies set status='fechada',closed_by=$2,closed_at=now(),version=version+1,updated_at=now() where id=$1",
        [c.id, r.locals.user.id],
      );
    },
    b.reason,
  );
  r.json({ ok: true });
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});
app.post(
  "/api/competencies/:id/documents/:type",
  upload.single("file"),
  async (q, r) => {
    const cid = id.parse(q.params.id),
      type = z.enum(["icms", "ipi", "pis_cofins", "cpp"]).parse(q.params.type);
    const f = q.file;
    if (!f || f.buffer.subarray(0, 5).toString() !== "%PDF-")
      throw new HttpError(422, "Envie um PDF válido, até 20 MB.");
    const storagePath = cid + "/" + type + "/" + randomUUID() + ".pdf";
    let uploaded = false;
    try {
      await tx(r.locals.user.id, async (d) => {
        const c = await lock(d, cid, ver.parse(q.body.version));
        if (type === "ipi" && !c.ipi_applicable)
          throw new HttpError(
            422,
            "Ative o IPI nesta competência antes de anexar.",
          );
        const doc = (
          await d.query(
            "select * from competency_documents where competency_id=$1 and document_type=$2",
            [cid, type],
          )
        ).rows[0];
        const n = (
          await d.query(
            "select coalesce(max(version_number),0)+1 n from competency_document_versions where competency_document_id=$1",
            [doc.id],
          )
        ).rows[0].n;
        const up = await admin!.storage
          .from("fiscal-documents")
          .upload(storagePath, f.buffer, {
            contentType: "application/pdf",
            upsert: false,
          });
        if (up.error)
          throw new HttpError(502, "Falha ao armazenar PDF. Tente novamente.");
        uploaded = true;
        const v = (
          await d.query(
            "insert into competency_document_versions(competency_document_id,version_number,original_filename,storage_path,file_size,file_hash,uploaded_by) values($1,$2,$3,$4,$5,$6,$7) returning id",
            [
              doc.id,
              n,
              path.basename(f.originalname),
              storagePath,
              f.size,
              createHash("sha256").update(f.buffer).digest("hex"),
              r.locals.user.id,
            ],
          )
        ).rows[0];
        await d.query(
          "update competency_documents set current_version_id=$2,status='enviado',updated_at=now() where id=$1",
          [doc.id, v.id],
        );
        const keys = [
          ...groups[type],
          ...(type === "pis_cofins" && c.tax_regime === "lucro_presumido"
            ? ["irpj", "csll"]
            : []),
        ];
        await d.query(
          "update competency_field_values set extracted_value=null,has_suggestion=false,suggested_document_version_id=null,suggested_evidence=null,suggested_page=null,confirmed_value=case when confirmed_at is not null or is_manual_override then confirmed_value else null end,evidence=case when confirmed_at is not null or is_manual_override then evidence else 'Aguardando leitura do novo PDF' end,updated_at=now() where competency_id=$1 and field_key=any($2)",
          [cid, keys],
        );
        await d.query(
          "update document_jobs set status='cancelled',message='PDF substituído',finished_at=now() where document_id=$1 and status in ('queued','running')",
          [doc.id],
        );
        await touch(d, cid);
        const fresh = (
          await d.query("select version from competencies where id=$1", [cid])
        ).rows[0];
        await enqueue(d, r.locals.user.id, doc.id, fresh.version);
      });
    } catch (e) {
      if (uploaded)
        await admin!.storage.from("fiscal-documents").remove([storagePath]);
      throw e;
    }
    r.json({ ok: true });
  },
);
app.get("/api/documents/:id/url", async (q, r) => {
  const v = (
    await pool.query(
      "select v.storage_path from competency_document_versions v join competency_documents d on d.id=v.competency_document_id join competencies c on c.id=d.competency_id join companies co on co.id=c.company_id where v.id=$1 and c.deleted_at is null and co.deleted_at is null",
      [id.parse(q.params.id)],
    )
  ).rows[0];
  if (!v) throw new HttpError(404, "Documento não encontrado.");
  const { data, error } = await admin!.storage
    .from("fiscal-documents")
    .createSignedUrl(v.storage_path, 60);
  if (error) throw new HttpError(502, "Não foi possível abrir o documento.");
  r.json({ url: data!.signedUrl });
});
app.post("/api/documents/:id/review", async (q, r) => {
  const b = z
    .object({ version: ver, reason: z.string().trim().min(3) })
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
      if (!doc?.current_version_id)
        throw new HttpError(422, "Anexe um documento antes de conferir.");
      const c = await lock(d, doc.competency_id, b.version);
      if (doc.document_type === "ipi" && !c.ipi_applicable)
        throw new HttpError(422, "IPI não se aplica nesta competência.");
      const co = (
        await d.query("select cnpj from companies where id=$1", [c.company_id])
      ).rows[0];
      const issues = doc.raw_extracted_data
        ? identityIssues(doc.raw_extracted_data, {
            ...c,
            cnpj: co.cnpj,
            document_type: doc.document_type,
          })
        : [];
      if (doc.status === "divergencia" || issues.length) {
        elevated(r.locals.user);
        if (b.reason.trim().length < 10)
          throw new HttpError(
            422,
            "A liberação de divergência exige justificativa com ao menos 10 caracteres.",
          );
      }
      const active = (
        await d.query(
          "select 1 from document_jobs where document_id=$1 and status in ('queued','running')",
          [doc.id],
        )
      ).rowCount;
      if (active)
        throw new HttpError(
          409,
          "Aguarde a leitura terminar antes de conferir o documento.",
        );
      await d.query(
        "update competency_documents set status='conferido',identity_override=$2,reviewed_by=$3,reviewed_at=now(),review_reason=$4,updated_at=now() where id=$1",
        [doc.id, issues.length > 0, r.locals.user.id, b.reason],
      );
      await touch(d, doc.competency_id, "aguardando_conferencia");
    },
    b.reason,
  );
  r.json({ ok: true });
});
app.get("/api/reports/:company/:year", async (q, r) => {
  const co = (
    await pool.query(
      "select * from companies where id=$1 and deleted_at is null",
      [id.parse(q.params.company)],
    )
  ).rows[0];
  if (!co) throw new HttpError(404, "Empresa não encontrada.");
  const year = z.coerce.number().int().min(2000).max(2200).parse(q.params.year);
  const rows = (
    await pool.query(
      "select * from vw_monthly_ficha_gestao where company_id=$1 and year=$2 order by month",
      [co.id, year],
    )
  ).rows;
  if (q.query.format === "pdf") {
    const pdf = await annualPdf(co, year, rows);
    r.type("pdf").setHeader(
      "Content-Disposition",
      `attachment; filename="ficha-gestao-${year}.pdf"`,
    );
    r.send(pdf);
  } else r.json({ company: co, year, months: rows });
});
app.post("/api/profiles", async (q, r) => {
  isAdmin(r.locals.user);
  const b = z
    .object({
      email: z.email(),
      full_name: z.string().trim().min(2).max(150),
      password: z.string().min(12).max(128),
      role: z.enum(["administrador", "supervisor", "colaborador"]),
    })
    .parse(q.body);
  const { data, error } = await admin!.auth.admin.createUser({
    email: b.email,
    password: b.password,
    email_confirm: true,
    user_metadata: { full_name: b.full_name },
  });
  if (error || !data.user)
    throw new HttpError(
      422,
      "Não foi possível cadastrar. Verifique se o e-mail já existe e se a senha atende aos requisitos.",
    );
  try {
    await tx(r.locals.user.id, async (d) => {
      const result = await d.query(
        "update profiles set role=$2,is_active=true where id=$1 returning id",
        [data.user!.id, b.role],
      );
      if (!result.rowCount)
        throw new HttpError(
          503,
          "Aplique a migration de perfis antes de cadastrar usuários.",
        );
      await d.query(
        "insert into audit_logs(user_id,entity_type,entity_id,action,new_value) values($1,'profiles',$2,'INSERT',$3)",
        [
          r.locals.user.id,
          data.user!.id,
          {
            email: b.email,
            full_name: b.full_name,
            role: b.role,
            is_active: true,
          },
        ],
      );
    });
  } catch (e) {
    throw new HttpError(
      503,
      "Conta criada no Auth, mas acesso não liberado. Revise o perfil pelo painel Supabase antes de tentar novamente.",
    );
  }
  r.json({ ok: true });
});
app.patch("/api/profiles/:id", async (q, r) => {
  isAdmin(r.locals.user);
  const uid = id.parse(q.params.id),
    b = z
      .object({
        role: z.enum(["administrador", "supervisor", "colaborador"]),
        is_active: z.boolean(),
      })
      .parse(q.body);
  if (uid === r.locals.user.id)
    throw new HttpError(422, "Não altere o próprio acesso por esta tela.");
  await tx(r.locals.user.id, async (d) => {
    const old = (
      await d.query("select * from profiles where id=$1 for update", [uid])
    ).rows[0];
    if (!old) throw new HttpError(404, "Usuário não encontrado.");
    await d.query(
      "update profiles set role=$2,is_active=$3,updated_at=now() where id=$1",
      [uid, b.role, b.is_active],
    );
    await d.query(
      "insert into audit_logs(user_id,entity_type,entity_id,action,old_value,new_value) values($1,'profiles',$2,'UPDATE',$3,$4)",
      [r.locals.user.id, uid, old, b],
    );
  });
  r.json({ ok: true });
});
upgradeRoutes(app);
app.use("/api", (_q, _r, next) =>
  next(new HttpError(404, "Recurso não encontrado.")),
);
app.use(express.static(path.resolve("dist")));
app.get("/{*path}", (_q, r) => r.sendFile(path.resolve("dist/index.html")));
app.use(
  (
    e: any,
    _q: express.Request,
    r: express.Response,
    _n: express.NextFunction,
  ) => {
    const code =
      e instanceof HttpError
        ? e.status
        : e instanceof z.ZodError
          ? 422
          : e.code === "23505"
            ? 409
            : e.code === "LIMIT_FILE_SIZE"
              ? 413
              : 500;
    const message =
      e instanceof HttpError
        ? e.message
        : e instanceof z.ZodError
          ? "Dados inválidos: " +
            e.issues.map((x) => x.path.join(".") + ": " + x.message).join("; ")
          : e.code === "23505"
            ? "Já existe um cadastro ou competência com estes dados."
            : e.code === "LIMIT_FILE_SIZE"
              ? "O PDF excede o limite de 20 MB."
              : ["42P01", "42703"].includes(e.code)
                ? "Atualize o banco: execute npm run db:migrate na pasta da versão 0.3 e reinicie o sistema."
                : "Não foi possível concluir. Confira a configuração ou tente novamente.";
    if (code === 500) console.error("Falha interna", e.code || e.name);
    r.status(code).json({ error: message });
  },
);
if (process.env.NO_LISTEN !== "true") {
  app.listen(Number(process.env.PORT || 3001), "0.0.0.0", () =>
    console.log(
      "Ficha Gestão disponível na porta " + (process.env.PORT || 3001),
    ),
  );
  if (configured) startWorker();
}
