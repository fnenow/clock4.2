// --- CHANGES NOTED ---
// [1] Added parseDateTime helper for "YYYY-MM-DD HH:MM:SS" format parsing
// [2] Updated all date parsing to use parseDateTime
// [3] Replaced isOvertimeSession logic with payroll-style overtime calculation (daily, per worker)
// [4] Documented changes at each step

// [1] Helper: Safe parse for "YYYY-MM-DD HH:MM:SS" strings
function parseDateTime(str) {
  if (!str) return null;
  return new Date(str.replace(' ', 'T'));
}

// [2] Update all duration and date math to use parseDateTime
function formatDuration(start, end) {
  if (!start) return '';
  const startDate = parseDateTime(start);
  const endDate = end ? parseDateTime(end) : new Date();
  const diffMs = endDate - startDate;
  if (diffMs < 0) return '';
  const h = Math.floor(diffMs / (1000 * 60 * 60));
  const m = Math.floor((diffMs / (1000 * 60)) % 60);
  return `${h}h ${m}m`;
}

// Returns duration in hours as a decimal
function getDurationHours(start, end) {
  if (!start) return 0;
  const startDate = parseDateTime(start);
  const endDate = end ? parseDateTime(end) : new Date();
  const diffMs = endDate - startDate;
  if (diffMs < 0) return 0;
  return diffMs / (1000 * 60 * 60);
}

function getSessions(entries) {
  // Pair by session_id
  const bySession = {};
  for (const e of entries) {
    if (!bySession[e.session_id]) bySession[e.session_id] = {};
    bySession[e.session_id][e.action] = e;
  }
  const sessions = [];
  for (const [session_id, pair] of Object.entries(bySession)) {
    const inEntry = pair.in;
    const outEntry = pair.out;
    const durationHours = inEntry ? getDurationHours(inEntry.datetime_local, outEntry?.datetime_local) : 0;
    const payRate = inEntry?.pay_rate || outEntry?.pay_rate || 0;
    const amount = payRate && durationHours ? (payRate * durationHours) : 0;
    sessions.push({
      session_id,
      worker_id: inEntry?.worker_id || outEntry?.worker_id,
      worker_name: inEntry?.worker_name || outEntry?.worker_name,
      project_id: inEntry?.project_id || outEntry?.project_id,
      project_name: inEntry?.project_name || outEntry?.project_name,
      clock_in: inEntry?.datetime_local || '',
      clock_out: outEntry?.datetime_local || '',
      duration: inEntry ? formatDuration(inEntry.datetime_local, outEntry?.datetime_local) : '',
      durationHours,
      amount,
      note_in: inEntry?.note || '',
      note_out: outEntry?.note || '',
      pay_rate: payRate,
      id_in: inEntry?.id,
      id_out: outEntry?.id
    });
  }
  return sessions;
}

function getUnique(entries, field) {
  return Array.from(new Set(entries.map(e => e[field]))).filter(Boolean);
}

// [3] Payroll-style overtime logic: highlight any session (or part) that is over the 8th hour in a day for a worker
function getOvertimeMap(sessions) {
  // Group by worker and day
  const dayMap = {};
  function getDay(dateStr) { return dateStr ? dateStr.slice(0, 10) : ''; }
  for (const s of sessions) {
    if (!s.clock_in || !s.clock_out) continue;
    const day = getDay(s.clock_in);
    const key = `${s.worker_name}|${day}`;
    if (!dayMap[key]) dayMap[key] = [];
    dayMap[key].push({
      session: s,
      start: parseDateTime(s.clock_in),
      end: parseDateTime(s.clock_out),
      duration: getDurationHours(s.clock_in, s.clock_out)
    });
  }
  // Set of session_ids that have overtime (even partial)
  const overtimeSessionIds = new Set();
  Object.values(dayMap).forEach(sessionList => {
    sessionList.sort((a, b) => a.start - b.start);
    let cumulative = 0;
    for (const { session, duration } of sessionList) {
      const prevCumulative = cumulative;
      cumulative += duration;
      // If any part of this session is after 8th hour, mark as overtime
      if (prevCumulative >= 8) {
        overtimeSessionIds.add(session.session_id);
      } else if (cumulative > 8) {
        overtimeSessionIds.add(session.session_id);
      }
    }
  });
  return overtimeSessionIds;
}

let allEntries = [];
let allSessions = [];
let filterWorker = '';
let filterProject = '';
let filterStartDate = '';
let filterEndDate = '';
let currentTab = 'open';
let highlightOvertime = false;
let durationInterval;

async function loadData() {
  // [NOTE] You may need to update this endpoint to /entries if the backend changed!
  const res = await fetch('/api/clock-entries');
  allEntries = await res.json();
  allSessions = getSessions(allEntries);
  populateFilters();
  renderSessions();

  if (durationInterval) clearInterval(durationInterval);
  durationInterval = setInterval(() => {
    allSessions = getSessions(allEntries);
    renderSessions();
  }, 60000); // update every minute
}

function populateFilters() {
  const workerSel = document.getElementById('filterWorker');
  const projectSel = document.getElementById('filterProject');
  const workers = getUnique(allEntries, 'worker_name');
  const projects = getUnique(allEntries, 'project_name');
  workerSel.innerHTML = '<option value="">All</option>' + workers.map(w => `<option>${w}</option>`).join('');
  projectSel.innerHTML = '<option value="">All</option>' + projects.map(p => `<option>${p}</option>`).join('');
}

// [3] Use getOvertimeMap in renderSessions
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

  let overtimeSessionIds = new Set();
  if (highlightOvertime) {
    overtimeSessionIds = getOvertimeMap(filtered);
  }

  tbody.innerHTML = filtered.map(s => {
    const overtime = highlightOvertime && overtimeSessionIds.has(s.session_id);
    return `
      <tr${overtime ? ' class="overtime"' : ''}>
        <td>${s.worker_name || ''}</td>
        <td>
          <span class="editable" data-type="project" data-session="${s.session_id}" contenteditable>${s.project_name || ''}</span>
        </td>
        <td>
          <span class="editable" data-type="clock_in" data-session="${s.session_id}" contenteditable>${s.clock_in || ''}</span>
        </td>
        <td>
          <span class="editable" data-type="clock_out" data-session="${s.session_id}" contenteditable>${s.clock_out || ''}</span>
        </td>
        <td>${s.duration || ''}</td>
        <td>${s.amount ? `$${s.amount.toFixed(2)}` : ''}</td>
        <td>
          <span class="editable" data-type="note_in" data-session="${s.session_id}" contenteditable>${s.note_in || ''}</span>
        </td>
        <td>
          <span class="editable" data-type="note_out" data-session="${s.session_id}" contenteditable>${s.note_out || ''}</span>
        </td>
        <td>${s.pay_rate ? `$${parseFloat(s.pay_rate).toFixed(2)}` : ''}</td>
        <td>
          ${!s.clock_out ? `<button onclick="forceClockOut('${s.id_in}')">Force Clock-Out</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
  document.querySelectorAll('.editable').forEach(span => {
    span.onblur = handleInlineEdit;
  });
}

async function handleInlineEdit(e) {
  const span = e.target;
  const newValue = span.innerText.trim();
  const type = span.getAttribute('data-type');
  const sessionId = span.getAttribute('data-session');
  const session = allSessions.find(s => s.session_id === sessionId);
  if (!session) return;
  // Patch backend for changed value
  if (type === 'project') {
    if (session.id_in)
      await patchEntry(session.id_in, { project_name: newValue });
    if (session.id_out)
      await patchEntry(session.id_out, { project_name: newValue });
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
document.getElementById('highlightOvertime').addEventListener('change', e => {
  highlightOvertime = e.target.checked;
  renderSessions();
});
function updateTabs() {
  document.getElementById('tabOpen').classList.toggle('selected', currentTab === 'open');
  document.getElementById('tabClosed').classList.toggle('selected', currentTab === 'closed');
  document.getElementById('tabAll').classList.toggle('selected', currentTab === 'all');
}

async function forceClockOut(id_in) {
  if (!confirm("Force clock out now?")) return;
  const res = await fetch(`/api/clock-entries/${id_in}/force-clock-out`, { method: 'POST' });
  if (res.ok) {
    await loadData();
  } else {
    alert("Failed to force clock out");
  }
}
window.forceClockOut = forceClockOut;

// CSV export
document.getElementById('exportCSV').addEventListener('click', () => {
  let csv = "Worker,Project,Clock-in,Clock-out,Duration,Amount,Note In,Note Out,Pay Rate\n";
  allSessions.forEach(s => {
    csv += `"${s.worker_name}","${s.project_name}","${s.clock_in}","${s.clock_out}","${s.duration}","${s.amount ? `$${s.amount.toFixed(2)}` : ''}","${s.note_in}","${s.note_out}","${s.pay_rate}"\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sessions.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

loadData();
