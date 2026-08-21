// Shared helpers used by every screen.

let THRESHOLDS = { yellowSeconds: 300, redSeconds: 600 };

async function loadThresholds() {
  try {
    const res = await fetch('/api/config');
    THRESHOLDS = await res.json();
  } catch (e) {
    // fall back to defaults already set above
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
  checkout: 'Checkout',
};

const OPERATORIES = ['OP1', 'OP2', 'OP3', 'OP4', 'OP5', 'OP6'];

const STATUS_LABEL = {
  arrived: 'Checked In',
  waiting_assistant: 'Waiting Room',
  with_assistant: 'Pulled Back',
  waiting_hygiene: 'Waiting for Hygienist',
  with_hygiene: 'With Hygienist',
  waiting_doctor: 'Waiting for Doctor',
  with_doctor: 'With Doctor',
  waiting_tc: 'Waiting for Treatment Coordinator',
  with_tc: 'With Treatment Coordinator',
  waiting_checkout: 'Waiting for Checkout',
  with_checkout: 'With Checkout',
  completed: 'Completed',
  cancelled: 'Cancelled / No-Show',
};

const ALL_STATUSES = Object.keys(STATUS_LABEL).filter((s) => s !== 'completed' && s !== 'cancelled').concat(['completed', 'cancelled']);

const ACTION_LABEL = {
  ready_for_assistant: 'Checked In',
  assign_operatory: 'Assigned Operatory',
  waiting_hygiene: 'Waiting for Hygienist',
  with_hygiene: 'With Hygienist',
  waiting_doctor: 'Waiting for Doctor',
  with_doctor: 'With Doctor',
  waiting_tc: 'Waiting for Treatment Coordinator',
  with_tc: 'With Treatment Coordinator',
  waiting_checkout: 'Ready for Checkout',
  with_checkout: 'With Checkout',
  complete: 'Completed Visit',
  manual_edit: 'Manual Edit',
  cancel_visit: 'Cancelled / No-Show',
  toggle_flag: 'Treatment Flag Changed',
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Connects to the SSE stream and calls onChange() whenever anything in the
// system changes. Falls back to a 5s poll if the stream drops.
function connectRealtime(onChange) {
  let es;
  let pollTimer;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(onChange, 5000);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function connect() {
    es = new EventSource('/api/stream');
    es.addEventListener('visits-changed', () => onChange());
    es.onopen = stopPolling;
    es.onerror = () => {
      startPolling();
      es.close();
      setTimeout(connect, 3000);
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
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
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

function logout() {
  localStorage.removeItem(STATION_KEY);
  window.location.href = '/login';
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
  if (isOpStation(getStation())) {
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
    window.location.href = '/login';
    return null;
  }
  return s;
}

// Fills in the station name + Switch button, and starts a lightweight poll
// that keeps the red "Waiting Room" badge accurate on every page, even ones
// that don't otherwise fetch the full active-visits list.
function initTopbar() {
  const station = requireStation();
  if (!station) return;
  const nameEl = document.getElementById('stationName');
  if (nameEl) nameEl.textContent = station;
  const logoutBtn = document.getElementById('stationLogout');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
  applyStationNav(station);

  async function pollWaitingRoom() {
    try {
      const res = await fetch('/api/visits/active');
      const visits = await res.json();
      updateWaitingBadge(visits);
    } catch (e) {
      // ignore transient errors
    }
  }
  pollWaitingRoom();
  setInterval(pollWaitingRoom, 5000);
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

function cancelButtonHtml(visitId, patientLabel) {
  return `<button class="cancel-link" title="Cancel visit / mark no-show" onclick="cancelVisit(${visitId}, '${escapeHtml(patientLabel || '')}')">Cancel / No-show</button>`;
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

async function cancelVisit(visitId, patientLabel) {
  const label = patientLabel ? `Patient ${patientLabel}` : 'this visit';
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
    const res = await fetch('/api/visits/active');
    const visits = await res.json();
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
  const patientId = document.getElementById('editPatientId').value;
  const status = document.getElementById('editStatus').value;
  const operatory = document.getElementById('editOperatory').value;
  const treatmentFlag = document.getElementById('editTreatmentFlag').checked;
  try {
    await postJSON(`/api/visits/${visitId}/override`, { patientId, status, operatory: operatory || null, treatmentFlag, role: getStation() });
    closeEditModal();
    toast('Visit updated');
    if (typeof window.__refreshCurrentPage === 'function') window.__refreshCurrentPage();
  } catch (e) {
    document.getElementById('editError').textContent = e.message;
  }
}
