# mesita-supabase

Supabase source of truth for the Mesita project — Edge Functions, migrations, seed data, and config.

## Project

- **Project ref:** `yjalywfzdelacdzccpgb`
- **Region:** us-west-2
- **Dashboard:** https://supabase.com/dashboard/project/yjalywfzdelacdzccpgb

## Architectural rules

1. **Clients never touch the database.** Web, mobile, and bot clients call Edge Functions only. Edge Functions call the database.
2. **Edge Functions do not call each other.** Each function owns its end-to-end workflow (auth check + validation + DB writes + response). Composition belongs inside one function, not across the network.

## Layout

```
supabase/
├── config.toml              # Local CLI + project config (per-function JWT settings live here)
├── functions/               # Edge Functions (Deno)
│   ├── hello-world/         # Public smoke test
│   ├── places-autocomplete/ # Google Places search proxy (JWT-protected)
│   ├── places-details/      # Google Place details proxy (JWT-protected)
│   ├── venues-list/         # Public — guest catalog read
│   ├── venues-create/       # Authenticated — manager creates a venue
│   └── venues-mine/         # Authenticated — manager lists their venues
├── migrations/              # Versioned SQL migrations
│   └── 0001_init.sql        # Core domain: venues, managers, venue_members, guests + RLS
└── seed.sql                 # Idempotent local seed (one test venue)
```

## Common commands

```bash
# Link this repo to the remote project (one time per machine)
supabase link --project-ref yjalywfzdelacdzccpgb

# Apply migrations to the linked project
supabase db push

# Deploy all venue Edge Functions
supabase functions deploy venues-list
supabase functions deploy venues-create
supabase functions deploy venues-mine

# Generate TypeScript types for the frontend
supabase gen types typescript --linked \
  > ../mesita-web-platform/src/lib/supabase/database.types.ts
```

## Function reference

| Function | Auth | Verb | Purpose |
|---|---|---|---|
| `hello-world` | none | GET | Smoke test |
| `places-autocomplete` | JWT | POST | Google Places search proxy |
| `places-details` | JWT | POST | Google Place details by `placeId` |
| `venues-list` | none | GET/POST | Public guest catalog (RLS-filtered to active/lead) |
| `venues-create` | JWT | POST | Authenticated manager creates a venue + becomes owner |
| `venues-mine` | JWT | GET/POST | Authenticated manager lists venues they belong to |

All venue functions are self-contained: each verifies its own caller, validates its own input, performs its own DB work, and never calls another Edge Function.

## Schema overview (`0001_init.sql`)

- **`venues`** — the catalog. Status: `lead | active | paused | archived`. Listing type: `partner | web`.
- **`managers`** — profile bound to `auth.users`. Created on first venue write (idempotent upsert inside `venues-create`).
- **`venue_members`** — many-to-many between managers and venues with role: `owner | manager | staff`.
- **`guests`** — profile bound to `auth.users`. Defined but not used until the guest phone-OTP plan.

**RLS is tight:** SELECT only for the rows a caller is permitted to see; all writes go through the service role inside Edge Functions.
