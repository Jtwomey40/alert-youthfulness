// ---- Constants ----
const STATUS_LABELS = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
const STAGE_ORDER = ['Intake', 'Offer requested', 'Offers ready', 'Offer selected', 'Not in DealioDesk'];
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

// ---- State ----
const state = {
  tasks: [],
  properties: [],
  stats: null,
  attention: null,
  activity: [],
  tasksSort: { key: 'due', dir: 'asc' },
  propertiesSort: { key: 'address', dir: 'asc' },
  tasksSearch: '',
  tasksFilterStatus: '',
  tasksFilterPriority: '',
  propertiesSearch: '',
  propertiesFilterStage: '',
  ownershipScope: 'mine', // 'mine' | 'everyone' — filters out properties not assigned_to_me
  selectedTaskIds: new Set(),
  autoRefreshTimer: null,
  recapMatchIds: null, // null = no active recap search; otherwise a Set of property ids matching the current recap search
  recapSearchTimer: null,
  staleIds: new Set(), // property ids with a stale/missing recap, from the Needs Attention data
  archivedProperties: []
};

// ---- Utilities ----
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function isoToday() { return new Date().toISOString().slice(0, 10); }
function fmtDate(d) { if (!d) return ''; return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function fmtDateTime(d) { if (!d) return ''; return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function priorityTag(p) { return `<span class="tag ${escapeHtml(p)}">${escapeHtml(p)}</span>`; }
function statusTag(s) { return `<span class="tag ${escapeHtml(s)}">${escapeHtml(STATUS_LABELS[s] || s)}</span>`; }
function fmtMoney(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return '';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function sortItems(items, key, dir) {
  const mult = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === 'priority') { av = PRIORITY_ORDER[av] ?? 99; bv = PRIORITY_ORDER[bv] ?? 99; }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * mult;
    return (av > bv ? 1 : av < bv ? -1 : 0) * mult;
  });
}

// ---- API helpers ----
async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = '';
    try { const data = await res.json(); detail = data.error || ''; } catch (e) { /* ignore */ }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}
function getJSON(url) { return apiFetch(url); }
function postJSON(url, body) {
  return apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function patchJSON(url, body) {
  return apiFetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ---- Error banner ----
function showError(msg) {
  document.getElementById('error-banner-text').textContent = msg;
  document.getElementById('error-banner').style.display = 'flex';
}
function hideError() {
  document.getElementById('error-banner').style.display = 'none';
}

// ---- Load / render orchestration ----
async function loadAll() {
  const statusEl = document.getElementById('refresh-status');
  const hasData = state.tasks.length || state.properties.length;
  statusEl.textContent = hasData ? 'Refreshing…' : 'Loading…';
  try {
    const [tasks, properties, stats, attention, activity] = await Promise.all([
      getJSON('/api/tasks'),
      getJSON('/api/properties'),
      getJSON('/api/insights/stats'),
      getJSON('/api/insights/needs-attention'),
      getJSON('/api/insights/activity?limit=30')
    ]);
    state.tasks = tasks;
    state.properties = properties;
    state.stats = stats;
    state.attention = attention;
    state.activity = activity;
    state.staleIds = new Set((attention.stale_recaps || []).map(p => String(p.id)));
    hideError();
    renderAll();
    statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    statusEl.textContent = 'Refresh failed';
    showError('Could not refresh dashboard data: ' + err.message);
  }
}

function renderAll() {
  renderOverview();
  renderTasksSection();
  renderPropertiesSection();
  renderAgents();
  renderInsights();
}

// ---- Generic board renderer ----
function renderBoard(container, items, groupKeyFn, groupOrder, groupLabelFn, cardHtmlFn) {
  container.innerHTML = groupOrder.map(key => {
    const groupItems = items.filter(i => groupKeyFn(i) === key);
    return `<div class="column"><h3>${escapeHtml(groupLabelFn(key))} (${groupItems.length})</h3>${groupItems.map(cardHtmlFn).join('')}</div>`;
  }).join('');
}

// ---- Needs Attention ----
function renderAttention(container, data, opts) {
  opts = opts || {};
  if (!data) { container.innerHTML = '<p class="muted">Loading…</p>'; return; }
  const limit = opts.compact ? 3 : Infinity;
  const sections = [
    {
      title: 'Stale / missing recaps',
      items: data.stale_recaps || [],
      render: p => `${escapeHtml(p.address)} — ${p.last_recap_date ? 'last recap ' + fmtDate(p.last_recap_date) : 'no recap on file'}`
    },
    {
      title: 'Missing agent contact',
      items: data.missing_agent_contact || [],
      render: p => `${escapeHtml(p.address)} (${escapeHtml(p.stage)})`
    },
    {
      title: 'Overdue tasks',
      items: data.overdue_tasks || [],
      render: t => `${escapeHtml(t.title)}${t.property_address ? ' — ' + escapeHtml(t.property_address) : ''} (due ${fmtDate(t.due)})`
    }
  ].filter(s => s.items.length);

  if (!sections.length) { container.innerHTML = '<p class="muted">Nothing needs attention right now.</p>'; return; }

  container.innerHTML = sections.map(s => {
    const shown = s.items.slice(0, limit);
    const more = s.items.length - shown.length;
    return `<div class="attention-group">
      <h4>${escapeHtml(s.title)} (${s.items.length})</h4>
      <ul>${shown.map(i => `<li>${s.render(i)}</li>`).join('')}</ul>
      ${more > 0 ? `<p class="muted small">+${more} more — see Insights tab</p>` : ''}
    </div>`;
  }).join('');
}

// ---- Activity feed ----
function renderActivityList(container, items, limit) {
  const shown = limit ? items.slice(0, limit) : items;
  if (!shown.length) { container.innerHTML = '<li class="muted">No recent activity.</li>'; return; }
  container.innerHTML = shown.map(a => {
    if (a.type === 'stage_change') {
      return `<li><strong>${escapeHtml(a.address)}</strong> moved ${a.from_stage ? escapeHtml(a.from_stage) + ' → ' : ''}${escapeHtml(a.to_stage)} <span class="muted small">${fmtDateTime(a.occurred_at)}</span></li>`;
    }
    return `<li>Call logged for <strong>${escapeHtml(a.address)}</strong>: ${escapeHtml(a.meeting_title)} <span class="muted small">${fmtDateTime(a.occurred_at)}</span></li>`;
  }).join('');
}

// ---- Shared property card template ----
// Properties in the "Offers ready" stage get two checkboxes:
//   - "I've called them" stamps called_at and the card drops out of the Offers ready
//     board column right away (see renderOverview / renderPropertiesSection filters).
//   - "Not enough equity" permanently deletes the property after a confirm prompt.
function propertyCardHtml(p, opts) {
  opts = opts || {};
  const linkable = opts.linkable !== false;
  const showOfferCheckboxes = p.stage === 'Offers ready';
  const checkboxes = showOfferCheckboxes
    ? `<div class="card-checkboxes">
        <label class="called-checkbox-label">
          <input type="checkbox" class="called-checkbox" data-id="${p.id}" ${p.called_at ? 'checked' : ''}>
          I've called them
        </label>
        <label class="equity-checkbox-label">
          <input type="checkbox" class="equity-checkbox" data-id="${p.id}">
          Not enough equity
        </label>
      </div>`
    : '';
  const ownerTag = p.assigned_to_me
    ? ''
    : '<span class="tag not-mine">Not yours</span>';
  const staleTag = state.staleIds.has(String(p.id)) ? '<span class="tag stale">Stale</span>' : '';
  const valueMeta = p.deal_value ? `<div class="meta">${fmtMoney(p.deal_value)}</div>` : '';
  return `<div class="card${linkable ? ' property-link' : ''}" data-id="${p.id}">
      <div class="title">${escapeHtml(p.address)} ${ownerTag} ${staleTag}</div>
      <div class="meta">${escapeHtml(p.agent_name || 'No agent on file')}</div>
      ${valueMeta}
      ${checkboxes}
    </div>`;
}

// Optimistically hides the card and persists the "called" timestamp; reverts and
// shows an error if the save fails.
async function toggleCalledAt(id, checked) {
  const idx = state.properties.findIndex(p => String(p.id) === String(id));
  const previous = idx !== -1 ? state.properties[idx].called_at : undefined;
  if (idx !== -1) state.properties[idx].called_at = checked ? new Date().toISOString() : null;
  renderOverview();
  renderPropertiesSection();
  try {
    const updated = await patchJSON(`/api/properties/${id}`, { called_at: checked ? new Date().toISOString() : null });
    if (idx !== -1) state.properties[idx] = updated;
  } catch (err) {
    if (idx !== -1) state.properties[idx].called_at = previous;
    showError('Could not save that: ' + err.message);
    renderOverview();
    renderPropertiesSection();
  }
}

// "Not enough equity" — archives the property (soft-delete) rather than destroying it,
// so it can be restored later from the Archived Properties list. Confirms first; re-renders
// either way so the checkbox doesn't stay visually checked.
async function handleNotEnoughEquity(id) {
  if (!window.confirm('Archive this property? It will be hidden from the dashboard but can be restored later from Archived Properties.')) {
    renderOverview();
    renderPropertiesSection();
    return;
  }
  const idx = state.properties.findIndex(p => String(p.id) === String(id));
  const removed = idx !== -1 ? state.properties[idx] : null;
  if (idx !== -1) state.properties.splice(idx, 1);
  renderAll();
  try {
    await patchJSON(`/api/properties/${id}`, { archived_at: new Date().toISOString() });
  } catch (err) {
    if (removed) state.properties.splice(idx, 0, removed);
    showError('Could not archive property: ' + err.message);
    renderAll();
  }
}

// ---- Archived Properties modal ----
async function loadArchivedProperties() {
  const tbody = document.querySelector('#archived-properties-table tbody');
  tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;
  try {
    const archived = await getJSON('/api/properties?archived=true');
    state.archivedProperties = archived;
    tbody.innerHTML = archived.length ? archived.map(p => `<tr data-id="${p.id}">
        <td>${escapeHtml(p.address)}</td>
        <td>${escapeHtml(p.stage)}</td>
        <td>${escapeHtml(p.agent_name || '')}</td>
        <td><button type="button" class="secondary-btn small restore-property-btn" data-id="${p.id}">Restore</button></td>
      </tr>`).join('') : `<tr><td colspan="4" class="muted">No archived properties.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Could not load archived properties.</td></tr>`;
    showError('Could not load archived properties: ' + err.message);
  }
}

async function restoreProperty(id) {
  try {
    await patchJSON(`/api/properties/${id}`, { archived_at: null });
    await loadArchivedProperties();
    await loadAll();
  } catch (err) { showError('Could not restore property: ' + err.message); }
}

// ---- Overview ----
function renderOverview() {
  renderAttention(document.getElementById('overview-attention-content'), state.attention, { compact: true });

  const today = isoToday();
  const dueRows = state.tasks
    .filter(t => t.status !== 'done' && t.due && t.due <= today)
    .sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  const tbody = document.querySelector('#overview-tasks-table tbody');
  tbody.innerHTML = dueRows.length ? dueRows.map(t => `<tr>
      <td>${escapeHtml(t.title)}</td>
      <td>${priorityTag(t.priority)}</td>
      <td>${t.due < today ? '<span class="tag overdue">OVERDUE</span> ' : ''}${fmtDate(t.due)}</td>
      <td>${escapeHtml(t.project || '')}</td>
      <td>${statusTag(t.status)}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="muted">Nothing due today or overdue.</td></tr>`;

  const active = state.properties.filter(p =>
    p.stage !== 'Not in DealioDesk' &&
    !(p.stage === 'Offers ready' && p.called_at) &&
    (state.ownershipScope !== 'mine' || p.assigned_to_me)
  );
  renderBoard(
    document.getElementById('overview-pipeline-board'),
    active,
    p => p.stage,
    STAGE_ORDER.filter(s => s !== 'Not in DealioDesk'),
    s => s,
    p => propertyCardHtml(p, { linkable: false })
  );

  renderActivityList(document.getElementById('overview-activity-list'), state.activity, 8);
}

// ---- Tasks ----
function getFilteredSortedTasks() {
  let items = [...state.tasks];
  const q = state.tasksSearch.trim().toLowerCase();
  if (q) items = items.filter(t => (t.title || '').toLowerCase().includes(q) || (t.project || '').toLowerCase().includes(q));
  if (state.tasksFilterStatus) items = items.filter(t => t.status === state.tasksFilterStatus);
  if (state.tasksFilterPriority) items = items.filter(t => t.priority === state.tasksFilterPriority);
  return sortItems(items, state.tasksSort.key, state.tasksSort.dir);
}

function updateSortIndicators(tableId, sortState) {
  document.querySelectorAll(`#${tableId} th[data-sort]`).forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === sortState.key) th.classList.add(sortState.dir === 'desc' ? 'sort-desc' : 'sort-asc');
  });
}

function updateBulkBar() {
  const bar = document.getElementById('tasks-bulk-bar');
  const count = state.selectedTaskIds.size;
  if (count > 0) {
    bar.style.display = 'flex';
    document.getElementById('tasks-bulk-count').textContent = `${count} selected`;
  } else {
    bar.style.display = 'none';
  }
  const selectAll = document.getElementById('tasks-select-all');
  const visibleIds = getFilteredSortedTasks().map(t => t.id);
  selectAll.checked = visibleIds.length > 0 && visibleIds.every(id => state.selectedTaskIds.has(id));
}

function renderTasksSection() {
  const items = getFilteredSortedTasks();
  const today = isoToday();
  const tbody = document.querySelector('#tasks-table tbody');
  tbody.innerHTML = items.length ? items.map(t => {
    const overdue = t.due && t.due < today && t.status !== 'done';
    return `<tr data-id="${t.id}" class="${overdue ? 'row-overdue' : ''}">
      <td class="checkbox-col"><input type="checkbox" class="task-select-checkbox" data-id="${t.id}" ${state.selectedTaskIds.has(t.id) ? 'checked' : ''}></td>
      <td>${escapeHtml(t.title)}</td>
      <td><select class="inline-edit" data-field="status" data-id="${t.id}">
        <option value="todo" ${t.status === 'todo' ? 'selected' : ''}>To do</option>
        <option value="in_progress" ${t.status === 'in_progress' ? 'selected' : ''}>In progress</option>
        <option value="done" ${t.status === 'done' ? 'selected' : ''}>Done</option>
      </select></td>
      <td><select class="inline-edit" data-field="priority" data-id="${t.id}">
        <option value="high" ${t.priority === 'high' ? 'selected' : ''}>High</option>
        <option value="medium" ${t.priority === 'medium' ? 'selected' : ''}>Medium</option>
        <option value="low" ${t.priority === 'low' ? 'selected' : ''}>Low</option>
      </select></td>
      <td><input type="date" class="inline-edit" data-field="due" data-id="${t.id}" value="${t.due ? String(t.due).slice(0, 10) : ''}"></td>
      <td>${escapeHtml(t.project || '')}</td>
      <td>${escapeHtml(t.source)}</td>
      <td><button type="button" class="ics-btn secondary-btn small" data-id="${t.id}">+ Calendar</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="muted">No tasks match.</td></tr>`;

  renderBoard(
    document.getElementById('tasks-board-view'),
    items,
    t => t.status,
    ['todo', 'in_progress', 'done'],
    s => STATUS_LABELS[s],
    t => `<div class="card"><div class="title">${escapeHtml(t.title)}</div><div class="meta">${priorityTag(t.priority)} ${fmtDate(t.due)}</div></div>`
  );

  updateSortIndicators('tasks-table', state.tasksSort);
  updateBulkBar();
}

function icsEscape(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function downloadICS(task) {
  if (!task.due) { showError('This task has no due date to add to a calendar.'); return; }
  const dateStr = String(task.due).slice(0, 10).replace(/-/g, '');
  const uid = `task-${task.id}@alert-youthfulness`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Zoodealio//Dashboard//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
    `DTSTART;VALUE=DATE:${dateStr}`,
    `SUMMARY:${icsEscape(task.title)}`,
    `DESCRIPTION:${icsEscape(task.project ? `Project: ${task.project}` : '')}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `task-${task.id}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- Properties ----
function getFilteredSortedProperties() {
  let items = [...state.properties];
  const q = state.propertiesSearch.trim().toLowerCase();
  if (q) {
    items = items.filter(p =>
      (p.address || '').toLowerCase().includes(q) ||
      (p.agent_name || '').toLowerCase().includes(q) ||
      (state.recapMatchIds && state.recapMatchIds.has(String(p.id)))
    );
  }
  if (state.propertiesFilterStage) items = items.filter(p => p.stage === state.propertiesFilterStage);
  if (state.ownershipScope === 'mine') items = items.filter(p => p.assigned_to_me);
  return sortItems(items, state.propertiesSort.key, state.propertiesSort.dir);
}

// Looks up which properties have a call recap matching the current search text, so
// "search" can match recap content in addition to address/agent (which are already
// filtered client-side above). Debounced so it doesn't fire on every keystroke.
const fetchRecapMatches = debounce(async (q) => {
  if (!q) { state.recapMatchIds = null; renderPropertiesSection(); return; }
  try {
    const matches = await getJSON(`/api/properties?recap_search=${encodeURIComponent(q)}&archived=all`);
    // Only apply if the search box still holds the same text (avoids stale results racing in).
    if (state.propertiesSearch.trim().toLowerCase() !== q) return;
    state.recapMatchIds = new Set(matches.map(p => String(p.id)));
    renderPropertiesSection();
  } catch (err) { /* silently ignore — recap search is an enhancement, not critical */ }
}, 300);

function renderPropertiesSection() {
  const items = getFilteredSortedProperties();
  const tbody = document.querySelector('#properties-table tbody');
  tbody.innerHTML = items.length ? items.map(p => `<tr data-id="${p.id}">
      <td><a href="#" class="property-link" data-id="${p.id}">${escapeHtml(p.address)}</a>${state.staleIds.has(String(p.id)) ? ' <span class="tag stale">Stale</span>' : ''}</td>
      <td>${escapeHtml(p.stage)}</td>
      <td>${p.deal_value ? fmtMoney(p.deal_value) : '<span class="muted">—</span>'}</td>
      <td>${p.assigned_to_me ? '<span class="tag mine">Mine</span>' : '<span class="tag not-mine">Not yours</span>'}</td>
      <td>${escapeHtml(p.agent_name || '')}</td>
      <td>${p.last_recap_date ? fmtDate(p.last_recap_date) : '<span class="muted">none</span>'}</td>
      <td>${p.deal_url ? `<a href="${escapeHtml(p.deal_url)}" target="_blank" rel="noopener">Open</a>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="muted">No properties match.</td></tr>`;

  const boardItems = items.filter(p => !(p.stage === 'Offers ready' && p.called_at));
  renderBoard(
    document.getElementById('properties-board-view'),
    boardItems,
    p => p.stage,
    STAGE_ORDER,
    s => s,
    p => propertyCardHtml(p)
  );

  updateSortIndicators('properties-table', state.propertiesSort);
}

// ---- Agent directory ----
function buildAgentDirectory(properties) {
  const map = new Map();
  for (const p of properties) {
    const key = (p.agent_email || p.agent_name || '').trim().toLowerCase();
    if (!key) continue;
    if (!map.has(key)) map.set(key, { name: p.agent_name || '(no name)', email: p.agent_email || '', phone: p.agent_phone || '', properties: [] });
    const entry = map.get(key);
    if (!entry.email && p.agent_email) entry.email = p.agent_email;
    if (!entry.phone && p.agent_phone) entry.phone = p.agent_phone;
    entry.properties.push(p.address);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function renderAgents() {
  const agents = buildAgentDirectory(state.properties);
  const tbody = document.querySelector('#agents-table tbody');
  tbody.innerHTML = agents.length ? agents.map(a => `<tr>
      <td>${escapeHtml(a.name)}</td>
      <td>${a.email ? `<a href="mailto:${escapeHtml(a.email)}">${escapeHtml(a.email)}</a>` : ''}</td>
      <td>${escapeHtml(a.phone)}</td>
      <td>${a.properties.map(escapeHtml).join(', ')}</td>
    </tr>`).join('') : `<tr><td colspan="4" class="muted">No agents on file yet.</td></tr>`;
}

// ---- Insights ----
function renderInsights() {
  const s = state.stats;
  const cardsEl = document.getElementById('insights-stats-cards');
  if (!s) {
    cardsEl.innerHTML = '<p class="muted">Loading…</p>';
  } else {
    const byPriority = Object.fromEntries((s.open_tasks_by_priority || []).map(r => [r.priority, r.n]));
    const byStage = Object.fromEntries((s.properties_by_stage || []).map(r => [r.stage, r.n]));
    cardsEl.innerHTML = `
      <div class="stat-card"><div class="stat-value">${s.tasks_completed_7d}</div><div class="stat-label">Tasks completed (7d)</div></div>
      <div class="stat-card"><div class="stat-value">${s.tasks_completed_30d}</div><div class="stat-label">Tasks completed (30d)</div></div>
      <div class="stat-card"><div class="stat-value">${s.deals_reached_offer_selected_30d}</div><div class="stat-label">Deals to Offer Selected (30d)</div></div>
      <div class="stat-card"><div class="stat-value">${byPriority.high || 0}</div><div class="stat-label">Open high-priority tasks</div></div>
      <div class="stat-card"><div class="stat-value">${byStage['Offers ready'] || 0}</div><div class="stat-label">Properties: Offers ready</div></div>
    `;
  }
  document.getElementById('insights-avg-stage-note').textContent = s ? s.avg_days_per_stage_note : '';
  const avgTbody = document.querySelector('#insights-avg-stage-table tbody');
  avgTbody.innerHTML = s && s.avg_days_per_stage.length
    ? s.avg_days_per_stage.map(r => `<tr><td>${escapeHtml(r.stage)}</td><td>${r.avg_days}</td></tr>`).join('')
    : `<tr><td colspan="2" class="muted">No stage-transition data yet.</td></tr>`;

  const valueTbody = document.querySelector('#insights-value-table tbody');
  valueTbody.innerHTML = s && s.pipeline_value_by_stage && s.pipeline_value_by_stage.length
    ? s.pipeline_value_by_stage.map(r => `<tr><td>${escapeHtml(r.stage)}</td><td>${fmtMoney(r.total_value) || '$0'}</td><td>${r.n_with_value}</td></tr>`).join('')
    : `<tr><td colspan="3" class="muted">No deal values entered yet.</td></tr>`;

  renderAttention(document.getElementById('insights-attention-content'), state.attention, { compact: false });
  renderActivityList(document.getElementById('insights-activity-list'), state.activity, null);
}

// ---- Modal helpers ----
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
});
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay.id); });
});

// ---- Add Task modal ----
document.getElementById('add-task-btn').addEventListener('click', () => {
  document.getElementById('task-form').reset();
  openModal('task-modal-overlay');
});

document.getElementById('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = { title: fd.get('title'), priority: fd.get('priority'), due: fd.get('due') || null, project: fd.get('project') || null };
  try {
    await postJSON('/api/tasks', body);
    closeModal('task-modal-overlay');
    await loadAll();
  } catch (err) { showError('Could not add task: ' + err.message); }
});

// ---- Archived Properties modal ----
document.getElementById('view-archived-btn').addEventListener('click', () => {
  openModal('archived-modal-overlay');
  loadArchivedProperties();
});
document.querySelector('#archived-properties-table tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.restore-property-btn');
  if (!btn) return;
  restoreProperty(btn.dataset.id);
});

// ---- Add Property modal ----
document.getElementById('add-property-btn').addEventListener('click', () => {
  document.getElementById('property-form').reset();
  openModal('property-modal-overlay');
});

document.getElementById('property-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    address: fd.get('address'), stage: fd.get('stage'), deal_url: fd.get('deal_url') || null,
    agent_name: fd.get('agent_name') || null, agent_phone: fd.get('agent_phone') || null, agent_email: fd.get('agent_email') || null,
    deal_value: fd.get('deal_value') || null
  };
  try {
    await postJSON('/api/properties', body);
    closeModal('property-modal-overlay');
    await loadAll();
  } catch (err) { showError('Could not add property: ' + err.message); }
});

// ---- Log a Call modal ----
function addFollowUpRow() {
  const row = document.createElement('div');
  row.className = 'follow-up-row';
  row.innerHTML = `
    <input type="text" placeholder="Task title" class="fu-title">
    <select class="fu-priority">
      <option value="medium" selected>Medium</option>
      <option value="high">High</option>
      <option value="low">Low</option>
    </select>
    <input type="date" class="fu-due">
    <button type="button" class="secondary-btn small fu-remove">&times;</button>
  `;
  row.querySelector('.fu-remove').addEventListener('click', () => row.remove());
  document.getElementById('log-call-task-rows').appendChild(row);
}

document.getElementById('log-call-add-task-row').addEventListener('click', addFollowUpRow);

function openLogCallModal(propertyId, propertyAddress) {
  document.getElementById('log-call-form').reset();
  document.getElementById('log-call-task-rows').innerHTML = '';
  document.querySelector('#log-call-form [name="property_id"]').value = propertyId;
  document.getElementById('log-call-property-label').textContent = propertyAddress ? `— ${propertyAddress}` : '';
  document.querySelector('#log-call-form [name="meeting_date"]').value = isoToday();
  openModal('log-call-modal-overlay');
}

document.getElementById('log-call-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const propertyId = fd.get('property_id');
  const followUpTasks = [...document.querySelectorAll('#log-call-task-rows .follow-up-row')]
    .map(row => ({
      title: row.querySelector('.fu-title').value.trim(),
      priority: row.querySelector('.fu-priority').value,
      due: row.querySelector('.fu-due').value || null
    }))
    .filter(t => t.title);
  const body = {
    meeting_title: fd.get('meeting_title'),
    meeting_date: fd.get('meeting_date'),
    summary: fd.get('summary'),
    follow_up_tasks: followUpTasks
  };
  try {
    await postJSON(`/api/properties/${propertyId}/log-call`, body);
    closeModal('log-call-modal-overlay');
    if (document.getElementById('property-detail-modal-overlay').style.display !== 'none') {
      closeModal('property-detail-modal-overlay');
    }
    await loadAll();
  } catch (err) { showError('Could not save recap: ' + err.message); }
});

// ---- Property detail modal (recap viewer + inline edit) ----
async function openPropertyDetail(id) {
  try {
    const p = await getJSON(`/api/properties/${id}`);
    document.getElementById('property-detail-address').textContent = p.address;
    const form = document.getElementById('property-detail-form');
    form.querySelector('[name="id"]').value = p.id;
    form.querySelector('[name="stage"]').value = p.stage;
    form.querySelector('[name="deal_url"]').value = p.deal_url || '';
    form.querySelector('[name="agent_name"]').value = p.agent_name || '';
    form.querySelector('[name="agent_phone"]').value = p.agent_phone || '';
    form.querySelector('[name="agent_email"]').value = p.agent_email || '';
    form.querySelector('[name="deal_value"]').value = p.deal_value || '';

    const recapsEl = document.getElementById('property-detail-recaps');
    recapsEl.innerHTML = (p.call_recaps && p.call_recaps.length)
      ? p.call_recaps.map(r => `<div class="recap-item">
          <div class="recap-title">${escapeHtml(r.meeting_title)} <span class="muted small">${fmtDate(r.meeting_date)}</span></div>
          <div class="recap-summary">${escapeHtml(r.summary)}</div>
        </div>`).join('')
      : '<p class="muted">No call recaps yet.</p>';

    const historyEl = document.getElementById('property-detail-edit-history');
    historyEl.innerHTML = (p.edit_history && p.edit_history.length)
      ? p.edit_history.map(h => `<div class="edit-history-item">
          <span class="muted small">${fmtDateTime(h.changed_at)}</span>
          <strong>${escapeHtml(h.field)}</strong>:
          ${h.old_value ? `<span class="edit-old">${escapeHtml(h.old_value)}</span> →` : '(blank) →'}
          <span class="edit-new">${escapeHtml(h.new_value ?? '(blank)')}</span>
        </div>`).join('')
      : '<p class="muted">No edits logged yet.</p>';

    document.getElementById('property-detail-log-call-btn').onclick = () => {
      closeModal('property-detail-modal-overlay');
      openLogCallModal(p.id, p.address);
    };

    openModal('property-detail-modal-overlay');
  } catch (err) { showError('Could not load property: ' + err.message); }
}

document.getElementById('property-detail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get('id');
  const body = {
    stage: fd.get('stage'), deal_url: fd.get('deal_url') || null,
    agent_name: fd.get('agent_name') || null, agent_phone: fd.get('agent_phone') || null, agent_email: fd.get('agent_email') || null,
    deal_value: fd.get('deal_value') || null
  };
  try {
    await patchJSON(`/api/properties/${id}`, body);
    closeModal('property-detail-modal-overlay');
    await loadAll();
  } catch (err) { showError('Could not save property: ' + err.message); }
});

document.querySelector('#properties-table tbody').addEventListener('click', (e) => {
  const link = e.target.closest('.property-link');
  if (!link) return;
  e.preventDefault();
  openPropertyDetail(link.dataset.id);
});
document.getElementById('properties-board-view').addEventListener('click', (e) => {
  if (e.target.closest('.card-checkboxes')) return;
  const card = e.target.closest('.property-link');
  if (!card) return;
  openPropertyDetail(card.dataset.id);
});

// ---- Offers ready card checkboxes ("I've called them" / "Not enough equity") ----
function handleCalledCheckboxChange(e) {
  const el = e.target;
  if (el.matches('.called-checkbox')) {
    toggleCalledAt(el.dataset.id, el.checked);
  } else if (el.matches('.equity-checkbox') && el.checked) {
    handleNotEnoughEquity(el.dataset.id);
  }
}
document.getElementById('overview-pipeline-board').addEventListener('change', handleCalledCheckboxChange);
document.getElementById('properties-board-view').addEventListener('change', handleCalledCheckboxChange);

// ---- Tasks table: inline edit, select, calendar export ----
document.querySelector('#tasks-table tbody').addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('.inline-edit[data-field]')) {
    const id = el.dataset.id;
    const field = el.dataset.field;
    const value = el.value || null;
    try {
      const updated = await patchJSON(`/api/tasks/${id}`, { [field]: value });
      const idx = state.tasks.findIndex(t => String(t.id) === String(id));
      if (idx !== -1) state.tasks[idx] = updated;
      renderTasksSection();
      renderOverview();
    } catch (err) { showError('Could not update task: ' + err.message); }
  } else if (el.matches('.task-select-checkbox')) {
    const id = Number(el.dataset.id);
    if (el.checked) state.selectedTaskIds.add(id); else state.selectedTaskIds.delete(id);
    updateBulkBar();
  }
});

document.querySelector('#tasks-table tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.ics-btn');
  if (!btn) return;
  const task = state.tasks.find(t => String(t.id) === String(btn.dataset.id));
  if (task) downloadICS(task);
});

document.getElementById('tasks-select-all').addEventListener('change', (e) => {
  const ids = getFilteredSortedTasks().map(t => t.id);
  if (e.target.checked) ids.forEach(id => state.selectedTaskIds.add(id));
  else ids.forEach(id => state.selectedTaskIds.delete(id));
  renderTasksSection();
});

// ---- Bulk actions ----
document.getElementById('tasks-bulk-apply').addEventListener('click', async () => {
  const status = document.getElementById('tasks-bulk-status').value;
  const priority = document.getElementById('tasks-bulk-priority').value;
  if (!status && !priority) return;
  const body = { ids: [...state.selectedTaskIds] };
  if (status) body.status = status;
  if (priority) body.priority = priority;
  try {
    await patchJSON('/api/tasks/bulk', body);
    state.selectedTaskIds.clear();
    document.getElementById('tasks-bulk-status').value = '';
    document.getElementById('tasks-bulk-priority').value = '';
    await loadAll();
  } catch (err) { showError('Bulk update failed: ' + err.message); }
});

document.getElementById('tasks-bulk-clear').addEventListener('click', () => {
  state.selectedTaskIds.clear();
  renderTasksSection();
});

// ---- Search / filter / sort wiring ----
document.getElementById('tasks-search').addEventListener('input', (e) => { state.tasksSearch = e.target.value; renderTasksSection(); });
document.getElementById('tasks-filter-status').addEventListener('change', (e) => { state.tasksFilterStatus = e.target.value; renderTasksSection(); });
document.getElementById('tasks-filter-priority').addEventListener('change', (e) => { state.tasksFilterPriority = e.target.value; renderTasksSection(); });

document.querySelectorAll('#tasks-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.tasksSort.key === key) state.tasksSort.dir = state.tasksSort.dir === 'asc' ? 'desc' : 'asc';
    else state.tasksSort = { key, dir: 'asc' };
    renderTasksSection();
  });
});

document.getElementById('properties-search').addEventListener('input', (e) => {
  state.propertiesSearch = e.target.value;
  const q = state.propertiesSearch.trim().toLowerCase();
  if (!q) state.recapMatchIds = null;
  renderPropertiesSection();
  fetchRecapMatches(q);
});
document.getElementById('properties-filter-stage').addEventListener('change', (e) => { state.propertiesFilterStage = e.target.value; renderPropertiesSection(); });

document.querySelectorAll('#properties-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.propertiesSort.key === key) state.propertiesSort.dir = state.propertiesSort.dir === 'asc' ? 'desc' : 'asc';
    else state.propertiesSort = { key, dir: 'asc' };
    renderPropertiesSection();
  });
});

// ---- Nav / view toggle / refresh ----
document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(btn.dataset.section).classList.add('active');
  });
});

document.querySelectorAll('.view-toggle').forEach(toggle => {
  toggle.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    const panel = toggle.closest('.panel');
    toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    const view = e.target.dataset.view;
    panel.querySelectorAll('[id$="-table-view"], [id$="-board-view"]').forEach(el => {
      el.style.display = el.id.endsWith(`${view}-view`) ? '' : 'none';
    });
  });
});

// ---- Mine / Everyone ownership scope toggle ----
document.querySelectorAll('.scope-toggle').forEach(toggle => {
  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    state.ownershipScope = btn.dataset.scope;
    document.querySelectorAll('.scope-toggle button').forEach(b => {
      b.classList.toggle('active', b.dataset.scope === state.ownershipScope);
    });
    renderOverview();
    renderPropertiesSection();
  });
});

document.getElementById('refresh-btn').addEventListener('click', () => loadAll());
document.getElementById('error-banner-retry').addEventListener('click', () => { hideError(); loadAll(); });
document.getElementById('error-banner-dismiss').addEventListener('click', hideError);

// ---- Boot ----
loadAll();
state.autoRefreshTimer = setInterval(loadAll, 60000);
