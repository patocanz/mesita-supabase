# ElevenLabs (reservation voice — post-MVP)

ElevenLabs **Agents** + Twilio native import for AI phone reservations. Not used for WhatsApp or reward tickets.

## Architecture (planned)

```
Caller → dedicated Twilio number → ElevenLabs agent
                                        ↓ webhook
                              Supabase EF (venue context, availability)
```

**Do not import WhatsApp numbers (`4968`, `8794`) into ElevenLabs** — they are owned by Supabase webhooks.

## Config in git (when added)

```
integrations/elevenlabs/
├── agents/           # agent prompt + tool config JSON
├── voices/           # voice ID references
└── scripts/          # push config via ElevenLabs API
```

## Secrets (Supabase, when live)

```bash
supabase secrets set ELEVENLABS_API_KEY=...
```

Personalization webhook: `elevenlabs-reservation-context` Edge Function (TBD).
