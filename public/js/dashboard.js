// === Modified dashboard.js fixes ===
function formatDuration(start, end) {
  if (!start) return '';
  const startDate = new Date(start.replace(' ', 'T'));
  const endDate = end ? new Date(end.replace(' ', 'T')) : new Date();
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return '';
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
    const inTime = new Date(clockInStr.replace(' ', 'T'));
    const outTime = new Date(clockOutStr.replace(' ', 'T'));

    const durationMs = inEntry && outEntry && !isNaN(inTime) && !isNaN(outTime) ? outTime - inTime : 0;
    const durationHr = durationMs / 3600000;
    const payRate = parseFloat(inEntry?.pay_rate || outEntry?.pay_rate || 0);

    const regularHours = Math.min(8, durationHr);
    const overtimeHours = Math.max(0, durationHr - 8);

    const baseSession = {
      session_id,
      worker_id: inEntry?.worker_id || outEntry?.worker_id,
      worker_name: inEntry?.worker_name || outEntry?.worker_name,
      project_id: inEntry?.project_id || outEntry?.project_id,
      project_name: inEntry?.project_name || outEntry?.project_name,
      pay_rate: payRate,
      note_out: outEntry?.note || '',
      id_in: inEntry?.id,
      id_out: outEntry?.id
    };

    // Regular time row
    let regClockOut = clockOutStr;
    if (overtimeHours > 0 && !isNaN(inTime)) {
      const otEnd = new Date(inTime.getTime() + 8 * 3600000);
      regClockOut = `${otEnd.getFullYear()}-${String(otEnd.getMonth() + 1).padStart(2, '0')}-${String(otEnd.getDate()).padStart(2, '0')} ${String(otEnd.getHours()).padStart(2, '0')}:${String(otEnd.getMinutes()).padStart(2, '0')}`;
    }

    sessions.push({
      ...baseSession,
      clock_in: clockInStr,
      clock_out: regClockOut,
      duration: formatDuration(clockInStr, regClockOut),
      regular_hours: round2(regularHours),
      overtime_hours: 0,
      total_pay: round2(regularHours * payRate),
      note_in: inEntry?.note || '',
      isOT: false
    });

    // Overtime row
    if (overtimeHours > 0 && !isNaN(inTime)) {
      const otStart = new Date(inTime.getTime() + 8 * 3600000);
      const otStartStr = `${otStart.getFullYear()}-${String(otStart.getMonth() + 1).padStart(2, '0')}-${String(otStart.getDate()).padStart(2, '0')} ${String(otStart.getHours()).padStart(2, '0')}:${String(otStart.getMinutes()).padStart(2, '0')}`;
      sessions.push({
        ...baseSession,
        clock_in: otStartStr,
        clock_out: clockOutStr,
        duration: formatDuration(otStartStr, clockOutStr),
        regular_hours: 0,
        overtime_hours: round2(overtimeHours),
        total_pay: round2(overtimeHours * payRate * 1.5),
        note_in: 'In: overtime',
        isOT: true
      });
    }
  }
  return sessions;
}

function round2(n) {
  return Math.round(n * 100) / 100;
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
        <td>${!s.clock_out ? `<button onclick="forceClockOut('${s.id_in}')">Force Clock-Out</button>` : ''}</td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.editable').forEach(span => {
    span.onblur = handleInlineEdit;
  });
}

const otCheckbox = document.getElementById('highlightOvertime');
otCheckbox.addEventListener('change', e => {
  highlightOvertime = e.target.checked;
  renderSessions();
});
