# QuoteRevive — "the money hiding in your inbox"

Connect a mailbox → backfill INBOX **and Sent** → AI finds dead quotes, unpaid
invoices, and ghosted threads → ranks them by recoverable dollars → drafts a
tailored follow-up for each. The app NEVER sends email itself; every nudge is a
draft the user reviews, copies, and sends from their own mail client.

Stack: Node.js 22 (ES modules, zero build step), `imapflow` for IMAP, TypeSafe
Jev for classification, Gumroad for licensing. Dark premium dashboard,
single-page frontend in `public/`.

## Changelog

### v2 — 2026-09-22
- **Sent-folder discovery added.** v1 read INBOX only, so `sentByUser` was false
  for every message and the directionality guard demoted every card:
  `QUOTE_SENT` and `INVOICE_UNPAID` were unreachable in production. Sent is now
  found via the `\Sent` special-use flag with name fallbacks; a mailbox without
  one is refused at connect. Message cache keyed `folder + uid`; UIDVALIDITY
  tracked per folder.
- **Identity is a signed HttpOnly session cookie**, not the client IP. A forged
  `X-Forwarded-For` previously returned any user's pipeline and could move their
  stored IMAP credentials to an attacker's licence key.
- **`GET /%` no longer kills the process** (unguarded `decodeURIComponent`);
  added `uncaughtException` / `unhandledRejection` guards.
- **Live Jev mode fixed** — mock and live now share one `normalizeAnswer()`.
  Live previously returned `NOT_MONEY` with recoverability 0 for every thread.
- **One request per thread** instead of one per question (~4x less spend and
  latency); Pro budget charges the real question count.
- **Model pinned** to `jev-1.13.0`; `jev-latest` is a moving alias.
- **Test harness rebuilt so it can fail:** fake IMAP models two folders with
  independent, colliding UID spaces. 21 tests → 34.

### v1
- Initial MVP. 21 tests, green — against a mailbox that cannot exist.

## Quick start

```bash
npm install
cp .env.example .env   # then fill in values (see Env vars)
JEV_MOCK=true node server.js   # boots with mocked Jev, no key needed
npm test                       # 34 mocked tests (fake IMAP + stubbed Jev)
npm run check                  # node --check on every file
```

Health: `GET /api/health` → `{"ok":true,"mode":"mock"|"live","model":"jev-1.13.0"}`

## Architecture

```
IMAP account ──▶ inbox-store.js ──▶ quote-store.js ──▶ quote-classify.js ──▶ server.js ──▶ public/
INBOX + Sent     (connect,          (threading,        (Jev taxonomy,       (REST API,      (dashboard)
(poll 10 min)     folder discovery,   dedupe,            scoring, drafts)     sessions)
                  backfill)           cards, weights)
```

**File map**

| File | Responsibility |
|---|---|
| `server.js` | Bare `node:http` server, all `/api/*` routes, static `public/`, tier gating, background 10-min poll loop, process-level crash guards |
| `session.js` | Signed HttpOnly session cookies (the free-tier identity), plus `clientIp` for rate limiting only |
| `inbox-store.js` | IMAP via `imapflow` (TLS), AES-256-GCM credential encryption, **Sent-folder discovery**, per-folder resumable backfill, UIDVALIDITY tracking, reconnect/backoff, never logs bodies or credentials |
| `quote-store.js` | Subject normalization, participant threading, near-duplicate merge, stable card IDs, lifecycle state, per-stall-reason Laplace outcome weights, free→Pro migration |
| `quote-classify.js` | The Jev pipeline (see taxonomy below), regex value extraction + Jev confirmation, recoverability scoring, deterministic draft templates, calendar-aware timing boost |
| `jev-client.js` | TypeSafe API client. **One normalizer for mock and live**, **one request per state**, pinned model |
| `license-store.js` | Gumroad license verify + 30-day cache + usage tiers |
| `public/` | Dashboard: pipeline hero number, connect panel, scan progress, ranked cards, locked-card upsell, license box |
| `test-quotes.mjs` | 34 tests, fake IMAP with real folder semantics + mocked Jev. `npm test` |

## Folders — read this before touching `inbox-store.js`

**QuoteRevive reads INBOX *and* the Sent folder, and the Sent folder is the
product.** A dead quote is something the owner *sent*; sent mail never appears
in INBOX. Reading INBOX alone makes `sentByUser` false for every message, the
directionality guard in `quote-classify.js` then demotes `QUOTE_SENT` →
`GHOSTED_THREAD` and `INVOICE_UNPAID` → `NOT_MONEY`, and the dashboard is empty
on a perfectly healthy mailbox.

- Sent is found via the RFC 6154 `\Sent` special-use flag, falling back to name
  matching (`Sent`, `Sent Items`, `[Gmail]/Sent Mail`, `INBOX.Sent`, …).
- A mailbox with no discoverable Sent folder is **refused at connect time**.
  Failing loudly beats an empty dashboard the user can't explain.
- UIDs are per-folder and collide across folders. The message cache is keyed
  `folder + uid`; every record carries its `folder`. Never key on uid alone.
- UIDVALIDITY is tracked per folder; when the server changes it, that folder's
  cache and cursor reset.
- `sentByUser` is true when a message is in Sent **or** its From matches the
  login — the first clause covers people sending from an alias.

## Jev taxonomy (the product)

- **Pass 1 — thread type** (`choice`): `QUOTE_SENT` / `INVOICE_UNPAID` /
  `GHOSTED_THREAD` / `NOT_MONEY`. **Directionality rule (critical):** quotes and
  invoices count ONLY when sent from the user's own Sent mail. Inbound vendor
  invoices, receipts, and newsletters with dollar amounts are `NOT_MONEY`. There
  is also a code-level directionality backstop in `quote-classify.js` — keep it.
- **Pass 2 — stall reason** (`choice`): `PRICE_STALL` / `TIMING_STALL` /
  `COMPETITOR_STALL` / `LOGISTICS_STALL` / `TRUE_GHOST` / `DEAD`. `DEAD`
  auto-dismisses forever.
- **Pass 3 — scores:** recoverability 0–1, deal value via regex + `noul`
  confirmation (unknown renders as `"est. ?"`, user-editable — **never `$0`**).
- All passes share one state, so they go out as a **single request**. Jev
  evaluates questions in parallel and bills input tokens only; splitting them
  across requests re-uploads the thread and pays for it again.
- **Ranking:** expected value = deal_value × recoverability, adjusted in code
  (sent-last boost, long-thread boost, calendar-aware timing boost, >120d cold
  penalty, per-stall-reason outcome weights).
- **Drafts are deterministic templates** with slots — no generative prose, no
  hallucination risk.

### Jev client rules

1. **One normalizer.** `normalizeAnswer()` handles mock and live answers alike,
   so the shape callers see cannot drift between the mode tests run and the mode
   customers run. A missing or renamed probability **throws** rather than
   silently scoring 0.
2. **One request per state.** Questions sharing an `input` are batched.
3. **The model is pinned** (`jev-1.13.0`, override with `JEV_MODEL`).
   `jev-latest` is a moving alias; letting it drift changes classification under
   fixed thresholds with no deploy.

## Identity and sessions

Free identities are a **signed HttpOnly cookie**, not the client IP. IP-based
identity meant anyone could read anyone's pipeline with a forged
`X-Forwarded-For`, and everyone behind one NAT shared an identity. Proxy headers
are now read only when `TRUST_PROXY_HEADERS=true`, and only for rate limiting.

The free→Pro migration follows the caller's own session cookie, so it can't be
aimed at a stranger's stored credentials.

## Lifecycle rules (do not regress)

- Nudged threads suppressed 21 days; a contact reply re-opens and re-classifies.
- Snooze 7/30 days; Dismiss permanent with reason.
- Won/Lost outcomes adjust per-stall-reason Laplace weights (learning loop).
- Newly-dead detection: silence after a user-sent quote/invoice → new card on the
  next 10-min poll. **This only works because the poller watches Sent too.**
- Free tier: full scan runs; API reveals top 3 cards + total count + pipeline
  value; rest locked. Pro (Gumroad license) unlocks all. Card IDs stay
  identity-independent so free→Pro migration never breaks links.
- Currency is detected and displayed, never converted (MVP).

## Env vars

| Var | Purpose |
|---|---|
| `JEV_API_KEY` | TypeSafe key (live mode) |
| `JEV_MOCK` | `true` = stubbed Jev (dev/test); `false` = live |
| `JEV_MODEL` | Pinned model, default `jev-1.13.0` |
| `CREDENTIAL_KEY` | 64 hex chars, AES-256-GCM for mailbox creds — **generate fresh per deploy** |
| `SESSION_SECRET` | HMAC secret for session cookies. Falls back to a key derived from `CREDENTIAL_KEY` |
| `TRUST_PROXY_HEADERS` | `true` only when actually behind a trusted proxy (e.g. Cloudflare) |
| `QR_INSECURE_COOKIES` | `true` to drop the `Secure` flag for local http development |
| `GUMROAD_PRODUCT_PERMALINK` | QuoteRevive Pro product permalink |
| `GUMROAD_URL` | Full Gumroad checkout URL (Pro buttons) |
| `FREE_SCAN_DAILY_LIMIT` | default 1 |
| `PRO_MONTHLY_LIMIT` | default 5000 Jev questions/month |
| `PORT` | only if the host requires it |

## Deploy (DirectAdmin, Node.js Selector)

App root `domains/<domain>/public_html`, startup file `server.js`,
`npm install`, paste env vars, **SAVE (blue button) then full STOP → START** —
restart alone does NOT apply env changes.

Run behind a process supervisor. The server now installs
`uncaughtException`/`unhandledRejection` guards, but a supervisor is still the
backstop.

## Open follow-ups

1. **Storage is JSON files and will not survive users.** Every read parses a
   whole file; every write rewrites it for all users. `cacheMessages` rewrites
   `messages.json` once per page (~8 MB/user at the cap). There is no locking,
   so the 10-minute poller and a user action can both read-modify-write
   `cards.json` and lose one of them. **Next change: move to `node:sqlite`.**
2. **Mailbox passwords are recoverable by anyone with the box.** AES-256-GCM is
   correct, but `CREDENTIAL_KEY` lives in the same env as the process that reads
   `data/inboxes.json`. OAuth (Gmail/Microsoft) is the real fix; Google's
   restricted scopes require verification plus an annual CASA assessment, so
   start that before it's the blocker.
3. **Live-mode smoke test** (`JEV_MOCK=false` + real key, one real scan) and a
   real-mailbox connect against Gmail/Outlook/Fastmail to confirm Sent discovery
   in the wild.
4. **Demo mode (not built):** seeded fictional inbox behind a "try the demo"
   toggle, so prospects click the full dashboard with no inbox connection. Also
   serves as video/post content.
5. Gumroad "QuoteRevive Pro" product ($29/mo) still needs creating; then fill
   `GUMROAD_PRODUCT_PERMALINK` / `GUMROAD_URL`.
6. Hand-tuned ranking multipliers (`×1.15` sent-last, `×1.5` timing, …) are
   guesses. Won/lost clicks are the only ground truth the system collects —
   accumulate them and fit the weights.
