'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TARGETS = {
  all: {}, input: { role: 'user' }, output: { role: 'assistant', kind: 'text' },
  commands: { kind: 'tool_use' }, toolout: { kind: 'tool_result' },
};
const TARGET_LABEL = { all: 'all', input: 'your input', output: 'Claude output', commands: 'commands', toolout: 'tool output' };
const WHO = { user: 'You', assistant: 'Claude', tool: 'Tool', system: 'System' };
const whoLabel = (role) => WHO[role] || 'Claude';

const state = {
  projects: [], sessions: [], project: null, sessionId: null, target: 'all',
  mode: 'browse',                 // 'browse' | 'search'
  query: '', scope: 'global', scopeId: null,   // scope: global | project | session
  hits: [], sessMatches: [], projMatches: [], // last search results
  openMatches: [], matchPos: 0,   // in-transcript match navigation
  searchSeq: 0,                   // guards against stale out-of-order responses
  collapsed: new Set(),           // collapsed result groups
};

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(r.status); return r.json(); }

function rel(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString();
}
function abs(ts) { if (!ts) return ''; const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleString(); }
function shortModel(m) { return String(m || '').replace(/^claude-/, '').replace(/-\d{6,}$/, ''); }
function tokens(q) { return (q || '').trim().split(/\s+/).filter((t) => t.length).map((t) => t.replace(/["*]/g, '')).filter(Boolean); }
function matchesAll(text, toks) { const s = String(text || '').toLowerCase(); return toks.every((t) => s.includes(t.toLowerCase())); }
function highlight(text, q) {
  let html = esc(text);
  for (const t of tokens(q)) {
    if (t.length < 2) continue;
    const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    html = html.replace(re, '<mark>$1</mark>');
  }
  return html;
}
function toast(msg) { let t = $('#toast'); if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1400); }

// narrow mode (VS Code sidebar / phone): single column with list⇄detail drill-down + rail drawer
const isNarrow = () => window.matchMedia('(max-width: 720px)').matches;      // single-column drill-down
const isRailDrawer = () => window.matchMedia('(max-width: 1040px)').matches;  // rail collapses to a ☰ drawer
function showList() { document.body.classList.remove('show-detail'); }
function initNarrow() {
  $('#railtoggle').addEventListener('click', () => document.body.classList.toggle('show-rail'));
  $('#rail').addEventListener('click', (e) => { if (isRailDrawer() && e.target.closest('.proj')) document.body.classList.remove('show-rail'); });
  window.matchMedia('(max-width: 720px)').addEventListener('change', (m) => { if (!m.matches) showList(); });
  window.matchMedia('(max-width: 1040px)').addEventListener('change', () => document.body.classList.remove('show-rail'));
}
function hlIf(text) { return (state.mode === 'search' && state.query) ? highlight(text, state.query) : esc(text); }

// theme (persisted)
function initTheme() {
  const saved = localStorage.getItem('am-theme') || 'dark';
  applyTheme(saved);
  $('#theme').addEventListener('click', () => applyTheme(document.body.classList.contains('light') ? 'dark' : 'light'));
}
function applyTheme(t) {
  document.body.classList.toggle('light', t === 'light');
  $('#theme').textContent = (t === 'light' ? '☀' : '☾') + ' Toggle theme';
  localStorage.setItem('am-theme', t);
}

/**
 * Clipboard that works everywhere — including VS Code webview iframes, where the async
 * Clipboard API is permission-blocked. Falls back to the legacy execCommand path.
 */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* webview denies */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
async function copyWithToast(text, label) {
  toast((await copyText(text)) ? label : 'Copy failed — select the text manually');
}

// ================= data load =================
/** Empty state (design 2h): real corpus size + clickable example queries. */
function fillEmptyFlow(stats) {
  const t = $('#ef-title');
  if (t && stats) t.textContent = `Search ${stats.sessions.toLocaleString()} sessions across ${stats.projects} projects`;
  const box = $('#ef-tries');
  if (!box || box.childElementCount) return;
  for (const q of ['npm publish', 'migration plan', 'auth']) {
    const b = el('button', 'ef-try', `“${q}”`);
    b.onclick = () => { const i = $('#q'); i.value = q; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); };
    box.appendChild(b);
  }
}

async function loadOverview() {
  const [stats, data] = await Promise.all([getJSON('/api/stats'), getJSON('/api/sessions')]);
  state.projects = data.projects; state.sessions = data.sessions;
  $('#stats').textContent = `${stats.sessions} sessions · ${stats.projects} projects · ${stats.messages.toLocaleString()} messages`;
  fillEmptyFlow(stats);
  renderRail(); renderBrowse();
}
function sessionsForProject(p) { return p == null ? state.sessions : state.sessions.filter((s) => s.project === p); }

// ================= RAIL (projects) =================
function renderRail() {
  const rail = $('#rail'); rail.innerHTML = '';
  rail.appendChild(el('div', 'railhead', state.mode === 'search' ? 'Projects with matches' : 'Projects'));

  if (state.mode === 'search') return renderSearchRail(rail);

  const all = mkProjRow('All projects', state.sessions.length, state.project == null, null);
  rail.appendChild(all);
  for (const p of state.projects) rail.appendChild(mkProjRow(p.project || '(unknown)', p.sessions, state.project === p.project, p.project));
}
function mkProjRow(name, count, active, projKey, opts = {}) {
  const d = el('div', 'proj' + (active ? ' active' : ''));
  const left = el('span', 'pname'); left.title = name;
  if (opts.nameMatch) left.appendChild(el('span', 'dotmatch', '')); // green dot = name match
  left.appendChild(document.createTextNode(name));
  d.appendChild(left);
  d.appendChild(el('span', 'pcount', String(count)));
  d.onclick = opts.onClick || (() => selectProject(projKey));
  return d;
}
function renderSearchRail(rail) {
  // aggregate matched projects from name-matches, session-title matches, and message hits
  const toks = tokens(state.query);
  const agg = new Map(); // project -> {name, nameMatch, sessions:Set, messages:count}
  const bump = (proj) => { if (!agg.has(proj)) agg.set(proj, { name: proj, nameMatch: false, sessions: new Set(), messages: 0 }); return agg.get(proj); };
  for (const p of state.projMatches) bump(p).nameMatch = true;
  for (const s of state.sessMatches) bump(s.project).sessions.add(s.sessionId);
  for (const h of state.hits) { const a = bump(h.project); a.messages++; a.sessions.add(h.sessionId); }
  const rows = [...agg.values()].sort((a, b) =>
    (b.nameMatch - a.nameMatch) || (b.messages - a.messages) || (b.sessions.size - a.sessions.size));

  const total = state.hits.length + state.sessMatches.length + state.projMatches.length;
  const all = mkProjRow('All matches', total, state.scope === 'global', null, { onClick: () => { setScope('global'); doSearch(); } });
  rail.appendChild(all);
  if (!rows.length) { rail.appendChild(el('div', 'empty small', 'No projects match.')); return; }
  for (const r of rows) {
    rail.appendChild(mkProjRow(r.name || '(unknown)', r.messages || r.sessions.size, state.scope === 'project' && state.scopeId === r.name, r.name, {
      nameMatch: r.nameMatch,
      onClick: () => { setScope('project', r.name); doSearch(); },
    }));
  }
}
function selectProject(name) { // browse mode
  state.project = name; state.mode = 'browse'; renderRail(); renderBrowse();
  showList(); // narrow mode: picking a project returns to the list view
}

// ================= BROWSE (session cards) =================
function renderBrowse() {
  const list = sessionsForProject(state.project);
  $('#listhead').innerHTML = `<span>${state.project == null ? 'All sessions' : esc(state.project)}</span><span>${list.length}</span>`;
  const box = $('#list'); box.innerHTML = ''; box.className = 'list';
  for (const s of list) box.appendChild(sessionCard(s));
}
function sessionCard(s) {
  const c = el('div', 'card' + (s.sessionId === state.sessionId ? ' active' : ''));
  c.appendChild(el('div', 'ctitle', s.title || s.sessionId.slice(0, 8)));
  const meta = el('div', 'cmeta');
  meta.appendChild(el('span', 'cproj', s.project || ''));
  meta.appendChild(el('span', null, '· ' + rel(s.lastActivityMs)));
  meta.appendChild(el('span', null, '· ' + s.msgCount + ' msg'));
  if (s.gitBranch) meta.appendChild(el('span', null, '· ⎇ ' + s.gitBranch));
  const srcLabel = s.source === 'desktop-cowork' ? 'cowork' : (s.source || 'cli');
  const srcClass = s.source === 'desktop-cowork' ? ' cowork' : (s.source === 'ide' ? ' ide' : (s.source === 'codex' ? ' codex' : ''));
  meta.appendChild(el('span', 'badge' + srcClass, srcLabel));
  if (s.subagentCount) meta.appendChild(el('span', 'badge', s.subagentCount + ' sub'));
  c.appendChild(meta);
  c.onclick = () => openSession(s.sessionId);
  return c;
}

// ================= SEARCH =================
function setScope(level, id = null) { state.scope = level; state.scopeId = id; }
function bindSearch() {
  const q = $('#q');
  let deb;
  q.addEventListener('input', () => {
    clearTimeout(deb);
    const v = q.value.trim();
    if (!v) { exitSearch(); return; }
    deb = setTimeout(() => {
      state.query = v;
      if (document.body.dataset.view === 'now') switchView('sessions'); // search always lands in Sessions
      doSearch();
    }, 220); // live search fixes "nothing happens on typing"
  });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(deb); state.query = q.value.trim(); if (state.query) doSearch(); } });
  $('#scope').addEventListener('change', () => {
    const v = $('#scope').value;
    if (v === 'global') setScope('global');
    else if (v === 'project') setScope('project', state.scopeId || state.project);
    else if (v === 'session') setScope('session', state.sessionId);
    if (state.query) doSearch();
  });
}
function exitSearch() { state.mode = 'browse'; state.query = ''; setScope('global'); syncScopeSelect(); renderRail(); renderBrowse(); }
function syncScopeSelect() { $('#scope').value = state.scope; }

async function doSearch() {
  const q = state.query; if (!q) return exitSearch();
  state.mode = 'search'; syncScopeSelect();
  const seq = ++state.searchSeq;
  const toks = tokens(q);

  // scope predicate for client-side (project/session) matching
  const inScope = (s) =>
    state.scope === 'global' ? true :
    state.scope === 'project' ? s.project === state.scopeId :
    s.sessionId === state.scopeId;

  // level 1 & 2 (client-side over already-loaded sessions)
  state.projMatches = state.scope === 'global'
    ? [...new Set(state.sessions.map((s) => s.project))].filter((p) => matchesAll(p, toks))
    : [];
  state.sessMatches = state.sessions.filter((s) => inScope(s) && matchesAll(s.title, toks));

  // level 3 (server FTS, target-filtered)
  const params = new URLSearchParams({ q, scope: state.scope });
  if (state.scope !== 'global' && state.scopeId) params.set('scopeId', state.scopeId);
  const t = TARGETS[state.target] || {};
  if (t.role) params.set('role', t.role); if (t.kind) params.set('kind', t.kind);
  let hits;
  try { hits = (await getJSON('/api/search?' + params.toString())).hits; }
  catch { hits = []; }
  if (seq !== state.searchSeq) return; // a newer search superseded this one — drop stale response
  state.hits = hits;

  renderRail();
  renderResults();
  showList(); // narrow mode: a new search brings the results list forward
}

function renderResults() {
  $('#listhead').innerHTML =
    `<span>Results for “${esc(state.query)}”</span>` +
    `<span>${state.projMatches.length}p · ${state.sessMatches.length}s · ${state.hits.length}m</span>`;
  const box = $('#list'); box.innerHTML = ''; box.className = 'list results';

  const nothing = !state.projMatches.length && !state.sessMatches.length && !state.hits.length;
  if (nothing) { box.appendChild(el('div', 'empty', 'No matches. Try a different keyword or target.')); return; }

  // ----- Projects group (global scope only) -----
  if (state.scope === 'global' && state.projMatches.length) {
    addGroup(box, 'projects', 'Projects', state.projMatches.length, null, (body) => {
      for (const p of state.projMatches) {
        const r = el('div', 'gitem proj-item');
        r.innerHTML = `<span class="gi-ico">▣</span><span class="gi-main">${highlight(p, state.query)}</span>`;
        r.onclick = () => { setScope('project', p); doSearch(); };
        body.appendChild(r);
      }
    });
  }

  // ----- Sessions group (title matches). Rule 5: project-scope name-match with no inner matches -> all its sessions -----
  let sessRows = state.sessMatches;
  let sessLabel = 'Sessions';
  if (state.scope === 'project' && !state.sessMatches.length && !state.hits.length) {
    sessRows = sessionsForProject(state.scopeId); sessLabel = 'All sessions in ' + state.scopeId;
  }
  if (sessRows.length) {
    addGroup(box, 'sessions', sessLabel, sessRows.length, null, (body) => {
      for (const s of sessRows) {
        const r = el('div', 'gitem sess-item' + (s.sessionId === state.sessionId ? ' active' : ''));
        r.dataset.sid = s.sessionId;
        r.innerHTML =
          `<div class="gi-main">${highlight(s.title || s.sessionId.slice(0, 8), state.query)}</div>` +
          `<div class="gi-sub"><span class="proj">${esc(s.project)}</span> · ${s.msgCount} msg · ${rel(s.lastActivityMs)}</div>`;
        r.onclick = () => openSession(s.sessionId, { fromSession: true });
        body.appendChild(r);
      }
    });
  }

  // ----- Messages group (text-block matches, target-filtered) -----
  if (state.hits.length) {
    addGroup(box, 'messages', 'Messages', state.hits.length, TARGET_LABEL[state.target], (body) => {
      for (const h of state.hits) {
        const r = el('div', 'gitem msg-item');
        r.dataset.sid = h.sessionId; r.dataset.mi = h.msgIndex;
        const kindLabel = h.kind === 'text' ? whoLabel(h.role).toLowerCase() : h.kind.replace('_', ' ');
        r.innerHTML =
          `<div class="gi-crumb"><span class="rolepill rp-${h.kind}">${kindLabel}</span>` +
          `<span class="proj">${esc(h.project)}</span><span class="sep">›</span>` +
          `<span>${esc((h.title || h.sessionId.slice(0, 8)).slice(0, 46))}</span></div>` +
          `<div class="gi-snip">${highlight((h.snippet || '').replace(/\s+/g, ' ').trim(), state.query)}</div>`;
        r.onclick = () => openSession(h.sessionId, { msgIndex: h.msgIndex });
        body.appendChild(r);
      }
    });
  }
}
function addGroup(box, key, label, count, note, buildItems) {
  const g = el('div', 'group' + (state.collapsed.has(key) ? ' collapsed' : ''));
  const h = el('div', 'group-h');
  h.appendChild(el('span', 'gh-chevron', '▾'));
  h.appendChild(el('span', 'gh-label', label));
  h.appendChild(el('span', 'gh-count', String(count)));
  if (note) h.appendChild(el('span', 'gh-note', note));
  h.onclick = () => { state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key); g.classList.toggle('collapsed'); };
  g.appendChild(h);
  const body = el('div', 'group-body');
  buildItems(body);
  g.appendChild(body);
  box.appendChild(g);
}

// ================= TRANSCRIPT (locate + navigate) =================
// Message-type visibility (multi-select checkboxes in the transcript header).
// This is the single filter for the transcript; the global chips sync it when clicked.
const MSG_TYPES = [
  { key: 'user', label: 'You', short: 'You' },
  { key: 'claude', label: 'Claude', short: 'Claude' },
  { key: 'thinking', label: 'Thinking', short: 'Think' },
  { key: 'tool_use', label: 'Commands', short: 'Cmds' },
  { key: 'tool_result', label: 'Tool output', short: 'Output' },
  { key: 'system', label: 'System', short: 'System' },
];
const ALL_TYPE_KEYS = MSG_TYPES.map((t) => t.key);
function typeKey(m) {
  if (m.kind === 'thinking') return 'thinking';
  if (m.kind === 'tool_use') return 'tool_use';
  if (m.kind === 'tool_result') return 'tool_result';
  if (m.role === 'user') return 'user';
  if (m.role === 'system') return 'system';
  return 'claude';
}
function loadMsgTypes() {
  try {
    const saved = JSON.parse(localStorage.getItem('am-msgtypes') || 'null');
    if (Array.isArray(saved) && saved.length) return new Set(saved.filter((k) => ALL_TYPE_KEYS.includes(k)));
  } catch { /* */ }
  return new Set(ALL_TYPE_KEYS);
}
state.msgTypes = loadMsgTypes();
function saveMsgTypes() { localStorage.setItem('am-msgtypes', JSON.stringify([...state.msgTypes])); }
/** The view strip is now the single filter: mirror it onto the server-side search target. */
function syncTargetToTypes() {
  const t = state.msgTypes;
  const only = (k) => t.size === 1 && t.has(k);
  state.target = only('user') ? 'input' : only('claude') ? 'output'
    : only('tool_use') ? 'commands' : only('tool_result') ? 'toolout' : 'all';
}

async function openSession(id, opts = {}) {
  state.sessionId = id;
  const data = await getJSON('/api/session/' + encodeURIComponent(id));
  const { session: s, messages } = data;
  state.openMeta = s; state.openMessages = messages; // cached so target-filter re-renders without refetch

  // In browse mode keep the rail focused on the session's project.
  if (state.mode === 'browse' && s.project) { state.project = s.project; renderRail(); renderBrowse(); }
  // In search mode: highlight the session row + its project in the rail (panes persist).
  if (state.mode === 'search') {
    document.querySelectorAll('.sess-item, .msg-item').forEach((n) => n.classList.toggle('active', n.dataset.sid === id));
    document.querySelectorAll('.proj').forEach((n) => n.classList.toggle('active',
      n.querySelector('.pname') && n.querySelector('.pname').textContent.replace(/^●?/, '').trim() === (s.project || '')));
  } else {
    document.querySelectorAll('.card').forEach((c) => c.classList.toggle('active', false));
  }

  // all in-session matches (for highlight + navigator) = message hits in this session
  state.openMatches = state.mode === 'search'
    ? state.hits.filter((h) => h.sessionId === id).map((h) => h.msgIndex).sort((a, b) => a - b)
    : [];
  const startMi = opts.msgIndex != null ? opts.msgIndex : (state.openMatches[0] ?? null);
  state.matchPos = startMi != null ? Math.max(0, state.openMatches.indexOf(startMi)) : 0;

  if (isNarrow()) document.body.classList.add('show-detail'); // make detail visible BEFORE render, so scroll-to-match works
  renderTranscript(s, messages, startMi);
}
function renderTranscript(s, messages, targetMi) {
  const detail = $('#detail'); detail.innerHTML = '';
  const head = el('div', 'dhead');
  const back = el('button', 'btn backbtn', '‹ Results'); back.onclick = showList; head.appendChild(back);
  const crumb = el('div', 'dcrumb');
  const projSpan = el('span', 'proj'); projSpan.innerHTML = hlIf(s.project || '(unknown)'); crumb.appendChild(projSpan);
  crumb.appendChild(el('span', 'sep', '›'));
  const folder = el('span'); folder.innerHTML = hlIf(s.cwd || s.filePath || ''); folder.title = s.cwd || ''; crumb.appendChild(folder);
  head.appendChild(crumb);
  const titleEl = el('div', 'dtitle'); titleEl.innerHTML = hlIf(s.title || s.sessionId.slice(0, 8)); head.appendChild(titleEl);
  const info = el('div', 'dcrumb');
  info.appendChild(el('span', null, `${s.msgCount} messages`));
  if (s.model) { info.appendChild(el('span', 'sep', '·')); info.appendChild(el('span', null, s.model)); }
  if (s.version) { info.appendChild(el('span', 'sep', '·')); info.appendChild(el('span', null, 'v' + s.version)); }
  info.appendChild(el('span', 'sep', '·')); info.appendChild(el('span', null, rel(s.lastActivityMs)));
  head.appendChild(info);

  // ---- ACT zone: exactly one primary; secondary quiet; tertiary in ⋯ (design 2a) ----
  const actions = el('div', 'dactions');
  const resume = `cd ${JSON.stringify(s.cwd || '.')} && claude --resume ${s.sessionId}`;
  const openBtn = mkBtn('✱ Open in Claude Code', () => openInClaudeCode(s));
  openBtn.classList.add('primary');
  actions.appendChild(openBtn);
  actions.appendChild(mkBtn('⧉ Copy resume', () => copyWithToast(resume, 'Resume command copied')));
  const moreBtn = mkBtn('⋯', (e) => sessionMenu(e, s, resume));
  moreBtn.classList.add('ghost'); moreBtn.title = 'More actions';
  actions.appendChild(moreBtn);
  head.appendChild(actions);
  detail.appendChild(head);

  // ---- VIEW strip: docked to the transcript, sticky while scrolling (design 2b) ----
  const counts = {};
  for (const m of messages) counts[typeKey(m)] = (counts[typeKey(m)] || 0) + 1;
  const present = MSG_TYPES.filter((t) => counts[t.key]);
  const allOn = state.msgTypes.size >= present.length;
  const strip = el('div', 'viewstrip');
  strip.appendChild(el('span', 'vs-label', 'View'));
  const seg = el('div', 'seg');
  const allBtn = el('button', 'seg-item' + (allOn ? ' on' : ''), 'All');
  allBtn.onclick = () => { state.msgTypes = new Set(ALL_TYPE_KEYS); saveMsgTypes(); syncTargetToTypes(); rerenderTranscript({ preserveScroll: true }); if (state.query) doSearch(); };
  seg.appendChild(allBtn);
  const PRIMARY = ['user', 'claude', 'tool_use'];   // the rest fold into the strip's own ⋯
  for (const t of present.filter((t) => PRIMARY.includes(t.key))) {
    const on = !allOn && state.msgTypes.has(t.key);
    const b = el('button', 'seg-item' + (on ? ' on' : ''));
    b.appendChild(document.createTextNode(t.short || t.label));
    b.appendChild(el('span', 'seg-n', String(counts[t.key])));
    b.onclick = () => toggleType(t.key, present);
    seg.appendChild(b);
  }
  const rest = present.filter((t) => !PRIMARY.includes(t.key));
  if (rest.length) {
    const more = el('button', 'seg-item seg-more', '⋯');
    more.title = rest.map((t) => `${t.label} (${counts[t.key]})`).join(' · ');
    more.onclick = (e) => typeMenu(e, rest, counts, present);
    if (rest.some((t) => !allOn && state.msgTypes.has(t.key))) more.classList.add('on');
    seg.appendChild(more);
  }
  strip.appendChild(seg);
  strip.appendChild(el('span', 'vs-spacer'));
  if (state.openMatches.length) {
    const nav = el('div', 'matchnav');
    if (state.query) nav.appendChild(el('span', 'mn-q', state.query));
    nav.appendChild(el('span', 'mn-count', `${state.matchPos + 1}/${state.openMatches.length}`));
    const prev = el('button', 'mn-btn', '◂'); prev.onclick = () => stepMatch(-1);
    const next = el('button', 'mn-btn', '▸'); next.onclick = () => stepMatch(1);
    nav.appendChild(prev); nav.appendChild(next);
    strip.appendChild(nav);
  }
  detail.appendChild(strip);

  const msgs = el('div', 'msgs');
  const matchSet = new Set(state.openMatches);
  const shown = messages.filter((m) => state.msgTypes.has(typeKey(m)));
  shown.forEach((m) => msgs.appendChild(messageRow(m, state.query, matchSet.has(m.msgIndex), m.msgIndex === targetMi)));
  if (!shown.length) msgs.appendChild(el('div', 'empty small', 'All message types are hidden — re-enable one above.'));
  detail.appendChild(msgs);
  detail.scrollTop = 0;
  // defer to next frame so layout is flushed (hundreds of rows just inserted) before scrolling
  if (targetMi != null) requestAnimationFrame(() => scrollToMatch(targetMi));
}
/** Tertiary session actions (design 2a: T = Copy path, Reveal folder …). */
function sessionMenu(e, s, resume) {
  popMenu(e, [
    ['⧉ Copy path', () => copyWithToast(s.cwd || '', 'Path copied')],
    ['◱ Reveal folder', () => { fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ path: s.cwd }) }); }],
    ['⧉ Copy resume command', () => copyWithToast(resume, 'Resume command copied')],
    ['⧉ Copy session id', () => copyWithToast(s.sessionId, 'Session id copied')],
  ]);
}
/** Overflow for the less-used message types inside the view strip. */
function typeMenu(e, rest, counts, present) {
  popMenu(e, rest.map((t) => [
    `${state.msgTypes.has(t.key) ? '✓ ' : '   '}${t.label}  (${counts[t.key]})`,
    () => toggleType(t.key, present),
  ]));
}
/** Toggle one message type. From "All", a click isolates that type (segmented-control semantics). */
function toggleType(key, present) {
  const allOn = state.msgTypes.size >= present.length;
  if (allOn) state.msgTypes = new Set([key]);
  else if (state.msgTypes.has(key)) {
    state.msgTypes.delete(key);
    if (!state.msgTypes.size) state.msgTypes = new Set(ALL_TYPE_KEYS); // never all-hidden
  } else state.msgTypes.add(key);
  saveMsgTypes();
  syncTargetToTypes();
  rerenderTranscript({ preserveScroll: true });
  if (state.query) doSearch();   // keep the Messages group in step with the view filter
}
/** Shared popup menu (used by the board cards too). */
function popMenu(e, items) {
  document.querySelectorAll('.bmenu').forEach((m) => m.remove());
  const m = el('div', 'bmenu');
  for (const [label, fn] of items) {
    const b = el('button', 'bmenu-item', label);
    b.onclick = () => { m.remove(); fn(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = e.currentTarget ? e.currentTarget.getBoundingClientRect() : e.target.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
  m.style.top = Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8) + 'px';
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
}

function rerenderTranscript(opts = {}) { // re-apply filters to the already-open transcript
  if (!state.openMeta) return;
  const detail = $('#detail');
  const keep = opts.preserveScroll ? detail.scrollTop : 0;
  renderTranscript(state.openMeta, state.openMessages, null);
  if (opts.preserveScroll) detail.scrollTop = keep;
}

/**
 * "Open in Claude Code" handoff. Deep links can open the session but NOT scroll to a block
 * (no message-anchor param exists), so we copy the current matched block's text first — the user can
 * paste it into the conversation search / use it as context on the other side.
 */
async function openInClaudeCode(s) {
  let copied = false;
  const mi = state.openMatches.length ? state.openMatches[state.matchPos] : null;
  if (mi != null) {
    const m = (state.openMessages || []).find((x) => x.msgIndex === mi);
    if (m && m.text) {
      copied = await copyText(m.text.slice(0, 4000));
    }
  }
  let r;
  try {
    r = await (await fetch('/api/open-in-claude', { method: 'POST', body: JSON.stringify({ sessionId: s.sessionId }) })).json();
  } catch { r = { method: 'none', reason: 'service unreachable' }; }
  const blockNote = copied ? ' · block copied' : '';
  if (r.method === 'ide') toast(`Opening in ${r.ide}…${blockNote}`);
  else if (r.method === 'terminal') toast(`Opened Terminal with claude --resume${blockNote}`);
  else if (r.method === 'copy') {
    await copyText(r.resumeCmd || '');
    toast(`Resume command copied${r.reason ? ` (${r.reason})` : ''}`);
  } else toast(`Cannot open: ${r.reason || 'unknown'}`);
}
function stepMatch(dir) {
  if (!state.openMatches.length) return;
  state.matchPos = (state.matchPos + dir + state.openMatches.length) % state.openMatches.length;
  const mi = state.openMatches[state.matchPos];
  document.querySelectorAll('.msg.target').forEach((n) => n.classList.remove('target'));
  scrollToMatch(mi);
  const label = $('.mn-label'); if (label) label.textContent = `${state.matchPos + 1}/${state.openMatches.length} matches`;
}
function scrollToMatch(mi) {
  const node = document.querySelector(`.msg[data-mi="${mi}"]`);
  if (!node) return;
  node.classList.add('target');
  node.scrollIntoView({ block: 'center', behavior: 'auto' });
  node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash'); // restart flash
}
function mkBtn(label, fn) { const b = el('button', 'btn', label); b.onclick = fn; return b; }
function messageRow(m, q, isMatch, isTarget) {
  const row = el('div', 'msg k-' + m.kind + (isMatch ? ' match' : '') + (isTarget ? ' target' : ''));
  row.dataset.mi = m.msgIndex;
  const h = el('div', 'mhead');
  h.appendChild(el('span', 'who ' + m.role, whoLabel(m.role)));
  if (m.kind !== 'text') h.appendChild(el('span', 'mkind', m.kind.replace('_', ' ')));
  if (m.model) { const mm = el('span', 'mmodel', shortModel(m.model)); mm.title = m.model; h.appendChild(mm); }
  h.appendChild(el('span', 'mspacer'));
  if (isTarget && state.openMatches.length) {
    h.appendChild(el('span', 'mmatch', `MATCH ${state.matchPos + 1}/${state.openMatches.length}`));
  }
  const cp = el('button', 'mcopy', '⧉ copy'); cp.title = 'Copy this message';
  cp.onclick = (e) => { e.stopPropagation(); copyWithToast(m.text || '', 'Message copied'); };
  h.appendChild(cp);
  if (m.ts) h.appendChild(el('span', 'mts', abs(m.ts)));
  row.appendChild(h);
  const body = el('div', 'mbody');
  const text = m.text || '';
  const doHl = q && isMatch;
  if (text.length > 1600) {
    body.innerHTML = doHl ? highlight(text.slice(0, 1600), q) : esc(text.slice(0, 1600));
    const more = el('span', 'showmore', '  …show more'); more.onclick = () => { body.innerHTML = doHl ? highlight(text, q) : esc(text); };
    body.appendChild(more);
  } else {
    body.innerHTML = doHl ? highlight(text, q) : esc(text);
  }
  row.appendChild(body);
  return row;
}

// ================= INSIGHTS (retro + context book) =================
const insights = { days: 7, pollTimer: null };
// Inside the VS Code sidebar we're an iframe: target=_blank is unreliable there, so the Portrait
// opens in the same frame (its "‹ Agent History" backlink returns). In a real browser: new tab.
const EMBEDDED = window.self !== window.top;
function portraitize(a) { a.href = '/portrait.html'; if (!EMBEDDED) a.target = '_blank'; }

async function openInsights() {
  state.sessionId = null;
  if (isNarrow()) document.body.classList.add('show-detail');
  const detail = $('#detail');
  detail.innerHTML = '<div class="empty">Loading insights…</div>';
  let retro, persona;
  try {
    [retro, persona] = await Promise.all([
      getJSON('/api/retro?days=' + insights.days),
      getJSON('/api/persona/facts'),
    ]);
  } catch (e) { detail.innerHTML = '<div class="empty">Failed to load insights: ' + esc(e.message) + '</div>'; return; }
  renderInsights(retro, persona);
}

function renderInsights(retro, persona) {
  const detail = $('#detail'); detail.innerHTML = '';
  const wrap = el('div', 'insights');

  // ---- header + range switch ----
  const head = el('div', 'dhead');
  const back = el('button', 'btn backbtn', '‹ Back'); back.onclick = showList; head.appendChild(back);
  head.appendChild(el('div', 'dtitle', '✦ Insights'));
  const range = el('div', 'dactions');
  for (const d of [7, 14, 30, 90]) {
    const b = el('button', 'btn' + (insights.days === d ? ' primary' : ''), d + 'd');
    b.onclick = () => { insights.days = d; openInsights(); };
    range.appendChild(b);
  }
  head.appendChild(range);
  wrap.appendChild(head);

  // ---- portrait hero banner (the wow moment gets top billing) ----
  const t0 = retro.totals || {};
  const banner = el('a', 'iv-banner');
  portraitize(banner);
  banner.innerHTML =
    `<div class="bt">✨ Your Agent Portrait</div>` +
    `<div class="bs">The full story — your streak, where your attention flowed, and the model of you with receipts` +
    (t0.sessions ? ` · built from ${t0.sessions} sessions in this window alone` : '') + `</div>` +
    `<span class="go">›</span>`;
  wrap.appendChild(banner);

  // ---- retro: totals ----
  const t = retro.totals || {};
  const totals = el('div', 'iv-totals');
  const stat = (n, label) => { const s = el('div', 'iv-stat'); s.appendChild(el('div', 'iv-n', String(n || 0))); s.appendChild(el('div', 'iv-l', label)); return s; };
  totals.appendChild(stat(t.sessions, 'sessions'));
  totals.appendChild(stat(t.projects, 'projects'));
  totals.appendChild(stat(t.userMsgs, 'your prompts'));
  totals.appendChild(stat(retro.signals.redirect, 'corrections'));
  totals.appendChild(stat(retro.signals.interrupt, 'interrupts'));
  wrap.appendChild(totals);

  // ---- retro: per-day activity bars ----
  const byDay = new Map();
  for (const d of retro.days) { if (!byDay.has(d.day)) byDay.set(d.day, []); byDay.get(d.day).push(d); }
  const maxDay = Math.max(1, ...[...byDay.values()].map((rows) => rows.reduce((a, r) => a + r.userMsgs, 0)));
  const daysBox = el('div', 'iv-days');
  daysBox.appendChild(el('div', 'iv-h', 'Activity by day (your prompts)'));
  for (const [day, rows] of byDay) {
    const total = rows.reduce((a, r) => a + r.userMsgs, 0);
    const row = el('div', 'iv-dayrow');
    row.appendChild(el('span', 'iv-date', day.slice(5)));
    const bar = el('div', 'iv-bar');
    const fill = el('div', 'iv-fill'); fill.style.width = Math.max(2, Math.round((total / maxDay) * 100)) + '%';
    bar.appendChild(fill); row.appendChild(bar);
    row.appendChild(el('span', 'iv-count', String(total)));
    const projs = el('span', 'iv-projs', rows.slice(0, 4).map((r) => r.project).join(' · '));
    projs.title = rows.map((r) => `${r.project} (${r.userMsgs})`).join(', ');
    row.appendChild(projs);
    daysBox.appendChild(row);
  }
  if (!byDay.size) daysBox.appendChild(el('div', 'empty small', 'No activity in this window.'));
  wrap.appendChild(daysBox);

  // ---- retro: top sessions ----
  if (retro.topSessions.length) {
    const box = el('div', 'iv-days');
    box.appendChild(el('div', 'iv-h', 'Most active sessions'));
    for (const s of retro.topSessions.slice(0, 8)) {
      const r = el('div', 'gitem sess-item');
      r.innerHTML = `<div class="gi-main">${esc((s.title || s.sessionId.slice(0, 8)).slice(0, 64))}</div>` +
        `<div class="gi-sub"><span class="proj">${esc(s.project || '')}</span> · ${s.userMsgs} prompts · ${rel(s.lastActivityMs)}</div>`;
      r.onclick = () => openSession(s.sessionId);
      box.appendChild(r);
    }
    wrap.appendChild(box);
  }

  // ---- retro: recent corrections (the preference gold) ----
  const redirects = (retro.topSignals || []).filter((s) => s.kind === 'redirect');
  if (redirects.length) {
    const box = el('div', 'iv-days');
    box.appendChild(el('div', 'iv-h', 'Recent corrections you made'));
    for (const s of redirects.slice(0, 6)) {
      const r = el('div', 'gitem');
      r.innerHTML = `<div class="gi-snip">“${esc(s.excerpt.slice(0, 140))}”</div>` +
        `<div class="gi-sub"><span class="proj">${esc(s.project || '')}</span> · ${esc((s.title || '').slice(0, 44))}</div>`;
      r.onclick = () => openSession(s.sessionId, { msgIndex: s.msgIndex });
      box.appendChild(r);
    }
    wrap.appendChild(box);
  }

  // ---- context book ----
  const bookBox = el('div', 'iv-days');
  const bh = el('div', 'iv-h iv-bookhead');
  bh.appendChild(el('span', null, `Context book — ${persona.status.facts.active || 0} active · ${persona.status.facts.forming || 0} forming facts, from ${persona.status.extracted} distilled sessions`));
  const actions = el('span', 'iv-bookactions');
  const extractBtn = el('button', 'btn', `⟳ Distill more (${persona.calls.used}/${persona.calls.limit} calls today)`);
  extractBtn.onclick = () => startExtract(extractBtn);
  actions.appendChild(extractBtn);
  const copyBtn = el('button', 'btn', '⧉ Copy book');
  actions.appendChild(copyBtn);
  bh.appendChild(actions);
  bookBox.appendChild(bh);

  const factsBox = el('div', 'iv-facts');
  const factRows = (persona.facts || []).filter((f) => f.status !== 'superseded');
  if (!factRows.length) {
    factsBox.appendChild(el('div', 'empty small', 'No facts yet — hit “Distill more” (uses your own claude CLI login, no API key) or run: agent-manager persona extract'));
  }
  for (const f of factRows) {
    const r = el('div', 'iv-fact' + (f.status === 'forming' ? ' forming' : ''));
    r.appendChild(el('span', 'iv-fkind', f.kind));
    const st = el('span', 'iv-fstmt', f.statement);
    st.title = (f.evidence || []).map((e) => `“${e.quote}”`).join('\n');
    r.appendChild(st);
    r.appendChild(el('span', 'iv-fobs', f.status === 'forming' ? 'forming' : f.sessions.length + ' sessions'));
    if (f.evidence && f.evidence.length) {
      const jump = el('span', 'iv-fjump', '↗');
      jump.title = 'Open evidence';
      jump.onclick = () => openSession(f.evidence[0].sessionId, { msgIndex: f.evidence[0].msgIndex });
      r.appendChild(jump);
    }
    factsBox.appendChild(r);
  }
  bookBox.appendChild(factsBox);
  wrap.appendChild(bookBox);

  copyBtn.onclick = async () => {
    try {
      const b = await getJSON('/api/persona/book');
      await copyText(b.markdown || '');
      toast('Context book copied — paste into any CLAUDE.md');
    } catch { toast('Copy failed'); }
  };

  detail.appendChild(wrap);
  detail.scrollTop = 0;
}

async function startExtract(btn) {
  try {
    const r = await (await fetch('/api/persona/extract', { method: 'POST', body: JSON.stringify({ limit: 5 }) })).json();
    if (!r.started) { toast(r.reason === 'already running' ? 'Extraction already running…' : 'Could not start'); return; }
    btn.disabled = true; btn.textContent = '⟳ Distilling…';
    clearInterval(insights.pollTimer);
    insights.pollTimer = setInterval(async () => {
      try {
        const s = await getJSON('/api/persona/extract-status');
        if (s.running) { btn.textContent = `⟳ Distilling ${s.done}/${s.total}…`; return; }
        clearInterval(insights.pollTimer);
        const lr = s.lastResult || {};
        toast(lr.error ? 'Extraction failed: ' + lr.error : `Done: +${lr.added || 0} facts, ${lr.merged || 0} reinforced${lr.capped ? ' (daily cap hit)' : ''}`);
        openInsights();
      } catch { /* poll again */ }
    }, 2000);
  } catch { toast('Service unreachable'); }
}

// ================= boot =================
function applyWorkspaceScope() {
  const ws = new URLSearchParams(location.search).get('ws');
  if (!ws) return;
  const match = state.sessions.find((s) => s.cwd && (s.cwd === ws || s.cwd.startsWith(ws + '/') || ws.startsWith(s.cwd)));
  if (match) { state.project = match.project; renderRail(); renderBrowse(); }
}
// M5: poll the server's change version; refresh data live without disrupting the open transcript.
let lastVersion = null;
async function pollVersion() {
  try {
    const v = await getJSON('/api/version');
    if (lastVersion !== null && v.version !== lastVersion) await refreshLive();
    lastVersion = v.version;
  } catch { /* server busy/restarting */ }
}
async function refreshLive() {
  try {
    const [stats, data] = await Promise.all([getJSON('/api/stats'), getJSON('/api/sessions')]);
    state.sessions = data.sessions; state.projects = data.projects;
    $('#stats').textContent = `${stats.sessions} sessions · ${stats.projects} projects · ${stats.messages.toLocaleString()} messages`;
    renderRail();
    if (state.mode === 'browse') renderBrowse();  // search results + open transcript are left intact
    $('#live')?.classList.add('pulse'); setTimeout(() => $('#live')?.classList.remove('pulse'), 800);
  } catch { /* */ }
}

// Let users select + copy text from rows: if a drag-select is active when the click lands on a
// navigable row, swallow the click (capture phase) so it doesn't navigate and wipe the selection.
// Normal clicks (collapsed caret) pass through and still open the session.
document.addEventListener('click', (e) => {
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.type === 'Range' && sel.toString().trim() && e.target.closest('.gitem, .card, .proj')) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

// ================= NOW BOARD (task view) =================
const BOARD_COLS = [
  { key: 'active', label: 'Active', cls: 'c-active', hint: 'Detected from live Claude processes — drag is disabled here.' },
  { key: 'waiting', label: 'Waiting on you', cls: 'c-waiting', hint: 'Nothing needs you. Nice.' },
  { key: 'inprogress', label: 'In progress', cls: 'c-inprog', hint: 'No recent work in flight.' },
  { key: 'recurring', label: 'Recurring', cls: 'c-recur', hint: 'No scheduled/loop sessions.' },
  { key: 'paused', label: 'Paused', cls: 'c-paused', hint: 'Drag here to pause.' },
];
const board = {
  timer: null, project: localStorage.getItem('am-board-project') || '',
  dismissed: new Set(JSON.parse(localStorage.getItem('am-done-dismissed') || '[]')),
  doneOpen: false,
};

function switchView(v) {
  state.view = v; localStorage.setItem('am-view', v);
  document.body.dataset.view = v;
  $('#boardview').hidden = v !== 'now';
  document.querySelector('main.layout').style.display = v === 'now' ? 'none' : '';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  clearInterval(board.timer);
  if (v === 'now') { refreshBoard(); board.timer = setInterval(refreshBoard, 5000); }
}
function initTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (t) switchView(t.dataset.view);
  });
  $('#bproject').addEventListener('change', () => {
    board.project = $('#bproject').value; localStorage.setItem('am-board-project', board.project); refreshBoard();
  });
  $('#refineai').hidden = false;
  $('#refineai').addEventListener('click', openRefineSheet);
  // ⋯ overflow menu (Insights / Portrait / theme / stats)
  $('#morebtn').addEventListener('click', (e) => { e.stopPropagation(); $('#moremenu').hidden = !$('#moremenu').hidden; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.more')) $('#moremenu').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#moremenu').hidden = true; });
  window.addEventListener('resize', () => { $('#moremenu').hidden = true; });
  // Sessions is the home view (search-first librarian). One-time migration for stored 'now' defaults.
  if (!localStorage.getItem('am-view-v2')) { localStorage.setItem('am-view-v2', '1'); localStorage.setItem('am-view', 'sessions'); }
  switchView(localStorage.getItem('am-view') || 'sessions');
}

// ---- ✨ Refine with AI (manual, metered — always confirm consumption first) ----
async function openRefineSheet() {
  let pv;
  try { pv = await (await fetch('/api/classify', { method: 'POST', body: JSON.stringify({ dryRun: true }) })).json(); }
  catch { toast('Service unreachable'); return; }
  if (pv.running) { toast('Already classifying…'); pollClassify(); return; }
  document.querySelectorAll('.sheet-backdrop').forEach((n) => n.remove());
  const bd = el('div', 'sheet-backdrop');
  const sh = el('div', 'sheet');
  sh.appendChild(el('div', 'sheet-title', '✨ Refine with AI'));

  // engine picker — which subscription does the work (shown only when both are signed in)
  let engine = (pv.engine === 'codex' && pv.engines?.codex) ? 'codex' : 'claude';
  const ENGINE_INFO = {
    claude: { cmd: '`claude -p`', plan: 'your Claude plan usage (5-hour/weekly limits)' },
    codex: { cmd: '`codex exec`', plan: 'your ChatGPT plan usage' },
  };
  const p1 = el('div', 'sheet-body');
  const meter = el('div', 'sheet-meter');
  const renderTexts = () => {
    p1.innerHTML = `Will classify <b>${pv.toClassify} changed session${pv.toClassify === 1 ? '' : 's'}</b> using <b>your local ${ENGINE_INFO[engine].cmd}</b>.<br>` +
      `Head+tail excerpts only; tool outputs never leave your machine.`;
    meter.textContent = `${Math.min(pv.toClassify, 25)} calls this run · consumes ${ENGINE_INFO[engine].plan} · shared daily cap ${pv.cap} (${pv.callsUsed} used)`;
  };
  if (pv.engines?.codex) {
    const seg = el('div', 'sheet-seg');
    for (const [key, label] of [['claude', '✱ Claude Code'], ['codex', '◎ Codex (ChatGPT)']]) {
      const b = el('button', 'segbtn' + (engine === key ? ' active' : ''), label);
      b.onclick = () => { engine = key; seg.querySelectorAll('.segbtn').forEach((x) => x.classList.toggle('active', x === b)); renderTexts(); };
      seg.appendChild(b);
    }
    sh.appendChild(seg);
  }
  sh.appendChild(p1);
  sh.appendChild(meter);
  renderTexts();
  sh.appendChild(el('div', 'sheet-note', 'Both engines run on YOUR logins — subscription plans consume plan usage, API-key logins are billed per token. Applies titles, categories and status reasons only where you haven’t set one (🔒 always wins). Cached by session — unchanged sessions are never re-sent.'));
  const row = el('div', 'sheet-actions');
  const run = el('button', 'btn primary', pv.toClassify ? 'Run' : 'Nothing to classify');
  run.disabled = !pv.toClassify;
  run.onclick = async () => {
    bd.remove();
    await fetch('/api/classify', { method: 'POST', body: JSON.stringify({ engine }) });
    pollClassify();
  };
  const cancel = el('button', 'btn', 'Cancel'); cancel.onclick = () => bd.remove();
  row.appendChild(run); row.appendChild(cancel);
  sh.appendChild(row);
  bd.appendChild(sh);
  bd.onclick = (e) => { if (e.target === bd) bd.remove(); };
  document.body.appendChild(bd);
}
function pollClassify() {
  const btn = $('#refineai');
  const t = setInterval(async () => {
    let s;
    try { s = await getJSON('/api/classify/status'); } catch { return; }
    if (s.running) { btn.textContent = `✨ classifying ${s.done}/${s.total || '…'}`; return; }
    clearInterval(t);
    btn.textContent = '✨ Refine with AI';
    const r = s.lastResult || {};
    toast(r.error ? 'Classify failed: ' + r.error : `Classified ${r.done || 0} · ${r.applied || 0} refined${r.capped ? ' · daily cap hit' : ''}`);
    refreshBoard();
  }, 1200);
}

async function refreshBoard() {
  let b;
  try { b = await getJSON('/api/board' + (board.project ? '?project=' + encodeURIComponent(board.project) : '')); }
  catch { return; }
  renderBoard(b);
}

function renderBoard(b) {
  // project filter options (from the overview data when loaded)
  const sel = $('#bproject');
  if (state.projects.length && sel.options.length <= 1) {
    for (const p of state.projects) { const o = document.createElement('option'); o.value = o.textContent = p.project || '(unknown)'; sel.appendChild(o); }
    sel.value = board.project;
  }
  $('#bmeta').textContent = `${b.liveCount} live process${b.liveCount === 1 ? '' : 'es'} · ${b.idleCount} idle in Sessions · reconciled just now`;

  const cols = $('#bcols'); cols.innerHTML = '';
  for (const col of BOARD_COLS) {
    const cards = b.columns[col.key] || [];
    const lane = el('div', 'bcol ' + col.cls);
    lane.dataset.status = col.key;
    const head = el('div', 'bcol-h');
    head.appendChild(el('span', 'bdot', ''));
    head.appendChild(el('span', 'bcol-label', col.label));
    head.appendChild(el('span', 'bcol-count', String(cards.length)));
    lane.appendChild(head);
    const body = el('div', 'bcol-body');
    cards.slice(0, 30).forEach((c) => body.appendChild(boardCard(c)));
    if (cards.length > 30) body.appendChild(el('div', 'bmore', `show all ${cards.length} ↓`)).onclick = function () {
      body.innerHTML = ''; cards.forEach((c) => body.appendChild(boardCard(c)));
    };
    if (!cards.length) body.appendChild(el('div', 'bempty', col.hint));
    lane.appendChild(body);
    bindDrop(lane, col.key);
    cols.appendChild(lane);
  }

  // Recently-done strip
  const doneBar = $('#bdone'); doneBar.hidden = false; doneBar.innerHTML = '';
  const strip = el('div', 'bdone-bar');
  strip.appendChild(el('span', 'bdone-label', '✅ Recently done'));
  strip.appendChild(el('span', 'bcol-count', `${b.done.length} · 14d`));
  strip.appendChild(el('span', 'bdone-titles', b.done.slice(0, 3).map((c) => c.title).join(' · ') + (b.done.length > 3 ? ` · +${b.done.length - 3}` : '') || '—'));
  const exp = el('button', 'btn bdone-exp', board.doneOpen ? 'collapse ⌃' : 'expand ⌄');
  exp.onclick = () => { board.doneOpen = !board.doneOpen; renderBoard(b); };
  strip.appendChild(exp);
  doneBar.appendChild(strip);
  if (board.doneOpen && b.done.length) {
    const grid = el('div', 'bdone-grid');
    b.done.forEach((c) => grid.appendChild(boardCard(c)));
    doneBar.appendChild(grid);
  }
  bindDrop(doneBar, 'done');
}

function boardCard(c) {
  const card = el('div', 'bcard' + (c.status === 'waiting' ? ' waiting' : ''));
  card.draggable = true; card.dataset.sid = c.sessionId;
  card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.sessionId); card.classList.add('dragging'); });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  // drop another card ONTO this one = merge into this task
  card.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); card.classList.add('mergetarget'); });
  card.addEventListener('dragleave', () => card.classList.remove('mergetarget'));
  card.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); card.classList.remove('mergetarget');
    const sid = e.dataTransfer.getData('text/plain');
    if (!sid || sid === c.sessionId) return;
    await fetch('/api/task/merge', { method: 'POST', body: JSON.stringify({ into: c.sessionId, sessionIds: [sid] }) });
    toast('Merged into “' + c.title.slice(0, 32) + '”'); refreshBoard();
  });

  const h = el('div', 'bcard-h');
  if (c.status === 'active') h.appendChild(el('span', 'bpulse', ''));
  h.appendChild(el('span', 'bcard-title', c.title));
  if (c.locked) h.appendChild(el('span', 'block', '🔒 ' + (c.status === 'paused' ? '⏸' : c.status)));
  card.appendChild(h);

  const meta = el('div', 'bcard-proj');
  meta.appendChild(el('span', null, c.project || '(unknown)'));
  const srcLabel = c.source === 'desktop-cowork' ? 'cowork' : (c.source === 'ide' ? 'claude' : c.source || 'claude');
  meta.appendChild(el('span', 'agent a-' + (c.source === 'desktop-cowork' ? 'cowork' : c.source === 'codex' ? 'codex' : 'claude'), srcLabel));
  if (c.sessions) meta.appendChild(el('span', 'block', `⧉ ${c.sessions.length} sessions`));
  if (c.category) meta.appendChild(el('span', 'block', c.category));
  card.appendChild(meta);
  if (c.sessions) {
    const list = el('div', 'bcard-sessions');
    c.sessions.forEach((s2) => {
      const a = el('a', 'bsess-link', `↳ ${s2.title.slice(0, 40)} · ${rel(s2.lastActivityMs)}`);
      a.onclick = (e) => { e.stopPropagation(); switchView('sessions'); openSession(s2.sessionId); };
      list.appendChild(a);
    });
    card.appendChild(list);
  }

  if (c.reason) card.appendChild(el('div', 'bcard-reason', c.reason));
  const info = el('div', 'bcard-info',
    `${rel(c.lastActivityMs)}${c.model ? ' · ' + shortModel(c.model) : ''} · ${c.msgCount} msg${c.gitBranch ? ' · ⎇ ' + c.gitBranch : ''}`);
  card.appendChild(info);

  if (c.doneSuggested && !board.dismissed.has(c.sessionId)) {
    const sug = el('div', 'bsuggest');
    sug.appendChild(el('span', null, 'Looks done — mark ✅?'));
    const yes = el('button', 'btn bs-yes', '✓'); yes.onclick = () => setTask(c.sessionId, { status: 'done' });
    const no = el('button', 'btn bs-no', '✕'); no.onclick = () => { board.dismissed.add(c.sessionId); localStorage.setItem('am-done-dismissed', JSON.stringify([...board.dismissed])); refreshBoard(); };
    sug.appendChild(yes); sug.appendChild(no);
    card.appendChild(sug);
  }

  const acts = el('div', 'bcard-acts');
  const open = el('button', 'btn primary', '✱ Open'); open.onclick = () => openInClaudeCode({ sessionId: c.sessionId, cwd: c.cwd });
  const tr = el('button', 'btn', '☰ Transcript'); tr.onclick = () => { switchView('sessions'); openSession(c.sessionId); };
  const more = el('button', 'btn', '⋯'); more.onclick = (e) => cardMenu(e, c);
  acts.appendChild(open); acts.appendChild(tr); acts.appendChild(more);
  card.appendChild(acts);
  return card;
}

function cardMenu(e, c) {
  document.querySelectorAll('.bmenu').forEach((m) => m.remove());
  const m = el('div', 'bmenu');
  const add = (label, fn) => { const b = el('button', 'bmenu-item', label); b.onclick = () => { m.remove(); fn(); }; m.appendChild(b); };
  add('⏸ Pause with reason…', () => { const r = prompt('Why is this paused / what is it waiting for?', c.reason || ''); if (r !== null) setTask(c.sessionId, { status: 'paused', reason: r }); });
  add('✅ Mark done', () => setTask(c.sessionId, { status: 'done' }));
  add('🗄 Archive', () => setTask(c.sessionId, { status: 'archived' }));
  add('✏️ Rename task…', () => { const t = prompt('Task title', c.title); if (t) setTask(c.sessionId, { taskTitle: t }); });
  if (c.locked) add('🔓 Clear my status (back to auto)', () => setTask(c.sessionId, { status: 'auto' }));
  if (c.sessions) add('⧉ Unmerge this session', async () => {
    await fetch('/api/task/unmerge', { method: 'POST', body: JSON.stringify({ sessionId: c.sessionId }) }); refreshBoard();
  });
  document.body.appendChild(m);
  const r = e.target.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 240) + 'px'; m.style.top = (r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
}

async function setTask(sessionId, patch) {
  try { await fetch('/api/task/' + encodeURIComponent(sessionId), { method: 'POST', body: JSON.stringify(patch) }); } catch { /* */ }
  refreshBoard();
}

function bindDrop(lane, status) {
  lane.addEventListener('dragover', (e) => {
    e.preventDefault();
    lane.classList.toggle('droptarget', status !== 'active');
    lane.classList.toggle('dropdenied', status === 'active');
  });
  lane.addEventListener('dragleave', () => lane.classList.remove('droptarget', 'dropdenied'));
  lane.addEventListener('drop', (e) => {
    e.preventDefault(); lane.classList.remove('droptarget', 'dropdenied');
    const sid = e.dataTransfer.getData('text/plain'); if (!sid) return;
    if (status === 'active') { lane.classList.add('shake'); setTimeout(() => lane.classList.remove('shake'), 400); toast('Active is detected, not declared'); return; }
    setTask(sid, { status });
  });
}

// draggable pane resizers (persisted widths)
function initResizers() {
  const rail = $('#rail'), listcol = document.querySelector('.listcol');
  const saved = (() => { try { return JSON.parse(localStorage.getItem('am-panes') || '{}'); } catch { return {}; } })();
  if (saved.rail) rail.style.flexBasis = saved.rail + 'px';
  if (saved.list) listcol.style.flexBasis = saved.list + 'px';
  bindResizer($('#rz-rail'), rail, 150, 420, 'rail');
  bindResizer($('#rz-list'), listcol, 260, 760, 'list');
}
function bindResizer(rz, pane, min, max, key) {
  if (!rz) return;
  rz.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = pane.getBoundingClientRect().width;
    document.body.classList.add('resizing'); rz.classList.add('dragging');
    const move = (ev) => { pane.style.flexBasis = Math.min(max, Math.max(min, startW + ev.clientX - startX)) + 'px'; };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing'); rz.classList.remove('dragging');
      let s = {}; try { s = JSON.parse(localStorage.getItem('am-panes') || '{}'); } catch { /* */ }
      s[key] = Math.round(pane.getBoundingClientRect().width);
      localStorage.setItem('am-panes', JSON.stringify(s));
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
}

initTheme();
syncTargetToTypes();   // persisted view filter defines the initial search target
initNarrow();
initResizers();
bindSearch();
initTabs();
$('#insights').addEventListener('click', () => { if (document.body.dataset.view === 'now') switchView('sessions'); });
$('#insights').addEventListener('click', openInsights);
portraitize($('#portrait'));
// gentle glow until the Portrait has been visited once
if (!localStorage.getItem('am-portrait-seen')) $('#portrait').classList.add('glow');
$('#portrait').addEventListener('click', () => { localStorage.setItem('am-portrait-seen', '1'); $('#portrait').classList.remove('glow'); });
loadOverview().then(applyWorkspaceScope).catch((e) => { $('#detail').innerHTML = '<div class="empty">Failed to load. Is the index built? Run <code>agent-manager index</code>.<br>' + esc(e.message) + '</div>'; });
setInterval(pollVersion, 4000);
