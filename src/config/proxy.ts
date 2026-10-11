/**
 * How many reverse proxies sit in front of the API (nginx alone = 1).
 *
 * Express then takes the client IP from the X-Forwarded-For entry appended by
 * the nearest trusted proxy, which a client cannot forge. Never use `true`:
 * that trusts the whole header, so any client can choose its own IP and walk
 * past every IP-based rate limit (login, password reset, signup).
 *
 * Set TRUST_PROXY_HOPS=2 if a CDN such as Cloudflare also sits in front, and 0
 * if the API is reached directly.
 */
export function trustProxyHops(raw = process.env.TRUST_PROXY_HOPS): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}
