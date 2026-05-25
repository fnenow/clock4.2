// === dashboard.js ===
// Dashboard calculation rule:
// For each worker per day, first 8 total working hours are regular time.
// Hours after 8 are overtime.
// If one session crosses the 8-hour point, that session is split into RT and OT.

function parseLocalDateTime(value) {
  if (!value) return null;

  // Accept both "YYYY-MM-DD HH:MM" and "YYYY-MM-DDTHH:MM"
  const cleanValue = String(value).trim().replace(' ', 'T');
  const date = new Date(cleanValue);

  if (isNaN(date.getTime())) return null;
  return date;
}

function getDatePart(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function formatDuration(start, end) {
  const startDate = parseLocalDateTime(start);
  const endDate = end ? parseLocalDateTime(end) : new Date();

  if (!startDate || !endDate) return '';

  const diffMs = endDate - startDate;
  if (diffMs < 0) return '';

  const h = Math.floor(diffMs / (1000 * 60 * 60));
  const m = Math.floor((diffMs / (1000 * 60)) % 60);

  return `${h}h ${m}m`;
}

function getDurationHours(start, end) {
  const startDate = parseLocalDateTime(start);
  const endDate = end ? parseLocalDateTime(end) : null;

  if (!startDate || !endDate) return 0;

  const diffMs = endDate - startDate;
  if (diffMs < 0) return 0;

  return diffMs / (1000 * 60 * 60);
}

function formatHourNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';

  return n
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/(\.\d)0$/, '$1');
}

function getRowDateTime(entry) {
  return entry?.datetime_local || entry?.datetime_utc || '';
}

// Pair clock-in and clock-out records into sessions.
// Main method: session_id.
// Fallback: worker/project/day for old records without session_id.
function getSessions(entries) {
  const groups = {};

  for (const entry of entries) {
    const rowTime = getRowDateTime(entry);
    const day = getDatePart(rowTime);

    let key;

    if (entry.session_id) {
      key = `session:${entry.session_id}`;
    } else {
      key = `legacy:${entry.worker_id}|${entry.project_id}|${day}`;
    }

    if (!groups[key]) groups[key] = [];
    groups[key].push(entry);
  }

  const sessions = [];

  for (const [groupKey, rows] of Object.entries(groups)) {
    rows.sort((a, b) => {
      const aTime = getRowDateTime(a);
      const bTime = getRowDateTime(b);

      if (aTime !== bTime) return String(aTime).localeCompare(String(bTime));
      return Number(a.id || 0) - Number(b.id || 0);
    });

    const openIns = [];

    for (const row of rows) {
      if (row.action === 'in') {
        openIns.push(row);
      }

      if (row.action === 'out') {
        if (openIns.length) {
          const inEntry = openIns.shift();
          sessions.push(makeSession(inEntry, row, groupKey));
        } else {
          // Out record without matching in record
          sessions.push(makeSession(null, row, groupKey));
        }
      }
    }

    // Remaining clock-in records are open sessions
    for (const inEntry of openIns) {
      sessions.push(makeSession(inEntry, null, groupKey));
    }
  }

  sessions.sort((a, b) => {
    const aTime = a.clock_in || a.clock_out || '';
    const bTime = b.clock_in || b.clock_out || '';
    return String(aTime).localeCompare(String(bTime));
  });

  return applyDailyOvertime(sessions);
}

function makeSession(inEntry, outEntry, fallbackSessionId) {
  const clockInStr = inEntry?.datetime_local || '';
  const clockOutStr = outEntry?.datetime_local || '';

  const durationHr = inEntry && outEntry
    ? getDurationHours(clockInStr, clockOutStr)
    : 0;

  const durationStr = inEntry && outEntry
    ? formatDuration(clockInStr, clockOutStr)
    : '';

  const payRate = parseFloat(inEntry?.pay_rate || outEntry?.pay_rate || 0) || 0;

  return {
    session_id: inEntry?.session_id || outEntry?.session_id || fallbackSessionId,

    worker_id: inEntry?.worker_id || outEntry?.worker_id || '',
    worker_name: inEntry?.worker_name || outEntry?.worker_name || '',

    project_id: inEntry?.project_id || outEntry?.project_id || '',
    project_name: inEntry?.project_name || outEntry?.project_name || '',

    clock_in: clockInStr,
    clock_out: clockOutStr,

    duration: durationStr,
    duration_hours: durationHr,

    // These will be corrected by applyDailyOvertime()
    regular_hours: 0,
    overtime_hours: 0,
    total_pay: '0.00',

    note_in: inEntry?.note || '',
    note_out: outEntry?.note || '',

    pay_rate: payRate,

    id_in: inEntry?.id,
    id_out: outEntry?.id
  };
}

function applyDailyOvertime(sessions) {
  const closedSessions = sessions
    .filter(s => s.clock_in && s.clock_out)
    .sort((a, b) => {
      const workerCompare = String(a.worker_id || '').localeCompare(String(b.worker_id || ''));
      if (workerCompare !== 0) return workerCompare;

      const dayCompare = getDatePart(a.clock_in).localeCompare(getDatePart(b.clock_in));
      if (dayCompare !== 0) return dayCompare;

      return String(a.clock_in).localeCompare(String(b.clock_in));
    });

  const workedHoursByWorkerDay = {};

  for (const session of closedSessions) {
    const day = getDatePart(session.clock_in);
    const key = `${session.worker_id}|${day}`;

    if (!workedHoursByWorkerDay[key]) {
      workedHoursByWorkerDay[key] = 0;
    }

    const totalWorkedBeforeThisSession = workedHoursByWorkerDay[key];
    const regularLeftToday = Math.max(0, 8 - totalWorkedBeforeThisSession);

    const durationHours = Number(session.duration_hours || 0);

    const regularHours = Math.min(durationHours, regularLeftToday);
    const overtimeHours = Math.max(0, durationHours - regularHours);

    session.regular_hours = regularHours;
    session.overtime_hours = overtimeHours;

    const payRate = Number(session.pay_rate || 0);

    session.total_pay = (
      regularHours * payRate +
      overtimeHours * payRate * 1.5
    ).toFixed(2);

    workedHoursByWorkerDay[key] += durationHours;
  }

  // Open sessions do not have final pay yet
  for (const session of sessions) {
    if (!session.clock_out) {
      session.regular_hours = 0;
      session.overtime_hours = 0;
      session.total_pay = '0.00';
    }
  }

  return sessions;
}

function isOvertimeSession(session) {
  return Number(session.overtime_hours || 0) > 0;
}

function getFilteredSessions() {
  let filtered = allSessions.filter(s => {
    if (filterWorker && s.worker_name !== filterWorker) return false;
    if (filterProject && s.project_name !== filterProject) return false;

    if (filterStartDate && (!s.clock_in || s.clock_in < filterStartDate)) {
      return false;
    }

    if (filterEndDate && (!s.clock_in || s.clock_in > filterEndDate + ' 23:59')) {
      return false;
    }

    return true;
  });

  if (currentTab === 'open') {
    filtered = filtered.filter(s => !s.clock_out);
  } else if (currentTab === 'closed') {
    filtered = filtered.filter(s => !!s.clock_out);
  }

  return filtered;
}

function renderSessions() {
  const tbody = document.querySelector('#sessionTable tbody');
  const filtered = getFilteredSessions();

  tbody.innerHTML = filtered.map(s => {
    const overtime = highlightOvertime && isOvertimeSession(s);

    return `
      <tr${overtime ? ' class="overtime"' : ''}>
        <td>${s.worker_name || ''}</td>

        <td>
          <span class="editable" data-type="project" data-session="${s.session_id}" contenteditable>
            ${s.project_name || ''}
          </span>
        </td>

        <td>
          <span class="editable" data-type="clock_in" data-session="${s.session_id}" contenteditable>
            ${s.clock_in || ''}
          </span>
        </td>

        <td>
          <span class="editable" data-type="clock_out" data-session="${s.session_id}" contenteditable>
            ${s.clock_out || ''}
          </span>
        </td>

        <td>
          ${s.duration || ''}
          (${formatHourNumber(s.regular_hours)}h RT / ${formatHourNumber(s.overtime_hours)}h OT)
        </td>

        <td>
          <span class="editable" data-type="note_in" data-session="${s.session_id}" contenteditable>
            ${s.note_in || ''}
          </span>
        </td>

        <td>
          <span class="editable" data-type="note_out" data-session="${s.session_id}" contenteditable>
            ${s.note_out || ''}
          </span>
        </td>

        <td>
          ${s.pay_rate ? `$${Number(s.pay_rate).toFixed(2)}` : ''}
          ($${s.total_pay || '0.00'})
        </td>

        <td>
          ${!s.clock_out ? `<button onclick="forceClockOut('${s.session_id}')">Force Clock-Out</button>` : ''}
        </td>
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
    console.error('loadData failed:', err);
  }
}

function populateFilters() {
  const workerSel = document.getElementById('filterWorker');
  const projectSel = document.getElementById('filterProject');

  const currentWorkerValue = workerSel.value;
  const currentProjectValue = projectSel.value;

  const workers = getUnique(allEntries, 'worker_name');
  const projects = getUnique(allEntries, 'project_name');

  workerSel.innerHTML =
    '<option value="">All</option>' +
    workers.map(w => `<option value="${w}">${w}</option>`).join('');

  projectSel.innerHTML =
    '<option value="">All</option>' +
    projects.map(p => `<option value="${p}">${p}</option>`).join('');

  workerSel.value = currentWorkerValue;
  projectSel.value = currentProjectValue;
}

function getUnique(entries, field) {
  return Array.from(new Set(entries.map(e => e[field]))).filter(Boolean);
}

async function handleInlineEdit(e) {
  const span = e.target;
  const newValue = span.innerText.trim();
  const type = span.getAttribute('data-type');
  const sessionId = span.getAttribute('data-session');

  const session = allSessions.find(s => String(s.session_id) === String(sessionId));
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
  const res = await fetch(`/api/clock-entries/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    alert('Failed to update entry.');
  }
}

async function forceClockOut(session_id) {
  if (!confirm('Force clock out now?')) return;

  const res = await fetch(`/api/clock-entries/${session_id}/force-clock-out`, {
    method: 'POST'
  });

  if (res.ok) {
    await loadData();
  } else {
    alert('Failed to force clock out.');
  }
}

function exportCSV() {
  const rows = getFilteredSessions();

  const csvRows = [
    [
      'Worker',
      'Project',
      'Clock In',
      'Clock Out',
      'Duration',
      'Regular Hours',
      'Overtime Hours',
      'Pay Rate',
      'Amount',
      'Note In',
      'Note Out'
    ]
  ];

  for (const s of rows) {
    csvRows.push([
      s.worker_name || '',
      s.project_name || '',
      s.clock_in || '',
      s.clock_out || '',
      s.duration || '',
      formatHourNumber(s.regular_hours),
      formatHourNumber(s.overtime_hours),
      s.pay_rate ? Number(s.pay_rate).toFixed(2) : '',
      s.total_pay || '0.00',
      s.note_in || '',
      s.note_out || ''
    ]);
  }

  const csvText = csvRows
    .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csvText], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'dashboard_sessions.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

function updateTabs() {
  document.getElementById('tabOpen').classList.toggle('selected', currentTab === 'open');
  document.getElementById('tabClosed').classList.toggle('selected', currentTab === 'closed');
  document.getElementById('tabAll').classList.toggle('selected', currentTab === 'all');
}

// Globals
let allEntries = [];
let allSessions = [];

let filterWorker = '';
let filterProject = '';
let filterStartDate = '';
let filterEndDate = '';

let currentTab = 'open';
let highlightOvertime = false;

// Event bindings
document.getElementById('highlightOvertime').addEventListener('change', e => {
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

document.getElementById('exportCSV').addEventListener('click', exportCSV);

// Make forceClockOut available to inline onclick button
window.forceClockOut = forceClockOut;

// Initial load
loadData();
