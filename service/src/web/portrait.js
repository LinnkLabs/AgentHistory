'use strict';
// Agent Portrait — renders /api/viz into five scenes + an action panel. Vanilla canvas, no deps.
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString();
const PALETTE = ['#6ea8fe', '#7ee0c0', '#e0b36e', '#c98fe0', '#ff8fa3', '#8fd3ff', '#b8e986', '#f2c94c', '#8a93a6'];
const KIND_COLOR = { profile: '#8fd3ff', preference: '#6ea8fe', workflow: '#7ee0c0', interest: '#e0b36e' };

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1800); }

/** Retina-ready canvas sized to its CSS box. */
function setupCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function countUp(node, target, ms = 1400) {
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 3);
    node.textContent = fmt(Math.round(target * e));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------- scene 1: hero ----------------
function renderHero(v) {
  const first = v.first && v.first.firstTs ? new Date(v.first.firstTs) : null;
  const daysSince = first ? Math.max(1, Math.round((Date.now() - first) / 86_400_000)) : 0;
  $('#hero-sub').textContent = first
    ? `Since ${first.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })} — starting with “${(v.first.title || '').slice(0, 60)}” — you and your agents have built this together.`
    : 'Everything below is distilled from your own session history, with receipts.';
  const nums = [
    [daysSince, 'days together'],
    [v.lifetime.sessions, 'sessions'],
    [v.lifetime.prompts, 'prompts by you'],
    [v.lifetime.projects, 'projects'],
    [v.lifetime.subagents || 0, 'subagents launched'],
  ];
  const box = $('#bignums');
  for (const [val, label] of nums) {
    const b = el('div', 'bn');
    const vn = el('div', 'v', '0'); b.appendChild(vn); b.appendChild(el('div', 'l', label));
    box.appendChild(b);
    countUp(vn, val);
  }
}

// ---------------- scene 2: rhythm (heatmap + hours) ----------------
function renderHeatmap(v) {
  const byDay = new Map(v.daily.map((d) => [d.day, d]));
  const today = new Date();
  const days = [];
  for (let i = v.days - 1; i >= 0; i--) {
    const d = new Date(today - i * 86_400_000);
    days.push(d.toISOString().slice(0, 10));
  }
  // align to weeks (columns), Sunday-first rows
  const firstDow = new Date(days[0] + 'T12:00:00').getDay();
  const cols = Math.ceil((days.length + firstDow) / 7);
  const wrap = $('#heatmap').parentElement;
  const cell = Math.min(15, Math.max(9, Math.floor((wrap.clientWidth - 30) / cols) - 3));
  const gap = 3, W = cols * (cell + gap) + 30, H = 7 * (cell + gap) + 24;
  const ctx = setupCanvas($('#heatmap'), W, H);
  const max = Math.max(1, ...v.daily.map((d) => d.prompts));
  const cells = [];
  ctx.font = '10px -apple-system, sans-serif'; ctx.fillStyle = '#5b6474';
  let lastMonth = '';
  days.forEach((day, idx) => {
    const pos = idx + firstDow, col = Math.floor(pos / 7), row = pos % 7;
    const x = 30 + col * (cell + gap), y = 14 + row * (cell + gap);
    const d = byDay.get(day);
    const p = d ? d.prompts : 0;
    const a = p ? 0.18 + 0.82 * Math.pow(p / max, 0.55) : 0;
    ctx.fillStyle = p ? `rgba(110,168,254,${a.toFixed(2)})` : 'rgba(255,255,255,0.045)';
    ctx.beginPath(); ctx.roundRect(x, y, cell, cell, 3); ctx.fill();
    cells.push({ x, y, day, d });
    const m = day.slice(0, 7);
    if (row === 0 && m !== lastMonth) {
      lastMonth = m;
      ctx.fillStyle = '#5b6474';
      ctx.fillText(new Date(day + 'T12:00:00').toLocaleDateString(undefined, { month: 'short' }), x, 9);
    }
  });
  ['Mon', 'Wed', 'Fri'].forEach((lab, i) => { ctx.fillStyle = '#5b6474'; ctx.fillText(lab, 0, 14 + (1 + i * 2) * (cell + gap) + cell - 3); });

  const tip = $('#heattip');
  $('#heatmap').addEventListener('mousemove', (e) => {
    const r = e.target.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const c = cells.find((c) => mx >= c.x && mx <= c.x + cell && my >= c.y && my <= c.y + cell);
    if (!c) { tip.classList.remove('show'); return; }
    const d = c.d;
    tip.innerHTML = `<b>${c.day}</b> · ${d ? d.prompts : 0} prompts` + (d && d.topProject ? ` <span class="dim">· mostly ${esc(d.topProject)}</span>` : '');
    tip.style.left = Math.min(c.x + 18, W - 220) + 'px'; tip.style.top = (c.y - 34) + 'px';
    tip.classList.add('show');
  });
  $('#heatmap').addEventListener('mouseleave', () => tip.classList.remove('show'));

  const activeDays = v.daily.filter((d) => d.prompts > 0).length;
  $('#rhythm-lede').textContent = `Active on ${activeDays} of the last ${v.days} days · best streak ${v.streak.best} days in a row · current streak ${v.streak.current}.`;
}

function renderHours(v) {
  const W = Math.min(720, $('#hours').parentElement.clientWidth), H = 120;
  const ctx = setupCanvas($('#hours'), W, H);
  const max = Math.max(1, ...v.hours);
  const bw = W / 24;
  for (let h = 0; h < 24; h++) {
    const val = v.hours[h], bh = Math.max(2, (val / max) * (H - 30));
    const night = h < 7 || h >= 22;
    ctx.fillStyle = val === max ? '#7ee0c0' : night ? 'rgba(201,143,224,0.55)' : 'rgba(110,168,254,0.55)';
    ctx.beginPath(); ctx.roundRect(h * bw + 2, H - 18 - bh, bw - 4, bh, 3); ctx.fill();
    if (h % 6 === 0) { ctx.fillStyle = '#5b6474'; ctx.font = '10px -apple-system, sans-serif'; ctx.fillText(String(h).padStart(2, '0'), h * bw + 2, H - 5); }
  }
  const peak = v.hours.indexOf(Math.max(...v.hours));
  const label = peak >= 5 && peak < 12 ? 'a morning mover' : peak >= 12 && peak < 18 ? 'an afternoon driver' : peak >= 18 && peak < 23 ? 'an evening builder' : 'a night owl';
  $('#hours-label').innerHTML = `Your peak hour with agents is <b>${String(peak).padStart(2, '0')}:00</b> — you're ${label}.`;
}

// ---------------- scene 3: attention river ----------------
function renderRiver(v) {
  const weeks = [...new Set(v.weekly.map((r) => r.week))].sort();
  if (!weeks.length) { $('#river-lede').textContent = 'No activity in this window yet.'; return; }
  const totals = {};
  for (const r of v.weekly) totals[r.project] = (totals[r.project] || 0) + r.prompts;
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p]) => p);
  const series = top.map(() => weeks.map(() => 0));
  const other = weeks.map(() => 0);
  for (const r of v.weekly) {
    const wi = weeks.indexOf(r.week), pi = top.indexOf(r.project);
    if (pi >= 0) series[pi][wi] += r.prompts; else other[wi] += r.prompts;
  }
  if (other.some((x) => x > 0)) { top.push('everything else'); series.push(other); }

  const wrap = $('#river').parentElement;
  const W = wrap.clientWidth, H = 280;
  const ctx = setupCanvas($('#river'), W, H);
  const sums = weeks.map((_, wi) => series.reduce((a, s) => a + s[wi], 0));
  const maxSum = Math.max(1, ...sums);
  const x = (wi) => weeks.length === 1 ? W / 2 : (wi / (weeks.length - 1)) * (W - 20) + 10;
  // stacked, centered (streamgraph feel), smoothed with simple midpoint curves
  const bands = [];
  for (let wi = 0; wi < weeks.length; wi++) {
    let y0 = (H - (sums[wi] / maxSum) * (H - 60)) / 2;
    bands[wi] = series.map((s) => { const h = (s[wi] / maxSum) * (H - 60); const seg = [y0, y0 + h]; y0 += h; return seg; });
  }
  const smooth = (pts) => {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1], [cx, cy] = pts[i];
      ctx.bezierCurveTo((px + cx) / 2, py, (px + cx) / 2, cy, cx, cy);
    }
  };
  series.forEach((s, si) => {
    const topPts = weeks.map((_, wi) => [x(wi), bands[wi][si][0]]);
    const botPts = weeks.map((_, wi) => [x(wi), bands[wi][si][1]]).reverse();
    ctx.beginPath(); smooth(topPts);
    for (const [bx, by] of botPts) ctx.lineTo(bx, by);
    ctx.closePath();
    ctx.fillStyle = PALETTE[si % PALETTE.length] + 'cc';
    ctx.fill();
  });
  // hover: nearest week column summary
  const tip = $('#rivertip');
  $('#river').addEventListener('mousemove', (e) => {
    const r = e.target.getBoundingClientRect();
    const wi = Math.max(0, Math.min(weeks.length - 1, Math.round(((e.clientX - r.left) - 10) / ((W - 20) / Math.max(1, weeks.length - 1)))));
    const rows = series.map((s, si) => [top[si], s[wi]]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (!rows.length) { tip.classList.remove('show'); return; }
    tip.innerHTML = `<b>week of ${weeks[wi]}</b><br>` + rows.map(([p, n]) => `${esc(p)} · ${n}`).join('<br>');
    tip.style.left = Math.min(x(wi) + 14, W - 220) + 'px'; tip.style.top = '14px';
    tip.classList.add('show');
  });
  $('#river').addEventListener('mouseleave', () => tip.classList.remove('show'));

  const leg = $('#river-legend');
  top.forEach((p, i) => {
    const s = el('span'); const sw = el('span', 'sw'); sw.style.background = PALETTE[i % PALETTE.length];
    s.appendChild(sw); s.appendChild(document.createTextNode(p)); leg.appendChild(s);
  });
  const lead = top[0];
  $('#river-lede').textContent = `Weekly flow of your prompts across projects — “${lead}” held the most of your attention in this window.`;
}

// ---------------- scene 4: constellation ----------------
function renderConstellation(v) {
  const facts = (v.facts || []).filter((f) => f.status !== 'superseded');
  $('#const-lede').textContent = facts.length
    ? `${v.persona.facts.active || 0} confirmed · ${v.persona.facts.forming || 0} forming — distilled from ${v.persona.extracted} sessions. Confirmed facts appeared in 2+ independent sessions. Click any statement for the verbatim quote that proves it.`
    : 'No facts yet — run `agent-manager persona extract` to begin distilling, then come back.';
  renderFactWall(facts);
  const wrap = $('#constellation').parentElement;
  // the constellation is now an overview, not the content — the fact wall below carries the detail
  const W = wrap.clientWidth, H = 230;
  const ctx = setupCanvas($('#constellation'), W, H);
  const cx = W / 2, cy = H / 2;
  const kinds = ['profile', 'preference', 'workflow', 'interest'];
  const nodes = facts.map((f, i) => {
    const ring = f.status === 'active' ? 0.32 : 0.62;                    // active facts orbit closer
    const ki = kinds.indexOf(f.kind); const kn = facts.filter((x) => x.kind === f.kind);
    const slot = kn.indexOf(f) / Math.max(1, kn.length);
    const base = (ki >= 0 ? ki : 0) * (Math.PI / 2) + slot * (Math.PI / 2) + 0.25;
    return {
      f, angle: base, ring: ring + (i % 3) * 0.045,
      r: 4 + Math.min(8, (f.observations || 1) * 1.6),
      speed: 0.00006 + (i % 5) * 0.00002, x: 0, y: 0,
    };
  });
  let selected = null, hovered = null;
  const card = $('#factcard');

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    // faint starfield
    for (let i = 0; i < 70; i++) {
      const sx = (i * 97.3) % W, sy = (i * 53.7) % H;
      ctx.fillStyle = `rgba(255,255,255,${0.03 + (i % 5) * 0.008})`;
      ctx.fillRect(sx, sy, 1.4, 1.4);
    }
    // center: YOU
    const pulse = 1 + Math.sin(t / 900) * 0.05;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 60 * pulse);
    g.addColorStop(0, 'rgba(110,168,254,0.75)'); g.addColorStop(0.5, 'rgba(110,168,254,0.12)'); g.addColorStop(1, 'transparent');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 60 * pulse, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 15px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('YOU', cx, cy + 5);

    const RX = W / 2 - 70, RY = H / 2 - 22;      // ellipse fills the banner instead of a blob
    for (const n of nodes) {
      n.angle += n.speed * 16;
      n.x = cx + Math.cos(n.angle) * RX * n.ring;
      n.y = cy + Math.sin(n.angle) * RY * n.ring;
      const color = KIND_COLOR[n.f.kind] || '#8a93a6';
      const active = n.f.status === 'active';
      const isSel = selected === n || hovered === n;
      ctx.strokeStyle = active ? color + (isSel ? '88' : '30') : 'rgba(255,255,255,0.05)';
      ctx.lineWidth = isSel ? 1.4 : 0.7;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(n.x, n.y); ctx.stroke();
      if (active || isSel) {
        const gg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 3);
        gg.addColorStop(0, color + '55'); gg.addColorStop(1, 'transparent');
        ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 3, 0, 7); ctx.fill();
      }
      ctx.fillStyle = active ? color : color + '55';
      ctx.beginPath(); ctx.arc(n.x, n.y, isSel ? n.r + 2 : n.r, 0, 7); ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  const hit = (e) => {
    const r = $('#constellation').getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    return nodes.find((n) => (n.x - mx) ** 2 + (n.y - my) ** 2 < (n.r + 7) ** 2) || null;
  };
  $('#constellation').addEventListener('mousemove', (e) => { hovered = hit(e); $('#constellation').style.cursor = hovered ? 'pointer' : 'default'; });
  $('#constellation').addEventListener('click', (e) => {
    selected = hit(e);
    if (!selected) { card.classList.remove('show'); return; }
    const f = selected.f;
    const ev = (f.evidence || []).slice(0, 2);
    card.innerHTML = `<div class="fk">${esc(f.kind)} · ${f.status === 'active' ? `confirmed in ${f.sessions.length} sessions` : 'forming'}</div>` +
      `<div class="fs">${esc(f.statement)}</div>` +
      ev.map((e2) => `<div class="fq">“${esc(e2.quote)}”</div>`).join('') +
      `<div class="fm">receipts: ${ev.map((e2) => e2.sessionId.slice(0, 8) + '#' + e2.msgIndex).join(' · ')}</div>`;
    card.classList.add('show');
    focusFactRow(selected.f.key);
  });
}

/**
 * The fact wall: every statement readable BY DEFAULT, grouped by kind, confirmed first.
 * The constellation above is the overview; this is the substance.
 */
const KIND_LABEL = { profile: 'Who you are', preference: 'What you prefer', workflow: 'How you work', interest: 'What you follow' };
function renderFactWall(facts) {
  const wall = $('#factwall');
  if (!facts.length) { wall.innerHTML = ''; return; }
  const kinds = ['workflow', 'preference', 'profile', 'interest'];   // most actionable first
  const byKind = new Map(kinds.map((k) => [k, []]));
  for (const f of facts) (byKind.get(f.kind) || byKind.get('profile')).push(f);
  const rank = (f) => (f.status === 'active' ? 0 : 1) * 1000 - (f.sessions?.length || 0);

  wall.innerHTML = kinds.filter((k) => byKind.get(k).length).map((k) => {
    const list = byKind.get(k).sort((a, b) => rank(a) - rank(b));
    const nActive = list.filter((f) => f.status === 'active').length;
    return `<div class="fw-col" style="--kc:${KIND_COLOR[k] || '#8a93a6'}">
      <div class="fw-h"><span class="fw-dot"></span><span class="fw-t">${esc(KIND_LABEL[k] || k)}</span>
        <span class="fw-n">${list.length}${nActive ? ` · ${nActive} confirmed` : ''}</span></div>
      ${list.map((f) => factRow(f)).join('')}
    </div>`;
  }).join('');

  wall.querySelectorAll('.fw-row').forEach((row) => {
    row.addEventListener('click', () => {
      const open = row.classList.toggle('open');
      if (open) wall.querySelectorAll('.fw-row.open').forEach((r) => { if (r !== row) r.classList.remove('open'); });
    });
  });
}
function factRow(f) {
  const ev = (f.evidence || []).slice(0, 2);
  const confirmed = f.status === 'active';
  return `<article class="fw-row${confirmed ? ' confirmed' : ''}" data-fid="${esc(String(f.key ?? ""))}">
    <div class="fw-s">${esc(f.statement)}</div>
    <div class="fw-m">
      <span class="fw-badge">${confirmed ? `confirmed · ${f.sessions?.length || 0} sessions` : 'forming'}</span>
      ${ev.length ? `<span class="fw-ev">${ev.length} receipt${ev.length > 1 ? 's' : ''}</span>` : ''}
    </div>
    ${ev.length ? `<div class="fw-q">${ev.map((e) =>
      `<blockquote>“${esc(e.quote)}”<cite>${esc(String(e.sessionId).slice(0, 8))}#${esc(String(e.msgIndex))}</cite></blockquote>`).join('')}</div>` : ''}
  </article>`;
}
function focusFactRow(id) {
  const row = document.querySelector(`.fw-row[data-fid="${CSS.escape(String(id ?? ''))}"]`);
  if (!row) return;
  document.querySelectorAll('.fw-row.hit').forEach((r) => r.classList.remove('hit'));
  row.classList.add('hit'); row.classList.add('open');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------------- scene 5: voice ----------------
function renderVoice(v) {
  const box = $('#quotes');
  const seen = new Set();
  const rows = (v.corrections || []).filter((c) => {
    const k = c.excerpt.slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true;
  }).slice(0, 9);
  if (!rows.length) { box.appendChild(el('div', 'q', 'No corrections captured yet — that either means smooth sailing, or the miner needs more history.')); return; }
  for (const c of rows) {
    const q = el('div', 'q');
    q.innerHTML = `<div class="qt">${esc(c.excerpt.slice(0, 180))}</div>` +
      `<div class="qm">${esc(c.project || '')} · ${esc((c.title || '').slice(0, 44))} · ${c.ts ? new Date(c.ts).toLocaleDateString() : ''}</div>`;
    box.appendChild(q);
  }
}

// ---------------- scene 6: actions ----------------
function bindActions(v) {
  $('#copy-book').onclick = async () => {
    try {
      const b = await (await fetch('/api/persona/book')).json();
      await navigator.clipboard.writeText(b.markdown || '');
      toast('Context book copied — paste into CLAUDE.md');
    } catch { toast('Copy failed'); }
  };
  $('#dl-book').onclick = async () => {
    try {
      const b = await (await fetch('/api/persona/book')).json();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([b.markdown || ''], { type: 'text/markdown' }));
      a.download = 'context-book.md'; a.click();
    } catch { toast('Download failed'); }
  };
  $('#copy-rules').onclick = async () => {
    const seen = new Set();
    const rules = (v.corrections || []).filter((c) => {
      const k = c.excerpt.slice(0, 50); if (seen.has(k)) return false; seen.add(k); return true;
    }).slice(0, 10).map((c) => `- <!-- from your correction in "${(c.title || '').slice(0, 40)}" --> ${c.excerpt.replace(/\s+/g, ' ').slice(0, 160)}`);
    const text = `## Standing rules (drafted from your own corrections — edit before use)\n${rules.join('\n')}\n`;
    try { await navigator.clipboard.writeText(text); toast('Rules draft copied — edit, then add to CLAUDE.md'); } catch { toast('Copy failed'); }
  };
  $('#copy-retro').onclick = async () => {
    try { await navigator.clipboard.writeText('agent-manager retro --days 7 --digest'); toast('Command copied'); } catch { toast('Copy failed'); }
  };
  $('#foot').textContent = `Everything on this page was computed locally from your own transcripts · ${fmt(v.lifetime.messages)} messages across ${fmt(v.lifetime.sessions)} sessions · nothing leaves your machine.`;
}

// ---------------- boot ----------------
(async function boot() {
  let v;
  try { v = await (await fetch('/api/viz?days=182')).json(); }
  catch { $('#hero-sub').textContent = 'Could not load data — is the agent-manager service running?'; return; }
  renderHero(v);
  renderHeatmap(v);
  renderHours(v);
  renderRiver(v);
  renderConstellation(v);
  renderVoice(v);
  bindActions(v);
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) e.target.classList.add('on');
  }, { threshold: 0.18 });
  document.querySelectorAll('.panel').forEach((p) => obs.observe(p));
})();
