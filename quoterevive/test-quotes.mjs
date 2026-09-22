// QuoteRevive test suite — mocked Jev + fake IMAP. No real mailbox, no network.
// Run: npm test
//
// The fake IMAP server models TWO folders with INDEPENDENT UID spaces,
// because that is what a real account looks like: mail you received is
// in INBOX, mail you sent is in Sent, and UID 1 exists in both. The
// previous fixture put the owner's sent mail straight into INBOX, which
// no IMAP server does — so 21 tests passed against a mailbox that
// cannot exist while the shipped product found zero deals.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "data");

// ── env for the whole suite (must be set before server.js is imported) ───
process.env.JEV_MOCK = "true";
process.env.CREDENTIAL_KEY = "ab".repeat(32); // 64 hex chars
process.env.SESSION_SECRET = "test-session-secret-value";
process.env.QR_INSECURE_COOKIES = "true"; // plain http in tests
process.env.PORT = "18923";

import { createJevClient, normalizeAnswer } from "./jev-client.js";
import {
  _setImapClientForTests,
  saveInbox,
  runBackfill,
  getScanProgress,
  pollNewMail,
  listInboxKeys,
  getCachedMessages,
  discoverSentFolder,
  testInboxConnection,
} from "./inbox-store.js";
import {
  classifyThread,
  extractDealCandidates,
  pickDealValue,
  extractPromisedTime,
  draftForCard,
} from "./quote-classify.js";
import {
  threadMessages,
  normalizeSubject,
  rethreadKey,
  upsertCards,
  getCards,
  cardAction,
  getPipelineTotals,
  deleteCardsForKey,
  resetFreeScanForTests,
  getOutcomeWeights,
  stallMultiplier,
  timingBoostFor,
} from "./quote-store.js";

// server.js starts listening on import; also exports qualifiesForClassification
const { qualifiesForClassification } = await import("./server.js");

// hermetic: start from a clean data dir (and leave it clean at the end)
function cleanData() {
  try {
    for (const f of fs.readdirSync(DATA)) {
      if (f.endsWith(".json")) fs.unlinkSync(path.join(DATA, f));
    }
  } catch { /* no data dir yet */ }
}
cleanData();
resetFreeScanForTests();

const jev = createJevClient({ mock: true });
const USER = "me@mybiz.com";

// ── fake IMAP with real folder semantics ─────────────────────────────────
const SENT_PATH = "[Gmail]/Sent Mail";
let FAKE_FOLDERS = { INBOX: [], [SENT_PATH]: [] };
let FAKE_LIST = [
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", flags: new Set(["\\HasNoChildren"]) },
  { path: "Drafts", name: "Drafts", specialUse: "\\Drafts", flags: new Set() },
  { path: SENT_PATH, name: "Sent Mail", specialUse: "\\Sent", flags: new Set() },
];
let bodyFetchCalls = 0;

class FakeImap {
  constructor(_opts) {
    this.connected = false;
    this.mailbox = null;
    this.current = null;
  }
  async connect() { this.connected = true; }
  async logout() { this.connected = false; }
  async list() { return FAKE_LIST; }
  async getMailboxLock(p) {
    if (!FAKE_FOLDERS[p]) throw new Error(`Mailbox does not exist: ${p}`);
    this.current = p;
    this.mailbox = { path: p, uidValidity: 42 };
    return { release: () => { this.current = null; } };
  }
  async status(p) { return { messages: (FAKE_FOLDERS[p] || []).length }; }
  async search() { return (FAKE_FOLDERS[this.current] || []).map((m) => m.uid); }
  async *fetch(uidsOrRange, opts) {
    const box = FAKE_FOLDERS[this.current] || [];
    let list;
    if (typeof uidsOrRange === "string") {
      const [a, b] = uidsOrRange.split(":");
      const lo = Number(a);
      const hi = b === "*" ? Infinity : Number(b);
      list = box.filter((m) => m.uid >= lo && m.uid <= hi);
    } else {
      const set = new Set(uidsOrRange.map(Number));
      list = box.filter((m) => set.has(m.uid));
    }
    if (opts.bodyParts) {
      bodyFetchCalls++;
      for (const m of list) {
        yield { uid: m.uid, bodyParts: new Map([["1", Buffer.from(m.text, "utf8")]]), binaryParts: new Set() };
      }
    } else {
      for (const m of list) {
        yield {
          uid: m.uid,
          envelope: { from: [m.from], to: m.to, cc: m.cc || [], subject: m.subject, date: new Date(m.date) },
          bodyStructure: { type: "text/plain", part: "1", encoding: "7bit", parameters: { charset: "utf-8" }, childNodes: [] },
        };
      }
    }
  }
}
_setImapClientForTests(FakeImap);

// ── fixture mailbox: received in INBOX, sent in Sent ─────────────────────
function msg(uid, from, to, subject, date, text) {
  return { uid, from, to: Array.isArray(to) ? to : [to], subject, date, text };
}
const ME = { name: "Myself", address: USER };
const BOB = { name: "Bob Home", address: "bob@home.com" };
const VENDOR = { name: "SupplyCo", address: "vendor@supply.com" };
const NEWS = { name: "Deal News", address: "news@deals.com" };
const CAROL = { name: "Carol Biz", address: "carol@biz.com" };
const DAVE = { name: "Dave Co", address: "dave@co.com" };
const ERIN = { name: "Erin Shop", address: "erin@shop.com" };
const FRANK = { name: "Frank Office", address: "frank@office.com" };

// UIDs deliberately restart at 1 in each folder — they collide across
// folders, exactly as they do on a real server. A cache keyed on UID
// alone silently loses half this mailbox.
const INBOX_MSGS = [
  msg(1, BOB, ME, "Kitchen remodel", "2026-06-01", "Hi, we're looking for a full kitchen remodel. Can you send a quote?"),
  msg(2, BOB, ME, "Re: Kitchen remodel", "2026-06-05", "Thanks! That's quite a bit more than we budgeted for. We'll need to think about it."),
  msg(3, BOB, ME, "Re: Kitchen remodel", "2026-06-08", "Still thinking it over, will let you know."),
  msg(4, VENDOR, ME, "Invoice #123 from SupplyCo", "2026-07-01", "Please find attached invoice #123 for $500. Payment due in 30 days."),
  msg(5, NEWS, ME, "SALE 20% off everything!", "2026-07-02", "Huge sale this weekend only. Click here to unsubscribe."),
  msg(6, CAROL, ME, "Re: Invoice #456", "2026-07-12", "Got it, thanks — we'll get this paid soon."),
  msg(7, DAVE, ME, "Re: Website redesign proposal", "2026-08-03", "Thanks but we went with someone else. We're all set."),
  msg(8, BOB, ME, "Kitchen remodel follow-up", "2026-06-22", "Sorry for the delay, still deciding."),
  msg(9, ERIN, ME, "Catering quote needed", "2026-09-01", "Hi! We need catering for 100 people next month. Could you send pricing?"),
  msg(10, FRANK, ME, "Office cleaning", "2026-09-05", "Do you do office cleaning? Need a quote for our 3 floors."),
];
const SENT_MSGS = [
  msg(1, ME, BOB, "Re: Kitchen remodel", "2026-06-03", "Here's your quote: $18,500 for the full kitchen remodel, valid 30 days."),
  msg(2, ME, CAROL, "Invoice #456", "2026-07-10", "Attached is invoice #456 for $4,200. Due on receipt, kindly pay at your earliest convenience."),
  msg(3, ME, DAVE, "Website redesign proposal", "2026-08-01", "Proposal attached: website redesign for $6,000."),
  msg(4, ME, BOB, "Re: Kitchen remodel quote", "2026-06-20", "Just following up on the kitchen remodel quote — happy to walk through options."),
  msg(5, ME, ERIN, "Re: Catering quote needed", "2026-09-02", "Happy to help! Our catering packages start at €3,000 for 100 guests. Full quote attached."),
  msg(6, ME, FRANK, "Re: Office cleaning", "2026-09-06", "Yes! Quote attached: $2,400/quarter for full office cleaning."),
];
const TOTAL_MSGS = INBOX_MSGS.length + SENT_MSGS.length;
function resetMailbox() {
  FAKE_FOLDERS = { INBOX: INBOX_MSGS.slice(), [SENT_PATH]: SENT_MSGS.slice() };
}
resetMailbox();

/** Records shaped like fetchRecords output — sentByUser comes from the FOLDER. */
function toRecords() {
  const out = [];
  for (const [folder, list] of Object.entries(FAKE_FOLDERS)) {
    const isSent = folder !== "INBOX";
    for (const m of list) {
      out.push({
        uid: m.uid, folder, from: m.from, to: m.to, cc: [], subject: m.subject,
        date: new Date(m.date).toISOString(), text: m.text,
        sentByUser: isSent || m.from.address === USER,
      });
    }
  }
  return out;
}

// ── tiny test runner ─────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; failures.push([name, e]); console.log("  ✗ " + name + " — " + (e && e.message)); }
}
const KEY = "unit-test-key";
const NOW = Date.UTC(2026, 8, 22); // Sep 22, 2026

// ── pure-function tests ──────────────────────────────────────────────────
console.log("\n[pure]");
await test("normalizeSubject strips Re/Fwd/Fw chains", () => {
  assert.equal(normalizeSubject("Fwd: Re: FW: Kitchen Remodel!"), "kitchen remodel");
  assert.equal(normalizeSubject("   re: re: Hello?"), "hello");
});
await test("extractDealCandidates finds $ amounts; pickDealValue prefers frequent", () => {
  const c = extractDealCandidates("Total: $4,200 and also $1,200 and $4,200 again.");
  assert.deepEqual(c.map((x) => x.amount), [4200, 1200, 4200]);
  assert.ok(c.every((x) => x.currency === "$"));
  assert.equal(pickDealValue(c).amount, 4200);
});
await test("extractPromisedTime pulls the contact's promised time (received only)", () => {
  assert.equal(extractPromisedTime({ messages: [{ sentByUser: false, text: "call me back in Q4 when budgets reset" }] }), "Q4");
  assert.equal(extractPromisedTime({ messages: [{ sentByUser: false, text: "let's talk again next march" }] }), "march");
  assert.equal(extractPromisedTime({ messages: [{ sentByUser: true, text: "call me back in Q4" }] }), null, "owner's own words don't count");
  assert.equal(extractPromisedTime({ messages: [{ sentByUser: false, text: "just checking in" }] }), null);
});
await test("TIMING_STALL draft names the promised time, not a vague age", () => {
  const d = draftForCard({
    stallReason: "TIMING_STALL", type: "QUOTE_SENT", contactName: "Gina",
    contactEmail: "gina@g.com", dealValue: null, dealValueOverride: null,
    lastActivity: new Date(NOW - 21 * 864e5).toISOString(), subject: "Photography", nowMs: NOW,
    promisedTime: "Q4",
  });
  assert.match(d, /Q4/, "draft names Q4");
});
await test("timingBoostFor: promise in the current quarter boosts (received msg)", () => {
  const nowQ4 = Date.UTC(2026, 9, 15); // October → Q4
  assert.equal(timingBoostFor({ messages: [{ sentByUser: false, text: "ping me in Q4, budgets reset then", date: "2026-09-01" }] }, nowQ4), true);
  assert.equal(timingBoostFor({ messages: [{ sentByUser: false, text: "just bumping this", date: "2026-09-01" }] }, nowQ4), false);
  assert.equal(timingBoostFor({ messages: [{ sentByUser: true, text: "ping me in Q4", date: "2026-09-01" }] }, nowQ4), false, "owner's own text doesn't boost");
  assert.equal(timingBoostFor({ messages: [{ sentByUser: false, text: "ping me in Q4", date: "2026-09-01" }] }, NOW), false, "Q4 promise isn't a boost in Q3");
});

// ── Jev client contract: mock and live MUST normalize identically ────────
console.log("\n[jev contract]");
await test("normalizeAnswer maps the live wire shape for every primitive", () => {
  const c = normalizeAnswer("q", { type: "choice", probabilities: { A: 0.7, B: 0.3 } }, { type: "choice" });
  assert.equal(c.top, "A");
  assert.equal(c.confidence, 0.7);
  const n = normalizeAnswer("q", { type: "noul", noul: 0.81 }, { type: "noul" });
  assert.equal(n.pYes, 0.81, "live field is `noul`, exposed as pYes");
  const s = normalizeAnswer("q", { type: "score", distribution: [0.1, 0.6, 0.3] }, { type: "score" });
  assert.equal(s.level, 2);
});
await test("a renamed/absent probability throws instead of silently scoring 0", () => {
  assert.throws(() => normalizeAnswer("recover", { type: "noul" }, { type: "noul" }), /no probability/);
  assert.throws(() => normalizeAnswer("threadType", { type: "choice", probabilities: {} }, { type: "choice" }), /no usable option/);
});
await test("mock and live answers have identical shapes", async () => {
  const questions = [
    { id: "t", type: "choice", input: "here's your quote: $500", options: ["NOT_MONEY", "QUOTE_SENT"] },
    { id: "r", type: "noul", input: "here's your quote: $500", proposition: "A follow-up would reopen this deal." },
  ];
  const mockAns = await createJevClient({ mock: true }).ask(questions);

  const realFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (_u, opts) => {
    requestCount++;
    const body = JSON.parse(opts.body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      answers[id] = q.type === "choice"
        ? { type: "choice", probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 1 ? 0.9 : 0.1])) }
        : { type: "noul", noul: 0.42 };
    }
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
  try {
    const liveAns = await createJevClient({ apiKey: "k", mock: false }).ask(questions);
    assert.deepEqual(liveAns.map((a) => Object.keys(a).sort()), mockAns.map((a) => Object.keys(a).sort()),
      "mock and live must expose the same fields");
    assert.equal(liveAns[1].pYes, 0.42);
    assert.equal(requestCount, 1, "questions sharing one state go out in ONE request, not one each");
  } finally {
    globalThis.fetch = realFetch;
  }
});
await test("live mode classifies a real thread (regression: used to return NOT_MONEY)", async () => {
  const realFetch = globalThis.fetch;
  let stateUploads = 0;
  globalThis.fetch = async (_u, opts) => {
    stateUploads++;
    const body = JSON.parse(opts.body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        const pick = keys.includes("QUOTE_SENT") ? "QUOTE_SENT" : "PRICE_STALL";
        answers[id] = { type: "choice", probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 0.88 : 0.02])) };
      } else {
        answers[id] = { type: "noul", noul: 0.77 };
      }
    }
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
  try {
    const r = await classifyThread(createJevClient({ apiKey: "k", mock: false }), {
      messages: [
        { sentByUser: false, subject: "Kitchen remodel", date: "2026-06-01", text: "Can you send a quote?" },
        { sentByUser: true, subject: "Re: Kitchen remodel", date: "2026-06-03", text: "Here's your quote: $18,500 for the remodel." },
        { sentByUser: false, subject: "Re: Kitchen remodel", date: "2026-06-05", text: "That's more than we budgeted for." },
      ],
    });
    assert.equal(r.type, "QUOTE_SENT", "live mode must classify, not collapse to NOT_MONEY");
    assert.equal(r.stallReason, "PRICE_STALL");
    assert.equal(r.recoverability, 0.77, "recoverability must survive the live parser");
    assert.equal(r.dealValue.amount, 18500);
    assert.ok(r.typeConfidence > 0, "confidence derived from probabilities");
    assert.equal(stateUploads, 1, "one thread = one state upload (billing is input-only)");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Sent-folder discovery: the product does not exist without it ─────────
console.log("\n[sent folder]");
await test("discoverSentFolder finds it by \\Sent special-use flag", async () => {
  const c = new FakeImap();
  assert.equal(await discoverSentFolder(c), SENT_PATH);
});
await test("discoverSentFolder falls back to well-known names", async () => {
  const saved = FAKE_LIST;
  FAKE_LIST = [
    { path: "INBOX", name: "INBOX", flags: new Set() },
    { path: "Sent Items", name: "Sent Items", flags: new Set() },
  ];
  try {
    assert.equal(await discoverSentFolder(new FakeImap()), "Sent Items");
  } finally { FAKE_LIST = saved; }
});
await test("a mailbox with no Sent folder is REFUSED at connect, not silently empty", async () => {
  const savedList = FAKE_LIST;
  const savedFolders = FAKE_FOLDERS;
  FAKE_LIST = [{ path: "INBOX", name: "INBOX", flags: new Set() }];
  FAKE_FOLDERS = { INBOX: INBOX_MSGS.slice() };
  try {
    await assert.rejects(
      () => testInboxConnection({ host: "fake", port: 993, user: USER, pass: "x" }),
      /Sent folder/,
      "connecting a Sent-less mailbox must fail loudly"
    );
  } finally { FAKE_LIST = savedList; FAKE_FOLDERS = savedFolders; }
});
await test("REGRESSION: an INBOX-only view yields zero money cards", async () => {
  // This is the bug the old suite could not see. With received mail only,
  // the directionality guard correctly demotes everything — which is why
  // reading the Sent folder is the product, not a nice-to-have.
  const inboxOnly = toRecords().filter((r) => r.folder === "INBOX");
  const threads = threadMessages("inbox-only", inboxOnly, USER);
  const types = [];
  for (const t of threads.values()) types.push((await classifyThread(jev, t)).type);
  assert.ok(!types.includes("QUOTE_SENT"), "no dead quotes are findable without Sent");
  assert.ok(!types.includes("INVOICE_UNPAID"), "no unpaid invoices are findable without Sent");
});

// ── threading + classification (both folders) ────────────────────────────
console.log("\n[threading + classification]");
const threadsMap = threadMessages(KEY, toRecords(), USER);
const threads = [...threadsMap.values()];
const byAddr = (addr) => threads.find((t) => t.primaryContact.address === addr);

await test("colliding UIDs across folders don't drop messages", () => {
  assert.equal(toRecords().length, TOTAL_MSGS, "all 16 messages survive folder+uid keying");
  assert.equal(threads.reduce((n, t) => n + t.messages.length, 0), TOTAL_MSGS);
});
await test("inbound invoice + newsletter are not money and don't qualify", async () => {
  const vendor = byAddr("vendor@supply.com");
  const news = byAddr("news@deals.com");
  assert.ok(vendor && news);
  assert.equal(qualifiesForClassification(vendor), false);
  assert.equal(qualifiesForClassification(news), false);
  assert.equal((await classifyThread(jev, vendor)).type, "NOT_MONEY", "code guard forces NOT_MONEY");
  assert.equal((await classifyThread(jev, news)).type, "NOT_MONEY");
});
await test("owner-sent quote thread → QUOTE_SENT / PRICE_STALL / $18,500", async () => {
  const bob = byAddr("bob@home.com");
  assert.ok(qualifiesForClassification(bob));
  const r = await classifyThread(jev, bob);
  assert.equal(r.type, "QUOTE_SENT");
  assert.equal(r.stallReason, "PRICE_STALL");
  assert.equal(r.dealValue.amount, 18500);
  assert.equal(r.dealValue.currency, "$");
  assert.ok(r.dealValue.confirmed, "Jev confirms the quoted amount");
  assert.ok(r.recoverability > 0 && r.recoverability <= 1);
});
await test("owner-sent invoice thread → INVOICE_UNPAID", async () => {
  const r = await classifyThread(jev, byAddr("carol@biz.com"));
  assert.equal(r.type, "INVOICE_UNPAID");
  assert.equal(r.dealValue.amount, 4200);
});
await test("dead thread → DEAD and gets auto-dismissed on upsert", async () => {
  const dave = byAddr("dave@co.com");
  const r = await classifyThread(jev, dave);
  assert.equal(r.stallReason, "DEAD");
  deleteCardsForKey(KEY);
  upsertCards(KEY, [{ thread: dave, result: r }], { nowMs: NOW });
  assert.ok(!getCards(KEY, { nowMs: NOW }).find((c) => c.contact.address === "dave@co.com"), "DEAD cards are hidden");
});
await test("€ currency preserved (no conversion)", async () => {
  const r = await classifyThread(jev, byAddr("erin@shop.com"));
  assert.equal(r.dealValue.currency, "€");
  assert.equal(r.dealValue.amount, 3000);
});
await test("duplicate contact/deal threads merge (bob = 3 subject-chains)", () => {
  const bob = byAddr("bob@home.com");
  assert.equal(bob.threadCount, 3, "all three bob subject-chains merged");
  assert.equal(bob.messages.length, 6);
});
await test("reclassification is idempotent: upsert twice → stable cards", async () => {
  deleteCardsForKey(KEY);
  const items = [];
  for (const t of threads) {
    if (!qualifiesForClassification(t)) continue;
    items.push({ thread: t, result: await classifyThread(jev, t) });
  }
  upsertCards(KEY, items, { nowMs: NOW });
  const n1 = getCards(KEY, { nowMs: NOW }).length;
  upsertCards(KEY, items, { nowMs: NOW });
  assert.equal(n1, 4, "bob, carol, erin, frank (dave auto-dismissed)");
  assert.equal(getCards(KEY, { nowMs: NOW }).length, n1, "second pass doesn't duplicate");
  assert.equal(getCards(KEY, { nowMs: NOW }).filter((c) => c.contact.address === "bob@home.com").length, 1);
});

// ── card lifecycle ───────────────────────────────────────────────────────
console.log("\n[lifecycle]");
const LKEY = "lifecycle-test-key";
function mkThread(contact, { inboundAfter = null } = {}) {
  const now = new Date().toISOString();
  return {
    id: "th-" + contact.address,
    primaryContact: contact,
    normalizedSubject: "some deal",
    subject: "Some deal",
    messages: [{ sentByUser: false, text: "do you have pricing?", date: now }],
    messageCount: 1,
    lastActivity: inboundAfter || now,
    lastInboundAt: inboundAfter,
    lastMessageSentByUser: !inboundAfter,
    threadCount: 1,
    signature: "sig-" + contact.address,
  };
}
const mkResult = (extra = {}) => ({
  type: "QUOTE_SENT", stallReason: "TRUE_GHOST", recoverability: 0.8,
  stallDetail: "Ghosted.", dealValue: { amount: 1000, currency: "$", confirmed: true }, ...extra,
});

await test("nudge hides card 21 days; contact reply reopens it", () => {
  deleteCardsForKey(LKEY);
  const contact = { name: "T", address: "t@t.com" };
  upsertCards(LKEY, [{ thread: mkThread(contact), result: mkResult() }]);
  const [card] = getCards(LKEY);
  assert.ok(card);
  cardAction(LKEY, card.id, "nudge");
  assert.equal(getCards(LKEY).length, 0, "nudged card suppressed");
  assert.equal(getCards(LKEY, { nowMs: Date.now() + 20 * 864e5 }).length, 0);
  assert.equal(getCards(LKEY, { nowMs: Date.now() + 22 * 864e5 }).length, 1);
  upsertCards(LKEY, [{ thread: mkThread(contact, { inboundAfter: new Date(Date.now() + 2000).toISOString() }), result: mkResult() }]);
  assert.equal(getCards(LKEY).length, 1, "reply reopens the card");
});
await test("snooze / dismiss / value actions", () => {
  deleteCardsForKey(LKEY);
  upsertCards(LKEY, [
    { thread: mkThread({ name: "S", address: "s@s.com" }), result: mkResult() },
    { thread: mkThread({ name: "V", address: "v@v.com" }), result: mkResult({ stallReason: "PRICE_STALL" }) },
    { thread: mkThread({ name: "D", address: "d@d.com" }), result: mkResult() },
  ]);
  const byEmail = (e) => getCards(LKEY).find((c) => c.contact.address === e);
  cardAction(LKEY, byEmail("s@s.com").id, "snooze", { days: 7 });
  assert.ok(!byEmail("s@s.com"), "snoozed hidden");
  cardAction(LKEY, byEmail("v@v.com").id, "value", { amount: 2500 });
  assert.equal(byEmail("v@v.com").dealValueOverride, 2500);
  assert.match(byEmail("v@v.com").draft, /\$2,500/, "draft re-rendered with override");
  cardAction(LKEY, byEmail("d@d.com").id, "dismiss", { reason: "not a fit" });
  assert.ok(!byEmail("d@d.com"), "dismissed hidden");
  assert.equal(cardAction(LKEY, byEmail("v@v.com").id, "value", { amount: "abc" }).ok, false, "invalid value rejected");
});
await test("won/lost outcomes close cards and adjust stall-reason weights", () => {
  deleteCardsForKey(LKEY);
  upsertCards(LKEY, [
    { thread: mkThread({ name: "W", address: "w@w.com" }), result: mkResult({ stallReason: "PRICE_STALL" }) },
    { thread: mkThread({ name: "X", address: "x@x.com" }), result: mkResult({ stallReason: "PRICE_STALL" }) },
  ]);
  assert.equal(stallMultiplier(getOutcomeWeights(LKEY), "PRICE_STALL"), 1, "no data → neutral");
  const [card] = getCards(LKEY);
  cardAction(LKEY, card.id, "outcome", { outcome: "lost" });
  const w1 = getOutcomeWeights(LKEY);
  assert.equal(w1.PRICE_STALL.lost, 1);
  assert.ok(stallMultiplier(w1, "PRICE_STALL") < 1, "a loss dampens that stall reason");
  assert.ok(!getCards(LKEY).find((c) => c.id === card.id), "outcome closes the card");
  assert.ok(getPipelineTotals(LKEY).total >= 0);
});

// ── HTTP end-to-end via the real server ──────────────────────────────────
console.log("\n[http e2e]");
const BASE = "http://127.0.0.1:18923";

/** A browser-like cookie jar, since identity now lives in a signed cookie. */
function makeJar() {
  let cookie = "";
  return {
    get header() { return cookie ? { cookie } : {}; },
    absorb(res) {
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const pair = String(c).split(";")[0];
        if (pair.startsWith("qr_sid=")) cookie = pair;
      }
    },
  };
}
const jar = makeJar();
async function post(p, body = {}, headers = {}, useJar = jar) {
  const res = await fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(useJar ? useJar.header : {}), ...headers },
    body: JSON.stringify(body),
  });
  if (useJar) useJar.absorb(res);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function get(p, headers = {}, useJar = jar) {
  const res = await fetch(BASE + p, { headers: { ...(useJar ? useJar.header : {}), ...headers } });
  if (useJar) useJar.absorb(res);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

await test("health check reports the pinned model", async () => {
  const { data } = await get("/api/health");
  assert.equal(data.ok, true);
  assert.equal(data.app, "quoterevive");
  assert.match(data.model, /^jev-/, "model is pinned, not a moving alias");
});
await test("full flow: connect → scan → free top-3 gating", async () => {
  const c = await post("/api/inbox/connect", { host: "fake", port: 993, user: USER, pass: "secret" });
  assert.equal(c.data.ok, true, JSON.stringify(c.data));
  assert.equal(c.data.folders.sent, SENT_PATH, "connect reports the discovered Sent folder");
  const s = await post("/api/inbox/scan", {});
  assert.equal(s.data.ok, true, JSON.stringify(s.data));
  let prog = null;
  for (let i = 0; i < 90; i++) {
    prog = (await get("/api/inbox/scan-progress")).data;
    if (prog.status === "done" || prog.status === "error") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(prog.status, "done", "scan failed: " + JSON.stringify(prog));
  const q = await get("/api/quotes");
  assert.equal(q.data.tier, "free");
  assert.equal(q.data.cards.length, 3, "free sees top 3");
  assert.equal(q.data.count, 4, "4 visible deals total");
  assert.equal(q.data.locked, 1, "1 locked behind pro");
  assert.ok(q.data.total > 10000, "pipeline total is in the thousands, got " + q.data.total);
  const addrs = q.data.cards.map((x) => x.contact.address);
  assert.ok(!addrs.includes("vendor@supply.com"), "vendor invoice excluded");
  assert.ok(!addrs.includes("news@deals.com"), "newsletter excluded");
  assert.ok(!addrs.includes("dave@co.com"), "dead deal auto-dismissed");
  const bob = q.data.cards.find((x) => x.contact.address === "bob@home.com");
  assert.ok(bob && bob.threadCount >= 2, "merged threads shown");
  assert.ok(bob.draft && bob.draft.length > 40, "draft present");
  assert.equal(q.data.cards[0].contact.address, "bob@home.com", "ranked by expected value");
});
await test("SECURITY: a forged X-Forwarded-For cannot read another session's deals", async () => {
  // Identity used to be `free:<client IP>` read straight from this
  // header, so one curl returned a stranger's entire pipeline.
  const stranger = makeJar(); // a different browser: no cookie
  const spoofed = await get("/api/quotes", { "X-Forwarded-For": "203.0.113.9", "CF-Connecting-IP": "203.0.113.9" }, stranger);
  assert.equal(spoofed.data.count, 0, "forged headers grant no access");
  assert.equal(spoofed.data.cards.length, 0);
  // and the real session still sees its own
  assert.equal((await get("/api/quotes")).data.count, 4, "the owning session is unaffected");
});
await test("SECURITY: a second browser gets its own empty pipeline, not a shared one", async () => {
  const other = makeJar();
  assert.equal((await get("/api/quotes", {}, other)).data.count, 0, "no NAT-mates sharing an identity");
  assert.equal((await get("/api/inbox/status", {}, other)).data.connected, false);
});
await test("a malformed path returns 400 and the server survives", async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: 18923, path: "/%", method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 400, "malformed percent-escape is a 400, not a process exit");
  assert.equal((await get("/api/health")).data.ok, true, "server still alive after the bad request");
});
await test("pro license unlocks all cards (free data migrates to the key)", async () => {
  fs.writeFileSync(path.join(DATA, "licenses.json"), JSON.stringify({ "TEST-PRO-KEY-1234": { email: "t@t.com", verifiedAt: Date.now() } }));
  const q = await get("/api/quotes", { "x-license-key": "TEST-PRO-KEY-1234" });
  assert.equal(q.data.tier, "pro");
  assert.equal(q.data.cards.length, 4);
  assert.equal(q.data.locked, 0);
  const st = await get("/api/inbox/status", { "x-license-key": "TEST-PRO-KEY-1234" });
  assert.equal(st.data.connected, true, "inbox migrated to the pro key");
  assert.equal(st.data.user, USER);
  fs.unlinkSync(path.join(DATA, "licenses.json"));
});
await test("SECURITY: a Pro key cannot adopt a stranger's inbox via a forged IP", async () => {
  fs.writeFileSync(path.join(DATA, "licenses.json"), JSON.stringify({ "TEST-PRO-KEY-9999": { email: "a@a.com", verifiedAt: Date.now() } }));
  const attacker = makeJar(); // own session, no connected inbox
  const st = await get("/api/inbox/status", { "x-license-key": "TEST-PRO-KEY-9999", "X-Forwarded-For": "203.0.113.9" }, attacker);
  assert.equal(st.data.connected, false, "migration follows the caller's own session, not a header");
  fs.unlinkSync(path.join(DATA, "licenses.json"));
});
await test("both folders are cached, within the 2,000 cap", () => {
  const ownerKey = listInboxKeys().find((k) => k !== "resume-test-key");
  assert.ok(ownerKey, "owner identity key exists");
  const cached = getCachedMessages(ownerKey);
  assert.ok(cached.length <= 2000, "under cap");
  assert.equal(cached.length, TOTAL_MSGS, "every message from both folders cached");
  assert.ok(cached.some((m) => m.folder === "INBOX"), "INBOX represented");
  assert.ok(cached.some((m) => m.folder === SENT_PATH), "Sent represented");
  assert.ok(cached.filter((m) => m.sentByUser).length === SENT_MSGS.length, "sent mail flagged as the owner's");
});

// ── backfill resume ──────────────────────────────────────────────────────
console.log("\n[resume]");
await test("partial scan state resumes per folder instead of restarting", async () => {
  const k = "resume-test-key";
  saveInbox(k, { host: "fake", port: 993, user: USER, pass: "secret", folders: { inbox: "INBOX", sent: SENT_PATH } });
  const before = bodyFetchCalls;
  fs.writeFileSync(path.join(DATA, "scan.json"), JSON.stringify({
    [k]: {
      status: "fetching",
      folders: {
        INBOX: { uids: INBOX_MSGS.map((m) => m.uid).sort((a, b) => b - a), cursor: 8, uidValidity: 42 },
        [SENT_PATH]: { uids: SENT_MSGS.map((m) => m.uid).sort((a, b) => b - a), cursor: 4, uidValidity: 42 },
      },
      total: TOTAL_MSGS, done: 12, startedAt: new Date().toISOString(),
    },
  }));
  const r = await runBackfill(k, USER, { pageSize: 4 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(bodyFetchCalls - before, 2, `only the remaining page per folder refetched (got ${bodyFetchCalls - before})`);
  const prog = getScanProgress(k);
  assert.equal(prog.status, "classifying");
  assert.equal(prog.done, TOTAL_MSGS);
});

// ── poll: new mail + newly-dead ───────────────────────────────────────────
console.log("\n[poll]");
await test("pollNewMail watches BOTH folders; a silent sent quote becomes a card", async () => {
  const ownerKey = listInboxKeys().find((k) => k !== "resume-test-key");
  assert.ok(ownerKey, "owner inbox key exists, got: " + listInboxKeys().join(","));
  const p0 = await pollNewMail(ownerKey, USER);
  assert.equal(p0.ok, true);
  assert.equal(p0.records.length, 0, "nothing new since the scan watermark");
  // A new enquiry lands in INBOX and the owner's quote lands in Sent.
  const GINA = { name: "Gina G", address: "gina@g.com" };
  FAKE_FOLDERS.INBOX.push(msg(11, GINA, ME, "Event photography", new Date(Date.now() - 9 * 864e5).toISOString(), "Hi, need a quote for event photography next month."));
  FAKE_FOLDERS[SENT_PATH].push(msg(7, ME, GINA, "Re: Event photography", new Date(Date.now() - 8 * 864e5).toISOString(), "Quote attached: $1,200 for full-day event photography."));
  const p1 = await pollNewMail(ownerKey, USER);
  assert.equal(p1.records.length, 2, "new records picked up from both folders");
  assert.ok(p1.records.some((r) => r.folder === SENT_PATH && r.sentByUser), "the sent quote is flagged as the owner's");
  const gina = [...rethreadKey(ownerKey, USER).values()].find((t) => t.primaryContact.address === "gina@g.com");
  assert.ok(gina, "gina thread exists");
  const r = await classifyThread(jev, gina);
  assert.equal(r.type, "QUOTE_SENT", "a quote sent 8 days ago with no reply is a live card");
  assert.equal(upsertCards(ownerKey, [{ thread: gina, result: r }]).upserted, 1);
  assert.ok(getCards(ownerKey).find((c) => c.contact.address === "gina@g.com"), "gina card visible");
  resetMailbox();
});

// ── summary ──────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const [n, e] of failures) console.log("FAILED:", n, "\n", e && e.stack);
  process.exit(1);
}

for (const f of fs.readdirSync(DATA)) {
  if (f.endsWith(".json")) fs.unlinkSync(path.join(DATA, f));
}
resetFreeScanForTests();
console.log("data/ cleaned, tests green.");
process.exit(0);
