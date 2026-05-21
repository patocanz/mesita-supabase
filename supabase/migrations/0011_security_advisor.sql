-- 0011_security_advisor.sql
-- Clean up the Supabase Security Advisor warnings:
--
--   1. Function Search Path Mutable on public.set_updated_at
--   2. Function Search Path Mutable on public.generate_guest_code
--   3. Extension in Public — pgvector should live in `extensions`
--
-- The remaining advisor warning (Leaked Password Protection Disabled)
-- is an auth-service setting and has to be toggled in the Supabase
-- dashboard at Authentication → Providers → Password Protection. There
-- is no SQL knob for it.

-- =========================
-- 1 + 2. Pin search_path on the two unpinned functions
-- =========================
-- Both functions only reference pg_catalog builtins + the public schema
-- they were defined in, so locking to those is sufficient.
alter function public.set_updated_at()
  set search_path = pg_catalog, public;

alter function public.generate_guest_code()
  set search_path = pg_catalog, public;

-- =========================
-- 3. Move pgvector out of public into the extensions schema
-- =========================
-- The `extensions` schema already exists on Supabase. ALTER EXTENSION
-- moves all of the extension's contained objects (types, functions,
-- operators) — column type references continue to resolve because
-- PostgreSQL tracks types by OID, not by qualified name.
alter extension vector set schema extensions;
