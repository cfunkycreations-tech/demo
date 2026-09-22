// ─────────────────────────────────────────────────────────────
// server.js — QuoteRevive. Zero-dependency Node server (+ imapflow).
//
// Serves ./public statically and routes:
//   GET  /api/health          → {ok, mode, model}
//   GET  /api/config          → {gumroadUrl}
//   POST /api/license         → verify a Gumroad license key
//   POST /api/inbox/connect    → connect an IMAP account (INBOX + Sent)
//   POST /api/inbox/disconnect → disconnect
//   POST /api/inbox/scan       → trigger a backfill scan (tier-limited)
//   GET  /api/inbox/scan-progress → backfill progress for the UI
//   GET  /api/inbox/status     → connection status
//   GET  /api/quotes           → ranked money cards (free: top 3 + totals)
//   POST /api/quotes/:id/:action → nudge|snooze|dismiss|outcome|value
//
// QuoteRevive NEVER sends email — follow-ups are drafts only.
//
// Identity is a signed HttpOnly cookie (session.js), NOT the client IP.
// IPs are rate-limiting input only, and proxy headers are read only
// when TRUST_PROXY_HEADERS=true.
//
// Run:  node server.js        (then open http://localhost:8787)
// Env:  PORT, JEV_MOCK, JEV_API_KEY, JEV_MODEL, CREDENTIAL_KEY,
//       SESSION_SECRET, TRUST_PROXY_HEADERS, QR_INSECURE_COOKIES,
//       GUMROAD_PRODUCT_PERMALINK, GUMROAD_URL,
//       FREE_SCAN_DAILY_LIMIT, PRO_MONTHLY_LIMIT
// ─────────────────────────────────────────────────────────────
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJevClient, jevModel, QUESTIONS_PER_THREAD } from "./jev-client.js";
import { ensureSession, clientIp, hasSessionSecret } from "./session.js";
import {
  verifyLicense,
  getCachedLicense,
  consumeUsage,
  cleanKey,
  proMonthlyLimit,
} from "./license-store.js";
import {
  hasCredentialKey,
  testInboxConnection,
  saveInbox,
  getInboxPublic,
  getInboxUserEmail,
  disconnectInbox,
  migrateInboxData,
  listInboxKeys,
  getScanProgress,
  runBackfill,
  finishScan,
  pollNewMail,
  startInboxPoller,
} from "./inbox-store.js";
import {
  rethreadKey,
  upsertCards,
  getCards,
  getCard,
  getPipelineTotals,
  cardAction,
  deleteCardsForKey,
  migrateCards,
  checkFreeScan,
  recordFreeScan,
} from "./quote-store.js";
import { classifyThread, QUOTE_RE, INVOICE_RE } from "./quote-classify.js";

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const FREE_SCAN_MESSAGE_CAP = 300;
const PRO_SCAN_MESSAGE_CAP = 2000;

const jev = createJevClient({ apiKey: process.env.JEV_API_KEY || "", mock: isMock() });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), "application/json");
}
function serveStatic(reqPath, res) {
  let rel;
  try {
    // A malformed percent-escape ("/%") throws here. Unguarded, that
    // threw out of the request handler and killed the process for
    // every connected user — one curl was a total outage.
    rel = reqPath === "/" ? "index.html" : decodeURIComponent(reqPath.slice(1)).split("?")[0];
  } catch {
    return send(res, 400, "Bad request path");
  }
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, MIME[path.extname(full).toLowerCase()] || "application/octet-stream");
  });
}
function readJsonBody(req, maxBytes = 200_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > maxBytes) {
        req.destroy();
        reject(new Error("Request too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Couldn't parse that request."));
      }
    });
    req.on("error", () => reject(new Error("Couldn't read that request.")));
  });
}
function isMock() {
  return String(process.env.JEV_MOCK ?? "true").toLowerCase() !== "false";
}

/**
 * Resolve the caller identity: a verified Pro licence key, else the
 * browser's signed session. Inbox data is keyed by this.
 *
 * The free→Pro migration is keyed on the caller's own session cookie,
 * which they must actually hold — it can no longer be aimed at a
 * stranger's data by forging an IP header.
 */
async function resolveIdentity(req, res, body) {
  const sid = ensureSession(req, res);
  const freeId = `free:${sid}`;
  const rawKey = cleanKey((body && body.key) || req.headers["x-license-key"] || "");
  if (rawKey) {
    let pro = !!getCachedLicense(rawKey);
    if (!pro) {
      try {
        pro = !!(await verifyLicense(rawKey)).ok;
      } catch {
        /* fall through to free */
      }
    }
    if (pro) {
      migrateInboxData(freeId, rawKey);
      migrateCards(freeId, rawKey);
      return { tier: "pro", id: rawKey, sid };
    }
  }
  return { tier: "free", id: freeId, sid };
}

/** Threads worth spending Jev calls on: a real external contact + substance. */
export function qualifiesForClassification(thread) {
  if (!thread.primaryContact || !thread.primaryContact.address || thread.primaryContact.address === "__unknown__") return false;
  const sentText = thread.messages.filter((m) => m.sentByUser).map((m) => `${m.subject}\n${m.text}`).join("\n");
  if (QUOTE_RE.test(sentText) || INVOICE_RE.test(sentText)) return true;
  return thread.messageCount >= 2;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Classify candidate threads and upsert cards. Sequential, polite to the API. */
async function classifyThreads(id, threads, { usageTier = null } = {}) {
  const candidates = [...threads.values()].filter(qualifiesForClassification);
  if (usageTier === "pro" && candidates.length > 0) {
    // Charge the real question count, not one per thread. classifyThread
    // asks up to QUESTIONS_PER_THREAD in a single request; billing the
    // budget per-thread undercounted actual usage ~4x.
    const gate = consumeUsage("pro", id, candidates.length * QUESTIONS_PER_THREAD);
    if (!gate.allowed) {
      throw new Error(
        `Pro classification budget used up (${proMonthlyLimit().toLocaleString()}/month). It resets on the 1st.`
      );
    }
  }
  const results = [];
  for (const thread of candidates) {
    try {
      const result = await classifyThread(jev, thread);
      results.push({ thread, result });
    } catch (err) {
      console.error("[quoterevive] classify failed for a thread:", String((err && err.message) || err).slice(0, 160));
    }
    await sleep(120); // be polite to the Jev API between threads
  }
  return upsertCards(id, results);
}

/** Full scan pipeline: backfill → classify → finish. Runs in background. */
async function runScanPipeline(id, tier) {
  const userEmail = getInboxUserEmail(id);
  const maxMessages = tier === "pro" ? PRO_SCAN_MESSAGE_CAP : FREE_SCAN_MESSAGE_CAP;
  const backfill = await runBackfill(id, userEmail, { maxMessages });
  if (!backfill.ok) return backfill;
  try {
    const threads = rethreadKey(id, userEmail);
    await classifyThreads(id, threads, { usageTier: tier === "pro" ? "pro" : null });
    finishScan(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
}

function scanInBackground(id, tier) {
  setImmediate(() => {
    runScanPipeline(id, tier).catch((err) => {
      console.error("[quoterevive] background scan failed:", String((err && err.message) || err).slice(0, 200));
    });
  });
}

/** 10-minute poll: new mail → re-thread → classify changed/newly-dead threads. */
async function pollAllInboxes() {
  for (const id of listInboxKeys()) {
    try {
      const userEmail = getInboxUserEmail(id);
      const { ok, records } = await pollNewMail(id, userEmail);
      if (!ok || !records.length) continue;
      const threads = rethreadKey(id, userEmail);
      const touched = new Set(records.map((r) => `${r.folder}\u0000${r.uid}`));
      const affected = [...threads.values()].filter(
        (t) => t.messages.some((m) => touched.has(`${m.folder}\u0000${m.uid}`)) && qualifiesForClassification(t)
      );
      if (!affected.length) continue;
      const results = [];
      for (const thread of affected) {
        try {
          results.push({ thread, result: await classifyThread(jev, thread) });
        } catch (err) {
          console.error("[quoterevive] poll classify failed:", String((err && err.message) || err).slice(0, 160));
        }
        await sleep(120);
      }
      upsertCards(id, results);
    } catch (err) {
      console.error("[quoterevive] poll failed for an inbox:", String((err && err.message) || err).slice(0, 200));
    }
  }
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return send(res, 400, "Bad request");
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, mode: isMock() ? "mock" : "live", model: jevModel(), app: "quoterevive" });
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    return sendJson(res, 200, { gumroadUrl: String(process.env.GUMROAD_URL || "").trim() });
  }

  if (url.pathname === "/api/license" && req.method === "POST") {
    readJsonBody(req, 10_000)
      .then(async (body) => {
        try {
          return sendJson(res, 200, await verifyLicense(body && body.key));
        } catch {
          return sendJson(res, 200, { ok: false, error: "Couldn't verify the key right now — try again in a minute." });
        }
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (url.pathname === "/api/inbox/connect" && req.method === "POST") {
    readJsonBody(req, 10_000)
      .then(async (body) => {
        const { tier, id } = await resolveIdentity(req, res, body);
        const host = String((body && body.host) || "").trim();
        const port = Number((body && body.port) || 993);
        const user = String((body && body.user) || "").trim();
        const pass = String((body && body.pass) || "");
        if (!host || !user || !pass) {
          return sendJson(res, 400, { ok: false, error: "Host, username, and app-password are all required." });
        }
        if (!Number.isFinite(port) || port < 1 || port > 65535) {
          return sendJson(res, 400, { ok: false, error: "Port must be between 1 and 65535." });
        }
        if (!hasCredentialKey()) {
          return sendJson(res, 500, {
            ok: false,
            error: "Inbox connections aren't set up on this server yet — the admin needs to add the CREDENTIAL_KEY.",
          });
        }
        let folders;
        try {
          // Also locates the Sent folder, and refuses the connection
          // when there isn't one — without it a scan finds nothing.
          ({ folders } = await testInboxConnection({ host, port, user, pass }));
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
        try {
          saveInbox(id, { host, port, user, pass, folders });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
        return sendJson(res, 200, {
          ok: true,
          tier,
          folders,
          message: `Inbox connected (reading ${folders.inbox} + ${folders.sent}) — run a scan to find your dead deals.`,
        });
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (url.pathname === "/api/inbox/disconnect" && req.method === "POST") {
    readJsonBody(req, 10_000)
      .then(async (body) => {
        const { id } = await resolveIdentity(req, res, body);
        disconnectInbox(id);
        deleteCardsForKey(id); // cards belong to the inbox; drop them too
        return sendJson(res, 200, { ok: true, message: "Inbox disconnected." });
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (url.pathname === "/api/inbox/scan" && req.method === "POST") {
    readJsonBody(req, 10_000)
      .then(async (body) => {
        const { tier, id } = await resolveIdentity(req, res, body);
        if (!getInboxPublic(id).connected) {
          return sendJson(res, 400, { ok: false, error: "Connect your inbox first." });
        }
        const progress = getScanProgress(id);
        if (["fetching", "classifying", "starting"].includes(progress.status)) {
          return sendJson(res, 200, { ok: true, message: "A scan is already running.", progress });
        }
        if (tier === "free") {
          const gate = checkFreeScan(clientIp(req));
          if (!gate.allowed) {
            return sendJson(res, 402, {
              ok: false,
              error: `Free scans are limited to ${gate.limit} per day. QuoteRevive Pro scans unlimited — upgrade below.`,
              upgrade: true,
            });
          }
          recordFreeScan(clientIp(req));
        }
        scanInBackground(id, tier);
        return sendJson(res, 200, { ok: true, tier, message: "Scan started — watch the progress bar." });
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (url.pathname === "/api/inbox/scan-progress" && req.method === "GET") {
    (async () => {
      const { id } = await resolveIdentity(req, res, {});
      return sendJson(res, 200, { ok: true, ...getScanProgress(id) });
    })().catch(() => sendJson(res, 500, { ok: false, error: "Couldn't load scan progress." }));
    return;
  }

  if (url.pathname === "/api/inbox/status" && req.method === "GET") {
    (async () => {
      const { tier, id } = await resolveIdentity(req, res, {});
      return sendJson(res, 200, { ok: true, tier, ...getInboxPublic(id) });
    })().catch(() => sendJson(res, 500, { ok: false, error: "Couldn't load inbox status." }));
    return;
  }

  if (url.pathname === "/api/quotes" && req.method === "GET") {
    (async () => {
      const { tier, id } = await resolveIdentity(req, res, {});
      const cards = getCards(id);
      const totals = getPipelineTotals(id);
      const pub = (c) => ({
        id: c.id,
        contact: c.contact,
        type: c.type,
        typeLabel: c.typeLabel,
        stallReason: c.stallReason,
        stallDetail: c.stallDetail,
        dealValue: c.dealValue,
        dealValueOverride: c.dealValueOverride,
        recoverability: c.recoverability,
        expectedValue: c.expectedValue,
        lastActivity: c.lastActivity,
        threadCount: c.threadCount,
        timingBoost: c.timingBoost,
        draft: c.draft,
        nudgedAt: c.nudgedAt,
      });
      if (tier === "pro") {
        return sendJson(res, 200, { ok: true, tier, cards: cards.map(pub), total: totals.total, count: totals.count, locked: 0 });
      }
      return sendJson(res, 200, {
        ok: true,
        tier,
        cards: cards.slice(0, 3).map(pub),
        total: totals.total,
        count: totals.count,
        locked: Math.max(0, totals.count - 3),
      });
    })().catch(() => sendJson(res, 500, { ok: false, error: "Couldn't load your deals." }));
    return;
  }

  const quoteAction = url.pathname.match(/^\/api\/quotes\/([^/]+)\/(nudge|snooze|dismiss|outcome|value)$/);
  if (quoteAction && req.method === "POST") {
    readJsonBody(req, 10_000)
      .then(async (body) => {
        const { id: identity } = await resolveIdentity(req, res, body);
        const [, cardId, action] = quoteAction;
        // Only the owning identity may touch its cards.
        if (!getCard(identity, cardId)) return sendJson(res, 404, { ok: false, error: "Card not found." });
        const result = cardAction(identity, cardId, action, body || {});
        if (!result.ok) return sendJson(res, 400, result);
        return sendJson(res, 200, { ok: true, card: result.card });
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (req.method === "GET") return serveStatic(url.pathname, res);
  return send(res, 405, "Method not allowed");
});

// A bad request must never take the process down with it. Anything
// reaching here is a bug worth fixing, but not worth an outage.
process.on("uncaughtException", (err) => {
  console.error("[quoterevive] uncaught exception:", String((err && err.stack) || err).slice(0, 500));
});
process.on("unhandledRejection", (err) => {
  console.error("[quoterevive] unhandled rejection:", String((err && err.stack) || err).slice(0, 500));
});

startInboxPoller(pollAllInboxes);

server.listen(PORT, () => {
  console.log(
    `QuoteRevive dev server on http://localhost:${PORT}  (mode: ${isMock() ? "mock" : "live"}, model: ${jevModel()})`
  );
  if (!hasSessionSecret()) {
    console.warn("[quoterevive] WARNING: no SESSION_SECRET or CREDENTIAL_KEY — sessions cannot be signed.");
  }
});
