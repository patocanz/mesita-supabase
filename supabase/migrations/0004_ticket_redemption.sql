-- 0004_ticket_redemption.sql
-- Close the cashback loop: tickets can now redeem an amount from the
-- guest's existing balance against the current check. The redemption is
-- captured at ticket-create time but only debited from the guest's
-- balance when the ticket transitions to 'paid' — same gate as earning,
-- so a cancelled ticket never moves money in either direction.
--
-- Also adds a cancel reason so we can audit/show why a validator killed
-- a draft.

alter table public.tickets
  add column redeem_cents   integer check (redeem_cents is null or redeem_cents >= 0),
  add column cancel_reason  text;
