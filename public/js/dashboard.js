// === Full updated dashboard.js with fixed data loading ===

function formatDuration(start, end) {
  if (!start) return '';
  const startDate = new Date(start.replace(' ', 'T'));
  const endDate = end ? new Date(end.replace(' ', 'T')) : new Date();
  const diffMs = endDate - startDate;
  if (diffMs < 0) return '';
  const h = Math.floor(diffMs / (1000 * 60 * 60));
  const m = Math.floor((diffMs / (1000 * 60)) % 60);
  return `${h}h ${m}m`;
}

function getSessions(entries) {
  const bySession = {};
  for (const e of entries) {
    if (!bySession[e.session_id]) bySession[e.session_id] = {};
    bySession[e.session_id][e.action] = e;
  }
  const sessions = [];
  for (const [session_id, pair] of Object.entries(bySession)) {
    const inEntry = pair.in;
    const outEntry = pair.out;
    const clockInStr = inEntry?.datetime_local || '';
    const clockOutStr = outEntry?.datetime_local || '';
    const durationMs = inEntry && outEntry ? (new Date(clockOutStr.replace(' ', 'T')) - new Date(clockInStr.replace(' ', 'T'))) : 0;
    const durationHr = durationMs / 3600000;
    const durationStr = inEntry && outEntry ? formatDuration(clockInStr, clockOutStr) : '';

    const regularHours = inEntry && outEntry ? Math.min(8, durationHr) : 0;
    const overtimeHours = inEntry && outEntry ? Math.max(0, durationHr - 8) : 0;
    const payRate = parseFloat(inEntry?.pay_rate || outEntry?.pay_rate || 0);
    const totalPay = (regularHours * payRate + overtimeHours * payRate * 1.5).toFixed(2);

    sessions.push({
      session_id,
      worker_id: inEntry?.worker_id || outEntry?.worker_id,
      worker_name: inEntry?.worker_name || outEntry?.worker_name,
      project_id: inEntry?.project_id || outEntry?.project_id,
      project_name: inEntry?.project_name || outEntry?.project_name,
      clock_in: clockInStr,
      clock_out: clockOutStr,
      duration: durationStr,
      regular_hours: regularHours,
      overtime_hours: overtimeHours,
      total_pay: totalPay,
      note_in: inEntry?.note || '',
      note_out: outEntry?.note || '',
      pay_rate: payRate,
      id_in: inEntry?.id,
      id_out: outEntry?.id
    });
  }
  return sessions;
}

function isOvertimeSession(session) {
  return session.overtime_hours > 0;
}

function renderSessions() {
  const tbody = document.querySelector('#sessionTable tbody');
  let filtered = allSessions.filter(s => {
    if (filterWorker && s.worker_name !== filterWorker) return false;
    if (filterProject && s.project_name !== filterProject) return false;
    if (filterStartDate && (!s.clock_in || s.clock_in < filterStartDate)) return false;
    if (filterEndDate && (!s.clock_in || s.clock_in > filterEndDate + " 23:59")) return false;
    return true;
  });
  if (currentTab === 'open') filtered = filtered.filter(s => !s.clock_out);
  else if (currentTab === 'closed') filtered = filtered.filter(s => !!s.clock_out);

  tbody.innerHTML = filtered.map(s => {
    const overtime = highlightOvertime && isOvertimeSession(s);
    return `
      <tr${overtime ? ' class="overtime"' : ''}>
        <td>${s.worker_name || ''}</td>
        <td><span class="editable" data-type="project" data-session="${s.session_id}" contenteditable>${s.project_name || ''}</span></td>
        <td><span class="editable" data-type="clock_in" data-session="${s.session_id}" contenteditable>${s.clock_in || ''}</span></td>
        <td><span class="editable" data-type="clock_out" data-session="${s.session_id}" contenteditable>${s.clock_out || ''}</span></td>
        <td>${s.duration || ''} (${s.regular_hours}h RT / ${s.overtime_hours}h OT)</td>
        <td><span class="editable" data-type="note_in" data-session="${s.session_id}" contenteditable>${s.note_in || ''}</span></td>
        <td><span class="editable" data-type="note_out" data-session="${s.session_id}" contenteditable>${s.note_out || ''}</span></td>
        <td>${s.pay_rate ? `$${s.pay_rate.toFixed(2)}` : ''} ($${s.total_pay})</td>
        <td>${!s.clock_out ? `<button onclick="forceClockOut('${s.session_id}')">Force Clock-Out</button>` : ''}</td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.editable').forEach(span => {
    span.onblur = handleInlineEdit;
  });
}

async function loadData() {
  try {
    const res = await fetch('/api/clock-entries');
    const data = await res.json();
    allEntries = data;
    allSessions = getSessions(allEntries);
    populateFilters();
    renderSessions();
  } catch (err) {
    console.error("loadData failed:", err);
  }
}

function populateFilters() {
  const workerSel = document.getElementById('filterWorker');
  const projectSel = document.getElementById('filterProject');
  const workers = getUnique(allEntries, 'worker_name');
  const projects = getUnique(allEntries, 'project_name');
  workerSel.innerHTML = '<option value="">All</option>' + workers.map(w => `<option>${w}</option>`).join('');
  projectSel.innerHTML = '<option value="">All</option>' + projects.map(p => `<option>${p}</option>`).join('');
}

function getUnique(entries, field) {
  return Array.from(new Set(entries.map(e => e[field]))).filter(Boolean);
}

// Event bindings
const otCheckbox = document.getElementById('highlightOvertime');
otCheckbox.addEventListener('change', e => {
  highlightOvertime = e.target.checked;
  renderSessions();
});

document.getElementById('filterWorker').addEventListener('change', e => {
  filterWorker = e.target.value;
  renderSessions();
});

document.getElementById('filterProject').addEventListener('change', e => {
  filterProject = e.target.value;
  renderSessions();
});

document.getElementById('filterStartDate').addEventListener('change', e => {
  filterStartDate = e.target.value;
  renderSessions();
});

document.getElementById('filterEndDate').addEventListener('change', e => {
  filterEndDate = e.target.value;
  renderSessions();
});

document.getElementById('tabOpen').addEventListener('click', () => {
  currentTab = 'open';
  updateTabs();
  renderSessions();
});

document.getElementById('tabClosed').addEventListener('click', () => {
  currentTab = 'closed';
  updateTabs();
  renderSessions();
});

document.getElementById('tabAll').addEventListener('click', () => {
  currentTab = 'all';
  updateTabs();
  renderSessions();
});

function updateTabs() {
  document.getElementById('tabOpen').classList.toggle('selected', currentTab === 'open');
  document.getElementById('tabClosed').classList.toggle('selected', currentTab === 'closed');
  document.getElementById('tabAll').classList.toggle('selected', currentTab === 'all');
}

async function handleInlineEdit(e) {
  const span = e.target;
  const newValue = span.innerText.trim();
  const type = span.getAttribute('data-type');
  const sessionId = span.getAttribute('data-session');
  const session = allSessions.find(s => s.session_id === sessionId);
  if (!session) return;

  if (type === 'project') {
    if (session.id_in) await patchEntry(session.id_in, { project_name: newValue });
    if (session.id_out) await patchEntry(session.id_out, { project_name: newValue });
  } else if (type === 'clock_in' && session.id_in) {
    await patchEntry(session.id_in, { datetime_local: newValue });
  } else if (type === 'clock_out' && session.id_out) {
    await patchEntry(session.id_out, { datetime_local: newValue });
  } else if (type === 'note_in' && session.id_in) {
    await patchEntry(session.id_in, { note: newValue });
  } else if (type === 'note_out' && session.id_out) {
    await patchEntry(session.id_out, { note: newValue });
  }
  await loadData();
}

async function patchEntry(id, body) {
  await fetch(`/api/clock-entries/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function forceClockOut(session_id) {
  if (!confirm("Force clock out now?")) return;
  const res = await fetch(`/api/clock-entries/${session_id}/force-clock-out`, { method: 'POST' });
  if (res.ok) await loadData();
  else alert("Failed to force clock out");
}
//window.forceClockOut = forceClockOut;
//async function forceClockOut(id_in) {
//  if (!confirm("Force clock out now?")) return;
//  const res = await fetch(`/api/clock-entries/${id_in}/force-clock-out`, { method: 'POST' });
//  if (res.ok) await loadData();
//  else alert("Failed to force clock out");
//}
//window.forceClockOut = forceClockOut;

// Globals
let allEntries = [];
let allSessions = [];
let filterWorker = '';
let filterProject = '';
let filterStartDate = '';
let filterEndDate = '';
let currentTab = 'open';
let highlightOvertime = false;

// Initial load
loadData();
