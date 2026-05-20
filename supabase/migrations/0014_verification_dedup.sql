-- 0014_verification_dedup.sql
-- One pending request per (venue, requester).
--
-- Without this, double-clicks on "Submit verification" produced two
-- pending rows for the same operator on the same venue, cluttering
-- the admin queue. The EF will also DELETE any existing pending row
-- before inserting a new one, so under normal use this index never
-- conflicts — it's a safety net for races / parallel tabs.

create unique index if not exists venue_verifications_one_pending_per_requester
  on public.venue_verifications (venue_id, requester_id)
  where status = 'pending';
