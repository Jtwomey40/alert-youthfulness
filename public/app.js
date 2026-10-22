const STATUS_LABELS = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
const STAGE_ORDER = ['Intake', 'Offer requested', 'Offers ready', 'Offer selected', 'Not in DealioDesk'];

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function priorityTag(p) {
  return `<span class="tag ${p}">${p}</span>`;
}

function statusTag(s) {
  return `<span class="tag ${s}">${STATUS_LABELS[s] || s}</span>`;
}

// ---- Nav ----
document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(btn.dataset.section).classList.add('active');
  });
});

// ---- View toggles (table/board) ----
document.querySelectorAll('.view-toggle').forEach(toggle => {
  toggle.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    const section = toggle.closest('.panel');
    toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    const view = e.target.dataset.view;
    section.querySelectorAll('[id$="-table-view"], [id$="-board-view"]').forEach(el => {
      el.style.display = el.id.endsWith(`${view}-view`) ? '' : 'none';
    });
  });
});

// ---- Overview ----
async function loadOverview() {
  const tasks = await fetchJSON(`/api/tasks?due_before=${isoToday()}&status=todo`);
  const tasks2 = await fetchJSON(`/api/tasks?due_before=${isoToday()}&status=in_progress`);
  const rows = [...tasks, ...tasks2].sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  const tbody = document.querySelector('#overview-tasks-table tbody');
  tbody.innerHTML = rows.length
    ? rows.map(t => `<tr>
        <td>${t.title}</td>
        <td>${priorityTag(t.priority)}</td>
        <td>${t.due && t.due < isoToday() ? '<span class="tag overdue">OVERDUE</span> ' : ''}${fmtDate(t.due)}</td>
        <td>${t.project || ''}</td>
        <td>${statusTag(t.status)}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="color:#6b7280;">Nothing due today or overdue. 🎉</td></tr>`;

  const props = await fetchJSON('/api/properties');
  const active = props.filter(p => p.stage !== 'Not in DealioDesk');
  const board = document.getElementById('overview-pipeline-board');
  board.innerHTML = STAGE_ORDER.filter(s => s !== 'Not in DealioDesk').map(stage => {
    const items = active.filter(p => p.stage === stage);
    return `<div class="column"><h3>${stage} (${items.length})</h3>${
      items.map(p => `<div class="card"><div class="title">${p.address}</div><div class="meta">${p.agent_name || 'No agent on file'}</div></div>`).join('')
    }</div>`;
  }).join('');
}

// ---- Tasks ----
async function loadTasks() {
  const tasks = await fetchJSON('/api/tasks');
  const tbody = document.querySelector('#tasks-table tbody');
  tbody.innerHTML = tasks.map(t => `<tr>
      <td>${t.title}</td>
      <td>${statusTag(t.status)}</td>
      <td>${priorityTag(t.priority)}</td>
      <td>${fmtDate(t.due)}</td>
      <td>${t.project || ''}</td>
      <td>${t.source}</td>
    </tr>`).join('');

  const board = document.getElementById('tasks-board-view');
  board.innerHTML = Object.keys(STATUS_LABELS).map(status => {
    const items = tasks.filter(t => t.status === status);
    return `<div class="column"><h3>${STATUS_LABELS[status]} (${items.length})</h3>${
      items.map(t => `<div class="card"><div class="title">${t.title}</div><div class="meta">${priorityTag(t.priority)} ${fmtDate(t.due)}</div></div>`).join('')
    }</div>`;
  }).join('');
}

// ---- Properties ----
async function loadProperties() {
  const props = await fetchJSON('/api/properties');
  const tbody = document.querySelector('#properties-table tbody');
  tbody.innerHTML = props.map(p => `<tr>
      <td>${p.address}</td>
      <td>${p.stage}</td>
      <td>${p.agent_name || ''}</td>
      <td>${p.deal_url ? `<a href="${p.deal_url}" target="_blank">Open</a>` : ''}</td>
    </tr>`).join('');

  const board = document.getElementById('properties-board-view');
  board.innerHTML = STAGE_ORDER.map(stage => {
    const items = props.filter(p => p.stage === stage);
    return `<div class="column"><h3>${stage} (${items.length})</h3>${
      items.map(p => `<div class="card"><div class="title">${p.address}</div><div class="meta">${p.agent_name || 'No agent on file'}</div></div>`).join('')
    }</div>`;
  }).join('');
}

loadOverview();
loadTasks();
loadProperties();
