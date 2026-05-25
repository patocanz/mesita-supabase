-- 0023_rename_guest_to_consumer.sql
--
-- Rename "guest" → "consumer" everywhere in the schema. The product
-- vocabulary changed; "consumer" is the canonical word now. Edge
-- Functions, web app code, and Notion all get the parallel rename in
-- the same session.
--
-- Tables, columns, constraints, indexes, RLS policies, and helper
-- functions are all renamed atomically. admin_reset_database() and
-- generate_guest_code() are rewritten because their bodies reference
-- the old table by name (so a pure rename wouldn't suffice).

-- 1. Tables
ALTER TABLE public.guests RENAME TO consumers;

-- 2. Columns
ALTER TABLE public.tickets RENAME COLUMN guest_id TO consumer_id;
ALTER TABLE public.cashback_ledger RENAME COLUMN guest_id TO consumer_id;

-- 3. Constraints
ALTER TABLE public.consumers RENAME CONSTRAINT guests_pkey TO consumers_pkey;
ALTER TABLE public.consumers RENAME CONSTRAINT guests_sex_check TO consumers_sex_check;
ALTER TABLE public.consumers RENAME CONSTRAINT guests_id_fkey TO consumers_id_fkey;
ALTER TABLE public.consumers RENAME CONSTRAINT guests_code_key TO consumers_code_key;
ALTER TABLE public.tickets RENAME CONSTRAINT tickets_guest_id_fkey TO tickets_consumer_id_fkey;
ALTER TABLE public.cashback_ledger RENAME CONSTRAINT cashback_ledger_guest_id_fkey TO cashback_ledger_consumer_id_fkey;

-- 4. Indexes (PK + code_key auto-rename via constraint rename; rename the standalone idx)
ALTER INDEX public.cashback_ledger_guest_idx RENAME TO cashback_ledger_consumer_idx;
ALTER INDEX public.tickets_guest_idx RENAME TO tickets_consumer_idx;

-- 5. RLS policies
ALTER POLICY guests_update_self ON public.consumers RENAME TO consumers_update_self;
ALTER POLICY guests_select_self ON public.consumers RENAME TO consumers_select_self;
ALTER POLICY tickets_select_own_guest ON public.tickets RENAME TO tickets_select_own_consumer;

-- 6. Helper function: generate_guest_code() → generate_consumer_code()
CREATE OR REPLACE FUNCTION public.generate_consumer_code()
  RETURNS text
  LANGUAGE plpgsql
  SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  attempts integer := 0;
begin
  loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    if not exists (select 1 from public.consumers where code = candidate) then
      return candidate;
    end if;
    attempts := attempts + 1;
    if attempts > 16 then
      raise exception 'could not generate unique consumer code';
    end if;
  end loop;
end;
$function$;

DROP FUNCTION IF EXISTS public.generate_guest_code();

-- 7. admin_reset_database(): update the truncate list to reference the
--    renamed `consumers` table so the super-admin reset keeps rebuilding
--    a clean working env (per the project rule on architectural changes).
CREATE OR REPLACE FUNCTION public.admin_reset_database()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public', 'auth', 'storage'
AS $function$
declare
  deleted_users     bigint;
  deleted_atlas     bigint;
begin
  truncate table
    public.cashback_ledger,
    public.tickets,
    public.venue_verifications,
    public.manager_invites,
    public.staff_invites,
    public.venue_roles,
    public.venue_members,
    public.venues,
    public.consumers,
    public.managers
  restart identity cascade;

  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (
       select lower(email) from public.super_admins
     );
  get diagnostics deleted_users = row_count;

  delete from storage.objects where bucket_id = 'atlas';
  get diagnostics deleted_atlas = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'deleted_atlas_objects', deleted_atlas,
    'reset_at', now()
  );
end;
$function$;
