-- 0017_verify_methods.sql
-- Verification redesign for /add.
--
-- Three methods now appear on the verification card for an unclaimed
-- web listing:
--
--   ai_call         (existing) — Twilio call/SMS reads a 6-digit code to
--                                the Google-listed phone. User types the
--                                code. Auto-grants ownership.
--   ai_email        (NEW)      — Transactional email sends a 6-digit code
--                                to a Firecrawl-discovered on-domain
--                                email. User types the code. Auto-grants
--                                ownership.
--   manual_contact  (NEW)      — Always available. Routes a contact
--                                request to Mesita ops; NEVER auto-grants.
--                                Admin reviews in admin.mesita.ai and
--                                approves manually.
--
-- The old `video` and `postcard` enum values stay defined so existing
-- rows survive; new EFs no longer emit them and the UI no longer offers
-- them. Postgres enums can't drop values cleanly without a rewrite, so
-- leaving them as legacy is the pragmatic move.
--
-- Reset semantics: admin_reset_database() TRUNCATEs venue_verifications
-- and preserves app_settings (config singleton). The new flag added
-- below inherits that — it survives a reset, which is the intended
-- behavior for global config.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Extend the verification_method enum
-- ─────────────────────────────────────────────────────────────────────
alter type public.verification_method add value if not exists 'ai_email';
alter type public.verification_method add value if not exists 'manual_contact';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Per-method auto-verify flag for ai_email
-- ─────────────────────────────────────────────────────────────────────
-- Default true: the on-domain email check is already a strong signal
-- (the email came from the venue's own website, same hostname). If an
-- admin wants a human in the loop they flip this to false via
-- admin-set-auto-verify, mirroring the ai_call governance.
alter table public.app_settings
  add column if not exists auto_verify_ai_email boolean not null default true;

-- ─────────────────────────────────────────────────────────────────────
-- 3. venues.country
-- ─────────────────────────────────────────────────────────────────────
-- Drives region routing for the manual fallback card:
--   MX / LatAm  → WhatsApp primary (later — buttons mocked for now)
--   US          → SMS primary (later — buttons mocked for now)
--   anything else / NULL → email-only floor
--
-- Stored as the long-form country name Google returns from
-- addressComponents (e.g. "Mexico", "United States"). The lookup EF
-- normalises to a region bucket so the wire format doesn't matter as
-- long as it's something Google emits.
alter table public.venues
  add column if not exists country text;

create index if not exists venues_country_idx on public.venues (country);
