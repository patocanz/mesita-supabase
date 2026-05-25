-- 0024_rename_manager_to_business.sql
--
-- Rename "manager" → "business" everywhere in the schema. Part of the
-- platform rebrand: manager.mesita.ai → business.mesita.ai, the B2B
-- venue-owner population is now called "business" instead of "manager".
--
-- Edge Functions (manager-* → business-*), web app code, and Notion all
-- get the parallel rename in the same session.
--
-- Tables, columns, constraints, indexes, RLS policies, enum values, and
-- helper functions are all renamed atomically. admin_reset_database() is
-- rewritten because its body references the old table names.
--
-- The platform-level enum public.venue_role carries a 'manager' value
-- that maps to the rebranded B2B role; it's migrated using the standard
-- swap-the-enum-type pattern (create new enum, switch column, drop old).
-- The per-venue tier enum public.member_role keeps its 'manager' value
-- on purpose: 'manager' there is the Editor tier inside a single venue
-- (owner / manager / viewer), distinct from the platform-level role.
-- "Owner / Business / Viewer" would read awkwardly as a permissions
-- hierarchy, so the rebrand only touches the platform role.
--
-- Finally, every auth.users row whose app_metadata.role = 'manager' is
-- updated in place to 'business' so existing sessions continue to work
-- under the new role label.

-- =====================================================================
-- 1. Tables
-- =====================================================================
ALTER TABLE public.managers        RENAME TO businesses;
ALTER TABLE public.manager_invites RENAME TO business_invites;

-- =====================================================================
-- 2. Columns
-- =====================================================================
ALTER TABLE public.venue_members RENAME COLUMN manager_id TO business_id;

-- =====================================================================
-- 3. Constraints (PK / FK / unique)
-- =====================================================================
-- managers_pkey / managers_id_fkey come from 0001_init.sql
ALTER TABLE public.businesses
  RENAME CONSTRAINT managers_pkey TO businesses_pkey;

ALTER TABLE public.businesses
  RENAME CONSTRAINT managers_id_fkey TO businesses_id_fkey;

-- venue_members: the FK pointing to the (renamed) businesses table and
-- the (venue_id, manager_id) unique constraint both carry the old name.
ALTER TABLE public.venue_members
  RENAME CONSTRAINT venue_members_manager_id_fkey TO venue_members_business_id_fkey;

ALTER TABLE public.venue_members
  RENAME CONSTRAINT venue_members_venue_id_manager_id_key TO venue_members_venue_id_business_id_key;

-- manager_invites_pkey / token unique constraint from 0020_team_invites.sql
ALTER TABLE public.business_invites
  RENAME CONSTRAINT manager_invites_pkey TO business_invites_pkey;

ALTER TABLE public.business_invites
  RENAME CONSTRAINT manager_invites_token_key TO business_invites_token_key;

-- =====================================================================
-- 4. Indexes
-- =====================================================================
ALTER INDEX public.venue_members_manager_idx  RENAME TO venue_members_business_idx;
ALTER INDEX public.manager_invites_venue_idx  RENAME TO business_invites_venue_idx;
ALTER INDEX public.manager_invites_token_idx  RENAME TO business_invites_token_idx;
ALTER INDEX public.manager_invites_email_idx  RENAME TO business_invites_email_idx;

-- =====================================================================
-- 5. RLS policy renames (names only — bodies fixed below where they
--    reference the renamed `manager_id` column)
-- =====================================================================
ALTER POLICY managers_select_self ON public.businesses
  RENAME TO businesses_select_self;
ALTER POLICY managers_update_self ON public.businesses
  RENAME TO businesses_update_self;

ALTER POLICY manager_invites_select_creator ON public.business_invites
  RENAME TO business_invites_select_creator;
ALTER POLICY manager_invites_select_by_venue_member ON public.business_invites
  RENAME TO business_invites_select_by_venue_member;

-- The venue_members_select_self policy body references manager_id, which
-- we just renamed. Recreate it with business_id.
DROP POLICY IF EXISTS venue_members_select_self ON public.venue_members;
CREATE POLICY venue_members_select_self
  ON public.venue_members
  FOR SELECT
  TO authenticated
  USING (business_id = auth.uid());

-- The venue_roles + staff_invites + business_invites "by_venue_member"
-- policies join through venue_members.manager_id (now business_id).
-- Postgres rewrites the column reference automatically on rename, so the
-- bodies still work — but recreate them anyway for readability and to
-- make sure any cached plan is invalidated.
DROP POLICY IF EXISTS venue_roles_select_by_venue_member ON public.venue_roles;
CREATE POLICY venue_roles_select_by_venue_member
  ON public.venue_roles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.venue_members vm
      WHERE vm.venue_id = venue_roles.venue_id
        AND vm.business_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS staff_invites_select_by_venue_member ON public.staff_invites;
CREATE POLICY staff_invites_select_by_venue_member
  ON public.staff_invites
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.venue_members vm
      WHERE vm.venue_id = staff_invites.venue_id
        AND vm.business_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS business_invites_select_by_venue_member ON public.business_invites;
CREATE POLICY business_invites_select_by_venue_member
  ON public.business_invites
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.venue_members vm
      WHERE vm.venue_id = business_invites.venue_id
        AND vm.business_id = auth.uid()
    )
  );

-- =====================================================================
-- 6. Enum value 'manager' → 'business' (platform role only)
-- =====================================================================
-- Postgres only supports ADD VALUE on an existing enum, never DROP
-- VALUE. To rename the value we create a parallel enum, switch every
-- column that references the old one, then drop the old type.
--
-- We only swap public.venue_role here. public.member_role keeps its
-- 'manager' value on purpose (per-venue Editor tier, see header).

-- ----- public.venue_role (used by public.venue_roles.role; values
--       become staff / business) -----
CREATE TYPE public.venue_role_new AS ENUM ('staff', 'business');

ALTER TABLE public.venue_roles
  ALTER COLUMN role TYPE public.venue_role_new
  USING (
    CASE role::text
      WHEN 'manager' THEN 'business'::public.venue_role_new
      ELSE role::text::public.venue_role_new
    END
  );

DROP TYPE public.venue_role;
ALTER TYPE public.venue_role_new RENAME TO venue_role;

-- =====================================================================
-- 7. app_metadata.role text update
-- =====================================================================
-- app_metadata is jsonb; role is a free-form text field (NOT a Postgres
-- enum). Every B2B account that signed in before the rebrand has
-- role = 'manager' on their JWT. Flip them to 'business' so existing
-- sessions stay valid; sign-in EFs will keep stamping 'business' going
-- forward.
UPDATE auth.users
   SET raw_app_meta_data = jsonb_set(
         coalesce(raw_app_meta_data, '{}'::jsonb),
         '{role}',
         '"business"'::jsonb,
         true
       )
 WHERE coalesce(raw_app_meta_data ->> 'role', '') = 'manager';

-- =====================================================================
-- 8. admin_reset_database(): swap renamed tables into the truncate list
-- =====================================================================
-- Per the super-admin reset rule: after every architectural change the
-- reset fn must rebuild a clean working env with the new names.
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
  -- 1. Wipe operational data. CASCADE clears FK-dependents and
  --    RESTART IDENTITY resets sequences. super_admins and app_settings
  --    are deliberately omitted (config singleton + founder allowlist).
  truncate table
    public.cashback_ledger,
    public.tickets,
    public.venue_verifications,
    public.business_invites,
    public.staff_invites,
    public.venue_roles,
    public.venue_members,
    public.venues,
    public.consumers,
    public.businesses
  restart identity cascade;

  -- 2. Drop every auth.user that isn't a super-admin. Anyone with no
  --    email (consumers/staff sign in by phone) is removed; emailed
  --    accounts are kept only if their lowercased email is in
  --    super_admins.
  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (
       select lower(email) from public.super_admins
     );
  get diagnostics deleted_users = row_count;

  -- 3. Nuke the atlas Storage bucket (research snapshots, mesita
  --    snapshots, media files). The bucket itself stays.
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

-- Service-role only. (Re-issuing the function preserves these grants but
-- restate them so a future read of just this migration shows the intent.)
REVOKE ALL ON FUNCTION public.admin_reset_database() FROM public;
REVOKE ALL ON FUNCTION public.admin_reset_database() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_database() TO service_role;
