// Normalize consumer QR codes: sequential 0000-0000 … 9999-9999 and legacy
// 6-char alphanumeric codes.

const SEQUENTIAL_RE = /^[0-9]{4}-[0-9]{4}$/;
const DIGITS_ONLY_RE = /^[0-9]{8}$/;

export function formatSequentialCode(n: number): string {
  const hi = Math.floor(n / 10000);
  const lo = n % 10000;
  return `${String(hi).padStart(4, "0")}-${String(lo).padStart(4, "0")}`;
}

/** Parse staff/consumer input into a DB lookup key. */
export function normalizeConsumerCodeInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length === 8) {
    return formatSequentialCode(Number(digits));
  }
  const upper = trimmed.toUpperCase();
  if (SEQUENTIAL_RE.test(upper)) return upper;
  if (DIGITS_ONLY_RE.test(digits)) {
    return formatSequentialCode(Number(digits));
  }
  // Legacy Crockford-style codes
  const alnum = upper.replace(/[^A-Z0-9]/g, "");
  if (alnum.length >= 4 && alnum.length <= 12) return alnum;
  return null;
}

/** Extract a consumer code from free-form text (regex fallback before LLM). */
export function extractConsumerCodeFromText(text: string): string | null {
  const hyphen = text.match(/\b([0-9]{4}[-\s]?[0-9]{4})\b/);
  if (hyphen) {
    const n = normalizeConsumerCodeInput(hyphen[1].replace(/\s/g, ""));
    if (n) return n;
  }
  const eight = text.match(/\b([0-9]{8})\b/);
  if (eight) return normalizeConsumerCodeInput(eight[1]);
  return null;
}

export function displayConsumerCode(code: string): string {
  if (SEQUENTIAL_RE.test(code)) return code;
  const digits = code.replace(/[^0-9]/g, "");
  if (digits.length === 8) return formatSequentialCode(Number(digits));
  return code;
}
