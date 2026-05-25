// URL-safe random invite tokens. Same shape used by both
// staff_invites and business_invites — 18 random bytes encoded as
// base64url. Matches the SQL helper public.generate_invite_token().

export function newInviteToken(byteLength = 18): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
