# Review notes — QuoteRevive v2 (2026-09-22)

For Lara, under the review protocol. Format: `file:line | severity | what's wrong | fix`.

**Read this before building demo mode.** The v1 MVP's 21-test suite was green
against a mailbox that cannot exist. Four defects, all confirmed by running the
code, not by reading it. Demo mode built on v1 inherits all four.

---

## Findings against v1

### 1. `inbox-store.js` (all IMAP paths) | **blocker** | the product could not work on a real mailbox

The v1 README claimed `inbox-store.js` performed *"Sent-folder discovery
(directionality depends on it)."* No such code existed — `grep -rn "Sent"`
returned comments and test fixtures only. Every IMAP path opened `INBOX`.

Your own sent mail is never in your INBOX. So `sentByUser` was false for every
message, `hasSentQuote` / `hasSentInvoice` were false, and the directionality
backstop in `quote-classify.js` demoted everything. Measured, both ways:

```
A) v1 fixture (sent mail injected into INBOX):
   bob@home.com   -> QUOTE_SENT
   carol@biz.com  -> INVOICE_UNPAID

B) a real IMAP INBOX (received mail only — what shipped):
   bob@home.com   -> GHOSTED_THREAD
   carol@biz.com  -> NOT_MONEY
```

`QUOTE_SENT` and `INVOICE_UNPAID` — the two headline card types — were
unreachable in production. Every deal collapsed to "ghosted thread," and the
inbound vendor invoice you correctly wanted excluded became indistinguishable
from the customer invoice you wanted found.

**Why the tests passed:** `test-quotes.mjs:144` set `sentByUser` by hand, and the
fixture put messages from `me@mybiz.com` directly into the fake INBOX. No IMAP
server does that.

**Fixed in v2:** Sent discovered via the RFC 6154 `\Sent` special-use flag with
name fallbacks (`Sent Items`, `[Gmail]/Sent Mail`, `INBOX.Sent`). A mailbox with
no discoverable Sent folder is **refused at connect** rather than silently
returning an empty dashboard. UIDs collide across folders, so the cache is keyed
`folder + uid` and every record carries its `folder`. UIDVALIDITY tracked per
folder. Backfill and the poller both cover every folder, budget split so Sent is
always scanned.

### 2. `server.js` (`resolveIdentity`) + `license-store.js` (`clientIp`) | **blocker** | identity was a spoofable HTTP header

Free identities were `free:<client IP>` read from `CF-Connecting-IP` /
`X-Forwarded-For` with no allowlist. Demonstrated against a running server:

```
curl -H "X-Forwarded-For: 203.0.113.9" /api/quotes
-> {"cards":[{"contact":{"address":"client@victim-co.com"},"dealValue":{"amount":18500}...}]}

curl /api/quotes          # no header
-> {"cards":[]}
```

Anyone could read anyone's pipeline by guessing an IP. Separately, everyone
behind one NAT — an office, a café, carrier CGNAT — already shared one identity,
no attacker required.

Worse: `resolveIdentity` called `migrateInboxData(free:<ip> -> licenseKey)`. A
forged header plus a real $29 licence moved the victim's **stored encrypted IMAP
credentials** onto the attacker's key. That violates security baseline rule 6 in
spirit — the crypto is correct, but the access control around it wasn't.

**Fixed in v2:** identity is a signed HttpOnly session cookie (`session.js`).
Proxy headers read only when `TRUST_PROXY_HEADERS=true`, and only for rate
limiting. Migration follows the caller's own session.

### 3. `server.js` (`serveStatic`) | **blocker** | one unauthenticated request killed the process

```
curl 'http://host/%'
-> URIError: URI malformed -> process exit
-> /api/health: SERVER DEAD
```

Unguarded `decodeURIComponent`. Total outage for every connected user, from one
curl, no auth.

**Fixed in v2:** 400 on a malformed path, plus process-level
`uncaughtException` / `unhandledRejection` guards. Still run a supervisor.

### 4. `jev-client.js` | **blocker** | live mode classified every thread as NOT_MONEY

The file held two contradictory beliefs about the API response shape.
`parseLiveAnswers` read `.noul` and derived the top choice from
`.probabilities`. `ask()` — the path QuoteRevive actually uses — read `.choice`,
and `quote-classify.js` read `.pYes`. Nothing exercised `ask()` in live mode.

Stubbed with the shape the file's own parser claims the API returns:

```
LIVE:  { type: "NOT_MONEY",  recoverability: 0,     dealValue: null,    typeConfidence: 0 }
MOCK:  { type: "QUOTE_SENT", recoverability: 0.418, dealValue: $18,500, typeConfidence: 0.879 }
```

Undefined `top` → NOT_MONEY for every thread. Undefined `pYes` →
recoverability 0 → expected value 0 → empty dashboard, $0 hero number.

**Fixed in v2:** one `normalizeAnswer()` for mock and live, so the shape callers
see cannot drift between the mode tests run and the mode customers run. A
missing or renamed probability now **throws** instead of silently scoring 0.

### 5. `jev-client.js` / `server.js` | **major** | ~4x overspend and a 4x-undercounted budget

`ask()` sent one HTTP POST per question, re-uploading the full thread each time.
Jev bills input tokens only and evaluates questions in parallel against one
state — the fan-out paid for the same thread three or four times over and
quadrupled scan latency.

`consumeUsage("pro", id, candidates.length)` charged 1 per thread against an
actual 3–4 questions, so a 5,000/month cap was really ~17,500 calls.

**Fixed in v2:** all four questions share one state and go out in a single
request. Budget charges the real question count.

### 6. `jev-client.js` | **major** | model was a moving alias

`jev-latest` resolves to `jev-1.13.0` today and will move. Under fixed
thresholds (`>= 0.5` value confirmation, `>= 0.55` urgency) that changes
classification behaviour with no deploy and no signal.

**Fixed in v2:** pinned to `jev-1.13.0`, override via `JEV_MODEL`.

### 7. README v1 | **major** | documentation asserted behaviour that did not exist

The README's file map credited `inbox-store.js` with Sent-folder discovery. It
also listed "verify Sent discovery against a real mailbox" as open follow-up #2,
and wrote: *"zero detected quotes on a known-good mailbox means this is broken."*
That prediction had already come true. This isn't a docs nit — it's the reason
the defect survived: anyone reading the repo would believe the feature shipped.

**Proposed protocol change:** doc claims are assertions under test. If the README
says the code does X, either a test covers X or the claim comes out.

---

## Known and unfixed in v2 — inherited, documented, yours to weigh

1. **Storage is JSON files and will not survive users.** Every read parses a
   whole file; every write rewrites it for all users. `cacheMessages` rewrites
   `messages.json` once per page (~8 MB/user at the 2,000 cap). No locking, so
   the 10-minute poller and a user clicking "won" can both read-modify-write
   `cards.json` and lose one silently. Fine at 1 user, corrupting at 20.
   **Recommended next change: `node:sqlite`.** This is the one I'd do before
   demo mode ships to anyone real.
2. **Mailbox passwords are recoverable by anyone with the host.** AES-256-GCM is
   implemented correctly, but `CREDENTIAL_KEY` lives in the same env as the
   process that reads `data/inboxes.json`. Rule 6 is satisfied as written; the
   architecture is still the exposure. OAuth is the real fix — Google's
   restricted scopes need verification plus an annual CASA assessment, so it
   wants starting before it's the blocker.
3. **Neither integration has been run against reality.** Sent discovery has
   never touched Gmail/Outlook/Fastmail; live Jev has never been called with a
   real key. v2 is green against a faithful fake, which is a different claim
   from working.
4. **Ranking multipliers are hand-tuned guesses** (`x1.15` sent-last, `x1.5`
   timing, `x0.5` cold). TypeSafe's own eval puts single-question Jev at 62.6%
   and decomposition-plus-fitted-weights at 95.0% — the won/lost Laplace weights
   are the only ground truth this system collects. Worth harvesting from day one.

---

## What to scrutinise in this handoff

- `inbox-store.js` — the folder refactor is the largest change. Per-folder UID
  spaces, UIDVALIDITY reset, and the budget split are the places I'd look for
  mistakes.
- `session.js` — new file. Cookie signing, the constant-time compare, and the
  `TRUST_PROXY_HEADERS` default (off).
- `jev-client.js` `normalizeAnswer()` — the live wire shape is **inferred**, not
  confirmed. `docs.typesafe.ai` was unreachable from my sandbox. The normalizer
  tolerates field-name variants and throws on absence rather than defaulting to
  zero, but **someone must verify it against the real API before live mode
  ships.** Treat this as an open blocker on live mode specifically.
- `test-quotes.mjs` — the fake IMAP server now models two folders with
  independent, deliberately colliding UID spaces.

## Verification

```
npm run check   -> syntax OK
npm test        -> 34 passed, 0 failed
```

Exploit probes re-run against a live server after the fix: forged
`X-Forwarded-For` → empty, forged cookie → empty, `GET /%` → 400 with the server
alive, fresh visitor → `HttpOnly; SameSite=Lax; Secure` session cookie.

Four of the 34 tests fail on v1 by construction. That was the point.
