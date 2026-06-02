# WhatsApp message templates

Source-of-truth JSON files for Twilio Content API. **Do not create templates only in the Console** — Meta approval still happens async, but definitions live here.

Apply (when script exists):

```bash
./scripts/twilio-apply-templates.sh
```

Categories to add for MVP:

| Template | Use |
|---|---|
| `reservation-confirmed` | Consumer booking confirmation |
| `reservation-reminder` | Day-of reminder |
| `staff-invite` | Waiter / PR invite link |
| `story-confirmation` | Story validated — notify waiter |
| `billing-form` | Bill entry link for waiter |

See [docs/whatsapp.md](../../docs/whatsapp.md) for WABA IDs and webhook URLs.
