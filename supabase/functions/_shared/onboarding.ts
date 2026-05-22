// Helpers shared by venue-onboarding EFs (lookup + email OTP).

// True when the email's domain matches the website's hostname, ignoring
// "www." on either side. Subdomain matches count in both directions so
// `hola@reservas.casaluminar.mx` against `https://casaluminar.mx` passes.
// Returns false on any parse error (malformed email or URL).
export function isOnDomain(email: string, websiteUrl: string): boolean {
  const at = email.indexOf("@");
  if (at < 1) return false;
  const emailHost = email.slice(at + 1).toLowerCase();
  let siteHost: string;
  try {
    siteHost = new URL(websiteUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const stripWww = (h: string) => h.replace(/^www\./, "");
  const a = stripWww(emailHost);
  const b = stripWww(siteHost);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
