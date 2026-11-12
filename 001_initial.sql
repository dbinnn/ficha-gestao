-- Instalação NOVA. Não executar sobre um sistema existente sem mapeamento prévio.
create type fiscal_role as enum ('administrador','supervisor','colaborador');
create type tax_regime as enum ('lucro_real','lucro_presumido','simples_nacional','outros');
create type competency_status as enum ('aguardando_documentos','em_preenchimento','processando','aguardando_conferencia','conferida','fechada','divergencia');
create type document_type as enum ('icms','ipi','pis_cofins','cpp');
create type document_status as enum ('pendente','enviado','processando','dados_extraidos','aguardando_conferencia','conferido','divergencia','nao_se_aplica');
create table profiles(id uuid primary key references auth.users(id) on delete restrict,email text unique not null,full_name text not null,role fiscal_role not null default 'colaborador',is_active boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table companies(id uuid primary key default gen_random_uuid(),internal_code text unique not null,legal_name text not null,trade_name text,cnpj varchar(14) unique not null check(cnpj ~ '^\d{14}$'),default_tax_regime tax_regime not null,has_ipi boolean not null default false,responsible_user_id uuid references profiles(id),supervisor_user_id uuid references profiles(id),margin_reference numeric(10,4),tax_load_reference numeric(10,4),is_active boolean not null default true,version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table competencies(id uuid primary key default gen_random_uuid(),company_id uuid not null references companies(id) on delete restrict,year smallint not null check(year between 2000 and 2200),month smallint not null check(month between 1 and 12),tax_regime tax_regime not null,ipi_applicable boolean not null,responsible_user_id uuid references profiles(id),supervisor_user_id uuid references profiles(id),status competency_status not null default 'aguardando_documentos',version integer not null default 1,confirmed_by uuid references profiles(id),confirmed_at timestamptz,closed_by uuid references profiles(id),closed_at timestamptz,reopened_by uuid references profiles(id),reopened_at timestamptz,reopen_reason text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(company_id,year,month));
create table competency_documents(id uuid primary key default gen_random_uuid(),competency_id uuid not null references competencies(id) on delete restrict,document_type document_type not null,status document_status not null default 'pendente',current_version_id uuid,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(competency_id,document_type));
create table competency_document_versions(id uuid primary key default gen_random_uuid(),competency_document_id uuid not null references competency_documents(id) on delete restrict,version_number integer not null,original_filename text not null,storage_path text unique not null,mime_type text not null default 'application/pdf',file_size bigint not null,file_hash text not null,uploaded_by uuid not null references profiles(id),uploaded_at timestamptz not null default now(),processing_status text not null default 'enviado',processing_started_at timestamptz,processing_finished_at timestamptz,processing_error text,raw_extracted_data jsonb,parser_version text,ai_model text,unique(competency_document_id,version_number),unique(id,competency_document_id));
alter table competency_documents add constraint current_version_belongs_to_document foreign key(current_version_id,id) references competency_document_versions(id,competency_document_id) deferrable initially deferred;
create table competency_field_values(id uuid primary key default gen_random_uuid(),competency_id uuid not null references competencies(id) on delete restrict,field_key text not null check(field_key in ('vendas_mercadorias','vendas_servicos','debito_icms','debito_ipi','debito_pis','debito_cofins','debito_iss','compras','despesas','icms','ipi','pis','cofins','iss','irpj','csll','cpp','credito_icms','credito_ipi','credito_pis','credito_cofins')),extracted_value numeric(18,2),confirmed_value numeric(18,2),source_type text not null,source_document_version_id uuid references competency_document_versions(id),is_manual_override boolean not null default false,notes text,evidence text,confirmed_by uuid references profiles(id),confirmed_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(competency_id,field_key),check(field_key not like 'credito_%' or confirmed_value >= 0),check(field_key not like 'credito_%' or extracted_value >= 0));
create table fiscal_cfop_rules(cfop varchar(4) primary key,rule_type text not null check(rule_type in ('icms_purchase','icms_sale')),is_active boolean not null default true);
insert into fiscal_cfop_rules values ('1101','icms_purchase',true),('1102','icms_purchase',true),('1403','icms_purchase',true),('2101','icms_purchase',true),('2102','icms_purchase',true),('2403','icms_purchase',true),('5101','icms_sale',true),('5102','icms_sale',true),('5405','icms_sale',true),('6101','icms_sale',true),('6102','icms_sale',true),('6405','icms_sale',true);
create table competency_cfop_values(id uuid primary key default gen_random_uuid(),competency_id uuid not null references competencies(id),document_version_id uuid not null references competency_document_versions(id),cfop varchar(4) not null,accounting_value numeric(18,2) not null,evidence text not null,unique(competency_id,document_version_id,cfop));
create table audit_logs(id uuid primary key default gen_random_uuid(),user_id uuid references profiles(id),company_id uuid references companies(id),competency_id uuid references competencies(id),entity_type text not null,entity_id uuid,action text not null,old_value jsonb,new_value jsonb,reason text,created_at timestamptz not null default now());
create index competencies_period on competencies(year,month);
create index competencies_status on competencies(status);
create index documents_status on competency_documents(status);
create index versions_document on competency_document_versions(competency_document_id);
create index fields_key on competency_field_values(field_key);
create index audit_competency on audit_logs(competency_id,created_at);
create index audit_company on audit_logs(company_id,created_at);
create index cfop_competency on competency_cfop_values(competency_id,cfop);
create function active_fiscal_user() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from profiles where id=auth.uid() and is_active) $$;
-- Nenhuma escrita direta de clientes. Servidor usa transações autenticadas e regras de domínio.
do $$ declare t text; begin foreach t in array array['profiles','companies','competencies','competency_documents','competency_document_versions','competency_field_values','fiscal_cfop_rules','competency_cfop_values','audit_logs'] loop execute format('alter table %I enable row level security',t);execute format('revoke all on %I from anon, authenticated',t);execute format('grant select on %I to authenticated',t);execute format('create policy authenticated_read on %I for select to authenticated using (active_fiscal_user())',t);end loop;end $$;
create function protect_and_audit() returns trigger language plpgsql as $$
declare rowdata jsonb; beforedata jsonb; cid uuid; comp uuid; actor uuid; st competency_status;
begin
 actor:=nullif(current_setting('app.actor',true),'')::uuid;
 if actor is null or not exists(select 1 from profiles where id=actor and is_active) then raise exception 'Operação exige usuário ativo';end if;
 if TG_OP='DELETE' then raise exception 'Exclusão de histórico não permitida';end if;
 rowdata:=to_jsonb(NEW);beforedata:=case when TG_OP='UPDATE' then to_jsonb(OLD) else null end;
 if TG_TABLE_NAME='companies' then comp:=NEW.id;
 elsif TG_TABLE_NAME='competencies' then cid:=NEW.id;comp:=NEW.company_id;
 elsif TG_TABLE_NAME='competency_document_versions' then select competency_id into cid from competency_documents where id=NEW.competency_document_id;
 else cid:=(rowdata->>'competency_id')::uuid;end if;
 if cid is not null and TG_TABLE_NAME<>'competencies' then
 select status,company_id into st,comp from competencies where id=cid for update;
 if st='fechada' then raise exception 'Reabra a competência antes de editar';end if;
 end if;
 if TG_TABLE_NAME='competencies' and TG_OP='UPDATE' and beforedata->>'status'='fechada' then
 if rowdata->>'status'<>'em_preenchimento' or nullif(trim(rowdata->>'reopen_reason'),'') is null or not exists(select 1 from profiles where id=actor and role in ('administrador','supervisor')) then raise exception 'Reabertura exige supervisor e motivo';end if;
 end if;
 if TG_TABLE_NAME='competency_field_values' and rowdata->>'source_document_version_id' is not null and not exists(select 1 from competency_document_versions v join competency_documents d on d.id=v.competency_document_id where v.id=(rowdata->>'source_document_version_id')::uuid and d.competency_id=(rowdata->>'competency_id')::uuid) then raise exception 'Documento de outra competência';end if;
 insert into audit_logs(user_id,company_id,competency_id,entity_type,entity_id,action,old_value,new_value,reason) values(actor,comp,cid,TG_TABLE_NAME,(rowdata->>'id')::uuid,TG_OP,beforedata,rowdata,nullif(current_setting('app.reason',true),''));
 return NEW;
end $$;
do $$ declare t text; begin foreach t in array array['companies','competencies','competency_documents','competency_document_versions','competency_field_values','competency_cfop_values'] loop execute format('create trigger audit_guard after insert or update or delete on %I for each row execute function protect_and_audit()',t);end loop;end $$;
create function immutable_audit() returns trigger language plpgsql as $$begin raise exception 'Auditoria imutável';end$$;
create trigger audit_immutable before update or delete on audit_logs for each row execute function immutable_audit();
create view vw_monthly_ficha_gestao with (security_invoker=true) as select c.*, coalesce((select jsonb_object_agg(f.field_key,f.confirmed_value) from competency_field_values f where f.competency_id=c.id),'{}'::jsonb) as values from competencies c;
grant select on vw_monthly_ficha_gestao to authenticated;
