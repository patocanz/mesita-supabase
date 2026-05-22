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

## Stripe configuration

Mesita uses Stripe Connect (Express accounts) under the **Destination Charges / Separate Charges and Transfers** pattern. See `migrations/0020_stripe_and_ledger.sql` for the schema.

### Required EF secrets

Set in Supabase dashboard → Project settings → Edge Functions → Secrets (or via `supabase secrets set`):

| Secret | Where to find | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys | `sk_test_...` in dev, `sk_live_...` in prod |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard → Developers → Webhooks → endpoint | `whsec_...`. One per webhook endpoint. |
| `STRIPE_CONNECT_RETURN_URL` | own config | URL the venue lands on after Express onboarding. Typically `https://manager.mesita.ai/unit/{venueId}/wallet?connect=done` |
| `STRIPE_CONNECT_REFRESH_URL` | own config | URL Stripe redirects to if the onboarding link expired. Typically the same as return URL with `?connect=refresh` |
| `STRIPE_PRICE_VENUE_FORMAL_PRO` | Stripe dashboard → Products | Recurring price for MX$400/mo Formal Pro |
| `STRIPE_PRICE_VENUE_INFORMAL_PRO` | Stripe dashboard → Products | Recurring price for MX$800/mo Informal Pro |
| `STRIPE_PRICE_GUEST_SILVER` | Stripe dashboard → Products | Recurring price for MX$200/mo Silver Subscription |
| `STRIPE_PRICE_GUEST_GOLD` | Stripe dashboard → Products | Recurring price for MX$500/mo Gold Subscription |
| `STRIPE_PRICE_GUEST_DIAMOND` | Stripe dashboard → Products | Recurring price for MX$1000/mo Diamond Subscription |
| `STRIPE_MESITA_FEE_BPS` | own config | Mesita's take on each bill payment in basis points. Default 500 (= 5%). |

### Webhook endpoints

One webhook endpoint per concern, configured in Stripe dashboard:

| Endpoint URL | Listens to |
|---|---|
| `/functions/v1/webhook-receives-stripe-connect` | `account.updated`, `account.application.deauthorized` |
| `/functions/v1/webhook-receives-stripe-bill-payment` | `checkout.session.completed`, `charge.refunded`, `charge.dispute.created` |
| `/functions/v1/webhook-receives-stripe-subscriptions` | `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` |
| `/functions/v1/webhook-receives-stripe-payouts` | `payout.paid`, `payout.failed`, `transfer.created` |

Each endpoint gets its own `STRIPE_WEBHOOK_SECRET`-prefixed secret (e.g. `STRIPE_WEBHOOK_SECRET_CONNECT`) — see the individual EF for the exact env var name.

### Architecture rules

- **Stripe is a rail. Postgres is the ledger.** Every state change is recorded in `ledger_entries`; aggregate balances in `guest_balances` / `venue_balances` / `mesita_balance` are materialised from the log.
- **Closed-loop guest balance.** No payout method is ever attached to a guest. Funds only flow OUT of `guest_balances` via `cashback_redeem` against a future bill — this is enforced by absence of code paths, not by Stripe rules.
- **Separate Charges and Transfers** for bill payments: charge into Mesita's platform balance, hold venue + cashback portions until story validates or the chargeback window closes, then transfer to the venue's Express account.
- **Idempotent webhooks.** Every event is recorded in `stripe_webhook_events` before processing; duplicates no-op.
