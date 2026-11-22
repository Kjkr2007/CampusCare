/* =========================================================
   Campus Health Services & Emergency Response — app logic
   Pure vanilla JS, persisted through the authenticated CampusCare API.
   ========================================================= */
const API_BASE = "https://campuscare-ztkr.onrender.com";
const STORAGE_KEY = "chs_app_state_v1"; // retained only for the theme preference migration
const ESCALATION_MINUTES = 5; // auto-escalate if not acknowledged in time

const TIME_SLOTS = ["09:00","09:30","10:00","10:30","11:00","11:30","12:00",
                     "14:00","14:30","15:00","15:30","16:00","16:30"];

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 9);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function timeNow() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ---------------- Default seed data ---------------- */
function seedState() {
  return {
    doctors: [
      { id: "doc_1", name: "Dr. Anjali Mehra", specialty: "General Physician", onDuty: true },
      { id: "doc_2", name: "Dr. Rohan Kapoor", specialty: "Orthopedics", onDuty: true },
      { id: "doc_3", name: "Dr. Simran Kaur", specialty: "Psychiatrist / Counsellor", onDuty: false },
    ],
    // bookings: { "doc_1|2026-10-26|09:00": {studentName, bookedAt} }
    bookings: {},
    queue: [],          // { token, name, status: 'waiting'|'serving'|'done', time }
    nextToken: 1,
    nowServing: null,
    alerts: [],          // {id, category, location, notes, raisedBy, raisedAt, status, ackAt, arrivedAt, resolvedAt, responderId, escalated}
    responders: [
      { id: "res_1", name: "Security Officer Verma", onDuty: true },
      { id: "res_2", name: "Nurse Latika", onDuty: true },
      { id: "res_3", name: "Warden Mr. Singh", onDuty: false },
    ],
    visits: [],
  };
}

// Never store account credentials or shared app data in browser localStorage.
// The server is the source of truth; this is only an empty display state until login.
function loadState() {
  return seedState();
}
let activeAccount = null;
let state = loadState();

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: { ...(options.headers || {}) }
  });
  return response;
}

function saveState(s) {
  if (!activeAccount) return;
  const payload = { ...s };
  delete payload.accounts;
  apiFetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).then(async response => {
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      console.error("Backend save failed:", data.error || response.statusText);
    }
  }).catch(error => console.error("Backend connection error:", error));
}

/* ---------------- Toast ---------------- */
function toast(msg) {
  const c = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- Current user ---------------- */
function getUser() {
  const name = document.getElementById("userName").value.trim() || "Guest";
  const role = document.getElementById("roleSelect").value;
  return { name, role };
}

/* ---------------- Tabs ---------------- */
document.getElementById("tabNav").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(btn.dataset.tab).classList.add("active");
  renderAll();
});

/* =========================================================
   DASHBOARD
   ========================================================= */
function renderDashboard() {
  const onDuty = state.doctors.filter(d => d.onDuty).length;
  document.getElementById("statDoctorsOnDuty").textContent = onDuty;
  document.getElementById("statQueueCount").textContent =
    state.queue.filter(q => q.status === "waiting").length;
  const active = state.alerts.filter(a => a.status !== "resolved").length;
  document.getElementById("statActiveAlerts").textContent = active;

  const resolved = state.alerts.filter(a => a.status === "resolved" && a.ackAt);
  if (resolved.length) {
    const avgMs = resolved.reduce((sum, a) => sum + (new Date(a.ackAt) - new Date(a.raisedAt)), 0) / resolved.length;
    document.getElementById("statAvgResponse").textContent = Math.max(0, Math.round(avgMs / 60000)) + " min";
  } else {
    document.getElementById("statAvgResponse").textContent = "—";
  }

  // availability mini list
  const availEl = document.getElementById("dashboardAvailability");
  availEl.innerHTML = "";
  if (!state.doctors.length) availEl.innerHTML = `<div class="empty-note">No doctors added yet.</div>`;
  state.doctors.forEach(d => {
    const booked = Object.keys(state.bookings).filter(k => k.startsWith(d.id + "|" + todayISO())).length;
    const row = document.createElement("div");
    row.className = "mini-row";
    row.innerHTML = `<div><strong>${esc(d.name)}</strong><div class="meta">${esc(d.specialty)}</div></div>
      <span class="status-pill ${d.onDuty ? "available" : "off"}">${d.onDuty ? "Available" : "Off duty"}</span>
      <span class="meta">${booked} booked today</span>`;
    availEl.appendChild(row);
  });

  // recent alerts
  const alertEl = document.getElementById("dashboardAlerts");
  alertEl.innerHTML = "";
  const recent = [...state.alerts].sort((a,b)=> new Date(b.raisedAt)-new Date(a.raisedAt)).slice(0,5);
  if (!recent.length) alertEl.innerHTML = `<div class="empty-note">No alerts raised yet.</div>`;
  recent.forEach(a => {
    const row = document.createElement("div");
    row.className = "mini-row";
    row.innerHTML = `<div><strong>${esc(a.category)}</strong><div class="meta">${esc(a.location)}</div></div>
      <span class="alert-badge ${badgeClass(a.status)}">${labelForStatus(a.status)}</span>`;
    alertEl.appendChild(row);
  });
}

/* =========================================================
   DOCTOR AVAILABILITY & BOOKING
   ========================================================= */
function initAvailDate() {
  const input = document.getElementById("availDate");
  if (!input.value) input.value = todayISO();
}

document.getElementById("availDate").addEventListener("change", renderDoctors);

document.getElementById("addDoctorBtn").addEventListener("click", () => {
  const user = getUser();
  if (user.role !== "admin") { toast("Only Admin can add doctors. Switch role above."); return; }
  const name = prompt("Doctor name:");
  if (!name) return;
  const specialty = prompt("Specialty:") || "General Physician";
  state.doctors.push({ id: uid("doc"), name, specialty, onDuty: true });
  saveState(state);
  renderAll();
  toast("Doctor added.");
});

function renderDoctors() {
  const date = document.getElementById("availDate").value || todayISO();
  const wrap = document.getElementById("doctorList");
  wrap.innerHTML = "";
  if (!state.doctors.length) {
    wrap.innerHTML = `<div class="empty-note">No doctors configured.</div>`;
    return;
  }
  state.doctors.forEach(doc => {
    const card = document.createElement("div");
    card.className = "doctor-card";
    const slotsHtml = TIME_SLOTS.map(t => {
      const key = `${doc.id}|${date}|${t}`;
      const bk = state.bookings[key];
      return `<button class="slot-btn ${bk ? "booked" : ""}" data-key="${key}" ${!doc.onDuty || bk ? "disabled" : ""}
                title="${bk ? "Booked by " + esc(bk.studentName) : "Available"}">${t}</button>`;
    }).join("");

    card.innerHTML = `
      <div class="doc-head">
        <div>
          <h3>${esc(doc.name)}</h3>
          <div class="doc-specialty">${esc(doc.specialty)}</div>
        </div>
        <span class="status-pill ${doc.onDuty ? "available" : "off"}">${doc.onDuty ? "On duty" : "Off duty"}</span>
      </div>
      <div class="slot-grid">${doc.onDuty ? slotsHtml : `<span class="empty-note">Not available today</span>`}</div>
      <div style="margin-top:10px;">
        <button class="btn ghost small toggle-duty" data-id="${doc.id}">${doc.onDuty ? "Mark off duty" : "Mark on duty"}</button>
      </div>
    `;
    wrap.appendChild(card);
  });

  wrap.querySelectorAll(".slot-btn:not(.booked):not(:disabled)").forEach(btn => {
    btn.addEventListener("click", () => bookSlot(btn.dataset.key));
  });
  wrap.querySelectorAll(".toggle-duty").forEach(btn => {
    btn.addEventListener("click", () => {
      const user = getUser();
      if (user.role === "student") { toast("Only staff/admin can change duty status."); return; }
      const doc = state.doctors.find(d => d.id === btn.dataset.id);
      doc.onDuty = !doc.onDuty;
      saveState(state);
      renderAll();
    });
  });
}

function bookSlot(key) {
  const user = getUser();
  if (!user.name || user.name === "Guest") {
    toast("Enter your name at the top first.");
    return;
  }
  state.bookings[key] = { studentName: user.name, bookedAt: new Date().toISOString() };
  saveState(state);
  renderAll();
  toast("Appointment booked for " + key.split("|")[2]);
}

function renderMyAppointments() {
  const user = getUser();
  const el = document.getElementById("myAppointments");
  el.innerHTML = "";
  const mine = Object.entries(state.bookings).filter(([k, v]) => v.studentName === user.name);
  if (!mine.length) { el.innerHTML = `<div class="empty-note">No appointments booked yet.</div>`; return; }
  mine.sort((a,b) => a[0].localeCompare(b[0]));
  mine.forEach(([key]) => {
    const [docId, date, time] = key.split("|");
    const doc = state.doctors.find(d => d.id === docId);
    const row = document.createElement("div");
    row.className = "mini-row";
    row.innerHTML = `<div><strong>${esc(doc ? doc.name : "Doctor")}</strong><div class="meta">${date} · ${time}</div></div>
      <button class="btn small danger cancel-appt" data-key="${key}">Cancel</button>`;
    el.appendChild(row);
  });
  el.querySelectorAll(".cancel-appt").forEach(btn => {
    btn.addEventListener("click", () => {
      delete state.bookings[btn.dataset.key];
      saveState(state);
      renderAll();
      toast("Appointment cancelled.");
    });
  });
}

/* =========================================================
   LIVE QUEUE
   ========================================================= */
document.getElementById("takeTokenBtn").addEventListener("click", () => {
  const user = getUser();
  if (!user.name || user.name === "Guest") { toast("Enter your name first."); return; }
  const token = state.nextToken++;
  state.queue.push({ token, name: user.name, status: "waiting", time: timeNow() });
  saveState(state);
  renderAll();
  toast("Token #" + token + " issued.");
});

function renderQueue() {
  document.getElementById("nowServingToken").textContent =
    state.nowServing !== null ? "#" + state.nowServing : "—";

  const list = document.getElementById("queueList");
  list.innerHTML = "";
  const waiting = state.queue.filter(q => q.status !== "done");
  if (!waiting.length) {
    list.innerHTML = `<div class="empty-note">Queue is empty.</div>`;
    return;
  }
  waiting.forEach(q => {
    const row = document.createElement("div");
    row.className = "queue-row " + q.status;
    const user = getUser();
    const canManage = user.role !== "student";
    row.innerHTML = `
      <span class="qtoken">#${q.token} — ${esc(q.name)}</span>
      <span class="meta">${q.time}${q.status === "serving" ? " · Serving now" : ""}</span>
      ${canManage ? `<span><button class="btn small primary serve-btn" data-token="${q.token}" ${q.status==='serving'?'disabled':''}>Call next</button>
        <button class="btn small ghost done-btn" data-token="${q.token}">Done</button></span>` : ""}
    `;
    list.appendChild(row);
  });

  list.querySelectorAll(".serve-btn").forEach(btn => btn.addEventListener("click", () => {
    const token = Number(btn.dataset.token);
    state.queue.forEach(q => { if (q.status === "serving") q.status = "waiting"; });
    const item = state.queue.find(q => q.token === token);
    item.status = "serving";
    state.nowServing = token;
    saveState(state);
    renderAll();
  }));
  list.querySelectorAll(".done-btn").forEach(btn => btn.addEventListener("click", () => {
    const token = Number(btn.dataset.token);
    const item = state.queue.find(q => q.token === token);
    item.status = "done";
    if (state.nowServing === token) state.nowServing = null;
    saveState(state);
    renderAll();
  }));
}

/* =========================================================
   EMERGENCY ALERTS
   ========================================================= */
document.getElementById("raiseAlertBtn").addEventListener("click", () => {
  const user = getUser();
  const category = document.getElementById("emergencyCategory").value;
  const location = document.getElementById("emergencyLocation").value.trim();
  const notes = document.getElementById("emergencyNotes").value.trim();
  if (!location) { toast("Please enter a location."); return; }

  const alert = {
    id: uid("alert"),
    category, location, notes,
    raisedBy: user.name || "Anonymous",
    raisedAt: new Date().toISOString(),
    status: "raised",
    ackAt: null, arrivedAt: null, resolvedAt: null,
    responderId: null,
    escalated: false,
  };
  state.alerts.unshift(alert);
  saveState(state);
  document.getElementById("emergencyLocation").value = "";
  document.getElementById("emergencyNotes").value = "";
  renderAll();
  toast("🚨 Emergency alert raised. Responders notified.");
});

function labelForStatus(s) {
  return { raised: "Raised", acknowledged: "Acknowledged", arrived: "Responder Arrived", resolved: "Resolved" }[s] || s;
}
function badgeClass(s) {
  return { raised: "", acknowledged: "ack", arrived: "arrived", resolved: "resolved" }[s] || "";
}

function renderAlertCard(a, { showActions }) {
  const div = document.createElement("div");
  div.className = `alert-card status-${a.status} ${a.escalated ? "escalated" : ""}`;
  const responder = state.responders.find(r => r.id === a.responderId);

  const steps = ["raised", "acknowledged", "arrived", "resolved"];
  const order = steps.indexOf(a.status);
  const timelineHtml = steps.map((s, i) =>
    `<span class="step ${i <= order ? "done" : ""}">${labelForStatus(s)}</span>`).join("");

  let actionsHtml = "";
  if (showActions && a.status !== "resolved") {
    if (a.status === "raised") actionsHtml += `<button class="btn small primary ack-btn" data-id="${a.id}">Acknowledge</button>`;
    if (a.status === "acknowledged") actionsHtml += `<button class="btn small primary arrive-btn" data-id="${a.id}">Mark Arrived</button>`;
    if (a.status === "arrived") actionsHtml += `<button class="btn small primary resolve-btn" data-id="${a.id}">Mark Resolved</button>`;
  }

  div.innerHTML = `
    <div class="alert-top">
      <div>
        <h4>${esc(a.category)} ${a.escalated && a.status !== "resolved" ? '<span class="escalated-tag">⚠ ESCALATED</span>' : ""}</h4>
        <div class="alert-loc">📍 ${esc(a.location)} · raised by ${esc(a.raisedBy)} at ${new Date(a.raisedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</div>
      </div>
      <span class="alert-badge ${badgeClass(a.status)}">${labelForStatus(a.status)}</span>
    </div>
    ${a.notes ? `<div class="alert-notes">${esc(a.notes)}</div>` : ""}
    ${responder ? `<div class="alert-notes">Responder: ${esc(responder.name)}</div>` : ""}
    <div class="timeline">${timelineHtml}</div>
    <div class="alert-actions">${actionsHtml}</div>
  `;
  return div;
}

function renderEmergencyTab() {
  const el = document.getElementById("alertTimelineList");
  el.innerHTML = "";
  if (!state.alerts.length) { el.innerHTML = `<div class="empty-note">No alerts yet.</div>`; return; }
  state.alerts.forEach(a => el.appendChild(renderAlertCard(a, { showActions: false })));
}

/* =========================================================
   RESPONDER ASSIGNMENT
   ========================================================= */
function renderResponders() {
  const wrap = document.getElementById("respondersList");
  wrap.innerHTML = "";
  state.responders.forEach(r => {
    const activeCount = state.alerts.filter(a => a.responderId === r.id && a.status !== "resolved").length;
    const card = document.createElement("div");
    card.className = "doctor-card";
    card.innerHTML = `
      <div class="doc-head">
        <div><h3>${esc(r.name)}</h3><div class="doc-specialty">${activeCount} active case(s)</div></div>
        <span class="status-pill ${r.onDuty ? "available" : "off"}">${r.onDuty ? "On duty" : "Off duty"}</span>
      </div>
      <div style="margin-top:10px;">
        <button class="btn ghost small toggle-res-duty" data-id="${r.id}">${r.onDuty ? "Mark off duty" : "Mark on duty"}</button>
      </div>
    `;
    wrap.appendChild(card);
  });
  wrap.querySelectorAll(".toggle-res-duty").forEach(btn => btn.addEventListener("click", () => {
    const r = state.responders.find(x => x.id === btn.dataset.id);
    r.onDuty = !r.onDuty;
    saveState(state);
    renderAll();
  }));

  const alertsWrap = document.getElementById("responderAlerts");
  alertsWrap.innerHTML = "";
  const open = state.alerts.filter(a => a.status !== "resolved");
  if (!open.length) { alertsWrap.innerHTML = `<div class="empty-note">No open alerts.</div>`; }
  open.forEach(a => {
    const card = renderAlertCard(a, { showActions: true });
    // assignment dropdown for 'raised' alerts without a responder
    if (a.status === "raised" && !a.responderId) {
      const assignWrap = document.createElement("div");
      assignWrap.style.marginTop = "8px";
      const onDutyResponders = state.responders.filter(r => r.onDuty);
      assignWrap.innerHTML = `
        <select class="assign-select" data-id="${a.id}">
          <option value="">Assign responder…</option>
          ${onDutyResponders.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}
        </select>`;
      card.appendChild(assignWrap);
    }
    alertsWrap.appendChild(card);
  });

  alertsWrap.querySelectorAll(".assign-select").forEach(sel => sel.addEventListener("change", () => {
    const a = state.alerts.find(x => x.id === sel.dataset.id);
    a.responderId = sel.value || null;
    saveState(state);
    renderAll();
    toast("Responder assigned.");
  }));
  alertsWrap.querySelectorAll(".ack-btn").forEach(btn => btn.addEventListener("click", () => {
    const a = state.alerts.find(x => x.id === btn.dataset.id);
    a.status = "acknowledged";
    a.ackAt = new Date().toISOString();
    a.escalated = false;
    saveState(state); renderAll();
    toast("Alert acknowledged.");
  }));
  alertsWrap.querySelectorAll(".arrive-btn").forEach(btn => btn.addEventListener("click", () => {
    const a = state.alerts.find(x => x.id === btn.dataset.id);
    a.status = "arrived";
    a.arrivedAt = new Date().toISOString();
    saveState(state); renderAll();
    toast("Responder marked arrived.");
  }));
  alertsWrap.querySelectorAll(".resolve-btn").forEach(btn => btn.addEventListener("click", () => {
    const a = state.alerts.find(x => x.id === btn.dataset.id);
    a.status = "resolved";
    a.resolvedAt = new Date().toISOString();
    saveState(state); renderAll();
    toast("Alert resolved.");
  }));
}

/* Auto-escalation check: raised & unacknowledged past threshold */
function checkEscalations() {
  const now = Date.now();
  let changed = false;
  state.alerts.forEach(a => {
    if (a.status === "raised" && !a.escalated) {
      const mins = (now - new Date(a.raisedAt)) / 60000;
      if (mins >= ESCALATION_MINUTES) { a.escalated = true; changed = true; }
    }
  });
  if (changed) { saveState(state); }
  return changed;
}

/* =========================================================
   VISIT LOG
   ========================================================= */
document.getElementById("addVisitBtn").addEventListener("click", () => {
  const student = document.getElementById("visitStudent").value.trim();
  const reason = document.getElementById("visitReason").value.trim();
  const doctor = document.getElementById("visitDoctor").value.trim();
  if (!student || !reason) { toast("Student name and reason are required."); return; }
  state.visits.unshift({ id: uid("visit"), student, reason, doctor: doctor || "—", date: new Date().toLocaleDateString() });
  saveState(state);
  document.getElementById("visitStudent").value = "";
  document.getElementById("visitReason").value = "";
  document.getElementById("visitDoctor").value = "";
  renderAll();
  toast("Visit recorded.");
});

function renderVisits() {
  const body = document.getElementById("visitTableBody");
  body.innerHTML = "";
  if (!state.visits.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty-note">No visit records yet.</td></tr>`;
    return;
  }
  state.visits.forEach(v => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(v.date)}</td><td>${esc(v.student)}</td><td>${esc(v.reason)}</td><td>${esc(v.doctor)}</td>`;
    body.appendChild(tr);
  });
}

/* ---------------- helpers ---------------- */
function esc(str) {
  return String(str).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
}


/* Demo sign-in and administrator account management.
   Plain-text localStorage credentials are NOT production security. */
function applyAccess() {
  const role = activeAccount?.role || "student";
  document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("role-hidden", role !== "admin"));
  document.querySelectorAll(".tab-btn").forEach(el => { if (el.dataset.tab === "admin") el.classList.toggle("role-hidden", role !== "admin"); });
  document.getElementById("responders").classList.toggle("role-hidden", role === "student");
  document.getElementById("visits").classList.toggle("role-hidden", role === "student");
}
function signIn(account) {
  activeAccount = account;
  document.getElementById("userName").value = account.name;
  document.getElementById("roleSelect").value = account.role === "doctor" ? "responder" : account.role;
  document.getElementById("sessionName").textContent = account.name + " · " + account.role;
  document.getElementById("loginScreen").classList.add("hidden");
  applyAccess(); renderAll();
}
document.getElementById("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const username = document.getElementById("loginUsername").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;
  const err = document.getElementById("loginError");
  try {
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username, password })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Sign in failed");
    await loadServerState();
    signIn(data.user);
    await renderAccounts();
  } catch (error) {
    err.textContent = error.message || "Unable to connect to the server.";
    err.hidden = false;
  }
});
async function loadServerState() {
  const response = await apiFetch("/api/state");
  if (!response.ok) throw new Error("Could not load CampusCare data.");
  const serverState = await response.json();
  state = { ...seedState(), ...serverState };
  delete state.accounts;
  renderAll();
}
document.getElementById("logoutBtn").addEventListener("click", async () => {
  await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  activeAccount = null;
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("loginUsername").value = "";
  document.getElementById("loginPassword").value = "";
});
document.getElementById("togglePassword").addEventListener("click", () => {
  const p=document.getElementById("loginPassword"); p.type=p.type==="password"?"text":"password";
  document.getElementById("togglePassword").textContent=p.type==="password"?"Show":"Hide";
});
document.getElementById("newRole").addEventListener("change", e => {
  document.getElementById("specialtyLabel").hidden=e.target.value!=="doctor";
});
document.getElementById("createUserForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (activeAccount?.role !== "admin") return toast("Administrator access required.");
  const payload = {
    name: document.getElementById("newFullName").value.trim(),
    username: document.getElementById("newUsername").value.trim().toLowerCase(),
    password: document.getElementById("newPassword").value,
    role: document.getElementById("newRole").value,
    specialty: document.getElementById("newSpecialty").value.trim()
  };
  try {
    const response = await apiFetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create account");
    if (payload.role === "doctor") state.doctors.push({ id: data.user.id, name: payload.name, specialty: payload.specialty || "General Physician", onDuty: true });
    if (payload.role === "responder") state.responders.push({ id: data.user.id, name: payload.name, onDuty: true });
    saveState(state);
    e.target.reset();
    document.getElementById("specialtyLabel").hidden = true;
    await renderAccounts();
    renderAll();
    toast("New account created.");
  } catch (error) { toast(error.message); }
});
async function renderAccounts() {
  const el = document.getElementById("accountList");
  if (!el || activeAccount?.role !== "admin") return;
  try {
    const response = await apiFetch("/api/users");
    if (!response.ok) throw new Error("Unable to load accounts");
    const users = await response.json();
    document.getElementById("accountCount").textContent = users.length + " accounts";
    el.innerHTML = users.map(a => `<div class="account-item"><div><b>${esc(a.name)}</b><small>@${esc(a.username)} · ${esc(a.role)}</small></div>${a.username === "admin" ? '<span class="protected">Primary admin</span>' : `<button class="btn ghost small delete-account" data-id="${a.id}">Remove</button>`}</div>`).join("");
  } catch (error) { el.textContent = error.message; }
}
document.getElementById("accountList").addEventListener("click", async e => {
  const btn = e.target.closest(".delete-account");
  if (!btn || activeAccount?.role !== "admin") return;
  if (!confirm("Remove this account?")) return;
  try {
    const response = await apiFetch("/api/users/" + encodeURIComponent(btn.dataset.id), {
      method: "DELETE"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not remove account");
    state.doctors = state.doctors.filter(x => x.id !== btn.dataset.id);
    state.responders = state.responders.filter(x => x.id !== btn.dataset.id);
    saveState(state);
    await renderAccounts(); renderAll(); toast("Account removed.");
  } catch (error) { toast(error.message); }
});

/* ---------------- master render ---------------- */
function renderAll() {
  checkEscalations();
  renderDashboard();
  renderDoctors();
  renderMyAppointments();
  renderQueue();
  renderEmergencyTab();
  renderResponders();
  renderVisits();
  renderAccounts();
}

/* ---------------- init ---------------- */
initAvailDate();
document.getElementById("roleSelect").addEventListener("change", renderAll);
document.getElementById("userName").addEventListener("input", renderAll);

// Restore a valid server session on page refresh; otherwise keep the login screen visible.
(async function initializeApp() {
  try {
    const response = await apiFetch("/api/auth/me");
    if (response.ok) {
      const data = await response.json();
      await loadServerState();
      signIn(data.user);
      await renderAccounts();
    } else {
      document.getElementById("loginScreen").classList.remove("hidden");
    }
  } catch (error) {
    console.error("Could not restore CampusCare session:", error);
    document.getElementById("loginScreen").classList.remove("hidden");
  }
})();

document.getElementById("themeToggle")?.addEventListener("click", () => {
  document.body.classList.toggle("dark-theme");
  const dark = document.body.classList.contains("dark-theme");
  document.getElementById("themeToggle").textContent = dark ? "☀️ Light mode" : "🌙 Dark mode";
  localStorage.setItem("campuscare_theme", dark ? "dark" : "light");
});
if (localStorage.getItem("campuscare_theme") === "dark") {
  document.body.classList.add("dark-theme");
  document.getElementById("themeToggle").textContent = "☀️ Light mode";
}
setInterval(() => { if (activeAccount) renderAll(); }, 15000); // refresh only during an authenticated session
