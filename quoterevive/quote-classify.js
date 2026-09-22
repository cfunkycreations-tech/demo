// ─────────────────────────────────────────────────────────────
// quote-classify.js — the Jev taxonomy for QuoteRevive.
//
// Three passes per thread:
//   1. Thread type (choice): QUOTE_SENT / INVOICE_UNPAID /
//      GHOSTED_THREAD / NOT_MONEY
//   2. Stall reason (choice, money threads only): PRICE_STALL /
//      TIMING_STALL / COMPETITOR_STALL / LOGISTICS_STALL /
//      TRUE_GHOST / DEAD
//   3. Scores: recoverability (noul) + deal value (regex extract in
//      code, confirmed by Jev noul).
//
// CRITICAL directionality rule, enforced in CODE (not just by the
// model): QUOTE_SENT / INVOICE_UNPAID count ONLY when the quote or
// invoice went out in the user's SENT mail. An inbound vendor invoice,
// a receipt, or a newsletter with dollar amounts is NOT_MONEY.
// The model also gets directionality-aware criteria for live mode,
// but the code guard is the backstop in both modes.
//
// Follow-up drafts are deterministic templates with slots — no
// generative prose, no hallucination risk.
// ─────────────────────────────────────────────────────────────

export const THREAD_TYPES = ["NOT_MONEY", "QUOTE_SENT", "INVOICE_UNPAID", "GHOSTED_THREAD"];
export const STALL_REASONS = ["TRUE_GHOST", "DEAD", "PRICE_STALL", "TIMING_STALL", "COMPETITOR_STALL", "LOGISTICS_STALL"];
export const MONEY_TYPES = ["QUOTE_SENT", "INVOICE_UNPAID", "GHOSTED_THREAD"];

// Signals that the OWNER sent commercial paper (applied to SENT mail only).
export const QUOTE_RE = /\b(quote|estimate|proposal|pricing|bid|scope of work|statement of work)\b/i;
export const INVOICE_RE = /\b(invoice|amount due|payment due|past due|balance due|remit payment|kindly pay)\b/i;

// ── thread → Jev input ──

function msgLine(m) {
  const tag = m.sentByUser ? "SENT" : "RECEIVED";
  const date = String(m.date || "").slice(0, 10);
  const text = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 1200);
  return `[${tag} | ${date}] Subject: ${m.subject}\n${text}`;
}

/**
 * Build the Jev input for a thread plus deterministic directionality
 * facts computed in code.
 */
export function buildThreadInput(thread) {
  const messages = (thread.messages || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const sentText = messages.filter((m) => m.sentByUser).map((m) => `${m.subject}\n${m.text}`).join("\n");
  const facts = {
    sentCount: messages.filter((m) => m.sentByUser).length,
    receivedCount: messages.filter((m) => !m.sentByUser).length,
    hasSentQuote: QUOTE_RE.test(sentText),
    hasSentInvoice: INVOICE_RE.test(sentText),
    lastIsSent: messages.length > 0 ? !!messages[messages.length - 1].sentByUser : false,
  };
  const header =
    "You are the business owner. Messages tagged [SENT] were written BY YOU (the owner). " +
    "Messages tagged [RECEIVED] came FROM the customer/contact.\n\n";
  const input = header + messages.map(msgLine).join("\n\n---\n\n");
  return { input, facts, messages };
}

// ── Pass 1: thread type ──

const TYPE_CRITERIA = {
  NOT_MONEY:
    "Not a sales opportunity for the owner: newsletters, receipts, order confirmations, promos, shipping notices, OR an inbound invoice/bill the owner RECEIVED from a vendor (the owner owes money — nothing to win back). When in doubt, choose this.",
  QUOTE_SENT:
    "The OWNER SENT a quote, estimate, proposal, or pricing to the contact (it appears in a [SENT] message) and the thread is about winning that deal. ONLY when the quote went OUT from the owner.",
  INVOICE_UNPAID:
    "The OWNER SENT an invoice or bill to the contact (it appears in a [SENT] message) that looks unpaid. ONLY when the invoice went OUT from the owner. An inbound invoice the owner received is NOT_MONEY.",
  GHOSTED_THREAD:
    "A real sales conversation with the contact that died with no quote or invoice sent — the owner was nurturing a potential deal and it went quiet.",
};

// ── Pass 2: stall reason ──

const STALL_CRITERIA = {
  TRUE_GHOST: "The contact simply went quiet — no objection, no explanation, just silence.",
  DEAD: "Explicitly dead: they said no, cancelled the project, are all set, or went with someone else. Only when the thread states this clearly.",
  PRICE_STALL: "Price came up as the blocker: too expensive, over budget, asked for a discount, comparing on price.",
  TIMING_STALL: "Timing came up as the blocker: not right now, next quarter, after the holidays, call me back later.",
  COMPETITOR_STALL: "They are shopping around: comparing quotes, talking to competitors, got a lower offer elsewhere.",
  LOGISTICS_STALL: "Open practical questions stalled it: timeline, scheduling, availability, scope details never resolved.",
};

function answerOf(results, id) {
  return (results || []).find((r) => r.id === id) || {};
}

// ── deal value: regex extraction in code, Jev confirms ──

const MONEY_RES = [
  /([$€£])\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g,
  /\b(USD|EUR|GBP)\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/gi,
  /(\d{1,3}(?:,\d{3})+(?:\.\d{2})|\d+(?:\.\d{2}))\s*(dollars|euros|pounds)/gi,
];
const SYMBOL_FOR = { $: "$", "€": "€", "£": "£", USD: "$", EUR: "€", GBP: "£", dollars: "$", euros: "€", pounds: "£" };

/** Extract candidate {amount, currency} pairs from thread text. */
export function extractDealCandidates(text) {
  const out = [];
  const src = String(text || "");
  for (const re of MONEY_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const amount = parseFloat(String(m[2]).replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount < 1 || amount > 100_000_000) continue;
      const currency = SYMBOL_FOR[String(m[1])] ?? SYMBOL_FOR[String(m[1]).toLowerCase()] ?? "";
      out.push({ amount: Math.round(amount * 100) / 100, currency });
    }
  }
  return out;
}

/** Pick the most likely deal value: most frequent amount, tie → largest. */
export function pickDealValue(candidates) {
  if (!candidates.length) return null;
  const counts = new Map();
  for (const c of candidates) {
    const k = `${c.amount}|${c.currency}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const c of candidates) {
    const n = counts.get(`${c.amount}|${c.currency}`);
    if (n > bestCount || (n === bestCount && c.amount > (best ? best.amount : 0))) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

// ── main entry ──

/**
 * Classify one thread. Returns:
 * { type, stallReason|null, recoverability, dealValue:{amount,currency,confirmed}|null,
 *   typeConfidence, stallConfidence }
 */
export async function classifyThread(jev, thread) {
  const { input, facts, messages } = buildThreadInput(thread);
  const candidates = pickDealValue(extractDealCandidates(messages.map((m) => `${m.subject}\n${m.text}`).join("\n")));

  // Every question shares one state, so they go out as a SINGLE request
  // and Jev evaluates them in parallel. Billing is input-token-only, so
  // asking all four costs the same as asking one — splitting the passes
  // across requests would re-upload the thread and pay for it twice.
  const questions = [
    {
      id: "threadType",
      type: "choice",
      input,
      options: THREAD_TYPES,
      instructions:
        "Classify this email thread from the business owner's perspective. " +
        "QUOTE_SENT and INVOICE_UNPAID are ONLY valid when the quote/invoice appears in a [SENT] message written by the owner. " +
        "An inbound invoice, receipt, or newsletter is NOT_MONEY. Be conservative.",
      criteria: TYPE_CRITERIA,
    },
    {
      id: "stall",
      type: "choice",
      input,
      options: STALL_REASONS,
      instructions: "Why did this deal stall? Pick the single best reason. TRUE_GHOST only when there is genuinely no signal.",
      criteria: STALL_CRITERIA,
    },
    {
      id: "recover",
      type: "noul",
      input,
      proposition: "A well-timed, human follow-up message now would likely reopen this deal conversation.",
    },
  ];
  if (candidates) {
    questions.push({
      id: "valueOk",
      type: "noul",
      input,
      proposition: `The amounts mentioned in this thread (around ${candidates.currency}${candidates.amount.toLocaleString("en-US")}) are the price of THIS deal — not a footer, ad, disclaimer, or someone else's invoice.`,
    });
  }

  const results = await jev.ask(questions);
  const typeAns = answerOf(results, "threadType");
  const stallAns = answerOf(results, "stall");
  const recoverAns = answerOf(results, "recover");
  const valueAns = answerOf(results, "valueOk");

  let type = THREAD_TYPES.includes(typeAns.top) ? typeAns.top : "NOT_MONEY";
  const typeConfidence = Number(typeAns.confidence || 0);

  // ── code-level directionality guard (the backstop) ──
  if (type === "QUOTE_SENT" && !facts.hasSentQuote) {
    type = messages.length >= 2 ? "GHOSTED_THREAD" : "NOT_MONEY";
  }
  if (type === "INVOICE_UNPAID" && !facts.hasSentInvoice) {
    type = "NOT_MONEY"; // inbound vendor invoice — never a win-back
  }

  if (!MONEY_TYPES.includes(type)) {
    return { type: "NOT_MONEY", stallReason: null, recoverability: 0, dealValue: null, typeConfidence, stallConfidence: 0 };
  }

  let stallReason = STALL_REASONS.includes(stallAns.top) ? stallAns.top : "TRUE_GHOST";
  const recoverability = Math.min(1, Math.max(0, Number(recoverAns.pYes ?? 0)));
  const dealValue = candidates
    ? { amount: candidates.amount, currency: candidates.currency, confirmed: Number(valueAns.pYes ?? 0) >= 0.5 }
    : null;

  return {
    type,
    stallReason,
    recoverability: Math.round(recoverability * 1000) / 1000,
    dealValue,
    typeConfidence: Math.round(typeConfidence * 1000) / 1000,
    stallConfidence: Math.round(Number(stallAns.confidence || 0) * 1000) / 1000,
  };
}

// ── human-readable stall reasons ──

export function plainStallReason(stallReason, type) {
  if (type === "INVOICE_UNPAID") return "Invoice looks unpaid";
  switch (stallReason) {
    case "PRICE_STALL": return "They balked at the price";
    case "TIMING_STALL": return "Bad timing — they asked you to wait";
    case "COMPETITOR_STALL": return "They were shopping around";
    case "LOGISTICS_STALL": return "Open questions never got answered";
    case "DEAD": return "They said no";
    default: return "They just went quiet";
  }
}

export function plainType(type) {
  switch (type) {
    case "QUOTE_SENT": return "Dead quote";
    case "INVOICE_UNPAID": return "Unpaid invoice";
    case "GHOSTED_THREAD": return "Ghosted thread";
    default: return "Not money";
  }
}

/** "23 days ago" / "last month" / "in March" style reference. Timezone-safe (UTC math). */
export function timeRef(isoDate, nowMs = Date.now()) {
  const t = new Date(isoDate || "").getTime();
  if (!Number.isFinite(t)) return "a while back";
  const days = Math.max(0, Math.round((nowMs - t) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 31) return `${Math.round(days / 7)} weeks ago`;
  if (days < 62) return "last month";
  if (days < 365) {
    const d = new Date(t);
    return `in ${d.toLocaleString("en-US", { month: "long", timeZone: "UTC" })}`;
  }
  return "over a year ago";
}

/** Short service label from the subject, e.g. "kitchen remodel". */
export function serviceLabel(subject) {
  const stop = new Set(["re", "fwd", "fw", "follow", "up", "quote", "proposal", "estimate", "invoice", "regarding", "hello", "hi", "the", "a", "an", "for", "on", "your", "our"]);
  const words = String(subject || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w));
  return words.slice(0, 4).join(" ") || "project";
}

function firstName(name, email) {
  const n = String(name || "").trim().split(/\s+/)[0];
  if (n) return n.charAt(0).toUpperCase() + n.slice(1);
  const local = String(email || "").split("@")[0].replace(/[._-]+/g, " ").trim().split(/\s+/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "there";
}

function fmtValue(dealValue, overrideAmount) {
  const amount = overrideAmount ?? dealValue?.amount;
  if (amount == null) return "";
  const cur = dealValue?.currency || "";
  return `${cur}${Number(amount).toLocaleString("en-US")}`;
}

/**
 * Deterministic follow-up draft. Slots: name, value, time reference,
 * service. Short, human, editable — never generated prose.
 */
export function draftForCard({ stallReason, type, contactName, contactEmail, dealValue, dealValueOverride, lastActivity, subject, nowMs, promisedTime }) {
  const name = firstName(contactName, contactEmail);
  const value = fmtValue(dealValue, dealValueOverride);
  const ref = timeRef(lastActivity, nowMs);
  const service = serviceLabel(subject);

  if (type === "INVOICE_UNPAID") {
    return `Hi ${name} — friendly nudge on the${value ? ` ${value}` : ""} invoice from ${ref}. Let me know if anything's holding it up on your end.`;
  }
  switch (stallReason) {
    case "PRICE_STALL":
      return `Hi ${name} — circling back on the${value ? ` ${value}` : ""} quote from ${ref}. If budget was the blocker, I can take another look at the numbers. Worth a quick call this week?`;
    case "TIMING_STALL":
      return promisedTime
        ? `Hi ${name} — you mentioned ${promisedTime} would be better timing, and here we are. Does it make sense to pick the ${service} back up?`
        : `Hi ${name} — circling back now that some time has passed. Does it make sense to pick the ${service} back up?`;
    case "COMPETITOR_STALL":
      return `Hi ${name} — no pressure, just checking whether you landed somewhere on the ${service}. Happy to do a quick apples-to-apples if it'd help.`;
    case "LOGISTICS_STALL":
      return `Hi ${name} — making sure my last note didn't get buried. Still happy to sort the ${service} details whenever you're ready.`;
    default:
      return `Hi ${name} — bumping this up. Still interested in the ${service}? A quick yes or no is plenty.`;
  }
}

/**
 * Pull the contact's promised time out of a thread's RECEIVED messages
 * ("Q4", "next quarter", a month name). Used to make TIMING_STALL drafts
 * specific instead of vague. Returns the matched phrase or null.
 */
export function extractPromisedTime(thread) {
  const receivedText = (thread.messages || [])
    .filter((m) => !m.sentByUser)
    .map((m) => String(m.text || ""))
    .join("\n");
  const q = receivedText.match(/\bQ([1-4])\b/i);
  if (q) return `Q${q[1]}`;
  const nq = receivedText.match(/\bnext quarter\b/i);
  if (nq) return "next quarter";
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  for (const mo of months) {
    if (new RegExp(`\\b${mo}\\b`, "i").test(receivedText)) return mo;
  }
  return null;
}
