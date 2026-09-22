// ─────────────────────────────────────────────────────────────
// inbox-store.js — connected-inbox plumbing for QuoteRevive.
//
// One IMAP account per identity. The app-password is AES-256-GCM
// encrypted (key from the CREDENTIAL_KEY env var) and stored in
// data/inboxes.json.
//
// FOLDERS: QuoteRevive reads BOTH the INBOX and the Sent folder. The
// whole product depends on it — a dead quote is something the owner
// SENT, and sent mail never appears in INBOX. Sent is discovered via
// the RFC 6154 \Sent special-use flag, with name matching as a
// fallback ("Sent Items", "[Gmail]/Sent Mail", ...). A mailbox with no
// discoverable Sent folder is REFUSED at connect time rather than
// silently producing an empty dashboard.
//
// UIDs are per-folder, so the message cache is keyed by folder+uid and
// every record carries its folder. UIDVALIDITY is tracked per folder;
// when the server changes it, that folder's cache and cursor reset.
//
// Backfill is paginated and resumable: data/scan.json persists the
// per-folder UID snapshot + cursor, so a crash restarts mid-scan.
// A background poller runs every 10 minutes for newly-dead detection.
//
// Never log credentials or email bodies.
// ─────────────────────────────────────────────────────────────
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";

const ROOT = fileURLToPath(new URL("./", import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const INBOXES_FILE = path.join(DATA_DIR, "inboxes.json");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const SCAN_FILE = path.join(DATA_DIR, "scan.json");

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const MAX_MESSAGES_PER_INBOX = 2000;
const BACKFILL_PAGE_SIZE = 200;
const CONNECT_TIMEOUT_MS = 25000;
const MAX_BODY_CHARS = 4000;

export const INBOX_FOLDER = "INBOX";
/** Separator for cache keys. NUL can't occur in a mailbox path. */
const CACHE_SEP = "\u0000";

// Fallback Sent-folder names, checked case-insensitively when the
// server doesn't advertise the \Sent special-use flag.
const SENT_NAME_PATTERNS = [
  /^sent$/i,
  /^sent items$/i,
  /^sent mail$/i,
  /^sent messages$/i,
  /^\[gmail\][/.]sent mail$/i,
  /^inbox[/.]sent$/i,
  /(^|[/.])sent([/.]|$)/i, // last resort: a path component literally named "sent"
];

// ── swappable IMAP client (tests inject a fake) ──
let ClientClass = ImapFlow;
/** Test hook: swap the IMAP client implementation. Pass nothing to restore. */
export function _setImapClientForTests(cls) {
  ClientClass = cls || ImapFlow;
}

// ── tiny JSON storage ──
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

function readInboxes() {
  const d = readJson(INBOXES_FILE, {});
  return d && typeof d === "object" ? d : {};
}
function writeInboxes(obj) {
  writeJson(INBOXES_FILE, obj);
}
function readMessages() {
  const d = readJson(MESSAGES_FILE, {});
  return d && typeof d === "object" ? d : {};
}
function writeMessages(obj) {
  writeJson(MESSAGES_FILE, obj);
}
function readScans() {
  const d = readJson(SCAN_FILE, {});
  return d && typeof d === "object" ? d : {};
}
function writeScans(obj) {
  writeJson(SCAN_FILE, obj);
}

// ── credential encryption (AES-256-GCM) ──
function credentialKey() {
  const raw = String(process.env.CREDENTIAL_KEY || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  return Buffer.from(raw, "hex");
}

/** True when CREDENTIAL_KEY is present and well-formed. */
export function hasCredentialKey() {
  return credentialKey() !== null;
}

function encryptSecret(plaintext) {
  const key = credentialKey();
  if (!key) throw new Error("CREDENTIAL_KEY is not configured on this server.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptSecret(enc) {
  const key = credentialKey();
  if (!key) throw new Error("CREDENTIAL_KEY is not configured on this server.");
  if (!enc || typeof enc !== "object" || !enc.iv || !enc.tag || !enc.data) {
    throw new Error("Stored inbox credentials are unreadable.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(enc.data, "base64")), decipher.final()]).toString("utf8");
}

// ── helpers ──
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out ${what} — check the host and port.`)), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

/** Map IMAP errors to human-friendly messages. Never includes secrets. */
function friendlyImapError(err, host) {
  const msg = String((err && err.message) || err || "");
  if (/AUTHENTICATIONFAILED|invalid credentials|login failed/i.test(msg)) {
    return "IMAP login failed — double-check the username and app-specific password.";
  }
  if (/timed out/i.test(msg)) return msg;
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return `Couldn't reach ${host} — check the IMAP host name.`;
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${host} — check the host and port.`;
  if (/certificate|self signed|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(msg)) {
    return `TLS certificate problem with ${host} — the server's certificate isn't trusted.`;
  }
  return `Couldn't talk to ${host}: ${msg.slice(0, 160)}`;
}

/** Scrub secret values out of a string before it is logged or stored. */
function scrub(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets || []) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out;
}

function makeClient({ host, port, user, pass }) {
  return new ClientClass({
    host: String(host).trim(),
    port: Number(port) || 993,
    secure: true,
    logger: false,
    auth: { user: String(user).trim(), pass: String(pass) },
  });
}

function markFailed(inboxes, k, message) {
  const rec = inboxes[k];
  if (!rec) return { ok: false, error: message };
  rec.failCount = (rec.failCount || 0) + 1;
  rec.lastFailedAt = Date.now();
  rec.lastError = String(message).slice(0, 300);
  writeInboxes(inboxes);
  return { ok: false, error: rec.lastError };
}

function markOk(inboxes, k, lastUids) {
  const rec = inboxes[k];
  if (!rec) return;
  rec.lastChecked = new Date().toISOString();
  if (lastUids && typeof lastUids === "object") rec.lastUids = { ...(rec.lastUids || {}), ...lastUids };
  rec.lastError = "";
  rec.failCount = 0;
  rec.lastFailedAt = 0;
  writeInboxes(inboxes);
}

// ── Sent-folder discovery ────────────────────────────────────
//
// The single most important piece of plumbing in the app. Without the
// Sent folder, `sentByUser` is false for every message, the
// directionality guard in quote-classify.js demotes every card, and
// the dashboard is empty. Fail loudly, never silently.

/**
 * Find the Sent folder on an open client. Prefers the RFC 6154
 * \Sent special-use flag, falls back to well-known names.
 * Returns the mailbox path, or null when there is genuinely none.
 */
export async function discoverSentFolder(client) {
  let boxes = [];
  try {
    boxes = (await withTimeout(client.list(), CONNECT_TIMEOUT_MS, "listing mailboxes")) || [];
  } catch {
    return null;
  }
  const normalized = (Array.isArray(boxes) ? boxes : []).map((b) => ({
    path: String((b && b.path) || ""),
    name: String((b && b.name) || ""),
    // imapflow exposes specialUse as "\\Sent"; some servers only set flags.
    special: String((b && b.specialUse) || ""),
    flags: b && b.flags ? [...b.flags].map(String) : [],
  })).filter((b) => b.path);

  const bySpecialUse = normalized.find(
    (b) => /^\\sent$/i.test(b.special) || b.flags.some((f) => /^\\sent$/i.test(f))
  );
  if (bySpecialUse) return bySpecialUse.path;

  for (const re of SENT_NAME_PATTERNS) {
    const hit = normalized.find((b) => re.test(b.path) || re.test(b.name));
    if (hit) return hit.path;
  }
  return null;
}

// ── connection helpers ──

/** Connect, run fn(client), always log out. Does not open a mailbox. */
async function withClient({ host, port, user, pass }, fn) {
  const client = makeClient({ host, port, user, pass });
  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, "connecting");
    return await fn(client);
  } finally {
    try {
      await withTimeout(client.logout(), 8000, "disconnecting");
    } catch {
      /* best effort */
    }
  }
}

/** Open one mailbox, run fn(client, mailbox), always release the lock. */
async function withFolder(client, folderPath, fn) {
  const lock = await withTimeout(
    client.getMailboxLock(folderPath),
    CONNECT_TIMEOUT_MS,
    `opening ${folderPath}`
  );
  try {
    return await fn(client, client.mailbox || {});
  } finally {
    lock.release();
  }
}

/** UIDVALIDITY as a plain number (imapflow may hand back a BigInt). */
function uidValidityOf(mailbox) {
  const raw = mailbox && mailbox.uidValidity;
  if (raw === undefined || raw === null) return 0;
  try {
    return Number(raw);
  } catch {
    return 0;
  }
}

// ── public connection API ──

/**
 * Verify IMAP credentials with a real login AND locate the Sent folder
 * before saving anything. Throws a human-friendly Error on failure.
 * Returns { ok, folders: { inbox, sent } } on success.
 */
export async function testInboxConnection({ host, port, user, pass }) {
  let sent = null;
  try {
    await withClient({ host, port, user, pass }, async (client) => {
      await withFolder(client, INBOX_FOLDER, async () => {
        await withTimeout(
          client.status(INBOX_FOLDER, { messages: true }),
          CONNECT_TIMEOUT_MS,
          "reading mailbox status"
        );
      });
      sent = await discoverSentFolder(client);
    });
  } catch (err) {
    throw new Error(friendlyImapError(err, host));
  }
  if (!sent) {
    throw new Error(
      "Connected, but QuoteRevive couldn't find your Sent folder — and dead quotes live in sent mail, " +
        "so a scan would come back empty. If your provider names it something unusual, get in touch and " +
        "we'll add it."
    );
  }
  return { ok: true, folders: { inbox: INBOX_FOLDER, sent } };
}

/** Persist an inbox for an identity (password encrypted). Overwrites any previous inbox. */
export function saveInbox(key, { host, port, user, pass, folders }) {
  const k = String(key || "").trim();
  if (!k) throw new Error("A valid identity is required.");
  const sent = String((folders && folders.sent) || "").trim();
  if (!sent) throw new Error("Refusing to save an inbox with no Sent folder — a scan would find nothing.");
  const inboxes = readInboxes();
  inboxes[k] = {
    host: String(host).trim(),
    port: Math.min(65535, Math.max(1, Number(port) || 993)),
    user: String(user).trim(),
    pass: encryptSecret(pass), // throws when CREDENTIAL_KEY is missing
    folders: { inbox: INBOX_FOLDER, sent },
    connectedAt: new Date().toISOString(),
    lastChecked: null,
    lastUids: {},
    uidValidity: {},
    lastError: "",
    failCount: 0,
    lastFailedAt: 0,
  };
  writeInboxes(inboxes);
  return { ok: true };
}

/** Public-safe inbox info — never includes the password. */
export function getInboxPublic(key) {
  const k = String(key || "").trim();
  const rec = readInboxes()[k];
  if (!rec) return { connected: false };
  return {
    connected: true,
    host: rec.host,
    port: rec.port,
    user: rec.user,
    folders: rec.folders || { inbox: INBOX_FOLDER, sent: "" },
    connectedAt: rec.connectedAt,
    lastChecked: rec.lastChecked,
    lastError: rec.lastError || "",
  };
}

/** The IMAP login address doubles as the user's own email for directionality. */
export function getInboxUserEmail(key) {
  const k = String(key || "").trim();
  const rec = readInboxes()[k];
  return rec ? String(rec.user || "").trim().toLowerCase() : "";
}

/** Folders to scan for an identity, inbox first. */
export function getInboxFolders(key) {
  const k = String(key || "").trim();
  const rec = readInboxes()[k];
  if (!rec) return [];
  const f = rec.folders || {};
  return [f.inbox || INBOX_FOLDER, f.sent].filter(Boolean);
}

/** Remove an inbox and all its cached data for an identity. */
export function disconnectInbox(key) {
  const k = String(key || "").trim();
  const inboxes = readInboxes();
  delete inboxes[k];
  writeInboxes(inboxes);
  const msgs = readMessages();
  delete msgs[k];
  writeMessages(msgs);
  const scans = readScans();
  delete scans[k];
  writeScans(scans);
  return { ok: true };
}

/**
 * Move an inbox, its cached mail, and its scan state from one identity
 * to another (free → pro upgrade). Only migrates into a target with no
 * inbox yet, so pro data is never clobbered. Returns true when moved.
 */
export function migrateInboxData(fromKey, toKey) {
  const f = String(fromKey || "").trim();
  const t = String(toKey || "").trim();
  if (!f || !t || f === t) return false;
  const inboxes = readInboxes();
  if (!inboxes[f] || inboxes[t]) return false;
  inboxes[t] = inboxes[f];
  delete inboxes[f];
  writeInboxes(inboxes);
  const msgs = readMessages();
  if (msgs[f]) {
    msgs[t] = msgs[f];
    delete msgs[f];
    writeMessages(msgs);
  }
  const scans = readScans();
  if (scans[f]) {
    scans[t] = scans[f];
    delete scans[f];
    writeScans(scans);
  }
  return true;
}

// ── message cache (keyed by folder + uid) ──

function cacheKey(folder, uid) {
  return `${folder}${CACHE_SEP}${uid}`;
}

/** Newest-first sort: by date, then folder/uid so ordering is stable. */
function byNewest(a, b) {
  const d = String(b.date || "").localeCompare(String(a.date || ""));
  if (d !== 0) return d;
  return String(cacheKey(b.folder, b.uid)).localeCompare(String(cacheKey(a.folder, a.uid)));
}

/** All cached raw messages for an identity, newest first. */
export function getCachedMessages(key) {
  const k = String(key || "").trim();
  const byId = readMessages()[k] || {};
  return Object.values(byId).sort(byNewest);
}

/** Merge records into the cache; prune to the newest MAX_MESSAGES_PER_INBOX. */
export function cacheMessages(key, records) {
  const k = String(key || "").trim();
  const store = readMessages();
  const byId = store[k] || {};
  for (const r of records || []) {
    if (!r || typeof r.uid !== "number") continue;
    byId[cacheKey(r.folder || INBOX_FOLDER, r.uid)] = r;
  }
  const pruned = {};
  for (const r of Object.values(byId).sort(byNewest).slice(0, MAX_MESSAGES_PER_INBOX)) {
    pruned[cacheKey(r.folder || INBOX_FOLDER, r.uid)] = r;
  }
  store[k] = pruned;
  writeMessages(store);
  return { cached: Object.keys(pruned).length };
}

/** Drop every cached message for one folder (UIDVALIDITY change). */
function dropFolderCache(key, folder) {
  const k = String(key || "").trim();
  const store = readMessages();
  const byId = store[k] || {};
  for (const id of Object.keys(byId)) {
    if (byId[id] && (byId[id].folder || INBOX_FOLDER) === folder) delete byId[id];
  }
  store[k] = byId;
  writeMessages(store);
}

// ── MIME text extraction ──
function walkParts(node, out = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  for (const child of node.childNodes || []) walkParts(child, out);
  return out;
}

/** Prefer the first text/plain part, else the first text/html part. */
function pickTextPart(bodyStructure) {
  const nodes = walkParts(bodyStructure);
  const plain = nodes.find((n) => String(n.type || "").toLowerCase() === "text/plain" && n.part);
  if (plain) return { node: plain, html: false };
  const html = nodes.find((n) => String(n.type || "").toLowerCase() === "text/html" && n.part);
  if (html) return { node: html, html: true };
  return null;
}

function decodeQuotedPrintable(str) {
  return str.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodePartBuffer(buf, node, wasBinary) {
  const encoding = String(node.encoding || "7bit").toLowerCase();
  let bytes = buf;
  if (!wasBinary) {
    if (encoding === "base64") {
      try {
        bytes = Buffer.from(buf.toString("ascii").replace(/\s+/g, ""), "base64");
      } catch {
        /* keep raw bytes */
      }
    } else if (encoding === "quoted-printable") {
      bytes = Buffer.from(decodeQuotedPrintable(buf.toString("binary")), "binary");
    }
  }
  const charset = String((node.parameters && node.parameters.charset) || "utf-8").toLowerCase();
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return bytes.toString("latin1");
    }
  }
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function envelopeDate(env) {
  try {
    const d = env && env.date ? new Date(env.date) : null;
    return d && !isNaN(d.getTime()) ? d.toISOString() : "";
  } catch {
    return "";
  }
}

function addrList(list) {
  return (Array.isArray(list) ? list : [])
    .map((a) => ({ name: String((a && a.name) || ""), address: String((a && a.address) || "").toLowerCase() }))
    .filter((a) => a.address);
}

/**
 * Build a QuoteRevive message record from a fetched IMAP message.
 *
 * `sentByUser` is the hinge the whole product turns on. A message is
 * the owner's when it came from their address OR it was found in their
 * Sent folder — the second clause matters because plenty of people send
 * from an alias that differs from the IMAP login.
 */
function toRecord(meta, body, userEmail, folder, isSentFolder) {
  const env = meta.envelope || {};
  const from = addrList(env.from)[0] || { name: "", address: "" };
  const subject = String(env.subject || "(no subject)");
  let text = "";
  const pick = pickTextPart(meta.bodyStructure);
  if (pick && body && body.bodyParts) {
    const buf = body.bodyParts.get(pick.node.part);
    if (buf) {
      const wasBinary = !!(body.binaryParts && body.binaryParts.has(pick.node.part));
      text = decodePartBuffer(buf, pick.node, wasBinary);
      if (pick.html) text = stripHtml(text);
    }
  }
  text = text.replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS);
  return {
    uid: meta.uid,
    folder,
    from,
    to: addrList(env.to),
    cc: addrList(env.cc),
    subject,
    date: envelopeDate(env),
    sentByUser: !!isSentFolder || (from.address === userEmail && userEmail !== ""),
    text,
  };
}

/** Fetch full records for an explicit UID list (one round trip per phase). */
async function fetchRecords(client, uids, userEmail, folder, isSentFolder) {
  if (!uids.length) return [];
  const metas = [];
  for await (const msg of client.fetch(uids, { uid: true, envelope: true, bodyStructure: true })) {
    metas.push(msg);
  }
  const partNums = [
    ...new Set(
      metas
        .map((m) => pickTextPart(m.bodyStructure))
        .filter(Boolean)
        .map((p) => p.node.part)
    ),
  ];
  const bodies = new Map();
  if (partNums.length > 0) {
    const metaUids = metas.map((m) => m.uid);
    for await (const msg of client.fetch(metaUids, { uid: true, bodyParts: partNums })) {
      bodies.set(msg.uid, msg);
    }
  }
  return metas.map((m) => toRecord(m, bodies.get(m.uid) || null, userEmail, folder, isSentFolder));
}

/** Open a connection for a stored identity, mapping errors to friendly text. */
async function withStoredClient(key, fn) {
  const k = String(key || "").trim();
  const inboxes = readInboxes();
  const rec = inboxes[k];
  if (!rec) throw new Error("No inbox connected for this account.");
  let pass;
  try {
    pass = decryptSecret(rec.pass);
  } catch (err) {
    markFailed(inboxes, k, err.message);
    throw err;
  }
  try {
    return await withClient({ host: rec.host, port: rec.port, user: rec.user, pass }, (client) =>
      fn(client, rec, inboxes, k)
    );
  } catch (err) {
    if (err && err.message && /Couldn't talk to|IMAP login failed|TLS certificate|Timed out/.test(err.message)) {
      markFailed(inboxes, k, err.message);
      throw err;
    }
    const friendly = scrub(friendlyImapError(err, rec.host), [pass]);
    markFailed(inboxes, k, friendly);
    throw new Error(friendly);
  }
}

// ── backfill: paginated + resumable, across every folder ──

const activeScans = new Set();

/** All connected inbox identities. */
export function listInboxKeys() {
  return Object.keys(readInboxes());
}

/** Current scan progress for the UI to poll. */
export function getScanProgress(key) {
  const k = String(key || "").trim();
  const s = readScans()[k];
  if (!s) return { status: "idle", total: 0, done: 0, pct: 0 };
  const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
  return {
    status: s.status,
    total: s.total,
    done: s.done,
    pct,
    folders: Object.keys(s.folders || {}),
    error: s.error || "",
    startedAt: s.startedAt || null,
    finishedAt: s.finishedAt || null,
  };
}

function saveScanState(key, state) {
  const k = String(key || "").trim();
  const scans = readScans();
  scans[k] = state;
  writeScans(scans);
}

/**
 * Backfill the newest mail across every scanned folder, page by page.
 * Resumable: the per-folder UID snapshot + cursor persist in
 * data/scan.json, so a crash restarts mid-scan rather than from zero.
 *
 * `maxMessages` is split evenly across folders so sent mail is always
 * covered — it is where every dead quote and unpaid invoice lives, and
 * a budget spent entirely on INBOX would find nothing.
 */
export async function runBackfill(key, userEmail, { pageSize = BACKFILL_PAGE_SIZE, maxMessages = MAX_MESSAGES_PER_INBOX } = {}) {
  const k = String(key || "").trim();
  if (activeScans.has(k)) return { ok: false, error: "A scan is already running for this inbox." };
  activeScans.add(k);
  try {
    const folders = getInboxFolders(k);
    if (!folders.length) return { ok: false, error: "No inbox connected for this account." };
    const perFolder = Math.max(1, Math.floor(maxMessages / folders.length));

    let state = readScans()[k];
    const fresh =
      !state ||
      state.status === "done" ||
      state.status === "error" ||
      state.status === "idle" ||
      !state.folders ||
      // folder set changed since the interrupted scan — start over
      folders.some((f) => !state.folders[f]);
    if (fresh) {
      state = {
        status: "starting",
        folders: Object.fromEntries(folders.map((f) => [f, { uids: [], cursor: 0, uidValidity: 0 }])),
        total: 0,
        done: 0,
        error: "",
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
    } else {
      state.status = "fetching";
      state.error = "";
    }
    saveScanState(k, state);

    return await withStoredClient(k, async (client, rec, inboxes, kk) => {
      for (const folder of folders) {
        const isSent = folder !== INBOX_FOLDER;
        const fState = state.folders[folder];
        await withFolder(client, folder, async (c, mailbox) => {
          const uidValidity = uidValidityOf(mailbox);
          // UIDVALIDITY changed: every cached UID for this folder is meaningless.
          if (fState.uidValidity && uidValidity && fState.uidValidity !== uidValidity) {
            dropFolderCache(kk, folder);
            fState.uids = [];
            fState.cursor = 0;
            if (rec.lastUids) delete rec.lastUids[folder];
          }
          fState.uidValidity = uidValidity || fState.uidValidity || 0;

          if (fState.uids.length === 0) {
            let uids = [];
            try {
              uids = await withTimeout(c.search({ all: true }, { uid: true }), CONNECT_TIMEOUT_MS, "listing messages");
            } catch {
              const status = await withTimeout(
                c.status(folder, { messages: true }),
                CONNECT_TIMEOUT_MS,
                "reading mailbox status"
              );
              const total = Number(status.messages || 0);
              uids = Array.from({ length: total }, (_, i) => i + 1);
            }
            uids = (Array.isArray(uids) ? uids : []).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
            fState.uids = uids.slice(0, perFolder);
            state.total += fState.uids.length;
            state.status = "fetching";
            saveScanState(kk, state);
          }

          while (fState.cursor < fState.uids.length) {
            const page = fState.uids.slice(fState.cursor, fState.cursor + pageSize);
            const records = await withTimeout(
              fetchRecords(c, page, userEmail, folder, isSent),
              CONNECT_TIMEOUT_MS * 3,
              "fetching a page of mail"
            );
            cacheMessages(kk, records);
            fState.cursor += page.length;
            state.done += records.length;
            saveScanState(kk, state);
          }

          // Watermark the poller so it picks up from here.
          const highest = fState.uids.length ? Math.max(...fState.uids) : 0;
          markOk(inboxes, kk, { [folder]: highest });
        });
      }

      state.status = "classifying";
      saveScanState(kk, state);
      return { ok: true, fetched: state.done };
    });
  } catch (err) {
    const state = readScans()[k] || {};
    state.status = "error";
    state.error = String((err && err.message) || err).slice(0, 300);
    saveScanState(k, state);
    return { ok: false, error: state.error };
  } finally {
    activeScans.delete(k);
  }
}

/** Mark the scan fully done (called after classification pass). */
export function finishScan(key) {
  const k = String(key || "").trim();
  const state = readScans()[k];
  if (!state) return;
  state.status = "done";
  state.finishedAt = new Date().toISOString();
  saveScanState(k, state);
}

/**
 * Fetch mail newer than the per-folder watermark across every scanned
 * folder (the 10-minute poll path). A quote you sent five minutes ago
 * only shows up here because Sent is polled too.
 * Never throws for inbox-level problems.
 */
export async function pollNewMail(key, userEmail) {
  const k = String(key || "").trim();
  const inboxes = readInboxes();
  const rec = inboxes[k];
  if (!rec) return { ok: false, error: "No inbox connected for this account.", records: [] };

  const now = Date.now();
  if (rec.failCount >= 3 && rec.lastFailedAt) {
    const backoffMs = Math.min(POLL_INTERVAL_MS * 2 ** (rec.failCount - 3), 2 * 60 * 60 * 1000);
    if (now - rec.lastFailedAt < backoffMs) return { ok: true, skipped: true, records: [] };
  }

  const folders = getInboxFolders(k);
  try {
    const all = await withStoredClient(k, async (client, recInner, inboxesInner, kk) => {
      const collected = [];
      const watermarks = {};
      for (const folder of folders) {
        const isSent = folder !== INBOX_FOLDER;
        await withFolder(client, folder, async (c, mailbox) => {
          const uidValidity = uidValidityOf(mailbox);
          const storedValidity = Number((recInner.uidValidity || {})[folder] || 0);
          if (storedValidity && uidValidity && storedValidity !== uidValidity) {
            // Folder was rebuilt server-side; drop and re-watermark.
            dropFolderCache(kk, folder);
            if (recInner.lastUids) delete recInner.lastUids[folder];
          }
          recInner.uidValidity = { ...(recInner.uidValidity || {}), [folder]: uidValidity || storedValidity || 0 };

          const lastUid = Number((recInner.lastUids || {})[folder] || 0);
          if (lastUid <= 0) {
            // No scan yet for this folder: just establish the watermark.
            const status = await withTimeout(
              c.status(folder, { messages: true }),
              CONNECT_TIMEOUT_MS,
              "reading mailbox status"
            );
            watermarks[folder] = Number(status.messages || 0);
            return;
          }
          const metas = [];
          for await (const msg of c.fetch(`${lastUid + 1}:*`, { uid: true, envelope: true, bodyStructure: true })) {
            if (msg.uid > lastUid) metas.push(msg);
          }
          if (!metas.length) {
            watermarks[folder] = lastUid;
            return;
          }
          const records = await withTimeout(
            fetchRecords(c, metas.map((m) => m.uid), userEmail, folder, isSent),
            CONNECT_TIMEOUT_MS * 3,
            "fetching new mail"
          );
          cacheMessages(kk, records);
          collected.push(...records);
          watermarks[folder] = Math.max(lastUid, ...metas.map((m) => m.uid));
        });
      }
      markOk(inboxesInner, kk, watermarks);
      return collected;
    });
    return { ok: true, records: all || [] };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300), records: [] };
  }
}

// ── background poller ──
let pollTimer = null;

/** Start the background poller (every 10 minutes). Safe to call twice. */
export function startInboxPoller(pollFn, intervalMs = POLL_INTERVAL_MS) {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    pollFn().catch((err) => {
      console.error("[quoterevive] poller error:", String((err && err.message) || err).slice(0, 200));
    });
  }, intervalMs);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
}

export function stopInboxPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
