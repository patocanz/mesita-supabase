// Input normalisation helpers shared by Edge Functions that accept
// user-typed strings (profile names, phones, free-form notes, etc.).

// Trim, length-cap, and reject empty/null. Used everywhere we'd
// otherwise repeat `String(...).trim()` plus a "did the user actually
// type anything" check.
export function clean(v: unknown, max = 256): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}
