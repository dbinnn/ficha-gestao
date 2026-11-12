-- Atualização aditiva v0.3: exclusões recuperáveis, sugestões e fila durável.
alter table companies add column deleted_at timestamptz, add column deleted_by uuid references profiles(id), add column delete_reason text;
alter table competencies add column deleted_at timestamptz, add column deleted_by uuid references profiles(id), add column delete_reason text;
alter table companies drop constraint companies_cnpj_key, drop constraint companies_internal_code_key;
create unique index companies_live_cnpj on companies(cnpj) where deleted_at is null;
create unique index companies_live_code on companies(internal_code) where deleted_at is null;
alter table competencies drop constraint competencies_company_id_year_month_key;
create unique index competencies_live_period on competencies(company_id,year,month) where deleted_at is null;
alter table competency_field_values add column suggested_document_version_id uuid references competency_document_versions(id), add column suggested_evidence text, add column suggested_page int, add column has_suggestion boolean not null default false;
alter table competency_documents add column reviewed_by uuid references profiles(id), add column reviewed_at timestamptz, add column review_reason text, add column identity_override boolean not null default false;
create table document_jobs(
 id uuid primary key default gen_random_uuid(), document_id uuid not null references competency_documents(id),
 document_version_id uuid not null references competency_document_versions(id), competency_id uuid not null references competencies(id),
 requested_by uuid not null references profiles(id), status text not null default 'queued' check(status in ('queued','running','done','error','cancelled')),
 attempts int not null default 0, progress int not null default 0, message text, result jsonb,
 created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz, locked_until timestamptz,
 claim_token uuid, field_snapshot jsonb not null default '{}'::jsonb
);
create unique index jobs_one_active_version on document_jobs(document_version_id) where status in ('queued','running');
create index jobs_queue on document_jobs(status,created_at);
alter table document_jobs enable row level security;
revoke all on document_jobs from anon,authenticated;
-- Results are delivered through authenticated API; no browser writes.
create or replace function fiscal_visible_competency(cid uuid) returns boolean language sql stable security definer set search_path=public as $$
 select active_fiscal_user() and exists(select 1 from competencies c join companies co on co.id=c.company_id where c.id=cid and c.deleted_at is null and co.deleted_at is null)
$$;
drop policy authenticated_read on companies;
create policy authenticated_read on companies for select to authenticated using (active_fiscal_user() and deleted_at is null);
drop policy authenticated_read on competencies;
create policy authenticated_read on competencies for select to authenticated using (fiscal_visible_competency(id));
do $$declare t text;begin foreach t in array array['competency_documents','competency_field_values','competency_cfop_values'] loop
 execute format('drop policy authenticated_read on %I',t);
 execute format('create policy authenticated_read on %I for select to authenticated using (fiscal_visible_competency(competency_id))',t);
end loop;end$$;
drop policy authenticated_read on competency_document_versions;
create policy authenticated_read on competency_document_versions for select to authenticated using (exists(select 1 from competency_documents d where d.id=competency_document_id and fiscal_visible_competency(d.competency_id)));
drop view vw_monthly_ficha_gestao;
create view vw_monthly_ficha_gestao with (security_invoker=true) as
 select c.*,coalesce((select jsonb_object_agg(f.field_key,f.confirmed_value) from competency_field_values f where f.competency_id=c.id),'{}'::jsonb) as values
 from competencies c where c.deleted_at is null and exists(select 1 from companies co where co.id=c.company_id and co.deleted_at is null);
grant select on vw_monthly_ficha_gestao to authenticated;
-- Guard in addition to the existing immutable audit and closed-period guard.
create function guard_workflow() returns trigger language plpgsql as $$
declare actor uuid; role fiscal_role; cid uuid; dead boolean; st competency_status;
begin
 actor:=nullif(current_setting('app.actor',true),'')::uuid;
 select p.role into role from profiles p where p.id=actor and p.is_active;
 if TG_TABLE_NAME in ('companies','competencies') then
  if TG_OP='UPDATE' and OLD.deleted_at is distinct from NEW.deleted_at then
   if role is null or (TG_TABLE_NAME='companies' and role<>'administrador') or (TG_TABLE_NAME='competencies' and role not in ('administrador','supervisor')) then raise exception 'Exclusão/restauração exige permissão elevada';end if;
   if length(trim(coalesce(current_setting('app.reason',true),'')))<3 then raise exception 'Informe motivo da exclusão/restauração';end if;
   if TG_TABLE_NAME='competencies' and to_jsonb(OLD)->>'status'='fechada' then raise exception 'Reabra a competência antes de excluir';end if;
  elsif TG_OP='UPDATE' and OLD.deleted_at is not null then raise exception 'Restaure o registro antes de editar';
  end if;
  if TG_TABLE_NAME='competencies' then
   if exists(select 1 from companies where id=NEW.company_id and deleted_at is not null) then raise exception 'Empresa excluída';end if;
  end if;
 else
  if TG_TABLE_NAME='competency_document_versions' then select competency_id into cid from competency_documents where id=NEW.competency_document_id;
  else cid:=NEW.competency_id;end if;
  if not exists(select 1 from competencies c join companies co on co.id=c.company_id where c.id=cid and c.deleted_at is null and co.deleted_at is null) then raise exception 'Competência excluída';end if;
  if TG_TABLE_NAME='competency_field_values' then
   if NEW.suggested_document_version_id is not null and not exists(select 1 from competency_document_versions v join competency_documents d on d.id=v.competency_document_id where v.id=NEW.suggested_document_version_id and d.competency_id=NEW.competency_id) then raise exception 'Sugestão de outra competência';end if;
  end if;
  if TG_TABLE_NAME='competency_documents' and TG_OP='UPDATE' and to_jsonb(NEW)->>'status'='conferido' and to_jsonb(OLD)->>'status'='divergencia' and (role is null or role not in ('administrador','supervisor')) then raise exception 'Divergência exige supervisor';end if;
 end if;
 return NEW;
end$$;
do $$declare t text;begin foreach t in array array['companies','competencies','competency_documents','competency_document_versions','competency_field_values','competency_cfop_values'] loop
 execute format('create trigger workflow_guard before insert or update on %I for each row execute function guard_workflow()',t);
end loop;end$$;
