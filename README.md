# mesita-supabase

Supabase source of truth for the Mesita project — Edge Functions, migrations, seed data, and config.

## Project

- **Project ref:** `yjalywfzdelacdzccpgb`
- **Dashboard:** https://supabase.com/dashboard/project/yjalywfzdelacdzccpgb

## Architectural rules

1. **Clients never touch the database.** Web, mobile, and bot clients call Edge Functions only. Edge Functions call the database.
2. **Edge Functions do not call each other.** Each function owns its end-to-end workflow (auth check + validation + DB writes + response). Composition belongs inside one function, not across the network.

## Layout

```
supabase/
├── config.toml              # Local CLI + project config (per-function JWT settings live here)
├── functions/
│   ├── _shared/             # Pure utilities imported by EFs (no fn-to-fn calls at runtime)
│   ├── admin-*/             # Admin console flows (super-admin gated)
│   ├── consumer-*/          # B2C diner flows
│   ├── business-*/          # B2B venue business flows
│   └── staff-*/             # WhatsApp validator (waiter) post-invite flow
├── migrations/              # Versioned SQL migrations (0001 … 0026)
└── seed.sql                 # Idempotent local seed
```

## Common commands

```bash
# Link this repo to the remote project (one time per machine)
supabase link --project-ref yjalywfzdelacdzccpgb

# Apply pending migrations to the linked project
supabase db push

# Deploy one or more Edge Functions
supabase functions deploy <function-name> [<function-name> ...]

# Push pending migrations and regenerate TypeScript types for every
# web repo that consumes them (business, consumer, admin).
./scripts/deploy.sh
```

## Edge Function families

| Prefix | Auth pool | Purpose |
|---|---|---|
| `admin-*` | email (`@canzeco.com` + MFA) | Super-admin tooling: verification queue, place search, DB reset, Atlas snapshots |
| `business-*` | email | Venue owners and team members: CRUD venues, tickets, team, invites |
| `consumer-*` | phone OTP | Diner-facing flows: venue discovery, tickets, profile, stories |
| `staff-*` | phone OTP (post-invite) | WhatsApp validator (waiter) post-invite handshake |

`_shared/` holds pure imports (HTTP/CORS helpers, env+auth wrappers, role catalog, token generator). It is **not** a runtime dependency — Supabase bundles imported source per-function at deploy time, so the "no function-to-function calls" rule is still honored.

## Schema highlights

- **`venues`** — the catalog. Status: `lead | active | paused | archived`. Listing type: `partner | web`.
- **`venue_members`** — businesses ↔ venues with role `owner | editor | viewer | staff` (legacy `staff` preserved on pre-`venue_roles` rows; the `manager` value was renamed to `editor` in `0025`).
- **`venue_roles`** — phone-pool roles bound directly to `auth.users` (waiter sign-in lives here).
- **`staff_invites` / `business_invites`** — token-based pending invitations.
- **`tickets`** — consumer tickets with status / story / reservation / cashback / discount columns.
- **`super_admins`** — allow-list bypass for the admin console.

**RLS is tight:** SELECT only for rows the caller is permitted to see; all writes go through the service role inside Edge Functions.
