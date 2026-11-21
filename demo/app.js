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
  try { info = await rpc("public_team", { p_slug: CFG.TENANT_SLUG }); }
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
  try { r = await rpc("login", { p_slug: CFG.TENANT_SLUG, p_name: selectedMember, p_pin: $("pinInput").value.trim() }); }
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
      p_slug: CFG.TENANT_SLUG, p_claim_code: $("claimCode").value.trim(),
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
      p_slug: CFG.TENANT_SLUG, p_recovery_code: $("recoverCode").value.trim(),
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
  box.innerHTML = `
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
  const sub = [r.buyer_name, r.type_name, r.paid === false ? "UNPAID" : null].filter(Boolean).join(" • ");
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
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}
function resetEventForm() {
  $("eventFormTitle").textContent = "New event";
  ["evId", "evName", "evPresenter", "evPrefix", "evDate", "evStart", "evEnd", "evVenue", "evCapacity"].forEach((id) => { $(id).value = ""; });
  $("evPrefix").disabled = false;
  flyerDataUrl = ""; flyerTouched = false;
  $("evFlyerPreview").classList.add("hidden"); $("evFlyerRemove").classList.add("hidden");
  $("evCancel").classList.add("hidden");
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
    <div class="breakdown-row"><span>${esc(t.name)} — ${money(t.price)}${t.capacity ? " • cap " + t.capacity : ""}${t.is_active ? "" : " • off"}</span>
    <button class="btn small" data-tyedit="${t.id}">Edit</button></div>`).join("");
  $("typesList").querySelectorAll("[data-tyedit]").forEach((b) => b.addEventListener("click", () => {
    const t = (e.types || []).find((x) => x.id === b.getAttribute("data-tyedit"));
    if (!t) return;
    $("tyId").value = t.id; $("tyName").value = t.name; $("tyPrice").value = t.price; $("tyCapacity").value = t.capacity || "";
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
      p_capacity: $("tyCapacity").value ? Number($("tyCapacity").value) : null, p_is_active: true
    });
  } catch (err) { showErr("tyError", err.message); return; }
  if (!r.ok) { showErr("tyError", r.message || "Could not save."); return; }
  $("tyId").value = ""; $("tyName").value = ""; $("tyPrice").value = ""; $("tyCapacity").value = "";
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
  $("shopLink").textContent = shopUrl();
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
      const rb = await authed("update_bank_details", { p_bank_details: $("setBank").value });
      if (!rb.ok) { toast(rb.message || "Bank details could not be saved."); return; }
    } catch (err) { toast(err.message); return; }
    session.tenant.business_name = $("setBiz").value.trim();
    session.tenant.owner_whatsapp = $("setWhatsapp").value.trim();
    session.tenant.bank_details = $("setBank").value;
    saveSession();
    $("bizName").textContent = session.tenant.business_name || "Ticket Office";
    toast("Settings saved.");
  });

  $("ticketClose").addEventListener("click", () => $("ticketModal").classList.add("hidden"));
  $("ticketBackIssue").addEventListener("click", () => { $("ticketModal").classList.add("hidden"); go("issue"); });
  $("themeFab").addEventListener("click", toggleTheme);
  applyTheme(document.documentElement.dataset.theme || "day");
  $("openShopBtn").addEventListener("click", openShop);
  $("shopBack").addEventListener("click", () => {
    $("shopScreen").classList.add("hidden");
    if (session && session.token) { $("app").classList.remove("hidden"); }
    else { $("loginScreen").classList.remove("hidden"); bootLogin(); }
  });
  $("shopForm").addEventListener("submit", submitShopOrder);
  $("shopType").addEventListener("change", updateShopTotal);
  $("shopQty").addEventListener("input", updateShopTotal);
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

/* ---------------- buyer shop (public) ---------------- */
let shopData = null;   // public_shop result
let shopEvent = null;  // event the buyer picked

function shopUrl() {
  return location.origin + location.pathname + "?shop";
}

async function openShop() {
  $("loginScreen").classList.add("hidden");
  $("app").classList.add("hidden");
  $("shopScreen").classList.remove("hidden");
  $("shopEvents").innerHTML = "<p class=\"muted\">Loading events…</p>";
  $("shopForm").classList.add("hidden");
  $("shopDone").classList.add("hidden");
  try {
    shopData = await rpc("public_shop", { p_slug: CFG.TENANT_SLUG });
  } catch (e) {
    $("shopEvents").innerHTML = "<p class=\"error\">" + esc(e.message) + "</p>";
    return;
  }
  if (!shopData.ok) {
    $("shopEvents").innerHTML = "<p class=\"error\">" + esc(shopData.message || "Shop unavailable.") + "</p>";
    return;
  }
  $("shopBiz").textContent = shopData.business_name + " — Tickets";
  const evs = shopData.events || [];
  $("shopEvents").innerHTML = evs.length ? evs.map((e) => `
    <div class="event-card">
      ${e.flyer_url ? `<img class="poster" src="${esc(e.flyer_url)}" alt="${esc(e.name)} flyer">` : ""}
      <div class="event-meta">
        <strong>${esc(e.name)}</strong><br>
        ${esc(fmtDate(e.event_date))} • ${esc(e.start_time || "")} • ${esc(e.venue || "")}<br>
        ${(e.types || []).map((t) => esc(t.name) + " " + money(t.price)).join(" • ")}
      </div>
      <button type="button" class="btn primary" data-shop-ev="${e.id}">Order tickets</button>
    </div>`).join("")
    : "<p class=\"muted\">No events are on sale right now.</p>";
  $("shopEvents").querySelectorAll("[data-shop-ev]").forEach((b) =>
    b.addEventListener("click", () => selectShopEvent(b.getAttribute("data-shop-ev"))));
}

function selectShopEvent(id) {
  shopEvent = (shopData.events || []).find((e) => e.id === id);
  if (!shopEvent) return;
  $("shopFormTitle").textContent = "Order — " + shopEvent.name;
  $("shopType").innerHTML = (shopEvent.types || []).map((t) =>
    `<option value="${t.id}">${esc(t.name)} — ${money(t.price)}</option>`).join("");
  $("shopForm").classList.remove("hidden");
  $("shopDone").classList.add("hidden");
  const bank = ((shopData && shopData.bank_details) || "").trim();
  $("shopFormBankBox").classList.toggle("hidden", !bank);
  if (bank) $("shopFormBank").textContent = bank;
  updateShopTotal();
  $("shopForm").scrollIntoView({ behavior: "smooth", block: "start" });
}
function shopUnitPrice() {
  const t = (shopEvent.types || []).find((x) => x.id === $("shopType").value);
  return t ? Number(t.price) : 0;
}
function updateShopTotal() { $("shopTotal").textContent = money(shopUnitPrice() * Math.max(1, Number($("shopQty").value || 1))); }

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
  let receiptUrl = "";
  const f = $("shopReceipt").files && $("shopReceipt").files[0];
  if (f) {
    try { receiptUrl = await uploadReceipt(f); }
    catch (e) { showErr("shopError", e.message); return; }
  }
  let r;
  try {
    r = await rpc("place_order", {
      p_slug: CFG.TENANT_SLUG, p_event_id: shopEvent.id, p_type_id: $("shopType").value,
      p_qty: Number($("shopQty").value || 1),
      p_buyer_name: $("shopName").value.trim(), p_buyer_whatsapp: $("shopPhone").value.trim(),
      p_receipt_url: receiptUrl || null
    });
  } catch (e) { showErr("shopError", e.message); return; }
  if (!r.ok) { showErr("shopError", r.message || "Could not place the order."); return; }
  $("shopForm").classList.add("hidden");
  $("shopDone").classList.remove("hidden");
  $("shopDoneText").textContent = "Thank you, " + $("shopName").value.trim() + ". Your order: " +
    r.qty + " × " + r.type_name + " for " + r.event_name + " — total " + money(r.total) + ". " +
    "Pay by bank transfer below, then send your order to the organiser on WhatsApp. " +
    "Your tickets are confirmed once the organiser accepts the order." +
    (receiptUrl ? " Your receipt was attached to the order." : "");
  const bank = (r.bank_details || "").trim();
  $("shopBankBox").classList.toggle("hidden", !bank);
  if (bank) $("shopBank").textContent = bank;
  const num = (r.owner_whatsapp || "").replace(/[^0-9]/g, "");
  const wa = $("shopWa");
  if (num) {
    const msg = "Hello " + shopData.business_name + ", I just ordered " + r.qty + " x " + r.type_name +
      " for " + r.event_name + " (total " + money(r.total) + "). My name is " + $("shopName").value.trim() +
      ". I am paying by bank transfer.";
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
  box.innerHTML = orders.map((o) => `
    <div class="order-row">
      <div class="row-between">
        <span><strong>${esc(o.buyer_name)}</strong> — ${esc(o.event_name)}<br>
          ${o.qty} × ${esc(o.type_name)} • ${money(o.total)} • ${esc(new Date(o.created_at).toLocaleString())}</span>
        <span class="chip ${o.status === "new" ? "" : o.status === "issued" ? "used" : "void"}">${esc(o.status.toUpperCase())}</span>
      </div>
      ${o.buyer_whatsapp ? `<div><a href="https://wa.me/${esc(o.buyer_whatsapp.replace(/[^0-9]/g, ""))}" target="_blank" rel="noopener">Message buyer on WhatsApp</a></div>` : ""}
      ${o.receipt_url ? `<div><a href="${esc(o.receipt_url)}" target="_blank" rel="noopener">View payment receipt</a></div>` : ""}
      ${o.status === "new" ? `<div style="margin-top:8px">
        <button type="button" class="btn primary small" data-convert="${o.id}">Issue tickets (unpaid)</button>
        <button type="button" class="btn ghost small" data-decline="${o.id}">Decline</button></div>` : ""}
    </div>`).join("");
  box.querySelectorAll("[data-convert]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    let r2;
    try { r2 = await authed("convert_order", { p_order_id: b.getAttribute("data-convert") }); }
    catch (e) { toast(e.message); b.disabled = false; return; }
    if (!r2.ok) { toast(r2.message || "Could not issue."); b.disabled = false; return; }
    toast("Tickets issued: " + (r2.tickets || []).map((t) => t.code).join(", "));
    loadOrders(); loadTickets();
  }));
  box.querySelectorAll("[data-decline]").forEach((b) => b.addEventListener("click", async () => {
    let r2;
    try { r2 = await authed("decline_order", { p_order_id: b.getAttribute("data-decline") }); }
    catch (e) { toast(e.message); return; }
    if (!r2.ok) { toast(r2.message || "Could not decline."); return; }
    loadOrders();
  }));
}

/* ---------------- boot ---------------- */
document.addEventListener("DOMContentLoaded", () => {
  wire();
  loadSession();
  if (new URLSearchParams(location.search).has("shop")) {
    // A buyer link always opens the shop — even on a phone where a team
    // member happens to be signed in.
    openShop();
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
