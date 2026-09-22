// ─────────────────────────────────────────────────────────────
// quote-store.js — threading, quote cards, nudge lifecycle, scoring.
//
// Threads: messages grouped by primary external contact + normalized
// subject (Re:/Fwd: chains stripped); near-duplicate subjects for the
// same contact merge into one card ("2 threads").
//
// Cards: one per money thread. Stable IDs (hash of the group key) so
// re-running classification never duplicates. User lifecycle fields
// (nudge/snooze/dismiss/outcome/value override) survive re-runs.
//
// Ranking: expected value = deal value × recoverability, adjusted in
// code (sent-last boost, long-thread boost, calendar-aware timing
// boost, >120d cold penalty, per-user stall-reason outcome weights).
//
// Never logs email bodies.
// ─────────────────────────────────────────────────────────────
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCachedMessages } from "./inbox-store.js";
import { plainStallReason, plainType, timeRef, draftForCard, extractPromisedTime } from "./quote-classify.js";

const ROOT = fileURLToPath(new URL("./", import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const CARDS_FILE = path.join(DATA_DIR, "cards.json");
const WEIGHTS_FILE = path.join(DATA_DIR, "weights.json");
const SCAN_USAGE_FILE = path.join(DATA_DIR, "scan-usage.json");

const NUDGE_QUIET_MS = 21 * 24 * 60 * 60 * 1000;
const COLD_DAYS = 120;

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* best effort */
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
function readCards() {
  const d = readJson(CARDS_FILE, {});
  return d && typeof d === "object" ? d : {};
}
function writeCards(obj) {
  writeJson(CARDS_FILE, obj);
}
export function _readCardsForTests() {
  return readCards();
}

// ── subject normalization ──

export function normalizeSubject(subject) {
  let t = String(subject || "(no subject)").trim();
  t = t.replace(/^(\[[^\]]{1,40}\]\s*)+/, ""); // [External], [Bulk], ...
  let prev;
  do {
    prev = t;
    t = t.replace(/^(re|fwd?|aw|sv|vs|rvs)\s*:\s*/i, "");
  } while (t !== prev);
  t = t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "").trim(); // strip stray punctuation
  return t.toLowerCase() || "(no subject)";
}

function wordSet(s) {
  return new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function stableId(prefix, key) {
  return prefix + crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 12);
}

// ── threading ──

/**
 * Group cached messages into threads. Returns Map<threadId, thread>.
 * thread = { id, subject, normalizedSubject, messages[], primaryContact,
 *   externalAddresses[], lastActivity, lastInboundAt, lastMessageSentByUser, messageCount }
 */
export function threadMessages(key, messages, userEmail) {
  const k = String(key || "").trim();
  const ue = String(userEmail || "").toLowerCase();
  const groups = new Map(); // groupKey -> messages[]

  for (const m of messages || []) {
    const external = [];
    const seen = new Set();
    const addrs = [
      ...(m.from && m.from.address ? [m.from] : []),
      ...(m.to || []),
      ...(m.cc || []),
    ];
    for (const a of addrs) {
      const addr = String(a.address || "").toLowerCase();
      if (!addr || addr === ue || seen.has(addr)) continue;
      seen.add(addr);
      external.push({ name: String(a.name || ""), address: addr });
    }
    const norm = normalizeSubject(m.subject);
    let primary;
    if (m.sentByUser) {
      primary = (m.to || []).map((a) => String(a.address || "").toLowerCase()).find((a) => a && a !== ue) || "";
    } else {
      primary = String((m.from && m.from.address) || "").toLowerCase();
    }
    if (!primary && external.length) primary = external[0].address;
    const groupKey = `${primary || "__unknown__"}|${norm}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ ...m, _external: external, _primary: primary });
  }

  // Merge near-duplicate subjects for the same contact ("2 threads" case).
  const merged = [];
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  for (const [groupKey, msgs] of sorted) {
    const [primary, norm] = groupKey.split("|");
    const ws = wordSet(norm);
    let target = null;
    for (const g of merged) {
      if (g.primary !== primary) continue;
      if (jaccard(ws, wordSet(g.normalizedSubject)) >= 0.5) {
        target = g;
        break;
      }
    }
    if (target) {
      target.messages.push(...msgs);
      target.threadCount += 1;
    } else {
      merged.push({ primary, normalizedSubject: norm, messages: msgs.slice(), threadCount: 1 });
    }
  }

  const threads = new Map();
  for (const g of merged) {
    const messagesSorted = g.messages.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    // Primary contact = most frequent external address; name from most recent message carrying it.
    const freq = new Map();
    for (const m of messagesSorted) {
      for (const a of m._external || []) freq.set(a.address, (freq.get(a.address) || 0) + 1);
    }
    let primaryAddr = g.primary;
    let best = -1;
    for (const [addr, n] of freq) if (n > best) { best = n; primaryAddr = addr; }
    let primaryName = "";
    for (let i = messagesSorted.length - 1; i >= 0; i--) {
      const hit = (messagesSorted[i]._external || []).find((a) => a.address === primaryAddr);
      if (hit && hit.name) { primaryName = hit.name; break; }
    }
    const externalAddresses = [...freq.keys()];
    const lastActivity = messagesSorted.length ? messagesSorted[messagesSorted.length - 1].date : "";
    const inbound = messagesSorted.filter((m) => !m.sentByUser);
    const lastInboundAt = inbound.length ? inbound[inbound.length - 1].date : "";
    const clean = messagesSorted.map(({ _external, _primary, ...rest }) => rest);
    const id = stableId("th_", `${k}|${primaryAddr}|${g.normalizedSubject}`);
    threads.set(id, {
      id,
      key: k,
      subject: messagesSorted[0] ? messagesSorted[0].subject : "(no subject)",
      normalizedSubject: g.normalizedSubject,
      messages: clean,
      messageCount: clean.length,
      primaryContact: { name: primaryName, address: primaryAddr },
      externalAddresses,
      lastActivity,
      lastInboundAt,
      lastMessageSentByUser: clean.length ? !!clean[clean.length - 1].sentByUser : false,
      threadCount: g.threadCount,
      signature: stableId("sg_", clean.map((m) => m.uid).join(",")),
    });
  }
  return threads;
}

/** Rebuild threads for a key from the cached messages. */
export function rethreadKey(key, userEmail) {
  return threadMessages(key, getCachedMessages(key), userEmail);
}

// ── outcome weights (per key, per stall reason) ──

function readWeights() {
  const d = readJson(WEIGHTS_FILE, {});
  return d && typeof d === "object" ? d : {};
}
function writeWeights(obj) {
  writeJson(WEIGHTS_FILE, obj);
}

/** { STALL_REASON: {won, lost} } for a key. */
export function getOutcomeWeights(key) {
  const k = String(key || "").trim();
  return readWeights()[k] || {};
}

/** Laplace-smoothed multiplier: 1.0 with no data, rewards converting stall reasons. */
export function stallMultiplier(weights, stallReason) {
  const w = (weights || {})[stallReason] || { won: 0, lost: 0 };
  const rate = (w.won + 1) / (w.won + w.lost + 2);
  return 0.8 + 0.4 * rate;
}

function recordOutcomeWeight(key, stallReason, outcome) {
  const k = String(key || "").trim();
  const all = readWeights();
  const w = all[k] || {};
  const rec = w[stallReason] || { won: 0, lost: 0 };
  if (outcome === "won") rec.won += 1;
  else if (outcome === "lost") rec.lost += 1;
  w[stallReason] = rec;
  all[k] = w;
  writeWeights(all);
}

// ── scoring ──

const NOMINAL_UNKNOWN_VALUE = 500; // ranking placeholder; display still shows "est. ?"

/**
 * Calendar-aware boost: the contact named a time ("next quarter", "Q4",
 * a month name) and that time is now. Deterministic given nowMs.
 */
export function timingBoostFor(thread, nowMs = Date.now()) {
  const receivedText = (thread.messages || [])
    .filter((m) => !m.sentByUser)
    .map((m) => String(m.text || ""))
    .join("\n");
  const lower = receivedText.toLowerCase();
  const now = new Date(nowMs);
  const curQ = Math.floor(now.getUTCMonth() / 3) + 1;
  const curY = now.getUTCFullYear();

  const qm = lower.match(/\bq([1-4])\b/);
  if (qm && Number(qm[1]) === curQ) return true;

  if (/next quarter/.test(lower)) {
    const msg = (thread.messages || [])
      .filter((m) => !m.sentByUser && /next quarter/i.test(String(m.text || "")))
      .pop();
    const said = msg && msg.date ? new Date(msg.date) : null;
    if (said && !isNaN(said.getTime())) {
      let nq = Math.floor(said.getUTCMonth() / 3) + 2;
      let y = said.getUTCFullYear();
      if (nq > 4) { nq = 1; y += 1; }
      if (nq === curQ && y === curY) return true;
    }
  }
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  for (let i = 0; i < 12; i++) {
    if (lower.includes(months[i]) && now.getUTCMonth() === i) return true;
  }
  return false;
}

export function scoreCard(card, weights, nowMs = Date.now()) {
  const amount = card.dealValueOverride ?? card.dealValue?.amount ?? NOMINAL_UNKNOWN_VALUE;
  let ev = Number(amount) * Number(card.recoverability || 0) * stallMultiplier(weights, card.stallReason);
  if (card.lastMessageSentByUser) ev *= 1.15; // you sent last and they went quiet
  if (Number(card.messageCount || 0) >= 6) ev *= 1.1; // invested conversation
  if (card.timingBoost) ev *= 1.5; // "ask me in Q4" and it's Q4
  const days = (nowMs - Date.parse(card.lastActivity || "")) / 86_400_000;
  if (Number.isFinite(days) && days > COLD_DAYS) ev *= 0.5;
  return Math.round(ev);
}

// ── cards ──

/**
 * Upsert cards from classification results.
 * results: [{ thread, result }] where result = classifyThread() output.
 * Preserves user lifecycle fields across re-runs. DEAD auto-dismisses.
 */
export function upsertCards(key, results, { nowMs = Date.now() } = {}) {
  const k = String(key || "").trim();
  const store = readCards();
  const byKey = store[k] || {};
  const nowIso = new Date(nowMs).toISOString();

  for (const { thread, result } of results || []) {
    if (!result || result.type === "NOT_MONEY") continue;
    const id = stableId("qr_", `${thread.primaryContact.address}|${thread.normalizedSubject}`);
    const prev = byKey[id] || {};
    const timingBoost = result.stallReason === "TIMING_STALL" && timingBoostFor(thread, nowMs);
    const promisedTime = extractPromisedTime(thread);

    // A reply after a nudge clears the nudge and re-opens the card.
    let nudgedAt = prev.nudgedAt || null;
    if (nudgedAt && thread.lastInboundAt && Date.parse(thread.lastInboundAt) > Date.parse(nudgedAt)) {
      nudgedAt = null;
    }

    const card = {
      id,
      key: k,
      threadId: thread.id,
      contact: thread.primaryContact,
      type: result.type,
      typeLabel: plainType(result.type),
      stallReason: result.stallReason,
      stallLabel: plainStallReason(result.stallReason, result.type),
      stallDetail: `${plainStallReason(result.stallReason, result.type)} · ${timeRef(thread.lastActivity, nowMs)}`,
      dealValue: result.dealValue,
      dealValueOverride: prev.dealValueOverride ?? null,
      recoverability: result.recoverability,
      lastActivity: thread.lastActivity,
      lastMessageSentByUser: thread.lastMessageSentByUser,
      messageCount: thread.messageCount,
      threadCount: thread.threadCount,
      timingBoost,
      promisedTime: promisedTime || prev.promisedTime || null,
      subject: thread.subject,
      draft: "",
      // lifecycle (preserved)
      nudgedAt,
      snoozedUntil: prev.snoozedUntil || null,
      dismissed: prev.dismissed || result.stallReason === "DEAD",
      dismissReason: prev.dismissReason || (result.stallReason === "DEAD" ? "auto: thread is dead" : ""),
      outcome: prev.outcome || null,
      createdAt: prev.createdAt || nowIso,
      updatedAt: nowIso,
      signature: thread.signature,
    };
    card.draft = draftForCard({
      stallReason: card.stallReason,
      type: card.type,
      contactName: card.contact.name,
      contactEmail: card.contact.address,
      dealValue: card.dealValue,
      dealValueOverride: card.dealValueOverride,
      lastActivity: card.lastActivity,
      subject: card.subject,
      nowMs,
      promisedTime: card.promisedTime,
    });
    byKey[id] = card;
  }

  store[k] = byKey;
  writeCards(store);
  return { upserted: (results || []).filter((r) => r.result && r.result.type !== "NOT_MONEY").length };
}

function cardVisible(card, nowMs) {
  if (card.dismissed || card.outcome) return false;
  if (card.snoozedUntil && Date.parse(card.snoozedUntil) > nowMs) return false;
  if (card.nudgedAt && nowMs - Date.parse(card.nudgedAt) < NUDGE_QUIET_MS) return false;
  return true;
}

/**
 * Ranked, lifecycle-filtered cards for a key. Each card gets
 * expectedValue. Sorted by expected value desc.
 */
export function getCards(key, { nowMs = Date.now() } = {}) {
  const k = String(key || "").trim();
  const byKey = readCards()[k] || {};
  const weights = getOutcomeWeights(k);
  const cards = Object.values(byKey)
    .filter((c) => cardVisible(c, nowMs))
    .map((c) => ({ ...c, expectedValue: scoreCard(c, weights, nowMs) }));
  cards.sort((a, b) => b.expectedValue - a.expectedValue || String(b.lastActivity).localeCompare(String(a.lastActivity)));
  return cards;
}

/** Totals across ALL cards (visible or not) — for the hero number. */
export function getPipelineTotals(key, { nowMs = Date.now() } = {}) {
  const k = String(key || "").trim();
  const byKey = readCards()[k] || {};
  const weights = getOutcomeWeights(k);
  const all = Object.values(byKey).filter((c) => !c.dismissed && !c.outcome);
  const total = all.reduce((s, c) => s + scoreCard(c, weights, nowMs), 0);
  return { total, count: all.length };
}

export function getCard(key, id) {
  const k = String(key || "").trim();
  return (readCards()[k] || {})[String(id)] || null;
}

/**
 * Move all cards + outcome weights from one identity to another
 * (free → pro upgrade). Card ids no longer embed the key, so they
 * survive the move unchanged. Only migrates into an empty target.
 */
export function migrateCards(fromKey, toKey) {
  const f = String(fromKey || "").trim();
  const t = String(toKey || "").trim();
  if (!f || !t || f === t) return false;
  const store = readCards();
  const src = store[f];
  if (!src || Object.keys(src).length === 0) return false;
  if (store[t] && Object.keys(store[t]).length > 0) return false; // don't clobber pro data
  for (const c of Object.values(src)) c.key = t;
  store[t] = src;
  delete store[f];
  writeCards(store);
  const w = readWeights();
  if (w[f] && !w[t]) {
    w[t] = w[f];
    delete w[f];
    writeWeights(w);
  }
  return true;
}

/** Drop all cards for a key (used on inbox disconnect). */
export function deleteCardsForKey(key) {
  const k = String(key || "").trim();
  const store = readCards();
  delete store[k];
  writeCards(store);
}

/** nudge | snooze | dismiss | outcome | value */
export function cardAction(key, id, action, params = {}) {
  const k = String(key || "").trim();
  const store = readCards();
  const byKey = store[k] || {};
  const card = byKey[String(id)];
  if (!card) return { ok: false, error: "Card not found." };
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  switch (action) {
    case "nudge":
      card.nudgedAt = nowIso;
      card.updatedAt = nowIso;
      break;
    case "snooze": {
      const days = Number(params.days) === 30 ? 30 : 7;
      card.snoozedUntil = new Date(now + days * 86_400_000).toISOString();
      card.updatedAt = nowIso;
      break;
    }
    case "dismiss":
      card.dismissed = true;
      card.dismissReason = String(params.reason || "user dismissed").slice(0, 200);
      card.updatedAt = nowIso;
      break;
    case "outcome": {
      const outcome = params.outcome === "won" ? "won" : params.outcome === "lost" ? "lost" : null;
      if (!outcome) return { ok: false, error: "Outcome must be 'won' or 'lost'." };
      card.outcome = outcome;
      card.updatedAt = nowIso;
      recordOutcomeWeight(k, card.stallReason, outcome);
      break;
    }
    case "value": {
      const amount = Number(params.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) {
        return { ok: false, error: "Enter a valid deal value." };
      }
      card.dealValueOverride = Math.round(amount * 100) / 100;
      card.updatedAt = nowIso;
      card.draft = draftForCard({
        stallReason: card.stallReason,
        type: card.type,
        contactName: card.contact.name,
        contactEmail: card.contact.address,
        dealValue: card.dealValue,
        dealValueOverride: card.dealValueOverride,
        lastActivity: card.lastActivity,
        subject: card.subject,
        nowMs: now,
        promisedTime: card.promisedTime || null,
      });
      break;
    }
    default:
      return { ok: false, error: `Unknown action "${action}".` };
  }
  byKey[String(id)] = card;
  store[k] = byKey;
  writeCards(store);
  return { ok: true, card: { ...card, expectedValue: scoreCard(card, getOutcomeWeights(k), now) } };
}

// ── free-scan usage (1 scan/day/IP by default) ──

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function readScanUsage() {
  const d = readJson(SCAN_USAGE_FILE, {});
  return d && typeof d === "object" ? d : {};
}

export function freeScanDailyLimit() {
  return Math.max(1, Number(process.env.FREE_SCAN_DAILY_LIMIT || 1));
}

/** {allowed, used, limit} for a free scan identity (IP). */
export function checkFreeScan(ip) {
  const day = utcDay();
  const rec = readScanUsage()[String(ip)] || {};
  const used = rec.day === day ? Number(rec.count) || 0 : 0;
  const limit = freeScanDailyLimit();
  return { allowed: used < limit, used, limit };
}

export function recordFreeScan(ip) {
  const day = utcDay();
  const all = readScanUsage();
  const rec = all[String(ip)] || {};
  all[String(ip)] = { day, count: (rec.day === day ? Number(rec.count) || 0 : 0) + 1 };
  writeJson(SCAN_USAGE_FILE, all);
}

/** Test helper: clear per-IP free scan usage. */
export function resetFreeScanForTests() {
  writeJson(SCAN_USAGE_FILE, {});
}
