// ─────────────────────────────────────────────────────────────
// session.js — browser sessions for QuoteRevive's free tier.
//
// Free identities used to be `free:<client IP>`, read from the
// CF-Connecting-IP / X-Forwarded-For headers with no allowlist. Two
// consequences, both live:
//
//   1. Anyone could read anyone's pipeline by guessing an IP:
//        curl -H "X-Forwarded-For: 1.2.3.4" /api/quotes
//   2. Everyone behind one NAT — an office, a café, carrier CGNAT —
//      shared a single identity and saw each other's deals.
//
// Worse, presenting a real licence key alongside a forged header moved
// the victim's stored (encrypted) IMAP credentials onto the attacker's
// key via the free→Pro migration.
//
// A session id is random, HttpOnly, and signed with a server secret, so
// the caller has to actually hold it. IPs are still used for rate
// limiting, but only from headers we're configured to trust.
// ─────────────────────────────────────────────────────────────
import crypto from "node:crypto";

const COOKIE_NAME = "qr_sid";
const SESSION_MAX_AGE_S = 180 * 24 * 60 * 60; // 180 days
const SID_RE = /^[0-9a-f]{32}$/;

let cachedSecret = null;

/**
 * HMAC secret for session signatures. Prefers SESSION_SECRET; otherwise
 * derives a distinct key from CREDENTIAL_KEY so a single-env deploy
 * still works without reusing the credential key verbatim.
 */
export function sessionSecret() {
  if (cachedSecret) return cachedSecret;
  const explicit = String(process.env.SESSION_SECRET || "").trim();
  if (explicit.length >= 16) {
    cachedSecret = Buffer.from(explicit, "utf8");
    return cachedSecret;
  }
  const credKey = String(process.env.CREDENTIAL_KEY || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(credKey)) {
    cachedSecret = Buffer.from(
      crypto.hkdfSync("sha256", Buffer.from(credKey, "hex"), Buffer.alloc(0), Buffer.from("quoterevive-session-v1"), 32)
    );
    return cachedSecret;
  }
  return null;
}

/** Test hook: forget the memoised secret after changing the env. */
export function _resetSecretForTests() {
  cachedSecret = null;
}

export function hasSessionSecret() {
  return sessionSecret() !== null;
}

function sign(sid) {
  const secret = sessionSecret();
  if (!secret) throw new Error("No session secret configured (set SESSION_SECRET or CREDENTIAL_KEY).");
  return crypto.createHmac("sha256", secret).update(sid).digest("base64url");
}

/** A fresh opaque session id. */
export function mintSid() {
  return crypto.randomBytes(16).toString("hex");
}

/** Cookie value for a session id: "<sid>.<signature>". */
export function signedValue(sid) {
  return `${sid}.${sign(sid)}`;
}

/** Verify a cookie value; returns the session id or null. Constant-time. */
export function verifySignedValue(value) {
  const raw = String(value || "");
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const sid = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!SID_RE.test(sid) || !sig) return null;
  let expected;
  try {
    expected = sign(sid);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? sid : null;
}

/** Parse one cookie out of a Cookie header. */
export function readCookie(req, name = COOKIE_NAME) {
  const header = String((req.headers && req.headers.cookie) || "");
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

function cookieIsSecure() {
  // Default to Secure. Local http development opts out explicitly.
  return String(process.env.QR_INSECURE_COOKIES || "").toLowerCase() !== "true";
}

export function buildSetCookie(sid) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(signedValue(sid))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_S}`,
  ];
  if (cookieIsSecure()) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * The caller's session id, minting and setting one when absent.
 * Must be called before the response headers are written.
 */
export function ensureSession(req, res) {
  const existing = verifySignedValue(readCookie(req));
  if (existing) return existing;
  const sid = mintSid();
  try {
    if (res && !res.headersSent) res.setHeader("Set-Cookie", buildSetCookie(sid));
  } catch {
    /* header already sent — the caller just gets a one-shot identity */
  }
  return sid;
}

/**
 * Client IP, for RATE LIMITING ONLY — never for identity.
 * Proxy headers are forwarded by anyone, so they are read only when
 * TRUST_PROXY_HEADERS=true says this process really does sit behind
 * one (e.g. Cloudflare). Otherwise the socket address is the truth.
 */
export function clientIp(req) {
  const h = (req && req.headers) || {};
  if (String(process.env.TRUST_PROXY_HEADERS || "").toLowerCase() === "true") {
    const cf = h["cf-connecting-ip"];
    if (cf && String(cf).trim()) return String(cf).trim().split(",")[0].trim();
    const xff = h["x-forwarded-for"];
    if (xff && String(xff).trim()) return String(xff).split(",")[0].trim();
  }
  return (req && req.socket && req.socket.remoteAddress) || "unknown";
}
