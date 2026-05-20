-- 0012_super_admins.sql
-- Super-admin allowlist.
--
-- Replaces the shared `ADMIN_ACCESS_KEY` secret. An operator is a
-- super-admin iff their signed-in email exists in this table. Both the
-- admin web and the manager web's super-admin EF paths look the caller
-- up here using `auth.jwt() ->> 'email'`.
--
-- Email-keyed so we can seed before someone signs in for the first
-- time. `user_id` is backfilled lazily by the EFs on first hit so any
-- future audit log can join by uuid without re-reading auth.users.
--
-- All access is service-role only — EFs are the only readers. No RLS
-- policies = denied for anon + authenticated.

create table public.super_admins (
  email      text primary key
              check (email = lower(email) and position('@' in email) > 1),
  user_id    uuid references auth.users(id) on delete set null,
  added_by   uuid references auth.users(id) on delete set null,
  note       text,
  created_at timestamptz not null default now()
);

create index super_admins_user_idx
  on public.super_admins (user_id)
  where user_id is not null;

alter table public.super_admins enable row level security;
-- No policies. Reads + writes go through Edge Functions running with
-- the service role. Anon + authenticated clients are denied by default.

-- Seed
-- ----
-- TODO Pato: insert the founder emails before applying this migration
-- in production. Example:
--
--   insert into public.super_admins (email, note) values
--     ('pato@canzeco.com', 'founder'),
--     ('luis@canzeco.com', 'founder');
--
-- Until you do this, NO ONE can act as super-admin — which is the
-- correct safe default. Add yourself first.
