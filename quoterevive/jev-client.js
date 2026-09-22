// ─────────────────────────────────────────────────────────────
// jev-client.js — client for TypeSafe AI's Jev model (QuoteRevive).
//
// Two modes:
//   MOCK = true   → no network. Deterministic-per-input fake
//                   probabilities so local dev and tests run at $0.
//   MOCK = false  → POST https://api.typesafe.ai/v1/systemone
//                   with `Authorization: Bearer <JEV_API_KEY>`.
//
// Primitives: choice / noul / score.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE:
//
//   1. ONE NORMALIZER. Mock and live answers pass through the same
//      normalizeAnswer(), so the shape callers see can never drift
//      between the mode the tests run and the mode customers run. The
//      previous version had two different readers of the API response
//      (`answer.choice`/`.pYes` in one place, `.probabilities`/`.noul`
//      in another); live mode classified every thread as NOT_MONEY
//      with recoverability 0 and no test could see it.
//
//   2. ONE REQUEST PER STATE. Jev evaluates every question against the
//      same state in a single parallel pass — that is the whole point
//      of the model. Billing is input-token-only, so fanning N
//      questions out to N requests re-uploads the thread N times and
//      pays for it N times. Questions sharing an input are batched.
//
// Model is PINNED. `jev-latest` is a moving alias (jev-1.13.0 today);
// letting it drift silently changes classification behaviour under
// fixed thresholds with no deploy. Override with JEV_MODEL.
// ─────────────────────────────────────────────────────────────

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-1.13.0";

/** Questions Jev is asked per classified thread — used for budget accounting. */
export const QUESTIONS_PER_THREAD = 4;

export function jevModel() {
  return String(process.env.JEV_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

// ── mock keyword tables (QuoteRevive taxonomy) ──
// Option ORDER matters for the mock: on a keyword tie (or zero hits)
// the earliest option wins, so the conservative default leads.
const CATEGORY_KEYWORDS = [
  {
    category: "NOT_MONEY",
    words: ["unsubscribe", "newsletter", "your receipt", "payment received", "thank you for your payment", "order confirmation", "tracking number", "% off", "sale ends", "promo code", "webinar", "podcast", "press release"],
  },
  {
    category: "QUOTE_SENT",
    words: ["quote", "estimate", "proposal", "pricing", "bid", "scope of work", "statement of work"],
  },
  {
    category: "INVOICE_UNPAID",
    words: ["invoice", "payment due", "amount due", "past due", "balance due", "remit payment", "kindly pay"],
  },
  {
    category: "GHOSTED_THREAD",
    words: ["following up", "checking in", "bumping this", "circling back", "did you get my"],
  },
  { category: "TRUE_GHOST", words: [] },
  {
    category: "DEAD",
    words: ["went with someone else", "no longer need", "cancelled the project", "not interested", "we're all set", "decided against", "pass on this"],
  },
  {
    category: "PRICE_STALL",
    words: ["too expensive", "expensive", "budget", "cheaper", "discount", "lower the price", "can't afford"],
  },
  {
    category: "TIMING_STALL",
    words: ["next quarter", "not right now", "bad timing", "later this year", "busy season", "next year", "call me back", "q1", "q2", "q3", "q4", "after the holidays"],
  },
  {
    category: "COMPETITOR_STALL",
    words: ["comparing quotes", "other quote", "competitor", "shopping around", "other company", "got a lower"],
  },
  {
    category: "LOGISTICS_STALL",
    words: ["what's your timeline", "timeline", "when can you start", "availability", "scope question", "lead time"],
  },
];

// ── deterministic PRNG so mock results are stable per input ──
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── mock implementations ──
// Each returns the SAME raw shape the live API returns, so both modes
// go through normalizeAnswer() below. Never return a pre-normalized
// object here — that is exactly how the two paths drifted apart.

function mockChoice(text, options) {
  const lower = String(text).toLowerCase();
  const rand = mulberry32(hashString("choice:" + text + ":" + options.join("|")));
  let dominant = options[0];
  let best = -1;
  for (const opt of options) {
    let hits = 0;
    const kw = CATEGORY_KEYWORDS.find((k) => k.category === opt);
    if (kw) for (const w of kw.words) if (lower.includes(w)) hits++;
    if (hits > best) {
      best = hits;
      dominant = opt;
    }
  }
  const domShare = best > 0 ? 0.55 + rand() * 0.35 : 0.34 + rand() * 0.2;
  const others = options.filter((o) => o !== dominant);
  const weights = others.map(() => 0.2 + rand());
  const wSum = weights.reduce((a, b) => a + b, 0);
  const probabilities = {};
  let acc = 0;
  others.forEach((o, i) => {
    probabilities[o] = Math.round(((1 - domShare) * weights[i] / wSum) * 1000) / 1000;
    acc += probabilities[o];
  });
  probabilities[dominant] = Math.round((1 - acc) * 1000) / 1000;
  return { type: "choice", probabilities };
}

function mockNoul(text, proposition) {
  const lower = String(text).toLowerCase();
  const rand = mulberry32(hashString("noul:" + text + ":" + proposition));
  const prop = String(proposition || "").toLowerCase();

  // Deal-revival judgment.
  if (/reopen|follow.?up|revive|win back/.test(prop)) {
    let p = 0.3 + rand() * 0.15;
    if (/thank|great|interested|sounds good|love/i.test(lower)) p += 0.15;
    if (/next quarter|timing|call me back|later/i.test(lower)) p += 0.15;
    if (/not interested|cancelled|went with|unsubscribe/i.test(lower)) p = 0.04 + rand() * 0.05;
    return { type: "noul", noul: Math.round(Math.min(0.95, p) * 1000) / 1000 };
  }
  // Deal-value confirmation.
  if (/price of this deal|amounts? (mentioned|in this thread)/.test(prop)) {
    const dealish = /quote|estimate|proposal|invoice|pricing|total/i.test(lower);
    const p = dealish ? 0.78 + rand() * 0.15 : 0.15 + rand() * 0.2;
    return { type: "noul", noul: Math.round(Math.min(0.97, p) * 1000) / 1000 };
  }
  return { type: "noul", noul: Math.round(Math.min(0.97, 0.1 + rand() * 0.4) * 1000) / 1000 };
}

function mockScore(text, levels) {
  const rand = mulberry32(hashString("score:" + text + ":" + levels));
  const weights = Array.from({ length: levels }, () => 0.2 + rand());
  const sum = weights.reduce((a, b) => a + b, 0);
  const distribution = weights.map((w) => Math.round((w / sum) * 1000) / 1000);
  return { type: "score", distribution };
}

// ── the single normalizer ──

/**
 * Turn one raw Jev answer (mock or live) into the shape QuoteRevive
 * consumes. Tolerates the field-name variants the API may use so a
 * rename upstream degrades into a logged warning, not a silent zero.
 *
 * choice → { id, type, probabilities, top, confidence }
 * noul   → { id, type, pYes }
 * score  → { id, type, level, distribution }
 */
export function normalizeAnswer(id, raw, question) {
  const type = String((raw && raw.type) || (question && question.type) || "").toLowerCase();
  const a = raw || {};

  if (type === "choice") {
    const probabilities = a.probabilities && typeof a.probabilities === "object" ? a.probabilities : {};
    const entries = Object.entries(probabilities).filter(([, v]) => Number.isFinite(Number(v)));
    let top = typeof a.choice === "string" ? a.choice : typeof a.top === "string" ? a.top : "";
    let confidence = Number(a.confidence);
    if (entries.length) {
      const sorted = entries.sort((x, y) => Number(y[1]) - Number(x[1]));
      if (!top) top = sorted[0][0];
      if (!Number.isFinite(confidence)) confidence = Number(probabilities[top] ?? sorted[0][1]);
    }
    if (!top) {
      throw new Error(
        `Jev choice answer "${id}" had no usable option (keys: ${Object.keys(a).join(",") || "none"})`
      );
    }
    return { id, type: "choice", probabilities, top, confidence: Number.isFinite(confidence) ? confidence : 0 };
  }

  if (type === "noul") {
    // The API field is `noul`; accept pYes/probability/value as aliases.
    const p = [a.noul, a.pYes, a.probability, a.value].map(Number).find(Number.isFinite);
    if (!Number.isFinite(p)) {
      throw new Error(
        `Jev noul answer "${id}" had no probability (keys: ${Object.keys(a).join(",") || "none"})`
      );
    }
    return { id, type: "noul", pYes: Math.min(1, Math.max(0, p)) };
  }

  if (type === "score") {
    const distribution = Array.isArray(a.distribution) ? a.distribution.map(Number) : [];
    let level = Number(a.level ?? a.score);
    if (!Number.isFinite(level) && distribution.length) {
      level = distribution.indexOf(Math.max(...distribution)) + 1;
    }
    if (!Number.isFinite(level)) {
      throw new Error(`Jev score answer "${id}" had no level (keys: ${Object.keys(a).join(",") || "none"})`);
    }
    return { id, type: "score", level, distribution };
  }

  throw new Error(`Jev returned an answer of unknown type for "${id}": ${JSON.stringify(a).slice(0, 200)}`);
}

// ── live request building ──

/** Convert a generic ask() question to a live API question object. */
export function toLiveQuestion(q) {
  if (q.type === "choice") {
    const criteria = {};
    for (const opt of q.options || []) criteria[opt] = (q.criteria && q.criteria[opt]) || null;
    return { type: "choice", instructions: q.instructions || "Pick the best-fitting option.", criteria };
  }
  if (q.type === "noul") {
    return { type: "noul", instructions: q.proposition || q.instructions || "Is this true?" };
  }
  if (q.type === "score") {
    const levels = Math.min(10, Math.max(2, q.levels || 5));
    return {
      type: "score",
      instructions: q.instructions || "Rate this.",
      criteria: Array.from({ length: levels }, (_, i) => `Level ${i + 1}`),
    };
  }
  throw new Error(`toLiveQuestion: unknown question type "${q.type}"`);
}

async function livePost(body, apiKey, attempt = 0) {
  const res = await fetch(JEV_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Docs recommend exponential backoff on 429/529.
  if ((res.status === 429 || res.status === 529) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return livePost(body, apiKey, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jev API error ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function requireKey(apiKey) {
  if (!apiKey) {
    throw new Error("JEV_API_KEY is not set. Run with JEV_MOCK=true (default) until the key arrives.");
  }
}

/** Group questions by shared `input` so each distinct state is sent once. */
function groupByState(questions) {
  const groups = new Map();
  for (const q of questions) {
    const state = String(q.input ?? "");
    if (!groups.has(state)) groups.set(state, []);
    groups.get(state).push(q);
  }
  return [...groups.entries()];
}

// ── public factory ──
export function createJevClient({ apiKey = "", mock = true } = {}) {
  return {
    mode: mock ? "mock" : "live",
    model: jevModel(),

    /**
     * Ask a batch of typed questions. Questions sharing the same
     * `input` go out in ONE request — Jev evaluates them in parallel
     * against that single state, and input tokens are the only thing
     * billed. Answers come back in the order asked.
     *
     * questions: [{ id, type: 'choice'|'noul'|'score', input,
     *               options?, criteria?, instructions?, proposition?, levels? }]
     */
    async ask(questions) {
      if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error("ask: expected a non-empty array of questions");
      }
      const byId = new Map();

      if (mock) {
        for (const q of questions) {
          let raw;
          if (q.type === "choice") raw = mockChoice(q.input, q.options || []);
          else if (q.type === "noul") raw = mockNoul(q.input, q.proposition || "");
          else if (q.type === "score") raw = mockScore(q.input, Math.min(10, Math.max(2, q.levels || 5)));
          else throw new Error(`ask: unknown question type "${q.type}"`);
          byId.set(q.id, normalizeAnswer(q.id, raw, q));
        }
        return questions.map((q) => byId.get(q.id));
      }

      requireKey(apiKey);
      const groups = groupByState(questions);
      const responses = await Promise.all(
        groups.map(([state, qs]) =>
          livePost(
            {
              model: jevModel(),
              state,
              questions: Object.fromEntries(qs.map((q) => [q.id, toLiveQuestion(q)])),
            },
            apiKey
          )
        )
      );
      responses.forEach((data, i) => {
        const answers = (data && data.answers) || {};
        for (const q of groups[i][1]) {
          if (!(q.id in answers)) {
            throw new Error(
              `Jev response is missing answer "${q.id}" (got: ${Object.keys(answers).join(",") || "none"}). ` +
                "See https://docs.typesafe.ai/api"
            );
          }
          byId.set(q.id, normalizeAnswer(q.id, answers[q.id], q));
        }
      });
      return questions.map((q) => byId.get(q.id));
    },
  };
}
