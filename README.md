# mesita-supabase

**Mesita backend** — Supabase (Postgres, Auth, Edge Functions) plus third-party integrations (Twilio, Stripe, ElevenLabs). Web and mobile apps call Edge Functions only; functions own business logic and talk to the database.

- **Project ref:** `yjalywfzdelacdzccpgb`
- **Dashboard:** https://supabase.com/dashboard/project/yjalywfzdelacdzccpgb

---

## Architectural rules

1. **Clients never touch the database.** Edge Functions are the only write path (service role inside EFs).
2. **Edge Functions do not call each other.** Each function owns an end-to-end workflow.
3. **Integration config lives in git** (`integrations/`) and is applied with `scripts/` — not ad-hoc Console clicks.
4. **Workflow logic lives in Edge Functions**, not in Twilio Studio or ElevenLabs prompts alone (except reservation voice agent, post-MVP).

---

## Repository layout

```
mesita-supabase/
├── README.md                 # you are here
├── docs/
│   └── whatsapp.md           # Twilio/Meta IDs, webhook URLs, runbook
├── integrations/             # declarative config (git = source of truth)
│   ├── twilio/
│   │   ├── twiml/            # voice TwiML (recording, etc.)
│   │   └── templates/        # WhatsApp Content API template definitions
│   └── elevenlabs/           # reservation voice agents (post-MVP)
├── scripts/
│   ├── deploy.sh             # db push + regen types for web repos
│   ├── setup-twilio-call-recording.sh
│   └── sync-twilio-whatsapp-webhooks.sh
├── supabase/
│   ├── config.toml           # CLI config, per-function JWT flags
│   ├── functions/            # Edge Functions (runtime)
│   ├── migrations/
│   └── seed.sql
└── .env.twilio.local.example # local Twilio scripts only (gitignored)
```

### Runtime vs config

| Layer | Location | Deploy |
|---|---|---|
| **App logic** (tickets, reservations, auth) | `supabase/functions/` | `supabase functions deploy` |
| **Twilio WhatsApp / SMS** | `_shared/twilio.ts` + `twilio-whatsapp-*` | same |
| **Stripe** | `stripe-handle-webhook` | same |
| **Twilio templates, TwiML, webhooks** | `integrations/twilio/` + `scripts/` | run scripts locally |
| **ElevenLabs agents** (later) | `integrations/elevenlabs/` | API scripts + Supabase webhook EF |

---

## External integrations

### Twilio (WhatsApp, SMS, voice)

**Role:** messaging pipe for reward tickets, team invites, reservation notifications.

| Number | Label | Use |
|---|---|---|
| `+1 628 296 8794` | Mesita Ops (Staff) | Staff / waiter WhatsApp |
| `+1 628 296 4968` | Mesita Notifications | Consumer notifications |

Meta WABA `1389123139178386` · Portfolio `1180640363250622`. Details: [docs/whatsapp.md](docs/whatsapp.md).

**Secrets (Supabase):**

```bash
supabase secrets set \
  TWILIO_ACCOUNT_SID=AC... \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_WHATSAPP_FROM_STAFF='whatsapp:+16282968794' \
  TWILIO_WHATSAPP_FROM_CONSUMERS='whatsapp:+16282964968'
```

`TWILIO_MESSAGE_SERVICE_SID` is also used by Supabase Auth SMS ([config.toml](supabase/config.toml)).

**Local scripts** — copy [`.env.twilio.local.example`](.env.twilio.local.example) → `.env.twilio.local`:

```bash
./scripts/setup-twilio-call-recording.sh      # voice → record-incoming TwiML
./scripts/sync-twilio-whatsapp-webhooks.sh    # WA senders → Supabase EFs
```

**Deploy webhooks:**

```bash
supabase functions deploy twilio-whatsapp-inbound twilio-whatsapp-status
```

### Stripe

Webhook: `stripe-handle-webhook` (public, signature-verified). Membership / Premium door.

### ElevenLabs (post-MVP)

AI voice for **phone reservations** on a **dedicated** Twilio number — not the WhatsApp lines. See [integrations/elevenlabs/README.md](integrations/elevenlabs/README.md).

---

## Edge Function families

| Prefix | Auth | Purpose |
|---|---|---|
| `admin-*` | email + MFA | Super-admin console |
| `business-*` | email | Venues, tickets, team, verification |
| `consumer-*` | phone OTP | Discovery, tickets, **reservations**, profile |
| `staff-*` | phone OTP | Waiter post-invite |
| `twilio-whatsapp-*` | Twilio signature | Inbound WA + delivery status |
| `stripe-handle-webhook` | Stripe signature | Subscriptions |
| `atlas-*` / `recommender-*` | internal | Venue intelligence (service role) |

Reward ticket sequences (Story, Billing, Discount/Cashback payment) orchestrate in **business-** / **consumer-** / **staff-** functions; Twilio sends the messages.

---

## Common commands

```bash
# One-time link
supabase link --project-ref yjalywfzdelacdzccpgb

# Schema
supabase db push

# Migrations + regen TS types for web repos
./scripts/deploy.sh

# Deploy changed functions
supabase functions deploy <name> [<name> ...]
```

---

## Schema highlights

- **`venues`** — catalog (`lead | active | paused | archived`)
- **`venue_members` / `venue_roles`** — business and staff access
- **`tickets`** — reward tickets (discount/cashback × story/no-story)
- **`reservations`** — consumer bookings (MVP)
- **`staff_invites` / `business_invites`** — token invites

RLS: clients read only what they may see; writes go through Edge Functions.

---

## MVP checklist (communications)

- [x] WABA + WhatsApp senders connected
- [ ] Meta Business Verification
- [ ] `supabase secrets set` Twilio vars
- [ ] Deploy `twilio-whatsapp-inbound` / `-status`
- [ ] `./scripts/sync-twilio-whatsapp-webhooks.sh`
- [ ] WhatsApp templates in `integrations/twilio/templates/` + apply script
- [ ] Wire `business-invite-waiter`, reservation confirmations
- [ ] Reservation voice (ElevenLabs) — post-MVP, separate number

---

## Related repos

| Repo | Role |
|---|---|
| `mesita-web-consumer` | Diner app |
| `mesita-web-business` | Venue dashboard |
| `mesita-web-admin` | Internal admin |
| **mesita-supabase** | **Backend + integrations** |

No separate `mesita-twilio` or `mesita-elevenlabs` repos — config and runtime stay here.
