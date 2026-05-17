# mesita-supabase

Supabase source of truth for the Mesita project — Edge Functions, migrations, seed data, and config.

## Project

- **Project ref:** `yjalywfzdelacdzccpgb`
- **Region:** us-west-2
- **Dashboard:** https://supabase.com/dashboard/project/yjalywfzdelacdzccpgb

## Layout

```
supabase/
├── config.toml              # Local CLI + project config
├── functions/               # Edge Functions (Deno)
│   └── hello-world/
│       └── index.ts
└── migrations/              # Versioned SQL migrations
```

## Common commands

```bash
# Link this repo to the remote project (one time)
supabase link --project-ref yjalywfzdelacdzccpgb

# Deploy an Edge Function
supabase functions deploy hello-world

# Push pending migrations
supabase db push

# Generate TS types for the frontend
supabase gen types typescript --linked > ../mesita-web-platform/src/types/supabase.ts
```

## Architectural rule

Clients (web, mobile, bot) call **Edge Functions**. Edge Functions call the **database**. Clients never touch the database directly.
