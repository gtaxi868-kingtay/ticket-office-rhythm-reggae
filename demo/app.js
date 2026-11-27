"use strict";
/* ============================================================================
   TICKET OFFICE — cloud PWA client.
   Talks to Supabase ONLY through RPC functions (anon key + session token).
   No table access, no secrets on the client. Ticket codes and verify codes
   are issued and checked server-side.
   ========================================================================== */
const CFG = window.TO_CONFIG || {};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "TT$" + Number(n || 0).toLocaleString("en-TT", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

let session = null;        // { token, grace, tenant:{...}, member:{id,name,role} }
let eventsCache = [];
let activeEventId = null;
let flyerDataUrl = "";     // pending flyer in the event form (data URL or "" = remove on save when editing)
let flyerTouched = false;

function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.add("hidden"), ms);
}
function showErr(id, msg) {
  const e = $(id); if (!e) return;
  if (msg) { e.textContent = msg; e.classList.remove("hidden"); }
  else e.classList.add("hidden");
}

/* The store this page serves: ?s=<slug> wins, then the deployment
   default in config.js, else "" = the public home (events directory). */
const ACTIVE_SLUG = (() => {
  const fromUrl = new URLSearchParams(location.search).get("s");
  return (fromUrl || CFG.TENANT_SLUG || "").trim().toLowerCase();
})();

/* ---------------- RPC ---------------- */
async function rpc(fn, args = {}) {
  if (!CFG.SUPABASE_URL || !CFG.ANON_KEY) {
    throw new Error("This app is not configured yet. Your provider needs to finish setting it up.");
  }
  let res;
  try {
    res = await fetch(CFG.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": CFG.ANON_KEY,
        "Authorization": "Bearer " + CFG.ANON_KEY
      },
      body: JSON.stringify(args)
    });
  } catch (e) {
    throw new Error("No connection. Check your signal and try again.");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const m = (data && (data.message || data.hint)) || ("Server error " + res.status);
    if (/not_signed_in|session_expired/.test(m)) { forceSignOut("Your session ended. Sign in again."); }
    throw new Error(m);
  }
  return data;
}
const authed = (fn, args = {}) => rpc(fn, { p_token: session.token, ...args });

/* ---------------- session storage ---------------- */
function saveSession() {
  if (session) localStorage.setItem("to_session", JSON.stringify(session));
  else localStorage.removeItem("to_session");
}
function loadSession() {
  try { session = JSON.parse(localStorage.getItem("to_session") || "null"); } catch (e) { session = null; }
}
function forceSignOut(msg) {
  session = null; saveSession();
  $("app").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  if (msg) toast(msg);
  bootLogin();
}

/* ---------------- login screen ---------------- */
let selectedMember = null;

async function bootLogin() {
  showErr("loginError", "");
  $("pinBox").classList.add("hidden");
  $("claimForm").classList.add("hidden");
  $("recoverForm").classList.add("hidden");
  $("recoveryBox").classList.add("hidden");
  $("teamPicker").innerHTML = "<p class='muted'>Loading your team…</p>";
  let info;
  try { info = await rpc("public_team", { p_slug: ACTIVE_SLUG }); }
  catch (e) { $("teamPicker").innerHTML = ""; showErr("loginError", e.message); return; }
  if (!info.ok) { $("teamPicker").innerHTML = ""; showErr("loginError", info.message); return; }
  if (info.business_name) { $("loginBiz").textContent = info.business_name; document.title = info.business_name + " — Tickets"; }
  if (!info.claimed) {
    $("loginSub").textContent = "First time here? The owner sets up this account.";
    $("teamPicker").innerHTML = "";
    $("claimForm").classList.remove("hidden");
    return;
  }
  $("loginSub").textContent = "Who's working?";
  $("teamPicker").innerHTML = (info.members || []).map((m) =>
    `<button class="member-card" data-member="${esc(m.name)}">
       <span class="avatar">${esc((m.name || "?").trim().charAt(0).toUpperCase())}</span>
       <span>${esc(m.name)}</span>
       <span class="role-pill ${esc(m.role)}">${esc(m.role)}</span>
     </button>`).join("") ||
    "<p class='muted'>No team members yet. The owner signs in first.</p>";
  $("teamPicker").querySelectorAll("[data-member]").forEach((b) =>
    b.addEventListener("click", () => {
      selectedMember = b.getAttribute("data-member");
      $("pinForName").textContent = selectedMember;
      showErr("pinError", "");
      $("pinInput").value = "";
      $("pinBox").classList.remove("hidden");
      $("pinInput").focus();
    }));
}

async function doLogin() {
  showErr("pinError", "");
  let r;
  try { r = await rpc("login", { p_slug: ACTIVE_SLUG, p_name: selectedMember, p_pin: $("pinInput").value.trim() }); }
  catch (e) { showErr("pinError", e.message); return; }
  if (!r.ok) { showErr("pinError", r.message || "Could not sign in."); return; }
  session = r; saveSession(); enterApp();
}

async function doClaim(ev) {
  ev.preventDefault();
  showErr("claimError", "");
  const pin = $("claimPin").value.trim(), pin2 = $("claimPin2").value.trim();
  if (pin !== pin2) { showErr("claimError", "The two PINs do not match."); return; }
  let r;
  try {
    r = await rpc("claim_tenant", {
      p_slug: ACTIVE_SLUG, p_claim_code: $("claimCode").value.trim(),
      p_owner_name: $("claimName").value.trim(), p_pin: pin
    });
  } catch (e) { showErr("claimError", e.message); return; }
  if (!r.ok) { showErr("claimError", r.message || "Could not set up the account."); return; }
  session = r; saveSession();
  $("claimForm").classList.add("hidden");
  $("recoveryCode").textContent = r.recovery_code || "";
  $("recoveryBox").classList.remove("hidden");
}

async function doRecover(ev) {
  ev.preventDefault();
  showErr("recoverError", "");
  let r;
  try {
    r = await rpc("recover_owner_pin", {
      p_slug: ACTIVE_SLUG, p_recovery_code: $("recoverCode").value.trim(),
      p_new_pin: $("recoverPin").value.trim()
    });
  } catch (e) { showErr("recoverError", e.message); return; }
  if (!r.ok) { showErr("recoverError", r.message || "That recovery code is not right."); return; }
  toast("Owner PIN reset. Sign in with your new PIN.", 3400);
  bootLogin();
}

/* ---------------- app shell / navigation ---------------- */
const SCREEN_TITLES = {
  dashboard: "Dashboard", issue: "Issue tickets", tickets: "Tickets & sales",
  door: "Door check-in", cashup: "Cash-up", events: "Events",
  settings: "Settings & team", audit: "Activity log", help: "Help & install"
};
let currentScreen = "dashboard";

function role() { return session ? session.member.role : ""; }
function applyRoles() {
  const r = role();
  document.querySelectorAll("[data-role]").forEach((el) => {
    const allowed = el.getAttribute("data-role").split(",").includes(r);
    el.classList.toggle("hidden", !allowed);
  });
}

function go(screen) {
  if (role() === "door" && !["door", "help"].includes(screen)) screen = "door";
  if (role() === "seller" && ["cashup", "events", "settings", "audit"].includes(screen)) screen = "dashboard";
  currentScreen = screen;
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  $("screen-" + screen).classList.remove("hidden");
  $("screenName").textContent = SCREEN_TITLES[screen] || "";
  $("menu").classList.add("hidden");
  window.scrollTo({ top: 0 });
  if (screen === "dashboard") renderDashboard();
  if (screen === "issue") renderIssue();
  if (screen === "tickets") renderTicketsScreen();
  if (screen === "door") renderDoor();
  if (screen === "cashup") renderCashup();
  if (screen === "events") renderEvents();
  if (screen === "settings") renderSettings();
  if (screen === "audit") renderAudit();
}

function enterApp() {
  $("loginScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("bizName").textContent = session.tenant.business_name || "Ticket Office";
  $("menuUser").textContent = "Signed in as " + session.member.name + " • " +
    session.member.role.charAt(0).toUpperCase() + session.member.role.slice(1);
  $("graceBanner").classList.toggle("hidden", !session.grace);
  applyRoles();
  refreshEvents().then(() => go(role() === "door" ? "door" : "dashboard"));
}

async function refreshEvents() {
  try {
    const r = await authed("list_events", {});
    if (r.ok) {
      eventsCache = r.events || [];
      if (!eventsCache.find((e) => e.id === activeEventId)) {
        activeEventId = eventsCache.length ? eventsCache[0].id : null;
      }
    }
  } catch (e) { /* dashboard shows its own error state */ }
}
const activeEvent = () => eventsCache.find((e) => e.id === activeEventId) || null;

function fillEventSelect(sel, includeAllLabel) {
  sel.innerHTML = eventsCache.map((e) =>
    `<option value="${e.id}" ${e.id === activeEventId ? "selected" : ""}>${esc(e.name)}</option>`).join("");
  sel.onchange = () => { activeEventId = sel.value; syncEventSelects(); go(currentScreen); };
}
function syncEventSelects() {
  ["issueEvent", "ticketsEvent", "doorEvent", "cashEvent"].forEach((id) => {
    const s = $(id); if (s && s.value !== activeEventId) s.value = activeEventId || "";
  });
}

/* ---------------- dashboard ---------------- */
function heroCardHTML(e) {
  const sub = [e.presenter, fmtDate(e.event_date), e.venue].filter(Boolean).join(" • ");
  const poster = e.flyer_url
    ? `<img class="poster" src="${esc(e.flyer_url)}" alt="${esc(e.name)} flyer">`
    : `<div class="hero-fallback"><h3>${esc(e.name)}</h3><p>${esc(sub)}</p></div>`;
  return `<div class="hero-card" data-hero="${e.id}">${poster}
    <div class="hero-meta"><div class="ev-name">${esc(e.name)}</div>
    <div class="ev-sub">${esc([fmtDate(e.event_date), e.start_time, e.venue].filter(Boolean).join(" • "))}</div></div></div>`;
}
function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

async function renderDashboard() {
  const c = $("heroCarousel"), dots = $("heroDots");
  if (!eventsCache.length) {
    c.innerHTML = `<div class="hero-card add-card" data-add="1"><span class="plus">+</span>Create your first event</div>`;
    dots.innerHTML = "";
    $("analyticsBox").innerHTML = "<div class='card'><p class='muted'>No events yet. " +
      (role() === "owner" ? "Tap the card above to create one." : "Ask the owner to create an event.") + "</p></div>";
    bindHero();
    return;
  }
  c.innerHTML = eventsCache.map(heroCardHTML).join("") +
    (role() === "owner" ? `<div class="hero-card add-card" data-add="1"><span class="plus">+</span>Add event</div>` : "");
  dots.innerHTML = eventsCache.map((e, i) => `<span data-dot="${i}" class="${e.id === activeEventId ? "on" : ""}"></span>`).join("") +
    (role() === "owner" ? `<span data-dot="${eventsCache.length}">+</span>` : "");
  bindHero();
  // scroll the active event into view
  const idx = eventsCache.findIndex((e) => e.id === activeEventId);
  if (idx > 0) c.scrollTo({ left: idx * (c.clientWidth * 0.86 + 14) });
  await renderAnalytics();
}

function bindHero() {
  const c = $("heroCarousel");
  c.querySelectorAll("[data-hero]").forEach((card) => {
    let sx = 0;
    card.addEventListener("pointerdown", (e) => { sx = e.clientX; });
    card.addEventListener("pointerup", (e) => {
      if (Math.abs(e.clientX - sx) > 10) return; // it was a swipe, not a tap
      activeEventId = card.getAttribute("data-hero"); syncEventSelects(); openSheet(activeEvent());
    });
  });
  const add = c.querySelector("[data-add]");
  if (add) add.addEventListener("click", () => { go("events"); setTimeout(() => $("evName").focus(), 60); });
  c.onscroll = () => {
    const w = c.clientWidth * 0.86 + 14;
    const i = Math.round(c.scrollLeft / w);
    if (eventsCache[i] && eventsCache[i].id !== activeEventId) {
      activeEventId = eventsCache[i].id; syncEventSelects(); renderAnalytics();
      $("heroDots").querySelectorAll("[data-dot]").forEach((d, di) =>
        d.classList.toggle("on", di === i));
    }
  };
}

async function renderAnalytics() {
  const box = $("analyticsBox");
  const e = activeEvent();
  if (!e) { box.innerHTML = ""; return; }
  let a;
  try { a = await authed("analytics", { p_event_id: e.id }); }
  catch (err) { box.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`; return; }
  if (!a.ok) { box.innerHTML = `<div class="card"><p class="muted">${esc(a.message || "")}</p></div>`; return; }
  if (a.door_view) {
    box.innerHTML = `<div class="stat-grid">
      <div class="stat"><div class="num">${a.checked_in}</div><div class="lbl">Checked in</div></div>
      <div class="stat"><div class="num">${a.sold}</div><div class="lbl">Tickets sold</div></div></div>`;
    return;
  }
  if (!a.sold && !a.voided) {
    box.innerHTML = `<div class="card"><p class="muted">No tickets sold yet — tap the event card above to start selling.</p></div>`;
    return;
  }
  const capPct = e.capacity ? Math.min(100, Math.round((a.sold / e.capacity) * 100)) : null;
  const paidPct = a.gross > 0 ? Math.round((a.paid_in / a.gross) * 100) : 0;
  const inPct = a.sold > 0 ? Math.round((a.checked_in / a.sold) * 100) : 0;
  const paidW = a.gross > 0 ? (a.paid_in / a.gross) * 100 : 0;
  const target = e.target_amount ? Number(e.target_amount) : null;
  const targetHtml = target ? (() => {
    const pct = Math.min(100, Math.round((a.gross / target) * 100));
    const avg = a.sold > 0 ? a.gross / a.sold : Math.min(...(e.types || []).filter((t) => !t.is_addon).map((t) => Number(t.price)).concat([100]));
    const left = Math.max(0, Math.ceil((target - a.gross) / Math.max(avg, 1)));
    return `<div class="card"><div class="lbl muted">Break-even target — ${money(a.gross)} of ${money(target)} (${pct}%)</div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="muted tiny" style="margin-top:6px">${a.gross >= target ? "Target reached. Everything from here is profit." : "About " + left + " more ticket" + (left === 1 ? "" : "s") + " at the current average covers the target."}</div></div>`;
  })() : "";
  box.innerHTML = targetHtml + `
    <div class="stat-grid">
      <div class="stat"><div class="num">${a.sold}</div><div class="lbl">Sold</div></div>
      <div class="stat"><div class="num">${money(a.gross)}</div><div class="lbl">Gross</div></div>
      <div class="stat"><div class="num">${money(a.paid_in)}</div><div class="lbl">Paid in</div></div>
      <div class="stat"><div class="num">${money(a.owed)}</div><div class="lbl">Still owed (${a.unpaid_count})</div></div>
      <div class="stat"><div class="num">${a.checked_in}</div><div class="lbl">Checked in</div></div>
      ${e.capacity ? `<div class="stat"><div class="num">${Math.max(0, e.capacity - a.sold)}</div><div class="lbl">Remaining</div></div>` : ""}
    </div>
    <div class="card">
      ${capPct !== null ? `<div class="lbl muted">Capacity sold — ${capPct}%</div><div class="bar"><div style="width:${capPct}%"></div></div>` :
        `<div class="lbl muted">Collected — ${paidPct}% of gross</div><div class="bar"><div style="width:${paidPct}%"></div></div>`}
      <div class="lbl muted" style="margin-top:10px">Checked in — ${inPct}%</div>
      <div class="bar"><div style="width:${inPct}%"></div></div>
      <div class="lbl muted" style="margin-top:12px">Paid vs unpaid</div>
      <div class="stack"><div class="paid" style="width:${paidW}%"></div><div class="unpaid" style="width:${100 - paidW}%"></div></div>
      <div class="muted tiny">Paid ${money(a.paid_in)} • Unpaid ${money(a.owed)}</div>
    </div>
    ${a.by_seller && a.by_seller.length ? `<div class="card"><h3>Sales by seller</h3>` +
      a.by_seller.map((s) => `<div class="breakdown-row"><span>${esc(s.seller)}</span><strong>${s.tickets} • ${money(s.gross)}</strong></div>`).join("") + `</div>` : ""}
    ${a.by_tier && a.by_tier.length ? `<div class="card"><h3>Sales by ticket type</h3>` +
      a.by_tier.map((s) => `<div class="breakdown-row"><span>${esc(s.tier)}</span><strong>${s.tickets} • ${money(s.gross)}</strong></div>`).join("") + `</div>` : ""}
    <p class="muted tiny" style="margin:8px 4px">Live from the shared system — every phone on the team sees these same numbers.</p>`;
}

/* ---------------- event options sheet ---------------- */
let sheetEvent = null;
function openSheet(e) {
  if (!e) return;
  sheetEvent = e;
  $("sheetTitle").textContent = e.name;
  applyRoles();
  $("sheet").classList.remove("hidden");
}
function closeSheet() { $("sheet").classList.add("hidden"); }

/* ---------------- issue ---------------- */
let issueQty = 1;
function renderIssue() {
  $("issueSeller").textContent = session.member.name;
  fillEventSelect($("issueEvent"));
  fillIssueTypes();
  updateIssueTotal();
}
function fillIssueTypes() {
  const e = activeEvent();
  const sel = $("issueType");
  sel.innerHTML = e ? (e.types || []).filter((t) => t.is_active).map((t) =>
    `<option value="${t.id}">${esc(t.name)} — ${money(t.price)}</option>`).join("") : "";
  sel.onchange = updateIssueTotal;
}
function issueUnitPrice() {
  const e = activeEvent(); if (!e) return 0;
  const t = (e.types || []).find((x) => x.id === $("issueType").value);
  return t ? Number(t.price) : 0;
}
function updateIssueTotal() { $("qtyVal").textContent = issueQty; $("issueTotal").textContent = money(issueUnitPrice() * issueQty); }

async function doIssue() {
  showErr("issueError", "");
  const e = activeEvent();
  if (!e) { showErr("issueError", "Create an event first."); return; }
  if (!$("issueType").value) { showErr("issueError", "This event has no ticket type yet — the owner adds one under Events."); return; }
  if (session.grace) { showErr("issueError", "Selling is paused — this account's licence has ended."); return; }
  const btn = $("issueBtn"); btn.disabled = true; btn.textContent = "Issuing…";
  let r;
  try {
    r = await authed("issue_ticket", {
      p_event_id: e.id, p_type_id: $("issueType").value,
      p_buyer_name: $("issueBuyer").value.trim(), p_buyer_phone: $("issuePhone").value.trim(),
      p_qty: issueQty, p_paid: $("issuePaid").checked
    });
  } catch (err) { showErr("issueError", err.message); btn.disabled = false; btn.textContent = "Generate tickets"; return; }
  btn.disabled = false; btn.textContent = "Generate tickets";
  if (!r.ok) { showErr("issueError", r.message || "Could not issue tickets."); return; }
  const evFull = { ...e, ...(r.event || {}) };
  $("issuedBox").innerHTML = `<div class="card"><h3>Tickets issued</h3>` +
    r.tickets.map((t) =>
      `<div class="breakdown-row"><span class="mono">${esc(t.code)}</span>
       <button class="btn small" data-view="${esc(t.code)}">View ticket</button></div>`).join("") +
    (session.tenant.owner_whatsapp ? "" :
      `<p class="muted tiny">Tip: the owner can set an Owner WhatsApp number in Settings.</p>`) +
    `</div>`;
  $("issuedBox").querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      const t = r.tickets.find((x) => x.code === b.getAttribute("data-view"));
      openTicket(evFull, { ...t, buyer_name: $("issueBuyer").value.trim(), seller_name: session.member.name, paid: $("issuePaid").checked });
    }));
  $("issueBuyer").value = ""; $("issuePhone").value = "";
  toast(r.tickets.length + " ticket" + (r.tickets.length > 1 ? "s" : "") + " issued");
}

/* ---------------- ticket view + image export ---------------- */
let currentTicket = null; // { event, ticket }
function qrPayload(t) { return t.code + "|" + t.verify_code; }

function openTicket(event, ticket) {
  currentTicket = { event, ticket };
  const poster = event.flyer_url
    ? `<img class="ticket-poster" src="${esc(event.flyer_url)}" alt="Event flyer">`
    : `<div class="ticket-hero-fallback"><h3>${esc(event.name)}</h3><p>${esc(event.presenter || "")}</p></div>`;
  $("ticketCard").innerHTML = `
    ${poster}
    <div class="perforation"></div>
    <div class="ticket-stub">
      <div style="font-weight:800;font-size:18px">${esc(event.name)}</div>
      <div class="muted">${esc([fmtDate(event.event_date), event.start_time, event.venue].filter(Boolean).join(" • "))}</div>
      <div style="margin-top:10px">Buyer: <strong>${esc(ticket.buyer_name || "—")}</strong></div>
      <div class="muted">${esc(ticket.type_name || "")} • ${money(ticket.price)} • ${ticket.paid ? "PAID" : "UNPAID"}</div>
      <div class="qr"><canvas id="ticketQr" width="180" height="180"></canvas></div>
      <div class="t-code mono">${esc(ticket.code)}</div>
      <div class="muted">Verify code: <strong class="mono">${esc(ticket.verify_code)}</strong></div>
      <div class="muted tiny">Sold by ${esc(ticket.seller_name || "")}</div>
      <div class="muted tiny">Powered by Ticket Office</div>
    </div>
    <div class="admit">ADMIT ONE</div>`;
  $("ticketModal").classList.remove("hidden");
  drawQr($("ticketQr"), qrPayload(ticket), 180);
}

/* Draw a QR code onto a canvas using the vendored qrcodejs build (no CDN —
   a ticket must render even on venue Wi-Fi). Falls back silently: the
   printed verify code below the QR still proves the ticket. */
function drawQr(canvas, text, size) {
  if (!canvas || !window.QRCode) return;
  try {
    const tmp = document.createElement("div");
    new QRCode(tmp, { text: text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
    const src = tmp.querySelector("canvas");
    if (!src) return;
    canvas.width = size; canvas.height = size;
    const c2 = canvas.getContext("2d");
    c2.fillStyle = "#fff"; c2.fillRect(0, 0, size, size);
    c2.drawImage(src, 0, 0, size, size);
  } catch (e) { /* verify code still printed */ }
}

/* Draw the downloadable ticket image: FULL flyer (natural ratio, never
   cropped) on top, stub below — the ticket is the event's marketing. */
async function downloadTicketImage() {
  if (!currentTicket) return;
  const { event, ticket } = currentTicket;
  const W = 900, pad = 48;
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d");
  let flyerImg = null, flyerH = 0;
  if (event.flyer_url) {
    try {
      flyerImg = await new Promise((resolve, reject) => {
        const im = new Image(); im.crossOrigin = "anonymous";
        im.onload = () => resolve(im); im.onerror = reject; im.src = event.flyer_url;
      });
      flyerH = Math.round(W * (flyerImg.naturalHeight / flyerImg.naturalWidth));
    } catch (e) { flyerImg = null; flyerH = 0; }
  }
  const stubH = 560, headH = flyerImg ? 0 : 190;
  cv.width = W; cv.height = (flyerImg ? flyerH : headH) + stubH + 70;
  ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, cv.width, cv.height);
  let y = 0;
  if (flyerImg) { ctx.drawImage(flyerImg, 0, 0, W, flyerH); y = flyerH; }
  else {
    const g = ctx.createLinearGradient(0, 0, W, headH);
    g.addColorStop(0, "#7C3AED"); g.addColorStop(1, "#3B82F6");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, headH);
    ctx.fillStyle = "#fff"; ctx.font = "800 44px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(event.name, W / 2, 110); y = headH;
  }
  ctx.strokeStyle = "#C6CEE6"; ctx.lineWidth = 3; ctx.setLineDash([12, 10]);
  ctx.beginPath(); ctx.moveTo(pad, y + 24); ctx.lineTo(W - pad, y + 24); ctx.stroke(); ctx.setLineDash([]);
  y += 70;
  ctx.fillStyle = "#17203A"; ctx.textAlign = "center";
  ctx.font = "800 38px sans-serif"; ctx.fillText(event.name, W / 2, y); y += 44;
  ctx.font = "28px sans-serif"; ctx.fillStyle = "#6B7699";
  ctx.fillText([fmtDate(event.event_date), event.start_time, event.venue].filter(Boolean).join(" • "), W / 2, y); y += 52;
  ctx.fillStyle = "#17203A"; ctx.font = "30px sans-serif";
  ctx.fillText("Buyer: " + (ticket.buyer_name || "—"), W / 2, y); y += 44;
  ctx.font = "26px sans-serif"; ctx.fillStyle = "#6B7699";
  ctx.fillText((ticket.type_name || "") + " • " + money(ticket.price) + " • " + (ticket.paid ? "PAID" : "UNPAID"), W / 2, y); y += 26;
  const qc = document.createElement("canvas");
  drawQr(qc, qrPayload(ticket), 220);
  if (qc.width) ctx.drawImage(qc, W / 2 - 110, y);
  y += 248;
  ctx.fillStyle = "#17203A"; ctx.font = "800 46px monospace"; ctx.fillText(ticket.code, W / 2, y); y += 42;
  ctx.font = "28px sans-serif"; ctx.fillStyle = "#6B7699";
  ctx.fillText("Verify code: " + ticket.verify_code, W / 2, y); y += 58;
  const g2 = ctx.createLinearGradient(0, y, W, y + 66);
  g2.addColorStop(0, "#7C3AED"); g2.addColorStop(1, "#3B82F6");
  ctx.fillStyle = g2; ctx.fillRect(0, y, W, 66);
  ctx.fillStyle = "#fff"; ctx.font = "800 30px sans-serif";
  ctx.fillText("A D M I T   O N E", W / 2, y + 44);
  const a = document.createElement("a");
  a.download = ticket.code + ".png";
  a.href = cv.toDataURL("image/png");
  a.click();
  // After the image is saved, take the seller straight back to issuing —
  // the next buyer is waiting. (Door accounts stay on the door screen.)
  $("ticketModal").classList.add("hidden");
  if (role() === "owner" || role() === "seller") {
    go("issue");
    toast("Ticket image saved.");
  }
}

/* ---------------- tickets registry ---------------- */
function renderTicketsScreen() {
  fillEventSelect($("ticketsEvent"));
  loadOrders();
  loadTickets();
}
async function loadTickets() {
  const e = activeEvent(); const box = $("ticketsList");
  if (!e) { box.innerHTML = "<p class='muted'>No event selected.</p>"; return; }
  box.innerHTML = "<p class='muted'>Loading…</p>";
  let r;
  try { r = await authed("list_tickets", { p_event_id: e.id, p_search: $("ticketsSearch").value.trim(), p_limit: 300 }); }
  catch (err) { box.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
  if (!r.ok) { box.innerHTML = `<p class="muted">${esc(r.message || "")}</p>`; return; }
  if (!r.tickets.length) { box.innerHTML = "<p class='muted'>No tickets found.</p>"; return; }
  const mine = session.member.name;
  box.innerHTML = r.tickets.map((t) => `
    <div class="ticket-row">
      <div><span class="code mono">${esc(t.code)}</span>
        ${t.voided ? `<span class="chip void">Void</span>` :
          t.checked_in_at ? `<span class="chip in">Checked in</span>` : ""}
        ${t.paid ? `<span class="chip paid">Paid</span>` : `<span class="chip unpaid">Unpaid</span>`}
      </div>
      <div class="muted" style="margin-top:4px">${esc(t.buyer_name || "—")} • ${esc(t.type_name)} • ${money(t.price)} • sold by ${esc(t.seller_name)}${t.seller_name === mine ? " (you)" : ""}</div>
      <div class="row-actions">
        <button class="btn" data-view="${t.id}">View</button>
        ${!t.voided ? `<button class="btn" data-paid="${t.id}" data-val="${t.paid ? "false" : "true"}">${t.paid ? "Mark unpaid" : "Mark paid"}</button>` : ""}
        ${role() === "owner" && !t.voided ? `<button class="btn" data-void="${t.id}">Void</button>` : ""}
        ${role() === "owner" ? `<button class="btn" data-del="${t.id}">Delete</button>` : ""}
      </div>
    </div>`).join("");
  box.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    const t = r.tickets.find((x) => x.id === b.getAttribute("data-view"));
    if (t) openTicket(e, t);
  }));
  box.querySelectorAll("[data-paid]").forEach((b) => b.addEventListener("click", async () => {
    const res = await authed("mark_paid", { p_ticket_id: b.getAttribute("data-paid"), p_paid: b.getAttribute("data-val") === "true" }).catch((err) => ({ ok: false, message: err.message }));
    if (!res.ok) { toast(res.message || "Could not update."); return; }
    loadTickets();
  }));
  box.querySelectorAll("[data-void]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Void this ticket? It will no longer work at the door.")) return;
    const res = await authed("void_ticket", { p_ticket_id: b.getAttribute("data-void") }).catch((err) => ({ ok: false, message: err.message }));
    if (!res.ok) { toast(res.message || "Could not void."); return; }
    loadTickets();
  }));
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this ticket permanently? This is recorded in the activity log.")) return;
    const res = await authed("delete_ticket", { p_ticket_id: b.getAttribute("data-del") }).catch((err) => ({ ok: false, message: err.message }));
    if (!res.ok) { toast(res.message || "Could not delete."); return; }
    loadTickets();
  }));
}

async function exportCsv() {
  const e = activeEvent(); if (!e) return;
  let r;
  try { r = await authed("export_tickets", { p_event_id: e.id }); }
  catch (err) { toast(err.message); return; }
  if (!r.ok) { toast(r.message || "Export failed."); return; }
  const rows = [["code", "verify_code", "type", "price", "buyer", "phone", "seller", "paid", "checked_in_at", "voided", "sold_at"]];
  (r.tickets || []).forEach((t) => rows.push([t.code, t.verify_code, t.type, t.price, t.buyer, t.phone, t.seller, t.paid, t.checked_in_at || "", t.voided, t.sold_at]));
  const csv = rows.map((row) => row.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = e.code_prefix + "-tickets.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------- door ---------------- */
let scanStream = null, scanTimer = null;
function renderDoor() {
  fillEventSelect($("doorEvent"));
  $("doorResult").classList.add("hidden");
  updateDoorCount();
}
async function updateDoorCount() {
  const e = activeEvent(); if (!e) return;
  try {
    const a = await authed("analytics", { p_event_id: e.id });
    if (a.ok) $("doorCount").textContent = a.checked_in + " checked in • " + a.sold + " sold";
  } catch (err) { /* count is a nicety */ }
}
function doorShow(status, message, sub) {
  const box = $("doorResult");
  box.className = "door-result " + (status === "valid" ? "valid" : status === "already_used" ? "used" : "bad");
  box.innerHTML = esc(message) + (sub ? `<span class="sub">${esc(sub)}</span>` : "");
  box.classList.remove("hidden");
}
async function doCheckin(code, verify) {
  code = (code || "").trim().toUpperCase(); verify = (verify || "").trim();
  if (!code) { doorShow("bad", "Enter or scan a ticket code."); return; }
  let r;
  try { r = await authed("checkin", { p_code: code, p_verify_code: verify }); }
  catch (err) { doorShow("bad", err.message); return; }
  let firstIn = null;
  if (r.status === "already_used" && r.checked_in_at) {
    firstIn = "First let in " + new Date(r.checked_in_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) +
      (r.checked_in_by ? " by " + r.checked_in_by : "");
  }
  const sub = [r.buyer_name, r.type_name, r.paid === false ? "UNPAID" : null, firstIn].filter(Boolean).join(" • ");
  doorShow(r.status, r.message || r.status, sub);
  if (r.status === "valid") { $("doorCode").value = ""; $("doorVerify").value = ""; }
  updateDoorCount();
}

/* Camera scanning: BarcodeDetector where available (Chrome/Android),
   jsQR fallback (Safari). Manual entry is always visible below. */
async function startScan() {
  const video = $("scanVideo");
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch (e) {
    toast("Camera not available — type the code instead. (On iPhone, open the app from its home-screen icon or Safari and allow camera access.)", 4200);
    return;
  }
  video.srcObject = scanStream;
  video.classList.remove("hidden"); $("scanStop").classList.remove("hidden"); $("scanBtn").classList.add("hidden");
  await video.play().catch(() => {});
  const detector = ("BarcodeDetector" in window) ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
  const cv = document.createElement("canvas");
  const tick = async () => {
    if (!scanStream) return;
    try {
      let raw = "";
      if (detector) {
        const codes = await detector.detect(video);
        if (codes && codes.length) raw = codes[0].rawValue || "";
      } else if (window.jsQR && video.readyState >= 2) {
        cv.width = video.videoWidth; cv.height = video.videoHeight;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, cv.width, cv.height);
        const found = window.jsQR(img.data, img.width, img.height);
        if (found) raw = found.data || "";
      }
      if (raw) {
        const parts = raw.split("|");
        stopScan();
        await doCheckin(parts[0], parts[1] || "");
        return;
      }
    } catch (e) { /* keep scanning */ }
    scanTimer = setTimeout(tick, 250);
  };
  tick();
}
function stopScan() {
  if (scanTimer) clearTimeout(scanTimer); scanTimer = null;
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  $("scanVideo").classList.add("hidden"); $("scanStop").classList.add("hidden"); $("scanBtn").classList.remove("hidden");
}

/* ---------------- cash-up ---------------- */
async function renderCashup() {
  fillEventSelect($("cashEvent"));
  const e = activeEvent(); const box = $("cashBox");
  if (!e) { box.innerHTML = ""; return; }
  let r;
  try { r = await authed("cash_up", { p_event_id: e.id }); }
  catch (err) { box.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`; return; }
  if (!r.ok) { box.innerHTML = `<div class="card"><p class="muted">${esc(r.message || "")}</p></div>`; return; }
  if (!r.rows.length) { box.innerHTML = "<div class='card'><p class='muted'>No sales yet for this event.</p></div>"; return; }
  const totCash = r.rows.reduce((s, x) => s + Number(x.expected_cash), 0);
  const totOwed = r.rows.reduce((s, x) => s + Number(x.still_owed), 0);
  window.__lastCash = { eventName: e.name, rows: r.rows, totCash, totOwed };
  box.innerHTML = `<div class="card"><h3>Cash-up — ${esc(e.name)}</h3>` +
    r.rows.map((x) => `<div class="breakdown-row"><span>${esc(x.seller)}<br>
      <span class="muted tiny">${x.tickets_sold} sold • ${x.checked_in} checked in</span></span>
      <strong>${money(x.expected_cash)}${Number(x.still_owed) ? `<br><span class="muted tiny">still owed ${money(x.still_owed)}</span>` : ""}</strong></div>`).join("") +
    `<div class="breakdown-row"><span><strong>Total cash expected</strong></span><strong>${money(totCash)}</strong></div>
     <div class="breakdown-row"><span>Total still owed</span><strong>${money(totOwed)}</strong></div></div>
     <p class="muted tiny">Expected cash = tickets each seller marked PAID. Count each seller's cash against their line before they leave.</p>`;
}

/* Print cash-up: build a clean sheet on screen first (never a blank print),
   with a Back button that always works. */
function openPrintSheet() {
  const c = window.__lastCash;
  if (!c) { toast("Nothing to print yet \u2014 no sales for this event."); return; }
  const now = new Date().toLocaleString();
  $("printSheetBody").innerHTML = `<h2 style="margin:0 0 4px">${esc((session && session.tenant && session.tenant.business_name) || "Ticket Office")}</h2>
    <h3 style="margin:0 0 2px">Cash-up \u2014 ${esc(c.eventName)}</h3>
    <p class="muted" style="margin:0 0 14px">Printed ${esc(now)}</p>` +
    c.rows.map((x) => `<div class="breakdown-row"><span>${esc(x.seller)}<br>
      <span class="muted tiny">${x.tickets_sold} sold \u2022 ${x.checked_in} checked in</span></span>
      <strong>${money(x.expected_cash)}${Number(x.still_owed) ? `<br><span class="muted tiny">still owed ${money(x.still_owed)}</span>` : ""}</strong></div>`).join("") +
    `<div class="breakdown-row"><span><strong>Total cash expected</strong></span><strong>${money(c.totCash)}</strong></div>
     <div class="breakdown-row"><span>Total still owed</span><strong>${money(c.totOwed)}</strong></div>
     <p class="muted tiny">Expected cash = tickets each seller marked PAID. Count each seller's cash against their line before they leave.</p>`;
  $("printSheet").classList.remove("hidden");
  // Wire the sheet's own buttons directly on the live elements every time it
  // opens — dismissal can never be lost to a stale load-time wiring.
  $("closePrintBtn").onclick = () => $("printSheet").classList.add("hidden");
  $("doPrintBtn").onclick = () => window.print();
  window.scrollTo(0, 0);
}
/* Guarded wiring: if the page shell is an older cached copy without these
   elements, skip instead of killing the whole script (mixed-version safety). */
const onEl = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
onEl("printCashBtn", "click", openPrintSheet);
onEl("doPrintBtn", "click", () => window.print());
onEl("closePrintBtn", "click", () => $("printSheet").classList.add("hidden"));
/* Capture-phase delegation: any [data-close-print] tap closes the sheet,
   ahead of every other handler — the exit can never be swallowed. */
document.addEventListener("click", (e) => {
  if (e.target && e.target.closest && e.target.closest("[data-close-print]")) {
    $("printSheet").classList.add("hidden");
  }
}, true);
document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => go(b.getAttribute("data-back"))));

/* ---------------- events admin ---------------- */
function renderEvents() {
  const box = $("eventsList");
  box.innerHTML = eventsCache.map((e) => `
    <div class="ticket-row">
      <div style="font-weight:800">${esc(e.name)} ${e.is_active ? "" : `<span class="chip void">Closed</span>`}</div>
      <div class="muted">${esc([fmtDate(e.event_date), e.venue, e.code_prefix].filter(Boolean).join(" • "))}</div>
      <div class="row-actions">
        <button class="btn" data-edit="${e.id}">Edit</button>
        <button class="btn" data-types="${e.id}">Ticket types</button>
        <button class="btn" data-use="${e.id}">Make active</button>
      </div>
    </div>`).join("") || "<p class='muted'>No events yet — create the first one below.</p>";
  box.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => fillEventForm(b.getAttribute("data-edit"))));
  box.querySelectorAll("[data-types]").forEach((b) => b.addEventListener("click", () => openTypes(b.getAttribute("data-types"))));
  box.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", () => {
    activeEventId = b.getAttribute("data-use"); syncEventSelects(); toast("Active event changed.");
  }));
}

function fillExtras(e) {
  $("evTarget").value = e && e.target_amount != null ? e.target_amount : "";
  $("evPlanPct").value = e && e.payment_plan_pct != null ? e.payment_plan_pct : "";
  const qs = e && Array.isArray(e.checkout_questions) ? e.checkout_questions : [];
  $("evQ1").value = qs[0] || ""; $("evQ2").value = qs[1] || ""; $("evQ3").value = qs[2] || "";
}
async function saveExtras(eventId) {
  const questions = [$("evQ1").value, $("evQ2").value, $("evQ3").value].map((s) => s.trim()).filter(Boolean);
  try {
    await authed("update_event_extras", {
      p_event_id: eventId,
      p_target_amount: $("evTarget").value ? Number($("evTarget").value) : null,
      p_payment_plan_pct: $("evPlanPct").value ? Number($("evPlanPct").value) : null,
      p_checkout_questions: questions
    });
  } catch (e) { /* extras are best-effort; the event itself saved */ }
}
function fillEventForm(id) {
  const e = eventsCache.find((x) => x.id === id); if (!e) return;
  activeEventId = id;
  $("eventFormTitle").textContent = "Edit event";
  $("evId").value = e.id; $("evName").value = e.name || ""; $("evPresenter").value = e.presenter || "";
  $("evPrefix").value = e.code_prefix || ""; $("evPrefix").disabled = true; // prefix is baked into issued codes
  $("evDate").value = e.event_date || ""; $("evStart").value = e.start_time || ""; $("evEnd").value = e.end_time || "";
  $("evVenue").value = e.venue || ""; $("evCapacity").value = e.capacity || "";
  flyerDataUrl = e.flyer_url || ""; flyerTouched = false;
  $("evFlyerPreview").classList.toggle("hidden", !e.flyer_url);
  if (e.flyer_url) $("evFlyerPreview").src = e.flyer_url;
  $("evFlyerRemove").classList.toggle("hidden", !e.flyer_url);
  $("evCancel").classList.remove("hidden");
  fillExtras(e);
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}
function resetEventForm() {
  $("eventFormTitle").textContent = "New event";
  ["evId", "evName", "evPresenter", "evPrefix", "evDate", "evStart", "evEnd", "evVenue", "evCapacity"].forEach((id) => { $(id).value = ""; });
  $("evPrefix").disabled = false;
  flyerDataUrl = ""; flyerTouched = false;
  $("evFlyerPreview").classList.add("hidden"); $("evFlyerRemove").classList.add("hidden");
  $("evCancel").classList.add("hidden");
  fillExtras(null);
}

/* Flyer handling: the picked image is downscaled to max 1200px wide JPEG and
   sent as a data URL (simplest deploy path — no Storage bucket needed).
   For a crisper poster, Taylor can instead upload the file to Supabase
   Storage and paste the public URL — update_event accepts any URL.
   The poster is only ever displayed at natural ratio (never cropped). */
function handleFlyerFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { showErr("evError", "That file is not an image."); return; }
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 1200 / img.naturalWidth);
    const cv = document.createElement("canvas");
    cv.width = Math.round(img.naturalWidth * scale);
    cv.height = Math.round(img.naturalHeight * scale);
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    flyerDataUrl = cv.toDataURL("image/jpeg", 0.86);
    flyerTouched = true;
    $("evFlyerPreview").src = flyerDataUrl;
    $("evFlyerPreview").classList.remove("hidden");
    $("evFlyerRemove").classList.remove("hidden");
    URL.revokeObjectURL(img.src);
  };
  img.onerror = () => showErr("evError", "Could not read that image.");
  img.src = URL.createObjectURL(file);
}

async function saveEvent(ev) {
  ev.preventDefault();
  showErr("evError", "");
  const id = $("evId").value;
  const flyerArg = flyerTouched ? flyerDataUrl : null; // null = leave unchanged on edit
  let r;
  try {
    if (id) {
      r = await authed("update_event", {
        p_event_id: id, p_name: $("evName").value.trim(), p_presenter: $("evPresenter").value.trim(),
        p_event_date: $("evDate").value || null, p_start_time: $("evStart").value.trim(),
        p_end_time: $("evEnd").value.trim(), p_venue: $("evVenue").value.trim(),
        p_capacity: $("evCapacity").value ? Number($("evCapacity").value) : null,
        p_flyer_url: flyerArg, p_is_active: true
      });
    } else {
      if (!$("evPrefix").value.trim()) { showErr("evError", "Give the event a code prefix, e.g. RR26."); return; }
      r = await authed("create_event", {
        p_name: $("evName").value.trim(), p_presenter: $("evPresenter").value.trim(),
        p_code_prefix: $("evPrefix").value.trim(), p_event_date: $("evDate").value || null,
        p_start_time: $("evStart").value.trim(), p_end_time: $("evEnd").value.trim(),
        p_venue: $("evVenue").value.trim(),
        p_capacity: $("evCapacity").value ? Number($("evCapacity").value) : null,
        p_flyer_url: flyerDataUrl || null
      });
    }
  } catch (err) { showErr("evError", err.message); return; }
  if (!r.ok) { showErr("evError", r.message || "Could not save the event."); return; }
  const savedId = id || r.id;
  if (savedId) await saveExtras(savedId);
  toast("Event saved.");
  resetEventForm();
  await refreshEvents();
  if (!id && r.id) activeEventId = r.id;
  renderEvents();
}

/* ticket types editor */
let typesEventId = null;
function openTypes(eventId) {
  typesEventId = eventId;
  const e = eventsCache.find((x) => x.id === eventId); if (!e) return;
  $("typesEventName").textContent = e.name;
  $("typesBox").classList.remove("hidden");
  $("typesList").innerHTML = (e.types || []).map((t) => `
    <div class="breakdown-row"><span>${esc(t.name)} — ${money(t.price)}${t.capacity ? " • cap " + t.capacity : ""}${t.is_addon ? " • add-on" : ""}${t.is_active ? "" : " • off"}</span>
    <button class="btn small" data-tyedit="${t.id}">Edit</button></div>`).join("");
  $("typesList").querySelectorAll("[data-tyedit]").forEach((b) => b.addEventListener("click", () => {
    const t = (e.types || []).find((x) => x.id === b.getAttribute("data-tyedit"));
    if (!t) return;
    $("tyId").value = t.id; $("tyName").value = t.name; $("tyPrice").value = t.price; $("tyCapacity").value = t.capacity || "";
    $("tyAddon").checked = !!t.is_addon;
  }));
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}
async function saveType(ev) {
  ev.preventDefault();
  showErr("tyError", "");
  let r;
  try {
    r = await authed("upsert_ticket_type", {
      p_event_id: typesEventId, p_type_id: $("tyId").value || null,
      p_name: $("tyName").value.trim(), p_price: Number($("tyPrice").value || 0),
      p_capacity: $("tyCapacity").value ? Number($("tyCapacity").value) : null, p_is_active: true,
      p_is_addon: $("tyAddon").checked
    });
  } catch (err) { showErr("tyError", err.message); return; }
  if (!r.ok) { showErr("tyError", r.message || "Could not save."); return; }
  $("tyId").value = ""; $("tyName").value = ""; $("tyPrice").value = ""; $("tyCapacity").value = ""; $("tyAddon").checked = false;
  toast("Ticket type saved.");
  await refreshEvents(); openTypes(typesEventId);
  if (currentScreen === "issue") fillIssueTypes();
}

/* ---------------- settings & team ---------------- */
async function renderSettings() {
  $("profileLine").textContent = session.member.name + " • " + session.member.role;
  $("setBiz").value = session.tenant.business_name || "";
  $("setWhatsapp").value = session.tenant.owner_whatsapp || "";
  $("setBank").value = session.tenant.bank_details || "";
  $("setCardLink").value = session.tenant.card_link || "";
  $("shopLink").textContent = shopUrl();
  renderThemeGrid();
  $("licenceLine").textContent = session.grace
    ? "Licence has ENDED — you are in read-only grace. Contact your provider to renew."
    : "Licence active" + (session.tenant.licence_expires ? " until " + session.tenant.licence_expires : "") + ". Renewals are handled by your provider.";
  loadTeam();
}
async function loadTeam() {
  let r;
  try { r = await authed("list_team", {}); } catch (e) { return; }
  if (!r.ok) return;
  $("teamList").innerHTML = (r.members || []).map((m) => `
    <div class="breakdown-row"><span>${esc(m.name)} <span class="role-pill ${esc(m.role)}">${esc(m.role)}</span>
      ${m.active ? "" : `<span class="chip void">Off</span>`}</span>
      ${m.role !== "owner" ? `<span>
        <button class="btn small" data-pin="${m.id}" data-name="${esc(m.name)}">Reset PIN</button>
        <button class="btn small" data-toggle="${m.id}" data-active="${m.active}">${m.active ? "Disable" : "Enable"}</button>
        <button class="btn small" data-remove="${m.id}" data-name="${esc(m.name)}">Remove</button></span>` : ""}
    </div>`).join("");
  $("teamList").querySelectorAll("[data-pin]").forEach((b) => b.addEventListener("click", async () => {
    const pin = prompt("New PIN for " + b.getAttribute("data-name") + " (4–6 digits):");
    if (!pin) return;
    const res = await authed("reset_member_pin", { p_member_id: b.getAttribute("data-pin"), p_new_pin: pin.trim() }).catch((e) => ({ ok: false, message: e.message }));
    toast(res.ok ? "PIN reset." : (res.message || "Could not reset PIN."));
  }));
  $("teamList").querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async () => {
    const m = (r.members || []).find((x) => x.id === b.getAttribute("data-toggle"));
    const res = await authed("update_member", { p_member_id: m.id, p_name: m.name, p_role: m.role, p_active: !(b.getAttribute("data-active") === "true") }).catch((e) => ({ ok: false, message: e.message }));
    if (!res.ok) toast(res.message || "Could not update."); else loadTeam();
  }));
  $("teamList").querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Remove " + b.getAttribute("data-name") + " from the team? Their past sales stay on record under their name.")) return;
    const res = await authed("remove_member", { p_member_id: b.getAttribute("data-remove") }).catch((e) => ({ ok: false, message: e.message }));
    if (!res.ok) toast(res.message || "Could not remove."); else loadTeam();
  }));
}

/* ---------------- audit ---------------- */
async function renderAudit() {
  const box = $("auditList");
  box.innerHTML = "<p class='muted'>Loading…</p>";
  let r;
  try { r = await authed("audit_list", { p_limit: 150 }); }
  catch (err) { box.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
  if (!r.ok) { box.innerHTML = `<p class="muted">${esc(r.message || "")}</p>`; return; }
  if (!r.entries.length) { box.innerHTML = "<p class='muted'>Nothing recorded yet.</p>"; return; }
  box.innerHTML = r.entries.map((e) => `
    <div class="audit-row"><strong>${esc(e.action.replace(/_/g, " "))}</strong> — ${esc(e.member || "system")}
      <br><span class="muted tiny">${new Date(e.at).toLocaleString()} ${e.detail && e.detail.code ? "• " + esc(e.detail.code) : ""}${e.detail && e.detail.buyer ? "• " + esc(e.detail.buyer) : ""}</span></div>`).join("");
}

/* ---------------- wiring ---------------- */
function wire() {
  $("pinGo").addEventListener("click", doLogin);
  $("pinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("pinBack").addEventListener("click", () => { $("pinBox").classList.add("hidden"); });
  $("forgotPin").addEventListener("click", () => {
    $("pinBox").classList.add("hidden"); $("teamPicker").innerHTML = "";
    $("loginSub").textContent = "Owner PIN recovery";
    $("recoverForm").classList.remove("hidden");
  });
  $("recoverBack").addEventListener("click", bootLogin);
  $("claimForm").addEventListener("submit", doClaim);
  $("recoverForm").addEventListener("submit", doRecover);
  $("recoveryDone").addEventListener("click", enterApp);

  $("menuBtn").addEventListener("click", () => $("menu").classList.toggle("hidden"));
  document.addEventListener("click", (e) => {
    if (!$("menu").classList.contains("hidden") && !$("menu").contains(e.target) && e.target !== $("menuBtn") && !$("menuBtn").contains(e.target)) {
      $("menu").classList.add("hidden");
    }
  });
  $("menu").querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.getAttribute("data-go"))));
  $("switchUser").addEventListener("click", () => { session = null; saveSession(); location.reload(); });
  $("logoutBtn").addEventListener("click", async () => {
    const tok = session && session.token;
    session = null; saveSession();
    if (tok) { try { await rpc("logout", { p_token: tok }); } catch (e) {} }
    location.reload();
  });

  $("sheetClose").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  $("sheet").querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
    const act = b.getAttribute("data-act");
    closeSheet();
    if (act === "issue") go("issue");
    if (act === "tickets") go("tickets");
    if (act === "door") go("door");
    if (act === "cashup") go("cashup");
    if (act === "edit") { go("events"); setTimeout(() => fillEventForm(sheetEvent.id), 60); }
  }));

  $("qtyMinus").addEventListener("click", () => { issueQty = Math.max(1, issueQty - 1); updateIssueTotal(); });
  $("qtyPlus").addEventListener("click", () => { issueQty = Math.min(20, issueQty + 1); updateIssueTotal(); });
  $("issueEvent").addEventListener("change", () => { fillIssueTypes(); updateIssueTotal(); });
  $("issueBtn").addEventListener("click", doIssue);

  let searchTimer;
  $("ticketsSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadTickets, 350); });
  $("exportBtn").addEventListener("click", exportCsv);

  $("checkinBtn").addEventListener("click", () => doCheckin($("doorCode").value, $("doorVerify").value));
  $("scanBtn").addEventListener("click", startScan);
  $("scanStop").addEventListener("click", stopScan);

  $("cashEvent").addEventListener("change", renderCashup);

  $("eventForm").addEventListener("submit", saveEvent);
  $("evCancel").addEventListener("click", resetEventForm);
  $("evFlyer").addEventListener("change", (e) => handleFlyerFile(e.target.files[0]));
  $("evFlyerRemove").addEventListener("click", () => {
    flyerDataUrl = ""; flyerTouched = true;
    $("evFlyerPreview").classList.add("hidden"); $("evFlyerRemove").classList.add("hidden");
  });
  $("typeForm").addEventListener("submit", saveType);

  $("memberForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); showErr("mbError", "");
    let r;
    try {
      r = await authed("add_member", { p_name: $("mbName").value.trim(), p_role: $("mbRole").value, p_pin: $("mbPin").value.trim() });
    } catch (err) { showErr("mbError", err.message); return; }
    if (!r.ok) { showErr("mbError", r.message || "Could not add member."); return; }
    $("mbName").value = ""; $("mbPin").value = "";
    toast("Team member added."); loadTeam();
  });
  $("cpBtn").addEventListener("click", async () => {
    showErr("cpError", "");
    let r;
    try { r = await authed("change_my_pin", { p_old_pin: $("cpOld").value.trim(), p_new_pin: $("cpNew").value.trim() }); }
    catch (err) { showErr("cpError", err.message); return; }
    if (!r.ok) { showErr("cpError", r.message || "Could not change PIN."); return; }
    $("cpOld").value = ""; $("cpNew").value = ""; toast("PIN changed.");
  });
  $("setSave").addEventListener("click", async () => {
    let r;
    try { r = await authed("update_settings", { p_business_name: $("setBiz").value.trim(), p_owner_whatsapp: $("setWhatsapp").value.trim() }); }
    catch (err) { toast(err.message); return; }
    if (!r.ok) { toast(r.message || "Could not save."); return; }
    try {
      const rb = await authed("update_payment_details", { p_bank_details: $("setBank").value, p_card_link: $("setCardLink").value.trim() });
      if (!rb.ok) { toast(rb.message || "Bank details could not be saved."); return; }
    } catch (err) { toast(err.message); return; }
    session.tenant.business_name = $("setBiz").value.trim();
    session.tenant.owner_whatsapp = $("setWhatsapp").value.trim();
    session.tenant.bank_details = $("setBank").value;
    session.tenant.card_link = $("setCardLink").value.trim();
    saveSession();
    $("bizName").textContent = session.tenant.business_name || "Ticket Office";
    toast("Settings saved.");
  });

  $("ticketClose").addEventListener("click", () => $("ticketModal").classList.add("hidden"));
  $("ticketBackIssue").addEventListener("click", () => { $("ticketModal").classList.add("hidden"); go("issue"); });
  $("ticketCal").addEventListener("click", () => { if (currentTicket) icsFor(currentTicket.event); });
  $("ticketTransfer").addEventListener("click", async () => {
    if (!currentTicket || !currentTicket.ticket) return;
    const tk = currentTicket.ticket;
    if (!tk.id) { toast("Open this ticket from Tickets & sales to transfer it."); return; }
    const name = prompt("Transfer to — new holder's full name:");
    if (!name) return;
    const phone = prompt("New holder's WhatsApp number (optional):", "") || "";
    let r;
    try { r = await authed("transfer_ticket", { p_ticket_id: tk.id, p_new_name: name.trim(), p_new_phone: phone.trim() }); }
    catch (e) { toast(e.message); return; }
    if (!r.ok) { toast(r.message || "Could not transfer."); return; }
    const nt = (r.tickets || [])[0] || {};
    toast("Transferred. New code: " + nt.code + " — the old ticket no longer works.");
    openTicket(currentTicket.event, { id: null, code: nt.code, verify_code: nt.verify_code,
      type_name: nt.type_name || tk.type_name, price: nt.price != null ? nt.price : tk.price,
      paid: tk.paid, buyer_name: name.trim(), seller_name: session.member.name });
    loadTickets();
  });
  $("themeFab").addEventListener("click", toggleTheme);
  applyTheme(document.documentElement.dataset.theme || "day");
  if (session && session.tenant) applySkin(session.tenant.theme || "fintech");
  $("openShopBtn").addEventListener("click", openShop);
  $("hostBtn").addEventListener("click", () => {
    $("signupForm").classList.toggle("hidden");
  });
  $("signupForm").addEventListener("submit", submitSignup);
  $("shopBack").addEventListener("click", () => {
    $("shopScreen").classList.add("hidden");
    if (session && session.token) { $("app").classList.remove("hidden"); }
    else { $("loginScreen").classList.remove("hidden"); bootLogin(); }
  });
  $("shopForm").addEventListener("submit", submitShopOrder);
  $("shopCalBtn").addEventListener("click", () => { if (lastShopOrder) icsFor(lastShopOrder.event); });
  $("shopAgain").addEventListener("click", () => { $("shopDone").classList.add("hidden"); openShop(); });
  $("shopCopyBank").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("shopBank").textContent); toast("Bank details copied."); }
    catch (e) { toast("Copy failed — long-press the bank details to copy them."); }
  });
  $("shopLinkCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(shopUrl()); toast("Shop link copied."); }
    catch (e) { toast("Copy failed — the link is shown above."); }
  });
  $("ticketDownload").addEventListener("click", downloadTicketImage);
}


/* ---------------- theme (day / night) ---------------- */
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem("to_theme", name); } catch (e) {}
  $("themeIconMoon").classList.toggle("hidden", name === "night");
  $("themeIconSun").classList.toggle("hidden", name !== "night");
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "night" ? "day" : "night");
}

/* ---------------- store skins (per-tenant theme — "the mall") ---------------- */
const SKINS = [
  { key: "noir", name: "Noir Glass", dots: ["#FFFFFF", "#0B0B0F", "#FF5A36"] },
  { key: "premiere", name: "Premiere Gold", dots: ["#E9BC55", "#060505", "#F5EFE6"] },
  { key: "fintech", name: "Clean Fintech", dots: ["#7C3AED", "#3B82F6", "#F6F7FB"] },
  { key: "gold", name: "Midnight Gold", dots: ["#D9A441", "#0A0806", "#F3EBDD"] },
  { key: "pop", name: "Poster Pop", dots: ["#0E7C86", "#E85D1F", "#F2B035"] },
  { key: "sunset", name: "Island Sunset", dots: ["#FF5E7E", "#FF9E4F", "#2A1A4A"] },
  { key: "navy", name: "Royal Navy", dots: ["#0F2B52", "#C9A24B", "#F7F3EA"] },
  { key: "mono", name: "Minimal Mono", dots: ["#111111", "#FFFFFF", "#E8E8E8"] },
];
function applySkin(key) {
  const valid = SKINS.some((s) => s.key === key);
  document.documentElement.dataset.skin = valid ? key : "fintech";
  try { localStorage.setItem("to_skin", document.documentElement.dataset.skin); } catch (e) {}
}
function renderThemeGrid() {
  const grid = $("themeGrid");
  if (!grid) return;
  const cur = (session && session.tenant && session.tenant.theme) || "fintech";
  grid.innerHTML = SKINS.map((s) => `
    <button type="button" class="theme-card ${s.key === cur ? "current" : ""}" data-skinpick="${s.key}">
      <span class="theme-dots">${s.dots.map((d) => `<span class="theme-dot" style="background:${d}"></span>`).join("")}</span>
      <span class="theme-name">${s.name}</span>
      ${s.key === cur ? `<span class="theme-cur">Current</span>` : ""}
    </button>`).join("");
  grid.querySelectorAll("[data-skinpick]").forEach((b) => b.addEventListener("click", () => pickSkin(b.dataset.skinpick)));
}
async function pickSkin(key) {
  try {
    const r = await authed("update_theme", { p_theme: key });
    if (!r.ok) { toast(r.message || "Could not change the theme."); return; }
    session.tenant.theme = key;
    try { localStorage.setItem("to_session", JSON.stringify(session)); } catch (e) {}
    applySkin(key);
    renderThemeGrid();
    toast("Theme set — your shop wears it now.");
  } catch (e) { toast(e.message); }
}

/* ---------------- public home: events directory + sign-up ---------------- */
function goStore(slug) { location.href = location.pathname + "?s=" + encodeURIComponent(slug) + "&shop"; }
function goStoreTeam(slug) { location.href = location.pathname + "?s=" + encodeURIComponent(slug); }

function updateSteps(stage) {
  const bar = $("shopSteps"); if (!bar) return;
  const set = (n, cls) => {
    const el = bar.querySelector('[data-step="' + n + '"]'); if (!el) return;
    el.classList.toggle("on", cls === "on");
    el.classList.toggle("done", cls === "done");
  };
  if (stage === 3) { set(1, "done"); set(2, "done"); set(3, "on"); }
  else if (stage === 2) { set(1, "done"); set(2, "on"); set(3, ""); }
  else { set(1, "on"); set(2, ""); set(3, ""); }
}

function tintCard(el, url) {
  if (!el || !url) return;
  if (document.documentElement.dataset.skin !== "noir") return;
  try {
    const im = new Image();
    if (!/^data:/.test(url)) im.crossOrigin = "anonymous";
    im.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = 8; c.height = 8;
        const x = c.getContext("2d"); if (!x) return;
        x.drawImage(im, 0, 0, 8, 8);
        const d = x.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]);
          if (mx < 36) continue;
          const wt = mx / 255;
          r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
        }
        if (!w) return;
        r = Math.round(r / w); g = Math.round(g / w); b = Math.round(b / w);
        const rf = r / 255, gf = g / 255, bf = b / 255;
        const mx2 = Math.max(rf, gf, bf), mn2 = Math.min(rf, gf, bf);
        let h = 0, s = 0; const l = (mx2 + mn2) / 2;
        if (mx2 !== mn2) {
          const dd = mx2 - mn2;
          s = l > 0.5 ? dd / (2 - mx2 - mn2) : dd / (mx2 + mn2);
          if (mx2 === rf) h = (gf - bf) / dd + (gf < bf ? 6 : 0);
          else if (mx2 === gf) h = (bf - rf) / dd + 2;
          else h = (rf - gf) / dd + 4;
          h *= 60;
        }
        s = Math.max(s, 0.7);
        const ll = Math.min(Math.max(l, 0.36), 0.52);
        el.style.background = "linear-gradient(160deg, hsla(" + Math.round(h) + "," + Math.round(s * 100) + "%," + Math.round(ll * 100) + "%,0.9), hsla(" + Math.round(h) + "," + Math.round(s * 100) + "%," + Math.round(ll * 78) + "%,0.82) 58%, rgba(12,10,16,0.55))";
      } catch (e) { /* image not readable: keep the house tint */ }
    };
    im.src = url;
  } catch (e) { /* keep the house tint */ }
}

async function openHome() {
  $("loginScreen").classList.add("hidden");
  $("app").classList.add("hidden");
  $("shopScreen").classList.add("hidden");
  $("homeScreen").classList.remove("hidden");
  applySkin("noir");
  $("homeEvents").innerHTML = "<p class='muted'>Loading events…</p>";
  let r;
  try { r = await rpc("public_events", {}); }
  catch (e) { $("homeEvents").innerHTML = "<p class='error'>" + esc(e.message) + "</p>"; return; }
  const evs = (r && r.events) || [];
  if (!evs.length) {
    $("homeEvents").innerHTML = "<p class='muted'>No events on sale right now — check back soon.</p>";
    return;
  }
  $("homeEvents").innerHTML = evs.map((e) => `
    <div class="event-card ticket-row" data-store="${esc(e.slug)}" role="button" tabindex="0" aria-label="Get tickets for ${esc(e.name)}">
      <div class="t-top">
        ${e.flyer_url ? `<img class="t-thumb" src="${esc(e.flyer_url)}" alt="${esc(e.name)} flyer">` : ""}
        <div class="t-main">
          <div class="t-date">${esc([fmtDate(e.event_date), e.start_time].filter(Boolean).join(" • "))}</div>
          <div class="t-name">${esc(e.name)}</div>
          <div class="t-by">by ${esc(e.business_name)}</div>
        </div>
        <span class="t-arrow"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg></span>
      </div>
      <div class="perf"></div>
      <div class="t-strip">
        <span class="t-venue"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-5.6-7-11a7 7 0 1 1 14 0c0 5.4-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/></svg><span>${esc(e.venue || "")}</span></span>
        ${e.from_price != null ? `<span class="t-price">from ${money(e.from_price)}</span>` : ""}
      </div>
    </div>`).join("");
  $("homeEvents").querySelectorAll("[data-store]").forEach((b) =>
    b.addEventListener("click", () => goStore(b.dataset.store)));
  $("homeEvents").querySelectorAll(".ticket-row").forEach((card, i) => tintCard(card, evs[i].flyer_url));
}

async function submitSignup(ev) {
  ev.preventDefault();
  showErr("signupError", "");
  const body = {
    p_business_name: $("suBiz").value.trim(),
    p_owner_name: $("suName").value.trim(),
    p_pin: $("suPin").value.trim(),
    p_whatsapp: $("suWhatsapp").value.trim(),
  };
  let r;
  try { r = await rpc("signup_tenant", body); }
  catch (e) { showErr("signupError", e.message); return; }
  if (!r.ok) { showErr("signupError", r.message || "Could not create your store."); return; }
  session = r; saveSession();
  $("signupForm").classList.add("hidden");
  $("hostBtn").classList.add("hidden");
  const done = $("signupDone");
  done.classList.remove("hidden");
  done.innerHTML = `
    <h3>Your store is open</h3>
    <p>Your buyer shop link:<br><strong>${esc(location.origin + location.pathname + "?s=" + r.slug + "&shop")}</strong></p>
    <p>Your recovery code — write it down now, it is shown only once:<br>
       <span class="mono" style="font-size:20px">${esc(r.recovery_code || "")}</span></p>
    <p class="tiny muted">Your store starts on a free 30-day trial. Add your first event, set your bank details in Settings, and share your shop link.</p>
    <button type="button" class="btn primary big" id="suGo">Go to my store</button>`;
  $("suGo").addEventListener("click", () => goStoreTeam(r.slug));
}

/* ---------------- buyer shop (public) ---------------- */
let shopData = null;   // public_shop result
let shopEvent = null;  // event the buyer picked

function shopUrl() {
  return location.origin + location.pathname + "?s=" + encodeURIComponent(ACTIVE_SLUG) + "&shop";
}

async function openShop() {
  $("shopSteps").classList.add("hidden");
  $("loginScreen").classList.add("hidden");
  $("app").classList.add("hidden");
  $("shopScreen").classList.remove("hidden");
  $("shopEvents").innerHTML = "<p class=\"muted\">Loading events…</p>";
  $("shopForm").classList.add("hidden");
  $("shopDone").classList.add("hidden");
  try {
    shopData = await rpc("public_shop", { p_slug: ACTIVE_SLUG });
  } catch (e) {
    $("shopEvents").innerHTML = "<p class=\"error\">" + esc(e.message) + "</p>";
    return;
  }
  if (!shopData.ok) {
    $("shopEvents").innerHTML = "<p class=\"error\">" + esc(shopData.message || "Shop unavailable.") + "</p>";
    return;
  }
  applySkin(shopData.theme || "fintech");
  $("shopBiz").textContent = shopData.business_name;
  const evs = shopData.events || [];
  $("shopEvents").innerHTML = evs.length ? evs.map((e) => `
    <div class="event-card ticket-row" data-shop-ev="${e.id}" role="button" tabindex="0" aria-label="Order tickets for ${esc(e.name)}">
      <div class="t-top">
        ${e.flyer_url ? `<img class="t-thumb" src="${esc(e.flyer_url)}" alt="${esc(e.name)} flyer">` : ""}
        <div class="t-main">
          <div class="t-date">${esc([fmtDate(e.event_date), e.start_time].filter(Boolean).join(" • "))}</div>
          <div class="t-name">${esc(e.name)}</div>
          <div class="t-by">${(e.types || []).filter((t) => !t.is_addon).map((t) => esc(t.name) + " " + money(t.price)).join(" • ")}</div>
        </div>
        <span class="t-arrow"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg></span>
      </div>
      <div class="perf"></div>
      <div class="t-strip">
        <span class="t-venue"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-5.6-7-11a7 7 0 1 1 14 0c0 5.4-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/></svg><span>${esc(e.venue || "")}</span></span>
        <span class="t-price">Order tickets</span>
      </div>
    </div>`).join("")
    : "<p class=\"muted\">No events are on sale right now.</p>";
  $("shopEvents").querySelectorAll("[data-shop-ev]").forEach((b) =>
    b.addEventListener("click", () => selectShopEvent(b.getAttribute("data-shop-ev"))));
  $("shopEvents").querySelectorAll(".ticket-row").forEach((card, i) => tintCard(card, evs[i].flyer_url));
}

/* Checkout: pick quantities across ticket types and add-ons, answer the
   organiser's questions, see the full summary before placing the order. */
let shopCart = {};
let lastShopOrder = null;

function selectShopEvent(id) {
  shopEvent = (shopData.events || []).find((e) => e.id === id);
  if (!shopEvent) return;
  shopCart = {};
  $("shopFormTitle").textContent = "Your order";
  const hero = $("shopHero");
  if (hero) {
    hero.classList.remove("hidden");
    const img = $("shopHeroImg");
    if (shopEvent.flyer_url) { img.src = shopEvent.flyer_url; img.alt = shopEvent.name + " flyer"; img.classList.remove("hidden"); }
    else img.classList.add("hidden");
    $("shopHeroKicker").textContent = (shopData.business_name || "") + " presents";
    $("shopHeroName").textContent = shopEvent.name;
    $("shopHeroMeta").textContent = [fmtDate(shopEvent.event_date), shopEvent.start_time, shopEvent.venue].filter(Boolean).join(" • ");
    $("shopHeroAvatar").textContent = (shopData.business_name || "T").trim().charAt(0).toUpperCase();
    tintCard(hero, shopEvent.flyer_url);
    $("shopHeroHost").textContent = "Hosted by " + (shopData.business_name || "");
    $("shopHeroSold").textContent = shopEvent.sold > 0 ? shopEvent.sold + (shopEvent.sold === 1 ? " ticket sold" : " tickets sold") : "";
    $("shopHeroChips").innerHTML = (shopEvent.types || []).filter((t) => !t.is_addon)
      .map((t) => `<span>${esc(t.name)} — ${money(t.price)}</span>`).join("");
  }
  renderShopTypes();
  renderShopQuestions();
  $("shopForm").classList.remove("hidden");
  $("shopSteps").classList.remove("hidden");
  updateSteps(1);
  try {
    if (!$("shopName").value) $("shopName").value = localStorage.getItem("to_buyer_name") || "";
    if (!$("shopPhone").value) $("shopPhone").value = localStorage.getItem("to_buyer_phone") || "";
  } catch (e) { /* private mode: no memory, no problem */ }
  $("shopDone").classList.add("hidden");
  const bank = ((shopData && shopData.bank_details) || "").trim();
  $("shopFormBankBox").classList.toggle("hidden", !bank);
  if (bank) $("shopFormBank").textContent = bank;
  updateShopSummary();
  $("shopForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

function shopTypeRow(t) {
  const q = shopCart[t.id] || 0;
  return `<div class="type-row">
    <div class="type-info"><strong>${esc(t.name)}</strong><span class="muted">${money(t.price)}</span></div>
    <div class="stepper">
      <button type="button" class="step-btn" data-step="${t.id}|-1" aria-label="One less">−</button>
      <span class="step-qty" id="qty-${t.id}">${q}</span>
      <button type="button" class="step-btn" data-step="${t.id}|1" aria-label="One more">+</button>
    </div></div>`;
}

function renderShopTypes() {
  const types = (shopEvent.types || []).filter((t) => !t.is_addon);
  const addons = (shopEvent.types || []).filter((t) => t.is_addon);
  $("shopTypes").innerHTML = types.length
    ? types.map(shopTypeRow).join("")
    : "<p class=\"muted\">No tickets on sale for this event yet.</p>";
  $("shopAddonsWrap").classList.toggle("hidden", !addons.length);
  $("shopAddons").innerHTML = addons.map(shopTypeRow).join("");
  [$("shopTypes"), $("shopAddons")].forEach((box) => box.querySelectorAll("[data-step]").forEach((b) =>
    b.addEventListener("click", () => {
      const [id, d] = b.getAttribute("data-step").split("|");
      shopCart[id] = Math.min(20, Math.max(0, (shopCart[id] || 0) + Number(d)));
      const el = $("qty-" + id); if (el) el.textContent = shopCart[id];
      updateShopSummary();
    })));
}

function renderShopQuestions() {
  const qs = Array.isArray(shopEvent.questions) ? shopEvent.questions : [];
  $("shopQuestions").innerHTML = qs.map((q, i) =>
    `<label>${esc(q)}<input id="shopQ${i}" data-question="${esc(q)}"></label>`).join("");
}

function shopLines() {
  return (shopEvent.types || [])
    .filter((t) => (shopCart[t.id] || 0) > 0)
    .map((t) => ({ type: t, qty: shopCart[t.id] }));
}
function shopTotalCalc() {
  return shopLines().reduce((s, l) => s + Number(l.type.price) * l.qty, 0);
}

function updateShopSummary() {
  const lines = shopLines();
  const total = shopTotalCalc();
  const planPct = shopEvent && shopEvent.plan_pct ? Number(shopEvent.plan_pct) : null;
  let html = lines.length
    ? lines.map((l) => `<div class="breakdown-row"><span>${l.qty} × ${esc(l.type.name)}</span><strong>${money(Number(l.type.price) * l.qty)}</strong></div>`).join("")
    : "<p class=\"muted\">Choose your tickets above.</p>";
  if (lines.length) {
    html += `<div class="breakdown-row total-row"><span>Total</span><strong>${money(total)}</strong></div>`;
    if (planPct) {
      const dep = Math.round(total * planPct) / 100;
      html += `<p class="plan-note">Payment plan: pay a deposit of <strong>${money(dep)}</strong> (${planPct}%) to book, and the balance of <strong>${money(total - dep)}</strong> after — the organiser tracks it for you.</p>`;
    }
  }
  $("shopSummary").innerHTML = html;
  const submitBtn = document.querySelector("#shopForm button[type=submit]");
  if (submitBtn) submitBtn.textContent = lines.length ? "Place order \u2022 " + money(total) : "Place order";
  updateSteps(lines.length ? 2 : 1);
}

/* Add-to-calendar (.ics) built locally — event times are free text like
   "7:00 PM", so parse them; an end time past midnight rolls to next day. */
function icsFor(ev, label) {
  const parse = (s) => {
    const m = String(s || "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!m) return null;
    let hh = Number(m[1]) % 12;
    if (/pm/i.test(m[3] || "")) hh += 12;
    return { hh, mm: Number(m[2] || 0) };
  };
  const d = String(ev.event_date || "").slice(0, 10).replace(/-/g, "");
  if (!d) return null;
  const st = parse(ev.start_time) || { hh: 19, mm: 0 };
  let en = parse(ev.end_time) || { hh: 23, mm: 0 };
  const start = new Date(Date.UTC(2000, 0, 1, st.hh, st.mm));
  let end = new Date(Date.UTC(2000, 0, 1, en.hh, en.mm));
  if (end <= start) end = new Date(end.getTime() + 24 * 3600 * 1000);
  const stamp = (base, addDays) => {
    const t = new Date(base.getTime() + addDays * 24 * 3600 * 1000);
    return d + "T" + String(t.getUTCHours()).padStart(2, "0") + String(t.getUTCMinutes()).padStart(2, "0") + "00";
  };
  const endDay = end.getUTCDate() !== start.getUTCDate() ? 1 : 0;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ticket Office//EN", "BEGIN:VEVENT",
    "UID:" + Date.now() + "@ticketoffice", "DTSTAMP:" + stamp(start, 0),
    "DTSTART:" + stamp(start, 0), "DTEND:" + stamp(end, endDay),
    "SUMMARY:" + String(label || ev.name || "Event").replace(/[\n,;]/g, " "),
    "LOCATION:" + String(ev.venue || "").replace(/[\n,;]/g, " "),
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = String(ev.name || "event").replace(/[^a-z0-9]+/gi, "-") + ".ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function uploadReceipt(file) {
  if (file.size > 6 * 1024 * 1024) throw new Error("That file is too big — keep it under 6 MB.");
  let blob = file, ext = (file.name.split(".").pop() || "bin").toLowerCase();
  if (file.type.startsWith("image/") && file.type !== "image/jpeg") {
    // Shrink big screenshots to a reasonable JPEG before upload.
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.85));
    ext = "jpg";
  }
  const name = Date.now() + "-" + Math.random().toString(36).slice(2, 10) + "." + ext;
  const res = await fetch(CFG.SUPABASE_URL.replace(/\/$/, "") + "/storage/v1/object/receipts/" + name, {
    method: "POST",
    headers: { "apikey": CFG.ANON_KEY, "Authorization": "Bearer " + CFG.ANON_KEY, "Content-Type": blob.type || file.type || "application/octet-stream" },
    body: blob
  });
  if (!res.ok) throw new Error("The receipt could not be uploaded. Check your connection and try again.");
  return CFG.SUPABASE_URL.replace(/\/$/, "") + "/storage/v1/object/public/receipts/" + name;
}

async function submitShopOrder(ev) {
  ev.preventDefault();
  showErr("shopError", "");
  const lines = shopLines();
  if (!lines.length) { showErr("shopError", "Choose at least one ticket."); return; }
  const answers = {};
  document.querySelectorAll("#shopQuestions [data-question]").forEach((inp) => {
    const v = inp.value.trim();
    if (v) answers[inp.getAttribute("data-question")] = v;
  });
  let receiptUrl = "";
  const f = $("shopReceipt").files && $("shopReceipt").files[0];
  if (f) {
    try { receiptUrl = await uploadReceipt(f); }
    catch (e) { showErr("shopError", e.message); return; }
  }
  let r;
  try {
    r = await rpc("place_order", {
      p_slug: ACTIVE_SLUG, p_event_id: shopEvent.id,
      p_lines: lines.map((l) => ({ type_id: l.type.id, qty: l.qty })),
      p_buyer_name: $("shopName").value.trim(), p_buyer_whatsapp: $("shopPhone").value.trim(),
      p_receipt_url: receiptUrl || null,
      p_answers: Object.keys(answers).length ? answers : null
    });
  } catch (e) { showErr("shopError", e.message); return; }
  if (!r.ok) { showErr("shopError", r.message || "Could not place the order."); return; }
  lastShopOrder = { event: shopEvent, result: r };
  const linesText = lines.map((l) => l.qty + " × " + l.type.name).join(", ");
  $("shopForm").classList.add("hidden");
  $("shopDone").classList.remove("hidden");
  $("shopDoneRef").textContent = r.ref;
  updateSteps(3);
  try {
    localStorage.setItem("to_buyer_name", $("shopName").value.trim());
    localStorage.setItem("to_buyer_phone", $("shopPhone").value.trim());
  } catch (e) { /* ignore */ }
  $("shopDoneText").textContent = "Thank you, " + $("shopName").value.trim() + ". Your order " +
    "(reference " + r.ref + "): " + linesText + " for " + r.event_name + " — total " + money(r.total) + ". " +
    (r.deposit_due != null
      ? "This event offers a payment plan: pay the deposit of " + money(r.deposit_due) + " now and the balance later. "
      : "") +
    "Pay using the details below, then send your order to the organiser on WhatsApp. " +
    "Your tickets are confirmed once the organiser accepts the order." +
    (receiptUrl ? " Your receipt was attached to the order." : "");
  const bank = (r.bank_details || "").trim();
  $("shopBankBox").classList.toggle("hidden", !bank);
  if (bank) $("shopBank").textContent = bank;
  const card = (r.card_link || "").trim();
  $("shopCardBox").classList.toggle("hidden", !card);
  if (card) {
    $("shopCardBtn").href = card;
    $("shopCardNote").textContent = "Pay " + money(r.deposit_due != null ? r.deposit_due : r.total) +
      " by card and use reference " + r.ref + " so the organiser can match your payment.";
  }
  const num = (r.owner_whatsapp || "").replace(/[^0-9]/g, "");
  const wa = $("shopWa");
  if (num) {
    const msg = "Hello " + shopData.business_name + ", I just ordered " + linesText +
      " for " + r.event_name + " (total " + money(r.total) + ", reference " + r.ref + "). My name is " +
      $("shopName").value.trim() + ". I am paying by " + (card ? "card / " : "") + "bank transfer.";
    wa.href = "https://wa.me/" + num + "?text=" + encodeURIComponent(msg);
    wa.classList.remove("hidden");
  } else wa.classList.add("hidden");
  $("shopDone").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------------- buyer orders inbox (team) ---------------- */
async function loadOrders() {
  const box = $("ordersList");
  let r;
  try { r = await authed("list_orders", {}); } catch (e) { box.innerHTML = ""; return; }
  if (!r.ok) { box.innerHTML = ""; return; }
  const orders = r.orders || [];
  if (!orders.length) { box.innerHTML = "<p class=\"muted\">No buyer orders yet. Orders from the ticket shop land here.</p>"; return; }
  box.innerHTML = orders.map((o) => {
    const total = Number(o.total || 0), paidAmt = Number(o.paid_amount || 0);
    const balance = Math.max(0, total - paidAmt);
    const answers = o.answers && typeof o.answers === "object"
      ? Object.entries(o.answers).map(([k, v]) => `<div class="tiny muted">${esc(k)}: ${esc(v)}</div>`).join("") : "";
    return `
    <div class="order-row">
      <div class="row-between">
        <span><strong>${esc(o.buyer_name)}</strong> — ${esc(o.event_name)}<br>
          ${(o.lines || []).map((l) => l.qty + " × " + esc(l.type_name) + (l.is_addon ? " (add-on)" : "")).join(", ")}<br>
          ${money(total)}${paidAmt > 0 ? ` • paid ${money(paidAmt)}` : ""}${balance > 0 && o.status !== "declined" ? ` • balance ${money(balance)}` : ""} • ref ${esc(o.ref || "")} • ${esc(new Date(o.created_at).toLocaleString())}</span>
        <span class="chip ${o.status === "new" ? "" : o.status === "issued" ? "used" : "void"}">${esc(o.status.toUpperCase())}</span>
      </div>
      ${answers}
      ${o.buyer_whatsapp ? `<div><a href="https://wa.me/${esc(o.buyer_whatsapp.replace(/[^0-9]/g, ""))}" target="_blank" rel="noopener">Message buyer on WhatsApp</a></div>` : ""}
      ${o.receipt_url ? `<div><a href="${esc(o.receipt_url)}" target="_blank" rel="noopener">View payment receipt</a></div>` : ""}
      ${o.status === "new" ? `<div style="margin-top:8px">
        ${balance > 0 ? `<button type="button" class="btn small" data-pay="${o.group}">Record payment</button>` : ""}
        <button type="button" class="btn primary small" data-convert="${o.group}">Issue tickets${paidAmt >= total ? " (paid)" : " (unpaid)"}</button>
        <button type="button" class="btn ghost small" data-decline="${o.group}">Decline</button></div>` : ""}
    </div>`;
  }).join("");
  box.querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", async () => {
    const amt = prompt("Payment received toward this order (TT$):");
    if (!amt) return;
    const r2 = await authed("record_order_payment", { p_group: b.getAttribute("data-pay"), p_amount: Number(amt) })
      .catch((e) => ({ ok: false, message: e.message }));
    toast(r2.ok ? "Payment recorded. Balance: " + money(r2.balance) : (r2.message || "Could not record."));
    if (r2.ok) loadOrders();
  }));
  box.querySelectorAll("[data-convert]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    let r2;
    try { r2 = await authed("convert_order", { p_group: b.getAttribute("data-convert") }); }
    catch (e) { toast(e.message); b.disabled = false; return; }
    if (!r2.ok) { toast(r2.message || "Could not issue."); b.disabled = false; return; }
    toast("Tickets issued: " + (r2.tickets || []).map((t) => t.code).join(", "));
    loadOrders(); loadTickets();
  }));
  box.querySelectorAll("[data-decline]").forEach((b) => b.addEventListener("click", async () => {
    let r2;
    try { r2 = await authed("decline_order", { p_group: b.getAttribute("data-decline") }); }
    catch (e) { toast(e.message); return; }
    if (!r2.ok) { toast(r2.message || "Could not decline."); return; }
    loadOrders();
  }));
}

/* ---------------- boot ---------------- */
document.addEventListener("DOMContentLoaded", () => {
  wire();
  loadSession();
  if (session && session.tenant && session.tenant.slug && ACTIVE_SLUG && session.tenant.slug !== ACTIVE_SLUG) {
    // A stored session belongs to one store only — never carry it into another.
    session = null; saveSession();
  }
  if (new URLSearchParams(location.search).has("shop")) {
    // A buyer link always opens the shop — even on a phone where a team
    // member happens to be signed in.
    openShop();
  } else if (!ACTIVE_SLUG) {
    openHome();
  } else if (session && session.token) {
    // Validate the stored session cheaply; enterApp's first RPC will bounce
    // to login if it has expired.
    $("loginScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("bizName").textContent = session.tenant.business_name || "Ticket Office";
    $("menuUser").textContent = "Signed in as " + session.member.name + " • " + session.member.role;
    $("graceBanner").classList.toggle("hidden", !session.grace);
    applyRoles();
    refreshEvents().then(() => go(role() === "door" ? "door" : "dashboard")).catch(() => forceSignOut());
  } else {
    bootLogin();
  }
});
