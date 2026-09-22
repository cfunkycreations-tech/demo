// ─────────────────────────────────────────────────────────────
// license-store.js — Gumroad license verification + usage tracking.
// Zero-dependency. Persists to ./data/licenses.json and
// ./data/usage.json (created on first use).
//
// Tiers (QuoteRevive):
//   free — full inbox scan (capped threads), reveals top 3 cards + totals
//   pro  — everything unlocked, deeper backfill
//
// Env knobs (all optional):
//   GUMROAD_PRODUCT_PERMALINK — permalink for license verification
//   GUMROAD_URL               — public checkout URL (served by /api/config)
//   FREE_DAILY_LIMIT          — default 25 (generic free-identity budget)
//   PRO_MONTHLY_LIMIT         — default 5000 (Pro classification budget)
// ─────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./", import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const LICENSES_FILE = path.join(DATA_DIR, "licenses.json");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");

const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";
const LICENSE_CACHE_MS = 30 * 24 * 60 * 60 * 1000; // re-verify after 30 days
const VERIFY_TIMEOUT_MS = 20000;
// Gumroad keys look like ABCD1234-EFGH5678-...; be strict so weird
// strings can never become object keys or file content surprises.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9\-_]{3,127}$/;

export function freeDailyLimit() {
  return Number(process.env.FREE_DAILY_LIMIT || 25);
}

export function proMonthlyLimit() {
  return Number(process.env.PRO_MONTHLY_LIMIT || 5000);
}

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* best effort — reads will just miss */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function utcDay() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function utcMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

// clientIp now lives in session.js. It is rate-limiting input only —
// identity comes from a signed cookie, never from a forwardable header.

export function cleanKey(raw) {
  const k = String(raw ?? "").trim();
  return KEY_RE.test(k) ? k : "";
}

// ── license cache ────────────────────────────────────────────

function readLicenses() {
  const data = readJson(LICENSES_FILE, {});
  return data && typeof data === "object" ? data : {};
}

/** Cached verification record for a key, or null. */
export function getCachedLicense(key) {
  const k = cleanKey(key);
  if (!k) return null;
  const rec = readLicenses()[k];
  if (!rec || typeof rec !== "object") return null;
  if (Date.now() - Number(rec.verifiedAt || 0) > LICENSE_CACHE_MS) return null;
  return { key: k, email: rec.email || "" };
}

function saveLicense(key, email) {
  const all = readLicenses();
  all[key] = { email: email || "", verifiedAt: Date.now() };
  writeJson(LICENSES_FILE, all);
}

/**
 * Verify a license key with Gumroad (cached for 30 days).
 * Never throws — always returns {ok:true,pro:true,email} or {ok:false,error}.
 */
export async function verifyLicense(rawKey) {
  const key = cleanKey(rawKey);
  if (!key) {
    return { ok: false, error: "That doesn't look like a license key — check for typos and try again." };
  }

  const cached = getCachedLicense(key);
  if (cached) return { ok: true, pro: true, email: cached.email };

  const permalink = String(process.env.GUMROAD_PRODUCT_PERMALINK || "").trim();
  if (!permalink) {
    return { ok: false, error: "License activation isn't set up yet — the store is still being connected. Try again soon." };
  }

  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS);
    res = await fetch(GUMROAD_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ product_permalink: permalink, license_key: key }).toString(),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch {
    return { ok: false, error: "Couldn't reach the license server — check your connection and try again in a minute." };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "The license server gave an odd response — try again in a minute." };
  }

  if (data && data.success) {
    const email = (data.purchase && data.purchase.email) || "";
    saveLicense(key, email);
    return { ok: true, pro: true, email };
  }
  return { ok: false, error: "That license key wasn't recognized. Double-check it, or reach out if you bought Pro and this keeps happening." };
}

// ── usage tracking ───────────────────────────────────────────

function readUsage() {
  const data = readJson(USAGE_FILE, {});
  const usage = { free: {}, pro: {} };
  const day = utcDay();
  const month = utcMonth();
  // Drop stale buckets so the file stays small.
  for (const [ip, rec] of Object.entries((data && data.free) || {})) {
    if (rec && rec.day === day) usage.free[ip] = { day, used: Number(rec.used) || 0 };
  }
  for (const [k, rec] of Object.entries((data && data.pro) || {})) {
    if (rec && rec.month === month && KEY_RE.test(k)) {
      usage.pro[k] = { month, used: Number(rec.used) || 0 };
    }
  }
  return usage;
}

/** {used, limit} for a tier identity without consuming. */
export function peekUsage(tier, id) {
  const usage = readUsage();
  const limit = tier === "pro" ? proMonthlyLimit() : freeDailyLimit();
  const bucket = tier === "pro" ? usage.pro[id] : usage.free[id];
  return { used: bucket ? bucket.used : 0, limit };
}

/**
 * Check-then-consume: returns {allowed, used, limit}. When allowed,
 * `used` already includes `count`.
 */
export function consumeUsage(tier, id, count) {
  const usage = readUsage();
  const limit = tier === "pro" ? proMonthlyLimit() : freeDailyLimit();
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (tier === "pro") {
    const rec = usage.pro[id] || { month: utcMonth(), used: 0 };
    if (rec.used + n > limit) return { allowed: false, used: rec.used, limit };
    rec.used += n;
    usage.pro[id] = rec;
  } else {
    const rec = usage.free[id] || { day: utcDay(), used: 0 };
    if (rec.used + n > limit) return { allowed: false, used: rec.used, limit };
    rec.used += n;
    usage.free[id] = rec;
  }
  try {
    writeJson(USAGE_FILE, usage);
  } catch {
    /* usage write failed — still allow the triage; don't punish the user */
  }
  const after = tier === "pro" ? usage.pro[id].used : usage.free[id].used;
  return { allowed: true, used: after, limit };
}
