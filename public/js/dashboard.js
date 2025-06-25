function getDurationHours(startStr, endStr) {
  if (!startStr || !endStr) return 0;

  const [startDate, startTime] = startStr.split(' ');
  const [endDate, endTime] = endStr.split(' ');

  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [sh, smin] = startTime.split(':').map(Number);

  const [ey, em, ed] = endDate.split('-').map(Number);
  const [eh, emin] = endTime.split(':').map(Number);

  const start = new Date(sy, sm - 1, sd, sh, smin);
  const end = new Date(ey, em - 1, ed, eh, emin);

  const ms = end - start;
  return ms > 0 ? ms / (1000 * 60 * 60) : 0;
}

function formatDuration(startStr, endStr) {
  if (!startStr || !endStr) return '';
  const duration = getDurationHours(startStr, endStr);
  const h = Math.floor(duration);
  const m = Math.round((duration - h) * 60);
  return `${h}h ${m}m`;
}

function getSessions(entries) {
  const bySession = {};
  for (const e of entries) {
    if (!bySession[e.session_id]) bySession[e.session_id] = {};
    bySession[e.session_id][e.action] = e;
  }

  const allSessions = [];
  for (const [session_id, pair] of Object.entries(bySession)) {
    const inEntry = pair.in;
    const outEntry = pair.out;
    const clockIn = inEntry?.datetime_local || '';
    const clockOut = outEntry?.datetime_local || '';
    const durationHours = clockIn && clockOut ? getDurationHours(clockIn, clockOut) : 0;
    const payRate = parseFloat(inEntry?.pay_rate || outEntry?.pay_rate || 0);
    allSessions.push({
      session_id,
      worker_id: inEntry?.worker_id || outEntry?.worker_id,
      worker_name: inEntry?.worker_name || outEntry?.worker_name,
      project_id: inEntry?.project_id || outEntry?.project_id,
      project_name: inEntry?.project_name || outEntry?.project_name,
      clock_in: clockIn,
      clock_out: clockOut,
      duration: formatDuration(clockIn, clockOut),
      durationHours,
      pay_rate: payRate,
      note_in: inEntry?.note || '',
      note_out: outEntry?.note || '',
      id_in: inEntry?.id,
      id_out: outEntry?.id,
      amount: 0
    });
  }

  // Group by worker + day
  const grouped = {};
  for (const s of allSessions) {
    if (!s.clock_in) continue;
    const dayKey = `${s.worker_id}_${s.clock_in.slice(0, 10)}`; // yyyy-mm-dd
    if (!grouped[dayKey]) grouped[dayKey] = [];
    grouped[dayKey].push(s);
  }

  const result = [];
  for (const group of Object.values(grouped)) {
    group.sort((a, b) => getDurationHours(a.clock_in, b.clock_in));
    let dayTotal = 0;
    for (const s of group) {
      const regAvailable = Math.max(0, 8 - dayTotal);
      const regHours = Math.min(s.durationHours, regAvailable);
      const otHours = Math.max(0, s.durationHours - regHours);
      s.amount = (regHours * s.pay_rate) + (otHours * s.pay_rate * 1.5);
      dayTotal += s.durationHours;
      result.push(s);
    }
  }

  return result;
}

function getUnique(entries, field) {
  return Array.from(new Set(entries.map(e => e[field]))).filter(Boolean);
}

function isOvertimeSession(session) {
  return session.durationHours > 8;
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
  const res = await fetch('/api/clock-entries');
  allEntries = await res.json();
  allSessions = getSessions(allEntries);
  populateFilters();
  renderSessions();

  if (durationInterval) clearInterval(durationInterval);
  durationInterval = setInterval(() => {
    allSessions = getSessions(allEntries);
    renderSessions();
  }, 60000);
}

function populateFilters() {
  const workerSel = document.getElementById('filterWorker');
  const projectSel = document.getElementById('filterProject');
  const workers = getUnique(allEntries, 'worker_name');
  const projects = getUnique(allEntries, 'project_name');
  workerSel.innerHTML = '<option value="">All</option>' + workers.map(w => `<option>${w}</option>`).join('');
  projectSel.innerHTML = '<option value="">All</option>' + projects.map(p => `<option>${p}</option>`).join('');
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
        <td>${s.duration || ''}</td>
        <td>${s.amount ? `$${s.amount.toFixed(2)}` : ''}</td>
        <td><span class="editable" data-type="note_in" data-session="${s.session_id}" contenteditable>${s.note_in || ''}</span></td>
        <td><span class="editable" data-type="note_out" data-session="${s.session_id}" contenteditable>${s.note_out || ''}</span></td>
        <td>${s.pay_rate ? `$${parseFloat(s.pay_rate).toFixed(2)}` : ''}</td>
        <td>${!s.clock_out ? `<button onclick="forceClockOut('${s.id_in}')">Force Clock-Out</button>` : ''}</td>
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
  if (res.ok) await loadData();
  else alert("Failed to force clock out");
}
window.forceClockOut = forceClockOut;

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
