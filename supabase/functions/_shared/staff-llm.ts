// LLM intent parsing for Staff WhatsApp (Mesita Ops). Handles messy input like
// "hey check this code 1234-5678" and structured bill replies.

import { extractConsumerCodeFromText, normalizeConsumerCodeInput } from "./consumer-code.ts";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

export type StaffMessageIntent = {
  intent:
    | "lookup_code"
    | "submit_bill"
    | "confirm_payment"
    | "cancel"
    | "help"
    | "unknown";
  consumer_code: string | null;
  check_subtotal_cents: number | null;
  tip_cents: number | null;
  confirm: boolean | null;
};

const EMPTY_INTENT: StaffMessageIntent = {
  intent: "unknown",
  consumer_code: null,
  check_subtotal_cents: null,
  tip_cents: null,
  confirm: null,
};

export async function parseStaffWhatsAppMessage(
  body: string,
  sessionState: string,
): Promise<StaffMessageIntent> {
  const heuristic = heuristicParse(body, sessionState);
  const openaiKey = Deno.env.get("OPENAI_KEY")?.trim();
  if (!openaiKey) return heuristic;

  const system =
    "You parse WhatsApp messages from restaurant waitstaff using Mesita. " +
    'Return JSON only: {"intent":"lookup_code"|"submit_bill"|"confirm_payment"|"cancel"|"help"|"unknown",' +
    '"consumer_code":"0000-0000"|null,"check_subtotal_cents":number|null,"tip_cents":number|null,"confirm":boolean|null}. ' +
    "Consumer codes are 8 digits formatted 0000-0000. " +
    "submit_bill: extract bill subtotal and tip in cents (e.g. $850.50 → 85050). " +
    "confirm_payment: staff confirming guest paid (yes/sí/confirm/pagado). " +
    "lookup_code: staff sending or asking about a guest code.";

  const user =
    `Session state: ${sessionState}\nMessage:\n${body.slice(0, 2000)}`;

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) return heuristic;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return mergeIntent(heuristic, parsed);
  } catch {
    return heuristic;
  }
}

function mergeIntent(
  fallback: StaffMessageIntent,
  raw: Record<string, unknown>,
): StaffMessageIntent {
  const intents = new Set([
    "lookup_code",
    "submit_bill",
    "confirm_payment",
    "cancel",
    "help",
    "unknown",
  ]);
  const intent = intents.has(String(raw.intent))
    ? (raw.intent as StaffMessageIntent["intent"])
    : fallback.intent;

  let consumer_code: string | null = null;
  if (typeof raw.consumer_code === "string" && raw.consumer_code.trim()) {
    consumer_code = normalizeConsumerCodeInput(raw.consumer_code);
  }
  if (!consumer_code) consumer_code = fallback.consumer_code;

  return {
    intent,
    consumer_code,
    check_subtotal_cents: toCents(raw.check_subtotal_cents) ??
      fallback.check_subtotal_cents,
    tip_cents: toCents(raw.tip_cents) ?? fallback.tip_cents,
    confirm: typeof raw.confirm === "boolean"
      ? raw.confirm
      : fallback.confirm,
  };
}

function heuristicParse(body: string, sessionState: string): StaffMessageIntent {
  const lower = body.trim().toLowerCase();
  if (/^(help|\?|menu|ayuda)\b/.test(lower)) {
    return { ...EMPTY_INTENT, intent: "help" };
  }
  if (/^(cancel|cancelar|reset|stop)\b/.test(lower)) {
    return { ...EMPTY_INTENT, intent: "cancel" };
  }

  const code = extractConsumerCodeFromText(body);
  if (code && sessionState === "idle") {
    return { ...EMPTY_INTENT, intent: "lookup_code", consumer_code: code };
  }

  if (
    sessionState === "consumer_identified" ||
    sessionState === "idle"
  ) {
    const bill = parseBillAmounts(body);
    if (bill.subtotal != null) {
      return {
        intent: "submit_bill",
        consumer_code: code,
        check_subtotal_cents: bill.subtotal,
        tip_cents: bill.tip ?? 0,
        confirm: null,
      };
    }
  }

  if (
    sessionState === "awaiting_staff_payment_confirm" ||
    sessionState === "awaiting_payment_confirm"
  ) {
    if (/^(yes|y|si|sí|confirm|confirmed|pagado|paid|listo|ok)\b/i.test(lower)) {
      return { ...EMPTY_INTENT, intent: "confirm_payment", confirm: true };
    }
  }

  if (code) {
    return { ...EMPTY_INTENT, intent: "lookup_code", consumer_code: code };
  }

  return EMPTY_INTENT;
}

/** Accept "850.50 100", "SUBTOTAL 850 TIP 100", or peso amounts. */
function parseBillAmounts(text: string): { subtotal: number | null; tip: number | null } {
  const lines = text.replace(/,/g, "").trim();
  const subtotalMatch = lines.match(
    /(?:subtotal|bill|cuenta|total)[:\s]*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
  );
  const tipMatch = lines.match(
    /(?:tip|propina)[:\s]*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
  );
  if (subtotalMatch) {
    return {
      subtotal: moneyToCents(subtotalMatch[1]),
      tip: tipMatch ? moneyToCents(tipMatch[1]) : 0,
    };
  }
  const nums = [...lines.matchAll(/([0-9]+(?:\.[0-9]{1,2})?)/g)].map((m) =>
    moneyToCents(m[1])
  ).filter((n): n is number => n != null);
  if (nums.length >= 2) {
    return { subtotal: nums[0], tip: nums[1] };
  }
  if (nums.length === 1) {
    return { subtotal: nums[0], tip: 0 };
  }
  return { subtotal: null, tip: null };
}

function moneyToCents(v: string): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function toCents(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}
