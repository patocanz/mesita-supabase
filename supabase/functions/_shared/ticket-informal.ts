// Informal (discount) ticket math — shared by business-create-ticket and Staff
// WhatsApp Type-A flow.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { isConsumerFirstVisit, selectVenueRate } from "./membership.ts";

export type VenueRateRow = {
  id: string;
  name: string;
  cashback_percent: number;
  welcome_free_rate: number | null;
  welcome_premium_rate: number | null;
  free_rate: number | null;
  premium_rate: number | null;
  monthly_promo_cap: number | null;
  fiscal_type: string;
  listing_type: string;
  status: string;
};

export type ConsumerRow = {
  id: string;
  code: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  cashback_balance_cents: number | null;
  tier_key: string | null;
  tier_origin: string | null;
  consumer_instagram_followers_count: number | null;
  phone: string | null;
};

export type InformalBillCalc = {
  subtotal: number;
  tip: number;
  total: number;
  eligibleCents: number;
  ratePercent: number;
  discountPercent: number;
  discountCents: number;
  redeemCents: number;
  amountDueCents: number;
};

export async function computeInformalBill(
  admin: SupabaseClient,
  venue: VenueRateRow,
  consumer: ConsumerRow,
  subtotal: number,
  tip: number,
  redeemRequested = 0,
): Promise<InformalBillCalc> {
  const total = subtotal + tip;
  const firstVisit = await isConsumerFirstVisit(admin, consumer.id, venue.id);
  const ratePercent = selectVenueRate(venue, consumer.tier_key, firstVisit);

  const capPesos = venue.monthly_promo_cap;
  const eligibleCents =
    capPesos != null && capPesos > 0 ? Math.min(total, capPesos * 100) : total;

  const discountPercent = ratePercent;
  let discountCents = Math.floor((eligibleCents * ratePercent) / 100);
  if (discountCents > total) discountCents = total;

  const consumerBalance = consumer.cashback_balance_cents ?? 0;
  const billAfterDiscount = total - discountCents;
  const cap = Math.min(consumerBalance, billAfterDiscount);
  const redeemCents = redeemRequested > 0 ? redeemRequested : cap;
  const amountDueCents = billAfterDiscount - redeemCents;

  return {
    subtotal,
    tip,
    total,
    eligibleCents,
    ratePercent,
    discountPercent,
    discountCents,
    redeemCents,
    amountDueCents,
  };
}

export function formatMoneyMx(cents: number, currency = "MXN"): string {
  const major = (cents / 100).toFixed(2);
  return `$${major} ${currency}`;
}

export async function finalizeInformalTicket(
  admin: SupabaseClient,
  ticketId: string,
  consumerId: string,
  venueId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ticket = await admin
    .from("tickets")
    .select(
      "id, status, redeem_cents, discount_cents, consumer_payment_confirmed_at, staff_payment_confirmed_at",
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticket.error || !ticket.data) {
    return { ok: false, error: ticket.error?.message ?? "ticket not found" };
  }
  if (ticket.data.status === "revealed") return { ok: true };
  if (
    !ticket.data.consumer_payment_confirmed_at ||
    !ticket.data.staff_payment_confirmed_at
  ) {
    return { ok: false, error: "payment confirmations incomplete" };
  }

  const redeemCents = ticket.data.redeem_cents ?? 0;
  const consumerRow = await admin
    .from("consumers")
    .select("cashback_balance_cents")
    .eq("id", consumerId)
    .single();
  if (consumerRow.error) {
    return { ok: false, error: consumerRow.error.message };
  }
  const balance = consumerRow.data.cashback_balance_cents ?? 0;

  const now = new Date().toISOString();
  const update = await admin
    .from("tickets")
    .update({
      status: "revealed",
      revealed_at: now,
      paid_at: now,
    })
    .eq("id", ticketId);
  if (update.error) return { ok: false, error: update.error.message };

  if (redeemCents > 0) {
    const newBalance = balance - redeemCents;
    await admin.from("cashback_ledger").insert({
      consumer_id: consumerId,
      ticket_id: ticketId,
      venue_id: venueId,
      delta_cents: -redeemCents,
      balance_after_cents: newBalance,
      kind: "redeem",
    });
    await admin
      .from("consumers")
      .update({ cashback_balance_cents: newBalance })
      .eq("id", consumerId);
  }

  return { ok: true };
}
