-- 0025_rename_member_role_manager_to_editor.sql
--
-- Follow-up to 0024: the per-venue tier is now owner / editor / viewer
-- (was owner / manager / viewer). 'manager' in the member_role enum is
-- replaced with 'editor' to align the team UI and the DB.
--
-- Postgres can't drop an enum value in place, so we use the standard
-- swap-the-enum-type pattern: create the new enum, switch every column
-- that references the old one, then drop the old type.
--
-- Columns affected:
--   public.venue_members.role
--   public.business_invites.role
--
-- The legacy 'staff' value is preserved (it's still referenced by old
-- venue_members rows created before venue_roles existed).

CREATE TYPE public.member_role_new AS ENUM ('owner', 'editor', 'staff', 'viewer');

-- Drop defaults before the type swap — defaults are type-bound.
ALTER TABLE public.venue_members
  ALTER COLUMN role DROP DEFAULT;
ALTER TABLE public.business_invites
  ALTER COLUMN role DROP DEFAULT;

ALTER TABLE public.venue_members
  ALTER COLUMN role TYPE public.member_role_new
  USING (
    CASE role::text
      WHEN 'manager' THEN 'editor'::public.member_role_new
      ELSE role::text::public.member_role_new
    END
  );

ALTER TABLE public.business_invites
  ALTER COLUMN role TYPE public.member_role_new
  USING (
    CASE role::text
      WHEN 'manager' THEN 'editor'::public.member_role_new
      ELSE role::text::public.member_role_new
    END
  );

DROP TYPE public.member_role;
ALTER TYPE public.member_role_new RENAME TO member_role;

-- Re-add defaults under the renamed enum, pointing at 'editor'.
ALTER TABLE public.venue_members
  ALTER COLUMN role SET DEFAULT 'editor'::public.member_role;
ALTER TABLE public.business_invites
  ALTER COLUMN role SET DEFAULT 'editor'::public.member_role;
