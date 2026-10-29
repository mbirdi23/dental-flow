// Shared helpers used by every screen.

let THRESHOLDS = { yellowSeconds: 300, redSeconds: 600 };

async function loadThresholds() {
  try {
    const cfg = await getJSON('/api/config');
    THRESHOLDS = { yellowSeconds: cfg.yellowSeconds, redSeconds: cfg.redSeconds };
  } catch (e) {
    // keep the defaults
  }
}

function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function waitLevel(seconds) {
  if (seconds >= THRESHOLDS.redSeconds) return 'red';
  if (seconds >= THRESHOLDS.yellowSeconds) return 'amber';
  return 'green';
}

const WAITING_FOR_LABEL = {
  assistant: 'Assistant / Hygienist',
  hygienist: 'Hygienist',
  doctor: 'Doctor',
  treatment_coordinator: 'Treatment Coordinator',
  checkout: 'Checkout (retired)',
};

const OPERATORIES = ['OP1', 'OP2', 'OP3', 'OP4', 'OP5', 'OP6'];

// waiting_checkout / with_checkout stay here (display-only) purely so old
// completed visits still render correctly in the Activity Log / Analytics
// — they're no longer reachable going forward. See STATUS_OPTIONS below
// for what the edit dropdown actually offers.
const STATUS_LABEL = {
  arrived: 'Checked In',
  doing_paperwork: 'Doing Paperwork',
  waiting_assistant: 'Waiting Room',
  with_assistant: 'Pulled Back',
  waiting_hygiene: 'Waiting for Hygienist',
  with_hygiene: 'With Hygienist',
  waiting_doctor: 'Waiting for Doctor',
  with_doctor: 'With Doctor',
  waiting_tc: 'Waiting for Treatment Coordinator',
  with_tc: 'With Treatment Coordinator',
  waiting_checkout: 'Waiting for Checkout (retired)',
  with_checkout: 'With Checkout (retired)',
  completed: 'Completed',
  cancelled: 'Cancelled / No-Show',
  auto_closed: 'Auto-Closed',
};

// The manual-edit status dropdown only ever offers these — the retired
// checkout statuses are deliberately excluded so staff can't manually set
// a visit to a stage that no longer exists in the live flow.
const ALL_STATUSES = [
  'arrived', 'doing_paperwork', 'waiting_assistant', 'with_assistant',
  'waiting_hygiene', 'with_hygiene', 'waiting_doctor', 'with_doctor',
  'waiting_tc', 'with_tc', 'completed', 'cancelled',
];

const ACTION_LABEL = {
  start_paperwork: 'Checked In',
  ready_for_assistant: 'Paperwork Complete',
  assign_operatory: 'Assigned Operatory',
  waiting_hygiene: 'Waiting for Hygienist',
  with_hygiene: 'With Hygienist',
  waiting_doctor: 'Waiting for Doctor',
  with_doctor: 'With Doctor',
  waiting_tc: 'Waiting for Treatment Coordinator',
  with_tc: 'With Treatment Coordinator',
  waiting_checkout: 'Ready for Checkout (retired)',
  with_checkout: 'With Checkout (retired)',
  complete: 'Completed Visit',
  manual_edit: 'Manual Edit',
  cancel_visit: 'Cancelled / No-Show',
  toggle_flag: 'Treatment Flag Changed',
  skip_hygiene: 'Skipped Hygiene',
  skip_doctor: 'Skipped Doctor',
  skip_tc: 'Skipped TC (Completed)',
  auto_close: 'Auto-Closed',
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Connects to the SSE stream and calls onChange() whenever anything in the
// system changes. Falls back to a 5s poll if the stream drops.
// Listens for "something changed" pushes from the server. Each push clears
// the local cache so the next render fetches fresh data; between pushes,
// timers tick locally (see getJSON) instead of asking the server every
// second. If the live connection drops, falls back to checking every 30s.
function connectRealtime(onChange) {
  let pollTimer = null;
  const changed = () => { invalidateCache(); onChange(); };
  function startPolling() { if (!pollTimer) pollTimer = setInterval(changed, 30000); }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  function connect() {
    const es = new EventSource('/api/stream');
    es.addEventListener('visits-changed', changed);
    es.onopen = stopPolling;
    es.onerror = () => {
      startPolling();
      es.close();
      setTimeout(connect, 5000);
    };
  }
  connect();
  onChange();
}

function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  if (await handleAuthFailure(res)) throw new Error('Please sign in again');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  invalidateCache();
  return data;
}

// --- Station login (per-device, not per-person; no password) ---------------

const STATION_KEY = 'dental_flow_station';

function getStation() {
  return localStorage.getItem(STATION_KEY);
}

function setStation(name) {
  localStorage.setItem(STATION_KEY, name);
}

// "Switch" — changes which station this screen is, without signing out.
function logout() {
  localStorage.removeItem(STATION_KEY);
  window.location.href = '/station';
}

function isOpStation(station) {
  return /^OP\d+$/.test(station || '');
}

// OP-station logins only ever see their own room (never the six-room
// board), so every page's "Operatories" nav link becomes "My Room" and
// points at /my-room instead. Runs automatically via initTopbar().
function applyStationNav(station) {
  if (!isOpStation(station)) return;
  document.querySelectorAll('.topbar nav a[href="/operatory"]').forEach((a) => {
    a.href = '/my-room';
    a.textContent = 'My Room';
  });
}

// Call at the very top of the Operatories board page (before anything
// else runs): an OP-station login has no way to see other rooms, even by
// typing the URL directly, so it's redirected to its own room instead.
// Returns true if a redirect happened, so the caller can stop early.
function redirectOpStationAwayFromBoard() {
  // OP stations land on their own room by default. A room someone clicked on
  // purpose (a room card on the Front Desk, which adds ?room=OP3) opens that
  // room instead of bouncing back.
  const pickedRoom = new URLSearchParams(window.location.search).get('room');
  if (isOpStation(getStation()) && !OPERATORIES.includes(pickedRoom)) {
    window.location.replace('/my-room');
    return true;
  }
  return false;
}

// Call at the top of every protected page. Redirects to /login if this
// device hasn't picked a station yet.
function requireStation() {
  const s = getStation();
  if (!s) {
    window.location.href = '/station';
    return null;
  }
  return s;
}

// Fills in the station name + Switch button, and starts a lightweight poll
// that keeps the red "Waiting Room" badge accurate on every page, even ones
// that don't otherwise fetch the full active-visits list.
// Fills in who's signed in, the station, and the Switch / Hide Names /
// Log Out buttons; adds the Admin link for admins; starts activity tracking
// (automatic logoff) and keeps the red Waiting Room badge current.
async function initTopbar() {
  const station = requireStation();
  if (!station) return;

  document.querySelectorAll('.station-pill').forEach((el) => {
    el.innerHTML = `
      <strong id="userDisplayName"></strong>
      <span style="opacity:0.55">·</span>
      <button id="stationName" type="button" title="Change which screen this is"></button>
      <button id="hideNamesBtn" class="names-only" type="button" title="Show only first initials on this screen"></button>
      <button id="fullLogout" type="button">Log Out</button>
    `;
  });
  const stationEl = document.getElementById('stationName');
  if (stationEl) {
    stationEl.textContent = `${station} \u25BE`;
    stationEl.addEventListener('click', logout); // goes to the station picker without signing out
  }
  const switchBtn = document.getElementById('stationLogout');
  if (switchBtn) switchBtn.addEventListener('click', logout);
  const logoutBtn = document.getElementById('fullLogout');
  if (logoutBtn) logoutBtn.addEventListener('click', fullLogout);
  const hideBtn = document.getElementById('hideNamesBtn');
  if (hideBtn) {
    const label = () => { hideBtn.textContent = namesHidden() ? 'Show Names' : 'Hide Names'; };
    label();
    hideBtn.addEventListener('click', () => {
      try { localStorage.setItem(HIDE_NAMES_KEY, namesHidden() ? '0' : '1'); } catch (e) {}
      label();
      if (typeof window.__refreshCurrentPage === 'function') window.__refreshCurrentPage();
    });
  }

  applyStationNav(station);
  setupActivityTracking();
  setInterval(() => { getJSON('/api/visits/active').then(updateWaitingBadge).catch(() => {}); }, 5000);

  try {
    const me = await getJSON('/api/me');
    const nameEl = document.getElementById('userDisplayName');
    if (nameEl) nameEl.textContent = me.displayName;
    if (me.isAdmin) {
      document.querySelectorAll('.topbar nav').forEach((nav) => {
        if (nav.querySelector('a[href="/admin"]')) return;
        const a = document.createElement('a');
        a.href = '/admin';
        a.textContent = 'Admin';
        if (window.location.pathname === '/admin') a.className = 'active';
        nav.appendChild(a);
      });
    }
  } catch (e) {
    // not fatal
  }
}

function updateWaitingBadge(visits) {
  const badge = document.getElementById('waitingBadge');
  if (!badge) return;
  const count = visits.filter((v) => v.status === 'waiting_assistant').length;
  if (count > 0) {
    badge.style.display = 'flex';
    badge.querySelector('.count').textContent = count;
    badge.querySelector('.label').textContent = count === 1 ? 'Patient in Waiting Room' : 'Patients in Waiting Room';
  } else {
    badge.style.display = 'none';
  }
}

// --- Edit modal: fix a fat-fingered patient ID, jump the status, or
// reassign the operatory. Available from every screen via a small pencil
// button (see editButtonHtml). ---------------------------------------------

function editButtonHtml(visitId) {
  return `<button class="edit-btn" title="Edit patient ID or status" onclick="editVisit(${visitId})">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
  </button>`;
}

// Only the numeric visit id goes into the click handler. Putting patient
// text there would let a crafted Patient ID run code (HTML-escaping isn't
// enough inside an onclick attribute).
function cancelButtonHtml(visitId) {
  return `<button class="cancel-link" title="Cancel visit / mark no-show" onclick="cancelVisit(${Number(visitId)})">Cancel / No-show</button>`;
}

// --- Treatment flag: staff mark a visit when it turns into same-day
// treatment (not just a routine checkup), so everyone expects a longer
// chair time. Purely visual/informational — it never changes the
// green/yellow/red wait thresholds, on purpose (per practice preference:
// a flagged patient waiting a long time is still worth knowing about). ---

function treatmentBadgeHtml(flag) {
  if (!flag) return '';
  return `<span class="pill pill-flag" title="Flagged for treatment — expect a longer visit">⏳ Extended Visit</span>`;
}

function flagButtonHtml(visitId, flag) {
  const label = flag ? 'Remove Treatment Flag' : 'Flag for Treatment';
  return `<button class="flag-link ${flag ? 'flag-link-active' : ''}" title="${flag ? 'Remove the extended-visit flag' : 'Mark this visit as turning into same-day treatment'}" onclick="toggleTreatmentFlag(${visitId}, ${flag ? 'true' : 'false'})">${flag ? '⏳ Flagged — tap to clear' : '⏳ Flag for Treatment'}</button>`;
}

async function toggleTreatmentFlag(visitId, currentFlag) {
  try {
    await postJSON(`/api/visits/${visitId}/override`, { treatmentFlag: !currentFlag, role: getStation() });
    toast(currentFlag ? 'Flag removed' : 'Flagged for treatment');
    if (typeof window.__refreshCurrentPage === 'function') window.__refreshCurrentPage();
  } catch (e) {
    toast(e.message);
  }
}

async function cancelVisit(visitId) {
  let label = 'this visit';
  try {
    const visits = await getJSON('/api/visits/active');
    const v = visits.find((x) => x.id === visitId);
    if (v) label = v.firstName || (v.patientId ? `Patient ${v.patientId}` : `Visit ${v.id}`);
  } catch (e) { /* fall back to the generic wording */ }
  if (!window.confirm(`Cancel ${label}? This stops their timer and removes them from all active screens.`)) return;
  try {
    await postJSON(`/api/visits/${visitId}/override`, { status: 'cancelled', role: getStation() });
    toast('Visit cancelled');
    if (typeof window.__refreshCurrentPage === 'function') window.__refreshCurrentPage();
  } catch (e) {
    toast(e.message);
  }
}

async function editVisit(visitId) {
  try {
    const visits = await getJSON('/api/visits/active');
    const visit = visits.find((v) => v.id === visitId);
    if (!visit) { toast("Can't edit — visit is no longer active"); return; }
    openEditModal(visit);
  } catch (e) {
    toast('Could not load visit');
  }
}

function openEditModal(visit) {
  closeEditModal();
  const overlay = document.createElement('div');
  overlay.id = 'editModalOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <h2>Edit Visit</h2>
      <div class="names-only">
        <label>First Name</label>
        <input type="text" id="editFirstName" value="${escapeHtml(visit.firstName || '')}" maxlength="40" autocomplete="off" style="margin-bottom:14px" />
      </div>
      <label>Patient ID</label>
      <input type="text" id="editPatientId" value="${escapeHtml(visit.patientId)}" maxlength="40" />
      <label>Status</label>
      <select id="editStatus">
        ${ALL_STATUSES.map((s) => `<option value="${s}" ${s === visit.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
      </select>
      <label>Operatory</label>
      <select id="editOperatory">
        <option value="">— None —</option>
        ${OPERATORIES.map((op) => `<option value="${op}" ${op === visit.operatory ? 'selected' : ''}>${op}</option>`).join('')}
      </select>
      <label class="checkbox-row">
        <input type="checkbox" id="editTreatmentFlag" ${visit.treatmentFlag ? 'checked' : ''} />
        <span>⏳ Turned into same-day treatment (expect a longer visit)</span>
      </label>
      <div id="editError" class="edit-error"></div>
      <p class="edit-hint">Changing status closes any timer currently running and starts a new one if the corrected status is a waiting state. Logged to the Activity Log.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="editCancelBtn">Cancel</button>
        <button class="btn btn-primary" id="editSaveBtn">Save</button>
      </div>
    </div>
  `;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeEditModal(); });
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-box').addEventListener('mousedown', (e) => e.stopPropagation());
  document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
  document.getElementById('editSaveBtn').addEventListener('click', () => saveEditModal(visit.id));
}

function closeEditModal() {
  const el = document.getElementById('editModalOverlay');
  if (el) el.remove();
}

async function saveEditModal(visitId) {
  const firstName = document.getElementById('editFirstName').value;
  const patientId = document.getElementById('editPatientId').value;
  const status = document.getElementById('editStatus').value;
  const operatory = document.getElementById('editOperatory').value;
  const treatmentFlag = document.getElementById('editTreatmentFlag').checked;
  try {
    await postJSON(`/api/visits/${visitId}/override`, { firstName, patientId, status, operatory: operatory || null, treatmentFlag, role: getStation() });
    closeEditModal();
    toast('Visit updated');
    if (typeof window.__refreshCurrentPage === 'function') window.__refreshCurrentPage();
  } catch (e) {
    document.getElementById('editError').textContent = e.message;
  }
}


// ---------------------------------------------------------------------------
// Sign-in, automatic logoff, caching and patient-name display
// ---------------------------------------------------------------------------

function stationHome(s) {
  if (s === 'Upfront') return '/';
  if (/^OP\d+$/.test(s)) return '/my-room';
  if (s === 'TC Room') return '/tc-queue';
  if (s === 'Lab') return '/dashboard';
  if (s === 'Back Office') return '/analytics';
  return '/';
}

async function fullLogout() {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
  // Logging out also clears the station, so the next sign-in picks a screen.
  try { localStorage.removeItem(STATION_KEY); } catch (e) {}
  window.location.href = '/login';
}

let _authRedirecting = false;
// Sends the browser to the sign-in page (or password page) when the server
// says the session is gone. Returns true if it handled the response.
async function handleAuthFailure(res) {
  if (res.status !== 401 && res.status !== 403) return false;
  const data = await res.clone().json().catch(() => ({}));
  if (res.status === 401) {
    if (!_authRedirecting) {
      _authRedirecting = true;
      window.location.href = `/login?reason=${encodeURIComponent(data.reason || 'signed-out')}`;
    }
    return true;
  }
  if (data.code === 'PASSWORD_CHANGE_REQUIRED') {
    if (!_authRedirecting) {
      _authRedirecting = true;
      window.location.href = '/change-password';
    }
    return true;
  }
  return false;
}

// Short-lived cache so screens don't ask the server for the same list every
// second. Between fetches, wait timers keep counting up locally. The cache
// is cleared whenever the server pushes a change or this screen makes one.
const CACHE_MAX_AGE_MS = 30000;
const _cache = new Map();
const _inflight = new Map();

function invalidateCache() {
  _cache.clear();
}

function ageVisitList(data, elapsedSec) {
  if (!Array.isArray(data) || elapsedSec <= 0) return data;
  return data.map((v) => (v && v.waitingFor && typeof v.currentWaitSeconds === 'number')
    ? { ...v, currentWaitSeconds: v.currentWaitSeconds + elapsedSec, totalIdleSeconds: v.totalIdleSeconds + elapsedSec }
    : v);
}

async function getJSON(url) {
  const now = Date.now();
  const cached = _cache.get(url);
  if (cached && now - cached.at < CACHE_MAX_AGE_MS) {
    return ageVisitList(cached.data, Math.floor((now - cached.at) / 1000));
  }
  if (_inflight.has(url)) return _inflight.get(url);
  const pending = (async () => {
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (await handleAuthFailure(res)) throw new Error('Please sign in again');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      _cache.set(url, { at: Date.now(), data });
      return data;
    } finally {
      _inflight.delete(url);
    }
  })();
  _inflight.set(url, pending);
  return pending;
}

// Automatic logoff: real use of the screen (click, key, touch, mouse)
// tells the server someone is here, at most once a minute. A screen nobody
// touches is signed out after the idle limit set on the server.
let _lastHeartbeat = 0;
function setupActivityTracking() {
  const ping = () => {
    const now = Date.now();
    if (now - _lastHeartbeat < 60000) return;
    _lastHeartbeat = now;
    fetch('/api/heartbeat', { method: 'POST', credentials: 'same-origin' })
      .then((res) => handleAuthFailure(res))
      .catch(() => {});
  };
  ['click', 'keydown', 'touchstart', 'mousemove', 'scroll'].forEach((evt) => {
    window.addEventListener(evt, ping, { passive: true });
  });
  ping();
}

const HIDE_NAMES_KEY = 'dental_flow_hide_names';
function namesHidden() {
  try { return localStorage.getItem(HIDE_NAMES_KEY) === '1'; } catch (e) { return false; }
}

// "Sarah #8472", "S. #8472" with names hidden, or "Patient 8472" if no
// first name was entered.
function patientLabel(v) {
  if (!v.firstName) return v.patientId ? `Patient ${escapeHtml(v.patientId)}` : `Visit ${v.id}`;
  const name = namesHidden() ? `${String(v.firstName).charAt(0)}.` : String(v.firstName);
  return `${escapeHtml(name)}${v.patientId ? ` <span class="pid">#${escapeHtml(v.patientId)}</span>` : ''}`;
}

function showTestBanner() {
  if (document.getElementById('testBanner')) return;
  const el = document.createElement('div');
  el.id = 'testBanner';
  el.className = 'test-banner';
  el.textContent = 'Test mode — this server is not yet set up for real patient information. Use made-up names only.';
  document.body.insertBefore(el, document.body.firstChild);
}


// ---------------------------------------------------------------------------
// Room view and room turnover (cleaning)
// ---------------------------------------------------------------------------

function cleaningFor(rooms, op) {
  return (rooms || []).find((r) => r.operatory === op) || null;
}

function cleaningBannerHtml(op, room) {
  if (!room || !OPERATORIES.includes(op)) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(room.cleaningSince).getTime()) / 60000));
  return `<div class="cleaning-banner">
    <span>🧽 Being broken down, ${mins < 1 ? 'just started' : mins + ' min'}</span>
    <button class="btn btn-secondary" onclick="markRoomReady('${op}')">Room ready</button>
  </div>`;
}

async function markRoomReady(op) {
  if (!OPERATORIES.includes(op)) return;
  try {
    await postJSON(`/api/rooms/${encodeURIComponent(op)}/ready`, { role: getStation() });
    toast(`${op} is ready`);
    if (typeof window.__refreshCurrentPage === 'function') window.__refreshCurrentPage();
  } catch (e) {
    toast(e.message);
  }
}

function roomPatientHtml(visit, big) {
  const isWaiting = !!visit.waitingFor;
  const level = isWaiting ? waitLevel(visit.currentWaitSeconds) : 'green';
  const next = visit.fullNextAction;
  const skip = visit.skipAction;
  const skipBtn = skip ? `<button class="btn btn-secondary skip-btn" onclick="roomAct(${visit.id}, '${skip.action}')">${skip.label}</button>` : '';
  const size = big ? 'timer-lg' : 'timer-md';
  return `
    <div class="panel" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="font-size:${big ? 28 : 20}px;font-weight:700">${patientLabel(visit)}</div>
          ${editButtonHtml(visit.id)}
        </div>
        <span class="pill ${isWaiting ? 'pill-' + level : 'pill-neutral'}">${escapeHtml(STATUS_LABEL[visit.status] || visit.status)}</span>
      </div>
      ${visit.treatmentFlag ? `<div style="margin-top:10px">${treatmentBadgeHtml(true)}</div>` : ''}
      <div style="display:flex;gap:40px;margin:20px 0 ${big ? 0 : 16}px;flex-wrap:wrap">
        <div>
          <div style="color:var(--ink-soft);font-size:13px;margin-bottom:6px">${isWaiting ? 'Current Wait' : 'Currently With Staff'}</div>
          <div class="timer ${size} timer-${level}">${isWaiting ? fmtDuration(visit.currentWaitSeconds) : '—'}</div>
        </div>
        <div>
          <div style="color:var(--ink-soft);font-size:13px;margin-bottom:6px">Total Idle Time This Visit</div>
          <div class="timer ${size}" style="color:var(--ink)">${fmtDuration(visit.totalIdleSeconds)}</div>
        </div>
      </div>
      ${big ? '' : (next ? `<button class="btn btn-primary" style="width:100%;padding:14px" onclick="roomAct(${visit.id}, '${next.action}')">${next.label}</button>` : '')}${big ? '' : skipBtn}
    </div>
    ${big ? `<div class="panel" style="margin-bottom:16px">
      ${next ? `<button class="btn btn-primary btn-huge" onclick="roomAct(${visit.id}, '${next.action}')">${next.label}</button>` : '<div class="empty-state">Waiting for the front desk.</div>'}
      ${skipBtn}
      <div style="text-align:center;margin-top:14px;display:flex;justify-content:center;gap:10px;flex-wrap:wrap">
        ${flagButtonHtml(visit.id, visit.treatmentFlag)}
        ${cancelButtonHtml(visit.id)}
      </div>
    </div>` : ''}
  `;
}

// One operatory: cleaning reminder, the patient in the chair, and any earlier
// patient from this room who is now with the treatment coordinator.
function renderRoomView(el, op, visits, rooms) {
  const here = visits.filter((v) => v.operatory === op);
  const current = here.find((v) => v.inRoom);
  const earlier = here.filter((v) => !v.inRoom);
  const room = cleaningFor(rooms, op);
  let html = cleaningBannerHtml(op, room);
  html += current
    ? roomPatientHtml(current, true)
    : `<div class="panel empty-state" style="padding:40px 20px;margin-bottom:16px">No patient in ${escapeHtml(op)} right now.${room ? '' : ' The front desk assigns rooms from the waiting room.'}</div>`;
  for (const v of earlier) {
    html += `<h2 style="margin:24px 0 10px;font-size:16px">Earlier patient from ${escapeHtml(op)}, now with the treatment coordinator</h2>${roomPatientHtml(v, false)}`;
  }
  el.innerHTML = html;
}

async function roomAct(visitId, action) {
  try {
    await postJSON(`/api/visits/${Number(visitId)}/transition`, { action, role: getStation() });
    if (typeof window.__refreshCurrentPage === 'function') window.__refreshCurrentPage();
  } catch (e) {
    toast(e.message);
  }
}


// Live Dashboard: every room currently being broken down, with its own
// "Room ready" button.
function brokenDownStripHtml(rooms) {
  const list = (rooms || []).filter((r) => OPERATORIES.includes(r.operatory)).sort((a, b) => a.operatory.localeCompare(b.operatory));
  if (!list.length) return '';
  return `<div class="panel" style="margin-bottom:16px">
    <h2 style="margin:0 0 10px;font-size:16px">🧽 Rooms being broken down</h2>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${list.map((r) => {
        const op = r.operatory;
        const mins = Math.max(0, Math.floor((Date.now() - new Date(r.cleaningSince).getTime()) / 60000));
        return `<div class="cleaning-banner" style="margin:0;flex:1 1 240px"><span>${op}, ${mins < 1 ? 'just started' : mins + ' min'}</span><button class="btn btn-secondary" onclick="markRoomReady('${op}')">Room ready</button></div>`;
      }).join('')}
    </div>
  </div>`;
}
