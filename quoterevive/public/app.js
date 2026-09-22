// QuoteRevive dashboard — no build step, plain JS.
const $ = (id) => document.getElementById(id);

const store = {
  get key() { return localStorage.getItem("qr_key") || ""; },
  set key(v) { v ? localStorage.setItem("qr_key", v) : localStorage.removeItem("qr_key"); },
};

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (store.key) headers["x-license-key"] = store.key;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.error) data.error = `Request failed (${res.status})`;
  return { status: res.status, data };
}

function setStatus(el, msg, kind) {
  el.textContent = msg || "";
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
}

function fmtMoney(n) {
  return "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
}
function fmtValue(card) {
  const amount = card.dealValueOverride ?? card.dealValue?.amount;
  if (amount == null) return "est. ?";
  const cur = card.dealValue?.currency || "$";
  return cur + Number(amount).toLocaleString("en-US");
}

// ── provider presets ──
document.querySelectorAll("#providerPresets .preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#providerPresets .preset").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.host) {
      $("imapHost").value = btn.dataset.host;
      $("imapPort").value = btn.dataset.port || "993";
    } else {
      $("imapHost").value = "";
      $("imapHost").focus();
    }
  });
});

// ── inbox connect ──
async function refreshInbox() {
  const { data } = await api("/api/inbox/status");
  const connected = !!(data && data.connected);
  $("disconnectBtn").hidden = !connected;
  if (connected) {
    setStatus($("inboxStatus"), `Connected as ${data.user} · last check ${data.lastChecked ? new Date(data.lastChecked).toLocaleString() : "never"}${data.lastError ? " · ⚠ " + data.lastError : ""}`, data.lastError ? "error" : "ok");
  } else {
    setStatus($("inboxStatus"), "");
  }
  return connected;
}

$("connectBtn").addEventListener("click", async () => {
  const body = {
    host: $("imapHost").value.trim(),
    port: $("imapPort").value.trim(),
    user: $("imapUser").value.trim(),
    pass: $("imapPass").value,
    key: store.key,
  };
  setStatus($("inboxStatus"), "Connecting…");
  const { data } = await api("/api/inbox/connect", { method: "POST", body: JSON.stringify(body) });
  if (data.ok) {
    $("imapPass").value = "";
    setStatus($("inboxStatus"), data.message, "ok");
    await refreshInbox();
  } else {
    setStatus($("inboxStatus"), data.error || "Couldn't connect.", "error");
  }
});

$("disconnectBtn").addEventListener("click", async () => {
  if (!confirm("Disconnect your inbox and delete its scanned deals?")) return;
  const { data } = await api("/api/inbox/disconnect", { method: "POST", body: JSON.stringify({ key: store.key }) });
  setStatus($("inboxStatus"), data.ok ? "Disconnected." : (data.error || "Couldn't disconnect."), data.ok ? "ok" : "error");
  await refreshAll();
});

// ── scan ──
let scanTimer = null;
async function pollScanProgress() {
  const { data } = await api("/api/inbox/scan-progress");
  const p = data || {};
  const active = ["starting", "fetching", "classifying"].includes(p.status);
  $("scanProgress").hidden = !active && p.status !== "done";
  if (active) {
    $("scanFill").style.width = (p.pct || 0) + "%";
    $("scanText").textContent = p.status === "classifying"
      ? "Reading threads with AI…"
      : `Fetching mail… ${p.done || 0} of ${p.total || 0}`;
    $("scanBtn").disabled = true;
  } else {
    $("scanBtn").disabled = false;
    if (p.status === "done" && p.finishedAt) {
      $("scanText").textContent = `Scan finished · ${p.done || 0} messages`;
    } else if (p.status === "error") {
      $("scanText").textContent = "Scan failed: " + (p.error || "unknown error");
    }
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (p.status === "done" || p.status === "error") await refreshQuotes();
  }
  return active;
}

$("scanBtn").addEventListener("click", async () => {
  const { data, status } = await api("/api/inbox/scan", { method: "POST", body: JSON.stringify({ key: store.key }) });
  if (data.ok) {
    $("scanProgress").hidden = false;
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = setInterval(pollScanProgress, 2500);
    pollScanProgress();
  } else {
    alert(data.error || `Couldn't start the scan (${status}).`);
  }
});

// ── license ──
async function activateLicense(key) {
  const k = (key || "").trim();
  if (!k) return;
  setStatus($("licenseStatus"), "Checking…");
  const { data } = await api("/api/license", { method: "POST", body: JSON.stringify({ key: k }) });
  if (data.ok) {
    store.key = k;
    setStatus($("licenseStatus"), "Pro activated — welcome aboard.", "ok");
    $("licenseKey").value = "";
    await refreshAll();
  } else {
    setStatus($("licenseStatus"), data.error || "That key didn't work.", "error");
  }
}
$("activateBtn").addEventListener("click", () => activateLicense($("licenseKey").value));
$("licenseKey").addEventListener("keydown", (e) => { if (e.key === "Enter") activateLicense($("licenseKey").value); });

async function initCheckout() {
  const { data } = await api("/api/config");
  const url = String((data && data.gumroadUrl) || "").trim();
  for (const id of ["buyBtn", "buyBtn2"]) {
    const el = $(id);
    if (!el) continue;
    if (url) { el.setAttribute("href", url); }
    else { el.textContent = "Checkout coming soon"; el.addEventListener("click", (e) => e.preventDefault()); }
  }
}

// ── quotes ──
function badgeClass(type) {
  return type === "QUOTE_SENT" ? "cat-quote" : type === "INVOICE_UNPAID" ? "cat-invoice" : "cat-ghost";
}

function cardHtml(c) {
  const recovPct = Math.round((c.recoverability || 0) * 100);
  return `
  <article class="deal-card${c.timingBoost ? " boosted" : ""}" data-id="${c.id}">
    ${c.timingBoost ? `<span class="boost-tag">Timing is now</span>` : ""}
    <div class="deal-top">
      <div>
        <div class="deal-contact">${escapeHtml(c.contact.name || c.contact.address)}</div>
        <div class="deal-email">${escapeHtml(c.contact.address)}</div>
      </div>
      <div class="deal-value">
        <div class="amount">${escapeHtml(fmtValue(c))}</div>
        <div class="ev">expected value ${fmtMoney(c.expectedValue)}</div>
      </div>
    </div>
    <div><span class="badge ${badgeClass(c.type)}">${escapeHtml(c.typeLabel)}</span></div>
    <p class="stall-detail">${escapeHtml(c.stallDetail)}</p>
    <div class="recov"><span>Revival chance</span><div class="recov-bar"><div class="recov-fill" style="width:${recovPct}%"></div></div><strong>${recovPct}%</strong></div>
    <div class="draft-box">${escapeHtml(c.draft)}</div>
    <div class="value-edit">
      <input type="number" min="0" step="1" placeholder="Set deal value" aria-label="Set deal value" />
      <button class="btn btn-ghost" data-act="value">Set</button>
    </div>
    <div class="deal-actions">
      <button class="btn btn-primary" data-act="nudge">Copy nudge</button>
      <button class="btn btn-ghost" data-act="snooze7">Snooze 7d</button>
      <button class="btn btn-ghost" data-act="snooze30">Snooze 30d</button>
      <button class="btn btn-ghost" data-act="won">Won ✓</button>
      <button class="btn btn-ghost" data-act="lost">Lost</button>
      <button class="btn btn-danger-ghost" data-act="dismiss">Dismiss</button>
    </div>
    ${c.threadCount > 1 ? `<p class="threads-note">${c.threadCount} threads merged into this deal</p>` : ""}
  </article>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

async function refreshQuotes() {
  const { data } = await api("/api/quotes");
  const tier = (data && data.tier) || "free";
  $("tierName").textContent = tier === "pro" ? "Pro" : "Free";
  $("tierHint").textContent = tier === "pro"
    ? "Pro unlocked — full ranked list, deeper scans, ongoing detection."
    : "Free shows your top 3 deals + totals. Pro unlocks everything.";
  $("pipelineNumber").textContent = fmtMoney(data.total || 0);
  $("pipelineSub").textContent = (data.count || 0) === 0
    ? "Connect your inbox and run a scan."
    : `${data.count} stalled deal${data.count === 1 ? "" : "s"} found`;

  const cards = data.cards || [];
  $("cardsHint").textContent = cards.length ? `Ranked by expected recoverable value · showing ${cards.length}` : "";
  $("cards").innerHTML = cards.length
    ? cards.map(cardHtml).join("")
    : `<div class="empty-state">No stalled deals found yet. Run a scan to dig them up.</div>`;

  const locked = Number(data.locked) || 0;
  $("lockedBanner").hidden = locked <= 0;
  if (locked > 0) $("lockedCount").textContent = `${locked} more`;

  // wire card buttons
  document.querySelectorAll(".deal-card").forEach((el) => {
    const id = el.dataset.id;
    el.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => cardAction(id, btn.dataset.act, el));
    });
  });
}

async function cardAction(id, act, el) {
  const card = { id };
  if (act === "nudge") {
    const draft = el.querySelector(".draft-box").textContent;
    try {
      await navigator.clipboard.writeText(draft);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = draft;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }
  let body = {};
  if (act === "snooze7") { act = "snooze"; body = { days: 7 }; }
  if (act === "snooze30") { act = "snooze"; body = { days: 30 }; }
  if (act === "value") {
    const input = el.querySelector(".value-edit input");
    body = { amount: input.value };
  }
  if (act === "dismiss" && !confirm("Dismiss this deal for good?")) return;
  const { data } = await api(`/api/quotes/${encodeURIComponent(id)}/${act}`, {
    method: "POST",
    body: JSON.stringify({ key: store.key, ...body }),
  });
  if (data.ok) {
    if (act === "nudge") {
      el.querySelector('[data-act="nudge"]').textContent = "Copied ✓";
    }
    setTimeout(refreshQuotes, 400);
  } else {
    alert(data.error || "Couldn't do that.");
  }
}

async function refreshAll() {
  await refreshInbox();
  await refreshQuotes();
  pollScanProgress();
}

// ── boot ──
(async function init() {
  if (store.key) $("licenseKey").placeholder = "Pro key saved ✓";
  await initCheckout();
  await refreshAll();
})();
