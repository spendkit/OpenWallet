// Owner dashboard + developer section. Talks to /api/* with the user's token (kept in localStorage).
const $ = (s, root = document) => root.querySelector(s);
const usd = (c) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toFixed(2);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const TOKEN_KEY = "agentCardsUserToken";
const TIERS = { quick: "Starter limits", full: "Full limits" };
const CHAINS = { "base-sepolia": "Base Sepolia", "ethereum-sepolia": "Ethereum Sepolia", base: "Base", "sandbox-sim": "Sandbox" };
const EXPLORERS = { base: "https://basescan.org/tx/", "base-sepolia": "https://sepolia.basescan.org/tx/", "ethereum-sepolia": "https://sepolia.etherscan.io/tx/" };
const chainName = (c) => CHAINS[String(c ?? "").replace(/^circle-/, "")] ?? CHAINS[c] ?? String(c ?? "").split("-").map(cap).join(" ");
const FIELDS = { firstName: "first name", lastName: "last name", dateOfBirth: "date of birth", idType: "ID type", idNumber: "ID number", idFrontImage: "ID photo", address1: "address", zipcode: "postcode",
  amountCents: "amount", perTransactionCents: "per-payment limit", dailyCents: "daily limit", allowedMccs: "MCCs", mcc: "MCC", idempotencyKey: "idempotency key" };
const VIEWS = ["overview", "fund", "agents", "developers"];
const ICONS = {
  overview: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  fund: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1.1-1.7 2.5-1.7s2.5.7 2.5 1.7-1.1 1.5-2.5 1.9-2.5.9-2.5 1.9 1.1 1.7 2.5 1.7 2.5-.7 2.5-1.7"/></svg>',
  agents: '<svg viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01"/></svg>',
  developers: '<svg viewBox="0 0 24 24"><path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/></svg>',
  docs: '<svg viewBox="0 0 24 24"><path d="M5 4h10l4 4v12H5zM14 4v5h5M8 13h8M8 17h6"/></svg>',
};

let token = localStorage.getItem(TOKEN_KEY) || null;
let state = null, revealed = null, busy = false;
let view = null, kycView = null, built = false, authTab = "signup";
const agentEls = new Map();
const root = $("#root");

// ---------- helpers ----------
function friendly(msg) {
  let m = String(msg || "Something went wrong");
  m = m.replace(/idFrontImage must be a PNG or JPEG data URI/, "ID photo must be a PNG or JPEG");
  m = m.replace(/must be a positive whole number of cents/, "must be at least $0.01");
  m = m.replace(/must be YYYY-MM-DD/, "must be a date like 1990-01-31");
  m = m.replace(/\b[a-z]+[A-Z0-9][A-Za-z0-9]*\b/g, (w) => FIELDS[w] ?? w);
  return cap(m);
}
class FieldError extends Error { constructor(input, message) { super(message); this.input = input; } }
function markInvalid(input) { input.closest("details")?.setAttribute("open", ""); input.setAttribute("aria-invalid", "true"); input.focus(); }
document.addEventListener("input", (e) => e.target.removeAttribute?.("aria-invalid"));

/** Dollars typed by a person → cents. Refuses fractions of a cent rather than rounding them away. */
function dollars(input, what) {
  const raw = input.value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!raw) throw new FieldError(input, `Enter ${what}`);
  if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) throw new FieldError(input, `${cap(what)} must be a number, like 10 or 10.50`);
  if (/\.\d{3,}$/.test(raw)) throw new FieldError(input, `${cap(what)} can only go down to cents (2 decimal places)`);
  const c = Math.round(Number(raw) * 100);
  if (c < 1) throw new FieldError(input, `${cap(what)} must be at least $0.01`);
  return c;
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || "HTTP " + r.status); e.status = r.status; throw e; }
  return data;
}

/** Runs one user action: locks the action buttons, spins the one pressed, then refreshes and confirms. */
async function act(btn, fn, okMsg) {
  if (busy) return;
  busy = true;
  const locked = [...document.querySelectorAll("#root button:not([data-copy]):not(.cp):not(.tab):not(:disabled)")];
  locked.forEach((b) => (b.disabled = true));
  btn?.classList.add("spin"); btn?.setAttribute("aria-busy", "true");
  try {
    const r = await fn();
    const fresh = await load();
    if (okMsg && fresh) toast(typeof okMsg === "function" ? okMsg(r) : okMsg, "ok");
  } catch (e) {
    if (e.input) markInvalid(e.input);
    toast(friendly(e.message), "bad");
  } finally {
    busy = false;
    locked.forEach((b) => b.isConnected && (b.disabled = false));
    btn?.classList.remove("spin"); btn?.removeAttribute("aria-busy");
  }
}

async function load() {
  if (!token) { render(); return false; }
  try { state = await api("GET", "/api/me"); render(); return true; }
  catch (e) {
    if (e.status === 401) { forget(); toast("Your session ended. Log in again with your user token.", "bad"); }
    else toast(friendly(e.message), "bad");
    render();
    return false;
  }
}
function forget() { token = null; state = null; revealed = null; localStorage.removeItem(TOKEN_KEY); }
/** Sets innerHTML only when it changed, so refreshes don't churn nodes under the cursor. */
function setHTML(el, html) { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } }
const hl = (v) => {
  // Tiny JSON highlighter: tokens are escaped one by one so nothing from the response reaches the DOM as markup.
  const src = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return src.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[^"\-\dtfn]+|./g, (m, str, colon, lit) =>
    str ? `<span class="${colon ? "k" : "s"}">${esc(str)}</span>${colon ?? ""}` : lit || /^-?\d/.test(m) ? `<span class="n">${esc(m)}</span>` : esc(m));
};
const codeBlock = (lang, body) => `<div class="code" data-lang="${esc(lang)}"><div class="bar"><span>${esc(lang)}</span><button type="button" class="cp">Copy</button></div><pre>${body}</pre></div>`;

// ---------- shell ----------
function render() {
  if (!token || !state) { if (view !== "out") showLoggedOut(); return; }
  if (view !== "in") showShell();
  update();
}

function showLoggedOut() {
  view = "out"; kycView = null; built = false; agentEls.clear();
  setHTML($("#who"), ""); // through setHTML so its cache is cleared, else logging back in skips redrawing #logout
  root.innerHTML = `<div class="auth">
    <div>
      <span class="badge accent"><span class="dot"></span>Sandbox · testnet money only</span>
      <h1 style="margin-top:16px">A real card for your AI agents. With a budget.</h1>
      <p class="lede">Verify once, fund with USDC, then hand each agent its own limits. They pay through MCP or REST; you stay in control.</p>
      <div class="tabs" role="tablist"><button type="button" class="tab" role="tab" data-tab="signup">Create account</button><button type="button" class="tab" role="tab" data-tab="login">I have a token</button></div>
      <div id="authForm"></div>
    </div>
    <div class="art" aria-hidden="true">
      <div class="vcard"><div style="display:flex;justify-content:space-between;align-items:center"><span class="chip"></span><span class="net">VISA</span></div>
        <div><div class="pan">•••• •••• •••• ••••</div></div><div class="meta"><span>AGENT CARDS</span><span>SANDBOX</span></div></div>
    </div></div>`;
  root.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { authTab = b.dataset.tab; paintAuth(); $("#authForm input")?.focus(); }));
  paintAuth();
}

function paintAuth() {
  root.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === authTab)));
  const box = $("#authForm");
  if (authTab === "signup") {
    box.innerHTML = `<form id="signupForm" class="row" novalidate><label style="flex:1 1 240px">Email<input id="email" type="email" autocomplete="email" placeholder="you@example.com"></label><button class="accent lg btn" type="submit">Create account</button></form>
      <p class="muted small" style="margin-top:12px">No password. You get a token that is shown once and saved in this browser.</p>`;
    $("#signupForm").onsubmit = (e) => {
      e.preventDefault();
      const input = $("#email"), btn = e.submitter ?? $("#signupForm button");
      act(btn, async () => {
        const email = input.value.trim();
        if (!email) throw new FieldError(input, "Enter your email address");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FieldError(input, "That email address doesn't look right");
        const r = await api("POST", "/api/signup", { email });
        token = r.token; localStorage.setItem(TOKEN_KEY, token);
      }, "Account created. Your token is saved in this browser.");
    };
  } else {
    box.innerHTML = `<form id="loginForm" class="row" novalidate><label style="flex:1 1 240px">Your user token<input id="tok" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="uk_…"></label><button class="accent lg btn" type="submit">Log in</button></form>`;
    $("#loginForm").onsubmit = (e) => {
      e.preventDefault();
      const input = $("#tok"), btn = e.submitter ?? $("#loginForm button");
      act(btn, async () => {
        const t = input.value.trim();
        if (!t) throw new FieldError(input, "Paste your user token. It starts with uk_");
        token = t;
        try { state = await api("GET", "/api/me"); }
        catch (err) { token = null; state = null; throw err.status === 401 ? new FieldError(input, "That token wasn't recognised") : err; }
        localStorage.setItem(TOKEN_KEY, token);
      }, "Logged in");
    };
  }
}

function showShell() {
  view = "in"; kycView = null; built = false; fundBuilt = false; agentsBuilt = false; devBuilt = false; agentEls.clear();
  const link = (v, label) => `<a href="#${v}" data-v="${v}">${ICONS[v]}${label}</a>`;
  root.innerHTML = `<div class="shell">
    <nav class="side" aria-label="Dashboard">${link("overview", "Overview")}${link("fund", "Fund")}${link("agents", "Agents")}${link("developers", "Developers")}<hr><a class="desk" href="/docs">${ICONS.docs}Documentation</a></nav>
    <main id="main" tabindex="-1">
      <section class="panel" data-view="overview"></section>
      <section class="panel" data-view="fund" hidden></section>
      <section class="panel" data-view="agents" hidden></section>
      <section class="panel" data-view="developers" hidden></section>
    </main></div>`;
  built = false;
  showView();
}

function showView() {
  const h = location.hash.slice(1);
  const v = VIEWS.includes(h) ? h : "overview";
  document.querySelectorAll("[data-view]").forEach((p) => (p.hidden = p.dataset.view !== v));
  document.querySelectorAll(".side a[data-v]").forEach((a) => (a.dataset.v === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  document.title = `${cap(v)} · Agent Cards`;
  const panel = $(`[data-view="${v}"]`);
  panel.classList.remove("enter"); void panel.offsetWidth; panel.classList.add("enter");
}
addEventListener("hashchange", () => { if (view === "in") { showView(); scrollTo({ top: 0 }); } });

function logout() { forget(); render(); toast("Logged out"); }

// ---------- update ----------
const activeAgents = () => (state?.card?.agents ?? []).filter((a) => !a.revoked);
const allSpends = () => (state?.card?.agents ?? []).flatMap((a) => a.recent.map((s) => ({ ...s, agent: a.name }))).sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
const statusClass = (s) => (s === "approved" ? "ok" : s === "processing" ? "warn" : "bad");

function update() {
  setHTML($("#who"), `${esc(state.email)} · <button type="button" class="link" id="logout">log out</button>`);
  $("#logout").onclick = logout;
  const c = state.card;
  if (!built) { buildPanels(); built = true; }
  updateOverview();
  updateFund();
  updateAgentsPanel();
  updateDevelopers();
  if (c) updateAgents(c.agents);
}

function lock(title, text) {
  return `<div class="ph"><div><h1>${esc(title)}</h1></div></div><div class="empty"><b style="color:var(--ink)">Finish verification first</b><p style="margin:6px 0 14px">${esc(text)}</p><a class="btn primary" href="#overview">Go to Overview</a></div>`;
}

function buildPanels() {
  $('[data-view="overview"]').innerHTML = `<div class="ph"><div><h1>Overview</h1><p id="ovSub"></p></div></div>
    <div id="kycArea"></div><div id="ovMain" class="panel"></div>`;
  $('[data-view="fund"]').innerHTML = `<div id="fundBody" class="panel"></div>`;
  $('[data-view="agents"]').innerHTML = `<div id="agentsBody" class="panel"></div>`;
  $('[data-view="developers"]').innerHTML = `<div id="devBody" class="panel"></div>`;
}

// ----- overview -----
function updateOverview() {
  const c = state.card, k = state.kycStatus;
  setHTML($("#ovSub"), `${esc(TIERS[state.tier] ?? state.tier)} · identity <span class="${k === "Approved" ? "ok" : k === "Rejected" ? "bad" : "warn"}">${esc(k === "none" ? "not started" : k)}</span>`);

  const want = c ? "none" : (k === "Approved" || k === "Initiated" || k === "Pending") ? "waiting" : "form";
  if (want !== kycView) {
    kycView = want;
    const area = $("#kycArea");
    area._h = null;
    area.innerHTML = want === "form" ? kycCard() : want === "waiting" ? `<div class="card"><h2>Verifying your identity</h2><p class="muted" style="margin:0">Waiting for Miden to approve. This page checks every few seconds.</p></div>` : "";
    if (want === "form") wireKyc();
  }
  if (!c) { setHTML($("#ovMain"), ""); return; }

  const b = c.balances;
  const agentTotal = activeAgents().reduce((n, a) => n + a.balanceCents, 0);
  const waiting = b.awaitingFundingCents + b.fundingInFlightCents;
  const holdReason = b.awaitingFundingReason ?? null;
  const spends = allSpends();
  const steps = [
    ["Verify your identity", "Card KYC with Miden", true],
    ["Fund the card with USDC", "Send testnet USDC, or simulate a deposit", (c.lifetimeFundedCents ?? 0) > 0 || b.unallocatedOnCardCents + agentTotal > 0],
    ["Create an agent", "Each agent gets its own budget and limits", (c.agents.length > 0)],
    ["Give it a budget", "Move money from the card to the agent", agentTotal > 0 || spends.length > 0],
    ["Make a first payment", "Through MCP or REST; try the playground", spends.length > 0],
  ];
  const nextIdx = steps.findIndex((s) => !s[2]);
  const nextView = ["", "fund", "agents", "agents", "developers"][nextIdx] ?? "";
  const NEXT = [null, ["Fund your card", "Send testnet USDC, or simulate a deposit in one click.", "Add funds"], ["Create your first agent", "Give it a name and spending limits.", "Create agent"],
    ["Give the agent a budget", "Move some of your card balance to it.", "Give a budget"], ["Make a first payment", "Try the API playground, or connect your agent.", "Try a payment"]][nextIdx];
  setHTML($("#ovMain"), `
    ${NEXT ? `<div class="next-step"><div><span class="eyebrow">Step ${nextIdx + 1} of 5</span><h2>${esc(NEXT[0])}</h2><p>${esc(NEXT[1])}</p>${progress(nextIdx)}</div><a class="btn accent lg" href="#${nextView}">${esc(NEXT[2])} →</a></div>` : ""}
    <div class="hero">
      <div class="vcard"><div style="display:flex;justify-content:space-between;align-items:center"><span class="chip"></span><span class="net">VISA</span></div>
        <div><span class="lbl">Card balance</span><div class="bal">${usd(b.unallocatedOnCardCents + agentTotal)}</div></div>
        <div class="meta"><span class="mono">${esc(c.cardId.slice(0, 8))}…</span><span>SANDBOX</span></div></div>
      <div class="grid g2">
        <div class="stat"><span class="lbl">Unallocated</span><b>${usd(b.unallocatedOnCardCents)}</b><span class="lbl">yours to give agents</span></div>
        <div class="stat"><span class="lbl">With agents</span><b>${usd(agentTotal)}</b><span class="lbl">${activeAgents().length} active agent${activeAgents().length === 1 ? "" : "s"}</span></div>
        <div class="stat"><span class="lbl">Awaiting funding</span><b>${usd(waiting)}</b><span class="lbl">moves to the card automatically</span>
          ${holdReason && b.awaitingFundingCents > 0 ? `<span class="warn small note">${esc(cap(String(holdReason)))}</span>` : ""}</div>
        <div class="stat"><span class="lbl">Card limits</span><b>${usd(c.limits.perTransactionCents)}<span class="muted" style="font-size:15px"> / ${usd(c.limits.dailyCents)}</span></b><span class="lbl">per payment / per day</span>
          ${c.lifetimeFundingCapCents != null ? `<span class="small note">Funded ${usd(c.lifetimeFundedCents ?? 0)} of ${usd(c.lifetimeFundingCapCents)} lifetime</span>` : ""}</div>
      </div>
    </div>
    <div class="grid g2">
      <div class="card"><h2>Get started</h2>${nextIdx === -1 ? `<p class="ok" style="margin:0 0 6px"><b>You're all set.</b></p>` : ""}
        <ol class="steps">${steps.map((s, i) => `<li class="${s[2] ? "done" : i === nextIdx ? "next" : ""}"><span class="tick">${s[2] ? "✓" : i + 1}</span><span class="t">${esc(s[0])}<small>${esc(s[1])}</small></span>${i === nextIdx && nextView ? `<a class="btn sm primary" href="#${nextView}">Go</a>` : ""}</li>`).join("")}</ol></div>
      <div class="card"><h2>Recent payments</h2>${spends.length ? `<div class="scroll"><table><thead><tr><th>When</th><th>Agent</th><th>Merchant</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>${spends.slice(0, 8).map((s) => `<tr><td>${when(s.createdAt)}</td><td>${esc(s.agent)}</td><td>${esc(s.merchant)}</td><td><span class="badge ${statusClass(s.status)}">${esc(s.status)}</span></td><td class="num">${usd(s.amountCents)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted" style="margin:0">No payments yet. They appear here as agents spend.</p>`}</div>
    </div>`);
}

// ----- KYC -----
const KYC_FIELDS = [
  ["firstName", "First name"], ["lastName", "Last name"], ["dateOfBirth", "Date of birth"], ["idType", "ID type"], ["idNumber", "ID number"],
  ["phone", "Phone"], ["email", "Email"], ["address1", "Address"], ["city", "City"], ["state", "State"], ["zipcode", "Postcode"], ["country", "Country"],
];
function kycCard() {
  const f = (id, label, attrs = "") => `<label>${label}<input id="k_${id}" ${attrs}></label>`;
  return `<div class="next-step"><div><span class="eyebrow">Step 1 of 5</span><h2>Verify your identity</h2><p>This is a sandbox, so we'll use made-up test details. One click.</p>${progress(0)}</div>
    <button class="accent btn lg" type="button" id="quick">Verify with test details</button></div>
  <details class="fold" style="margin-top:14px"><summary>Or enter my own details</summary>
  <form id="kycForm" class="card" novalidate style="margin-top:10px">
  <p class="muted">Each submission needs a unique ID number, phone and email, or Miden matches it to an earlier customer. We never store these details.</p>
  <div class="grid auto">${f("firstName", "First name", `autocomplete="given-name"`)}${f("lastName", "Last name", `autocomplete="family-name"`)}${f("dateOfBirth", "Date of birth", `type="date" placeholder="1990-01-31"`)}
  <label>ID type<select id="k_idType"><option value="PASSPORT">Passport</option><option value="NATIONAL_ID">National ID</option><option value="DRIVERS_LICENSE">Driver's licence</option><option value="VOTERS_CARD">Voter's card</option></select></label>
  ${f("idNumber", "ID number")}${f("phone", "Phone", `type="tel" autocomplete="tel" placeholder="+2348012345678"`)}${f("email", "Email", `type="email" autocomplete="email"`)}
  ${f("address1", "Address", `autocomplete="address-line1"`)}${f("city", "City", `autocomplete="address-level2"`)}${f("state", "State", `autocomplete="address-level1"`)}${f("zipcode", "Postcode", `autocomplete="postal-code"`)}${f("country", "Country", `value="NG" maxlength="2" autocomplete="country"`)}</div>
  <label style="margin-top:14px">ID photo (PNG/JPEG; optional in sandbox)<input id="k_file" type="file" accept="image/png,image/jpeg"></label>
  <div class="row" style="margin-top:16px"><button class="accent" type="submit" id="kyc">Submit for verification</button></div></form></details>`;
}
const progress = (n) => `<div class="progress" aria-hidden="true">${[0, 1, 2, 3, 4].map((i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</div>`;
function wireKyc() {
  $("#quick").onclick = () => { fillTest(); $("#kycForm").requestSubmit(); };
  function fillTest() {
    const n = Date.now().toString().slice(-8), set = (id, v) => { const el = $("#k_" + id); el.value = v; el.removeAttribute("aria-invalid"); };
    set("firstName", "Ada"); set("lastName", "Sandbox" + n.slice(-3)); set("dateOfBirth", "1990-01-31"); set("idType", "PASSPORT"); set("idNumber", "A" + n);
    set("phone", "+23480" + n); set("email", `sandbox+${n}@example.com`); set("address1", "1 Test Street"); set("city", "Lagos"); set("state", "Lagos"); set("zipcode", "100001"); set("country", "NG");
  }
  $("#kycForm").onsubmit = (e) => {
    e.preventDefault();
    act($("#kyc"), async () => {
      const v = {};
      for (const [id, label] of KYC_FIELDS) {
        const el = $("#k_" + id);
        v[id] = el.value.trim();
        if (!v[id]) throw new FieldError(el, `${label} is required`);
        if (id === "dateOfBirth" && !/^\d{4}-\d{2}-\d{2}$/.test(v[id])) throw new FieldError(el, "Date of birth must be a date like 1990-01-31");
        if (id === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v[id])) throw new FieldError(el, "That email address doesn't look right");
      }
      const file = $("#k_file").files[0];
      const image = file ? await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); })
        : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      return api("POST", "/api/me/kyc", { firstName: v.firstName, lastName: v.lastName, dateOfBirth: v.dateOfBirth, idType: v.idType, idNumber: v.idNumber, phone: v.phone, email: v.email, idFrontImage: image,
        address: { address1: v.address1, city: v.city, state: v.state, zipcode: v.zipcode, country: v.country.toUpperCase() } });
    }, (r) => "Submitted: " + r.kycStatus);
  };
}

// ----- fund -----
let fundBuilt = false;
function updateFund() {
  const c = state.card, body = $("#fundBody");
  if (!c) { fundBuilt = false; setHTML(body, lock("Fund", "Your card and deposit address appear once your identity is approved.")); return; }
  if (!fundBuilt) {
    fundBuilt = true;
    body._h = null;
    body.innerHTML = `<div class="ph"><div><h1>Fund</h1><p>Send USDC to your deposit address. It lands on your card automatically.</p></div></div>
      <div class="card"><h2>Deposit address</h2><div id="fundIntro" class="muted" style="margin-bottom:12px"></div><div id="depAddr"></div>
        <p id="faucetNote" class="muted small" style="margin:14px 0 0" hidden>Free test USDC: <a href="https://faucet.circle.com" target="_blank" rel="noopener">faucet.circle.com</a> → choose <b>Base Sepolia</b>. The faucet opens on Ethereum Sepolia, which also works but is slower.</p></div>
      ${state.simulatedDeposits ? `<form id="simForm" class="card" novalidate><h2>Simulate a deposit</h2><p class="muted">Sandbox shortcut: credits your card as if USDC had arrived. It is labelled “simulated” in the ledger.</p>
        <div class="row"><label>Amount ($)<input id="simAmt" value="25" size="8" inputmode="decimal"></label><button type="submit" id="sim" class="accent">Simulate deposit</button></div></form>` : ""}
      <div id="depTables" class="panel"></div>`;
    if (state.simulatedDeposits) $("#simForm").onsubmit = (e) => {
      e.preventDefault();
      let amount;
      act($("#sim"), async () => { amount = dollars($("#simAmt"), "the deposit amount"); await api("POST", "/api/me/simulate-deposit", { amountCents: amount }); },
        () => `Simulated a ${usd(amount)} deposit. Moving it onto the card…`);
    };
  }
  const dep = c.deposit.address;
  const nets = c.deposit.networks ?? [c.deposit.chain];
  const netNames = nets.map(chainName);
  const testnet = nets.some((n) => /sepolia|goerli|testnet/i.test(String(n)));
  $("#faucetNote").hidden = !testnet;
  const timing = c.deposit.rail === "circle" ? `Credited once the network confirms it (${testnet ? "about 5 minutes on a testnet" : "usually within a few minutes"})` : "Credited after 5 blocks (about 10 s on Base, 1 min on Ethereum)";
  setHTML($("#fundIntro"), `<div class="chips">${netNames.map((n, i) => `<span class="badge ${i ? "" : "accent"}">USDC · ${esc(n)}</span>`).join("")}${testnet ? '<span class="badge warn">Testnet</span>' : ""}</div>
    <p style="margin:0 0 8px"><strong>Send only USDC on ${esc(netNames.join(" or "))}.</strong></p>${esc(timing)}, then moved onto the card. Minimum card top-up $1.00.
    <div class="warnbox" role="note"><strong>Wrong network means lost funds.</strong> This address only sees USDC that arrives on ${esc(netNames.join(" or "))}. USDC sent on any other network (Ethereum, Polygon, Arbitrum…) and USDT on any network are not supported, will not be credited and usually cannot be recovered. Check the network in your wallet before you send.</div>`);
  setHTML($("#depAddr"), dep ? `<div class="addr"><span class="mono">${esc(dep)}</span><button type="button" class="sm" data-copy="${esc(dep)}">Copy</button></div>` : `<p class="muted">Creating your address…</p>`);
  setHTML($("#depTables"), `
    ${c.deposits.length ? `<div class="card"><h2>Deposits</h2><div class="scroll"><table><thead><tr><th>When</th><th>Network</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>${c.deposits.map((d) => `<tr><td>${when(d.at)}</td><td>${d.simulated ? '<span class="badge">Simulated</span>' : esc(chainName(d.chain))}</td><td class="mono">${d.simulated ? "–" : `<a href="${esc(EXPLORERS[String(d.chain).replace(/^circle-/, "")] ?? EXPLORERS["base-sepolia"])}${esc(d.reference)}" target="_blank" rel="noopener">${esc(d.reference.slice(0, 14))}…</a>`}</td><td class="num">${usd(d.amountCents)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
    ${c.fundings.length ? `<div class="card"><h2>Card top-ups</h2><div class="scroll"><table><thead><tr><th>When</th><th>Status</th><th>Detail</th><th class="num">Amount</th></tr></thead><tbody>${c.fundings.map((f) => `<tr><td>${when(f.at)}</td><td><span class="badge ${f.status === "completed" ? "ok" : f.status === "released" ? "bad" : "warn"}">${esc(f.status)}</span></td><td class="muted wrap">${esc(f.detail ?? "")}</td><td class="num">${usd(f.amountCents)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`);
}

// ----- agents -----
let agentsBuilt = false;
function updateAgentsPanel() {
  const c = state.card, body = $("#agentsBody");
  if (!c) { agentsBuilt = false; setHTML(body, lock("Agents", "Create agents once your card is issued.")); return; }
  if (!agentsBuilt) {
    agentsBuilt = true;
    agentEls.clear();
    body._h = null;
    body.innerHTML = `<div class="ph"><div><h1>Agents</h1><p>Each agent gets its own budget, limits and token. Limits can't exceed the card's.</p></div></div>
      <form id="aForm" class="card" novalidate><h2>New agent</h2>
        <div class="grid auto"><label>Name<input id="aName" placeholder="research-bot" autocomplete="off"></label><label>Per payment ($)<input id="aTxn" value="20" inputmode="decimal"></label><label>Per day ($)<input id="aDay" value="50" inputmode="decimal"></label><label>Only MCCs (optional)<input id="aMcc" placeholder="5734,5817" inputmode="numeric"></label></div>
        <div class="row" style="margin-top:16px"><button class="accent" type="submit" id="aCreate">Create agent</button></div></form>
      <div id="reveal"></div><div id="agentList" class="panel"></div>
      <details class="fold" id="revokedWrap" hidden><summary>Revoked agents (<span id="revokedCount">0</span>)</summary><div id="revokedList" class="panel" style="margin-top:12px"></div></details>`;
    $("#aForm").onsubmit = (e) => {
      e.preventDefault();
      act($("#aCreate"), async () => {
        const nameEl = $("#aName"), name = nameEl.value.trim();
        if (!name) throw new FieldError(nameEl, "Give the agent a name");
        const perTransactionCents = dollars($("#aTxn"), "the per-payment limit"), dailyCents = dollars($("#aDay"), "the daily limit");
        const mccEl = $("#aMcc"), mcc = mccEl.value.trim();
        if (mcc && !mcc.split(",").map((m) => m.trim()).filter(Boolean).every((m) => /^\d{4}$/.test(m))) throw new FieldError(mccEl, "MCCs are 4-digit codes, separated by commas");
        revealed = await api("POST", "/api/me/agents", { name, perTransactionCents, dailyCents, ...(mcc ? { allowedMccs: mcc } : {}) });
        nameEl.value = "";
        showReveal();
        return revealed;
      }, (r) => `Created ${r.name}. Copy its token below; it's shown once.`);
    };
    showReveal();
  }
}

function showReveal() {
  const box = $("#reveal");
  if (!box) return;
  if (!revealed) { box.innerHTML = ""; return; }
  const t = revealed.token;
  box.innerHTML = `<div class="secret"><b>Token for ${esc(revealed.name)}. Shown once; copy it now.</b>
    <div class="tok"><span class="mono">${esc(t)}</span><button type="button" class="sm" data-copy="${esc(t)}">Copy</button></div>
    <p class="small" style="margin:0">Connection snippets for this agent are in <a href="#developers">Developers</a>, with the token filled in.</p>
    <div><button type="button" id="hide">I've saved it</button></div></div>`;
  $("#hide").onclick = () => { revealed = null; showReveal(); updateDevelopers(); };
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  updateDevelopers();
}

const agentName = (id) => state?.card?.agents.find((a) => a.agentId === id)?.name ?? "the agent";

function agentEl(a) {
  let el = agentEls.get(a.agentId);
  if (!el) {
    el = document.createElement("div");
    el.className = "agent";
    el.innerHTML = `<div class="head"></div><div class="grid auto stats"></div><div class="ctl"></div><div class="recent"></div>`;
    agentEls.set(a.agentId, el);
  }
  el.classList.toggle("revoked", !!a.revoked);
  setHTML($(".head", el), `<div><div class="name">${esc(a.name)} ${a.revoked ? '<span class="badge bad">revoked</span>' : '<span class="badge ok"><span class="dot"></span>active</span>'}</div><div class="mono muted small">${esc(a.agentId)}</div></div>
      <div class="muted small" style="text-align:right">${usd(a.policy.perTransactionCents)} / payment · ${usd(a.policy.dailyCents)} / day${a.policy.allowedMccs ? "<br>MCC " + esc(a.policy.allowedMccs.join(", ")) : ""}</div>`);
  setHTML($(".stats", el), `<div class="stat"><span class="lbl">Balance</span><b>${usd(a.balanceCents)}</b></div><div class="stat"><span class="lbl">Spent today</span><b>${usd(a.spentTodayCents)}</b></div>`);
  const ctl = $(".ctl", el);
  if (a.revoked) ctl.innerHTML = "";
  else if (!ctl.firstChild) {
    ctl.innerHTML = `<div class="row"><label>Amount ($)<input class="amt" value="10" size="6" inputmode="decimal"></label><button type="button" class="give primary">Give</button><button type="button" class="take">Take back</button><button type="button" class="revoke">Revoke</button></div>`;
    const id = a.agentId, amt = $(".amt", ctl);
    $(".give", ctl).onclick = (e) => { let c; act(e.currentTarget, async () => { c = dollars(amt, "the amount"); await api("POST", `/api/me/agents/${id}/fund`, { amountCents: c }); }, () => `Gave ${usd(c)} to ${agentName(id)}`); };
    $(".take", ctl).onclick = (e) => { let c; act(e.currentTarget, async () => { c = dollars(amt, "the amount"); await api("POST", `/api/me/agents/${id}/reclaim`, { amountCents: c }); }, () => `Took ${usd(c)} back from ${agentName(id)}`); };
    $(".revoke", ctl).onclick = (e) => {
      const name = agentName(id), btn = e.currentTarget;
      if (busy || !confirm(`Revoke ${name}? Its token stops working and its balance returns to the card.`)) return;
      act(btn, () => api("POST", `/api/me/agents/${id}/revoke`), `Revoked ${name}. Its balance went back to the card.`);
    };
  }
  setHTML($(".recent", el), a.recent.length ? `<div class="scroll"><table><thead><tr><th>When</th><th>Merchant</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>${a.recent.map((s) => `<tr><td>${when(s.createdAt)}</td><td>${esc(s.merchant)}${s.mcc ? ` <span class="muted">${esc(s.mcc)}</span>` : ""}</td><td class="wrap"><span class="badge ${statusClass(s.status)}" title="${esc(s.status === "processing" ? "The card network's answer was lost. The money is held until it settles, usually within 10 minutes." : s.reason ?? "")}">${esc(s.status)}</span>${s.reason ? ` <span class="muted small">${esc(s.reason)}</span>` : ""}</td><td class="num">${usd(s.amountCents)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted small" style="margin:0">No payments yet.</p>`);
  return el;
}

/** Puts elements in `list` into `box` in order, moving only the ones out of place. */
function place(box, list) {
  list.forEach((el, i) => { if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null); });
  while (box.children.length > list.length) box.lastElementChild.remove();
}

function updateAgents(agents) {
  if (!$("#agentList")) return;
  const seen = new Set(agents.map((a) => a.agentId));
  for (const id of [...agentEls.keys()]) if (!seen.has(id)) { agentEls.get(id).remove(); agentEls.delete(id); }
  const active = agents.filter((a) => !a.revoked).map(agentEl);
  const gone = agents.filter((a) => a.revoked).map(agentEl);
  const list = $("#agentList");
  if (active.length) { if (list.firstChild?.classList?.contains("empty")) list.innerHTML = ""; list._h = null; place(list, active); }
  else setHTML(list, `<div class="empty">${gone.length ? "No active agents." : "No agents yet. Create one above."}</div>`);
  $("#revokedWrap").hidden = !gone.length;
  $("#revokedCount").textContent = gone.length;
  place($("#revokedList"), gone);
}

// ----- developers -----
let devBuilt = false, pgToken = sessionStorage.getItem("ac-pg-token") || "";
const ENDPOINTS = {
  wallet: { label: "GET /agent/v1/wallet", method: "GET", path: "/agent/v1/wallet" },
  transactions: { label: "GET /agent/v1/transactions", method: "GET", path: "/agent/v1/transactions" },
  pay: { label: "POST /agent/v1/pay", method: "POST", path: "/agent/v1/pay" },
  hostedPay: { label: "POST /agent/v1/hosted-checkouts/pay", method: "POST", path: "/agent/v1/hosted-checkouts/pay" },
  hosted: { label: "GET /agent/v1/hosted-checkouts", method: "GET", path: "/agent/v1/hosted-checkouts" },
};
function updateDevelopers() {
  const body = $("#devBody");
  if (!body) return;
  const c = state.card, base = location.origin;
  if (!devBuilt) {
    devBuilt = true;
    body._h = null;
    body.innerHTML = `<div class="ph"><div><h1>Developers</h1><p>Everything an agent needs to pay, and a place to try it. <a href="/docs">Read the full docs →</a></p></div></div>
      <div class="grid g2">
        <div class="card"><h2>Your credentials</h2>
          <dl class="kv"><dt>Base URL</dt><dd class="mono" id="dBase"></dd><dt>MCP endpoint</dt><dd class="mono" id="dMcp"></dd><dt>Owner token</dt><dd><span class="mono" id="dTok"></span></dd></dl>
          <div class="row" style="margin-top:14px"><button type="button" class="sm" id="revTok">Reveal</button><button type="button" class="sm" id="cpTok">Copy token</button><button type="button" class="sm" id="rotTok">Rotate</button></div>
          <p class="muted small" style="margin:12px 0 0">The owner token (<code>uk_…</code>) manages your account. Agents use their own <code>ak_…</code> tokens, which can only pay within their limits.</p></div>
        <div class="card"><h2>Connect an agent</h2><div id="connect"></div></div>
      </div>
      <div class="card"><h2>API playground</h2><p class="muted">Call the agent API as an agent would. Paste an agent token (it stays in this tab only).</p>
        <div class="pg"><form id="pgForm" novalidate>
          <div class="grid" style="gap:12px">
            <label>Agent token<input id="pgTok" type="password" autocomplete="off" spellcheck="false" placeholder="ak_…"></label>
            <label>Endpoint<select id="pgEp">${Object.entries(ENDPOINTS).map(([k, e]) => `<option value="${k}">${e.label}</option>`).join("")}</select></label>
            <div id="pgFields" class="grid" style="gap:12px"></div>
          </div>
          <div class="row" style="margin-top:16px"><button class="accent" type="submit" id="pgSend">Send request</button></div></form>
          <div class="res" id="pgRes"><div class="empty">The response appears here.</div></div></div></div>
      <div class="card"><h2>Request log</h2><div id="devLog"></div></div>`;
    $("#pgTok").value = pgToken;
    $("#pgTok").oninput = (e) => { pgToken = e.target.value.trim(); sessionStorage.setItem("ac-pg-token", pgToken); };
    $("#pgEp").onchange = paintPgFields;
    paintPgFields();
    $("#pgForm").onsubmit = (e) => { e.preventDefault(); runPlayground(); };
    let shown = false;
    const paintTok = () => { $("#dTok").textContent = shown ? token : token.slice(0, 7) + "•".repeat(14); $("#revTok").textContent = shown ? "Hide" : "Reveal"; };
    $("#revTok").onclick = () => { shown = !shown; paintTok(); };
    $("#cpTok").onclick = () => navigator.clipboard.writeText(token).then(() => toast("Copied", "ok"), () => toast("Couldn't copy", "bad"));
    $("#rotTok").onclick = (e) => {
      if (busy || !confirm("Rotate your owner token? The current one stops working immediately and this browser switches to the new one.")) return;
      act(e.currentTarget, async () => { const r = await api("POST", "/api/me/token"); token = r.token; localStorage.setItem(TOKEN_KEY, token); paintTok(); }, "Token rotated. This browser has the new one.");
    };
    paintTok();
    $("#dBase").textContent = base; $("#dMcp").textContent = base + "/mcp";
  }
  if (revealed && $("#pgTok") && !$("#pgTok").value) { $("#pgTok").value = pgToken = revealed.token; sessionStorage.setItem("ac-pg-token", pgToken); }
  // Connection snippets for the agent just created (token known), else a placeholder.
  const t = revealed?.token ?? "ak_YOUR_AGENT_TOKEN";
  setHTML($("#connect"), `${revealed ? `<p class="small ok" style="margin-top:0">Using the token for <b>${esc(revealed.name)}</b>.</p>` : `<p class="small muted" style="margin-top:0">Agent tokens are shown once, at creation. Create an agent to get snippets with its token filled in.</p>`}
    ${codeBlock("Claude Code · MCP over HTTP", `<span class="c">$</span> claude mcp add --transport http agent-cards ${esc(base)}/mcp \\\n  --header "Authorization: Bearer ${esc(t)}"`)}
    ${codeBlock("curl · REST", `curl -s ${esc(base)}/agent/v1/pay \\\n  -H "Authorization: Bearer ${esc(t)}" \\\n  -H "content-type: application/json" \\\n  -d '{"amountCents":500,"merchant":"Example API","mcc":"5734","idempotencyKey":"order-1"}'`)}
    <details class="fold"><summary>MCP over stdio (Claude Desktop and others)</summary>${codeBlock("json", hl({ mcpServers: { "agent-cards": { command: "node", args: ["--import", "tsx", "src/startMcpStdio.ts"], cwd: "<path to agent-cards>", env: { AGENT_CARDS_URL: base, AGENT_CARDS_TOKEN: t } } } }))}</details>`);
  const spends = allSpends();
  setHTML($("#devLog"), spends.length ? `<div class="scroll"><table><thead><tr><th>When</th><th>Agent</th><th>Spend ID</th><th>Merchant</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>${spends.slice(0, 25).map((s) => `<tr><td>${when(s.createdAt)}</td><td>${esc(s.agent)}</td><td class="mono">${esc(s.spendId)}</td><td>${esc(s.merchant)}${s.mcc ? ` <span class="muted">${esc(s.mcc)}</span>` : ""}</td><td class="wrap"><span class="badge ${statusClass(s.status)}">${esc(s.status)}</span>${s.reason ? ` <span class="muted small">${esc(s.reason)}</span>` : ""}</td><td class="num">${usd(s.amountCents)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted" style="margin:0">Payments from every agent show up here, newest first.</p>`);
}

function paintPgFields() {
  const ep = $("#pgEp").value, box = $("#pgFields");
  box._h = null;
  box.innerHTML = ep === "transactions" || ep === "hosted" ? `<label>limit (1–100)<input id="pgLimit" value="10" inputmode="numeric"></label>`
    : ep === "hostedPay" ? `<label>checkoutUrl<input id="pgUrl" placeholder="https://checkout.stripe.com/c/pay/…"></label><label>amountCents<input id="pgAmt" value="500" inputmode="numeric"></label><label>merchant<input id="pgMer" value="Example Store"></label><label>idempotencyKey<input id="pgKey" value="swap-${Date.now().toString(36)}"></label>`
    : ep === "pay" ? `<label>amountCents<input id="pgAmt" value="500" inputmode="numeric"></label><label>merchant<input id="pgMer" value="Example API"></label><label>mcc (optional)<input id="pgMcc" value="5734" inputmode="numeric"></label><label>idempotencyKey<input id="pgKey" value="demo-${Date.now().toString(36)}"></label>`
    : `<p class="muted small" style="margin:0">No parameters.</p>`;
}

async function runPlayground() {
  const ep = ENDPOINTS[$("#pgEp").value], tokInput = $("#pgTok");
  const res = $("#pgRes");
  const tok = tokInput.value.trim();
  if (!/^ak_\S+$/.test(tok)) { markInvalid(tokInput); toast("Paste an agent token. It starts with ak_", "bad"); return; }
  let path = ep.path, body;
  if (ep.path.endsWith("transactions") || ep.path.endsWith("hosted-checkouts")) path += `?limit=${encodeURIComponent($("#pgLimit").value.trim() || "10")}`;
  if (ep.method === "POST") {
    const mcc = $("#pgMcc")?.value.trim(), key = $("#pgKey").value.trim();
    body = { ...($("#pgUrl") ? { checkoutUrl: $("#pgUrl").value.trim() } : {}), amountCents: Number($("#pgAmt").value), merchant: $("#pgMer").value, ...(mcc ? { mcc } : {}), ...(key ? { idempotencyKey: key } : {}) };
  }
  const btn = $("#pgSend");
  btn.disabled = true; btn.classList.add("spin");
  const t0 = performance.now();
  let status = 0, data;
  try {
    const r = await fetch(path, { method: ep.method, headers: { authorization: "Bearer " + tok, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    status = r.status; data = await r.json().catch(() => ({}));
  } catch (e) { data = { error: String(e.message || e) }; }
  const ms = Math.round(performance.now() - t0);
  btn.disabled = false; btn.classList.remove("spin");
  const curl = `curl -s ${location.origin}${path} \\\n  -H "Authorization: Bearer $AGENT_TOKEN"` + (body ? ` \\\n  -H "content-type: application/json" \\\n  -d '${JSON.stringify(body)}'` : "");
  res._h = null;
  res.innerHTML = `<div class="meta"><span class="badge ${status >= 200 && status < 300 ? "ok" : "bad"}">${status || "network error"}</span><span class="muted small num">${ms} ms</span><span class="muted small mono">${esc(ep.label)}</span></div>
    ${codeBlock("response", hl(data))}<details class="fold"><summary>Equivalent curl</summary>${codeBlock("sh", esc(curl))}</details>`;
  if (status === 200 || status === 202) load();
}

// ---------- card tilt ----------
document.addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.querySelectorAll(".vcard").forEach((c) => {
    const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    const near = Math.abs(x) < 1.6 && Math.abs(y) < 1.6;
    c.style.setProperty("--ry", near ? (x * 10).toFixed(1) + "deg" : "0deg"); c.style.setProperty("--rx", near ? (-y * 10).toFixed(1) + "deg" : "0deg");
  });
});

// ---------- boot ----------
load();
// Refreshes only touch the data regions, so it's safe to keep polling while someone types.
setInterval(() => { if (token && !busy && !document.hidden) load(); }, 5000);
