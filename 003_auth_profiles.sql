-- Novos cadastros externos não recebem acesso ao escritório automaticamente.
create function create_fiscal_profile() returns trigger language plpgsql security definer set search_path=public as $$
begin
 insert into profiles(id,email,full_name,role,is_active) values(NEW.id,NEW.email,coalesce(nullif(NEW.raw_user_meta_data->>'full_name',''),NEW.email),'colaborador',false);
 return NEW;
end $$;
create trigger auth_fiscal_profile after insert on auth.users for each row execute function create_fiscal_profile();
