-- 0031_b — lock down the coupon-issue / coupon-cancel trigger functions.
--
-- Both functions are SECURITY DEFINER so the trigger can write into
-- public.coupons even when the inserting/deleting role doesn't have
-- direct DML on that table. The side effect is that they're also
-- exposed via PostgREST as RPC endpoints — /rest/v1/rpc/tg_…  Anyone
-- with the anon key (i.e., the public internet) could otherwise call
-- them directly with hand-crafted record arguments.
--
-- Trigger functions are never meant to be invoked by clients; the
-- engine calls them. Revoking EXECUTE from anon, authenticated and
-- public closes that door. The service role retains EXECUTE via its
-- blanket grant in supabase's standard role setup.
--
-- Found by `get_advisors` immediately after 0031 landed — addressing
-- in a follow-up rather than amending 0031 so the schema migration
-- and the hardening read as separate intents in the history.

revoke execute on function public.tg_saved_venues_issue_coupon()  from anon, authenticated, public;
revoke execute on function public.tg_saved_venues_cancel_coupon() from anon, authenticated, public;
