insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('fiscal-documents','fiscal-documents',false,20971520,array['application/pdf']) on conflict(id) do nothing;
-- Objetos acessíveis somente pelo servidor, que valida usuário ativo e emite URL curta.
-- Não adicionar políticas públicas ao bucket.
do $$ declare t text; begin foreach t in array array['companies','competencies','competency_documents','competency_field_values'] loop if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename=t and schemaname='public') then execute format('alter publication supabase_realtime add table public.%I',t);end if;end loop;end $$;
