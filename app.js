'use strict';

/* =========================================================
   Clock Management — cronómetro de proyectos con micro-logros
   Todo se guarda en localStorage (este navegador).
   ========================================================= */

const STORAGE_KEY = 'clock-management:v1';
const XP = { step: 10, round: 50, project: 200 };
const XP_PER_LEVEL = 500;

const DEFAULT_TEMPLATE = [
  { short: 'A', name: 'Evaluación A', steps: ['Preparar material', 'Evaluar', 'Registrar resultados'] },
  { short: 'B', name: 'Evaluación B', steps: ['Preparar material', 'Evaluar', 'Registrar resultados'] },
  { short: 'A+B', name: 'Evaluación combinada', steps: ['Comparar A vs B', 'Conciliar diferencias', 'Resultado final'] },
];

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = (o) => JSON.parse(JSON.stringify(o));
const now = () => Date.now();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
function fmtShort(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const h = Math.floor(m / 60);
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}
const fmtDate = (t) => new Date(t).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (t) => new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* ---------- almacenamiento ---------- */
let storageWarned = false;
function freshState() {
  return { version: 1, projects: [], selectedId: null, settings: { sound: true, template: clone(DEFAULT_TEMPLATE) } };
}
function normalize(s) {
  const base = freshState();
  if (!s || !Array.isArray(s.projects)) return base;
  s.settings = Object.assign(base.settings, s.settings || {});
  if (!Array.isArray(s.settings.template) || !s.settings.template.length) s.settings.template = clone(DEFAULT_TEMPLATE);
  return s;
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch {
    if (!storageWarned) { storageWarned = true; toast('⚠️ No se pudo guardar en el navegador. Usa Exportar para respaldar.'); }
  }
}

let state = normalize(load());
let flash = null; // { pid, ri?, sid? } — elemento a animar en el próximo render

/* ---------- consultas ---------- */
const getProject = (id) => state.projects.find((p) => p.id === id);
const selected = () => getProject(state.selectedId);
const isDone = (p) => p.completedAt != null;
const isRunning = (p) => p.sessions.some((s) => s.end == null);
function activeSession() {
  for (const p of state.projects) {
    const s = p.sessions.find((x) => x.end == null);
    if (s) return { p, s };
  }
  return null;
}
function sessionsTime(p, filter) {
  const n = now();
  let t = 0;
  for (const s of p.sessions) if (!filter || filter(s)) t += (s.end ?? n) - s.start;
  return t;
}
const projectTime = (p) => sessionsTime(p);
const roundTime = (p, ri) => sessionsTime(p, (s) => s.round === ri);
function progress(p) {
  let total = 0, done = 0;
  for (const r of p.rounds) {
    total += r.steps.length + 1;
    done += r.steps.filter((s) => s.doneAt).length + (r.completedAt ? 1 : 0);
  }
  return total ? done / total : 0;
}

function achievementTimes() {
  const out = [];
  for (const p of state.projects) {
    for (const r of p.rounds) {
      for (const s of r.steps) if (s.doneAt) out.push(s.doneAt);
      if (r.completedAt) out.push(r.completedAt);
    }
    if (p.completedAt) out.push(p.completedAt);
  }
  return out;
}
function xpTotal() {
  let xp = 0;
  for (const p of state.projects) {
    for (const r of p.rounds) {
      xp += r.steps.filter((s) => s.doneAt).length * XP.step;
      if (r.completedAt) xp += XP.round;
    }
    if (p.completedAt) xp += XP.project;
  }
  return xp;
}
const level = () => Math.floor(xpTotal() / XP_PER_LEVEL) + 1;
function todayMs() {
  const s0 = startOfToday(), n = now();
  let t = 0;
  for (const p of state.projects) for (const s of p.sessions) {
    const a = Math.max(s.start, s0), b = s.end ?? n;
    if (b > a) t += b - a;
  }
  return t;
}
const todayAchievements = () => { const s0 = startOfToday(); return achievementTimes().filter((t) => t >= s0).length; };
function streak() {
  const days = new Set(achievementTimes().map(dayKey));
  for (const p of state.projects) for (const s of p.sessions) days.add(dayKey(s.start));
  const d = new Date(); d.setHours(12, 0, 0, 0);
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1); // hoy aún no cuenta: la racha sigue viva
  let n = 0;
  while (days.has(dayKey(d.getTime()))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ---------- acciones ---------- */
function commit() { save(); renderAll(); }

function createProject() {
  const p = {
    id: uid(),
    name: `Proyecto ${state.projects.length + 1}`,
    createdAt: now(),
    completedAt: null,
    currentRound: 0,
    sessions: [],
    rounds: state.settings.template.map((t) => ({
      short: t.short, name: t.name, completedAt: null,
      steps: t.steps.map((text) => ({ id: uid(), text, doneAt: null })),
    })),
  };
  state.projects.push(p);
  state.selectedId = p.id;
  startTimer(p);
  sfx('start');
  commit();
  toast('⏱ Cronómetro corriendo. Cámbiale el nombre si quieres.');
  requestAnimationFrame(() => { const i = $('#projName'); if (i) { i.focus(); i.select(); } });
}

function startTimer(p) {
  const a = activeSession();
  if (a) a.s.end = now();
  p.sessions.push({ id: uid(), start: now(), end: null, round: isDone(p) ? null : p.currentRound });
}
function stopTimer() { const a = activeSession(); if (a) a.s.end = now(); }
function toggleTimer(p) {
  if (isRunning(p)) { stopTimer(); sfx('stop'); }
  else { startTimer(p); sfx('start'); }
  commit();
}
// Cuando cambia la ronda con el cronómetro corriendo, cortamos la sesión para atribuir bien el tiempo.
function splitRunningSession(p) {
  const s = p.sessions.find((x) => x.end == null);
  if (!s) return;
  const t = now();
  s.end = t;
  if (!isDone(p)) p.sessions.push({ id: uid(), start: t, end: null, round: p.currentRound });
}

function toggleStep(p, sid, el) {
  if (isDone(p)) return;
  const r = p.rounds[p.currentRound];
  const st = r.steps.find((s) => s.id === sid);
  if (!st) return;
  if (st.doneAt) { st.doneAt = null; commit(); return; }
  const lvl = level();
  const pt = el ? centerOf(el.querySelector('.check') || el) : screenCenter();
  st.doneAt = now();
  flash = { pid: p.id, sid };
  commit();
  flash = null;
  burst(pt.x, pt.y, 26, 0.9);
  floatText(pt.x, pt.y, `+${XP.step} XP`);
  sfx('step');
  if (r.steps.every((s) => s.doneAt)) toast(`🔓 Todo listo en ${r.name}. ¡Cierra la ronda!`);
  checkLevel(lvl);
}

function completeRound(p, el) {
  if (isDone(p)) return;
  const ri = p.currentRound, r = p.rounds[ri];
  const pending = r.steps.filter((s) => !s.doneAt).length;
  if (pending && !confirm(`Faltan ${pending} paso(s) en "${r.name}". ¿Cerrar la ronda de todos modos?`)) return;
  const lvl = level();
  const pt = el ? centerOf(el) : screenCenter();
  r.completedAt = now();
  p.currentRound++;
  if (p.currentRound >= p.rounds.length) p.completedAt = now();
  splitRunningSession(p);
  flash = { pid: p.id, ri };
  commit();
  flash = null;
  if (isDone(p)) {
    celebrateProject(p);
  } else {
    const node = $(`.milestone[data-ri="${ri}"]`);
    const np = node ? centerOf(node) : pt;
    burst(pt.x, pt.y, 50, 1.2);
    burst(np.x, np.y, 40, 1);
    floatText(np.x, np.y, `+${XP.round} XP`);
    sfx('round');
    toast(`✅ ${r.name} completada. Siguiente: ${p.rounds[p.currentRound].name}`);
  }
  checkLevel(lvl);
}

function reopenRound(p, ri) {
  const r = p.rounds[ri];
  if (!r) return;
  if (!confirm(`¿Reabrir "${r.name}"? Las rondas posteriores también se reabren.`)) return;
  for (let i = ri; i < p.rounds.length; i++) p.rounds[i].completedAt = null;
  p.currentRound = ri;
  p.completedAt = null;
  splitRunningSession(p);
  commit();
}

function addStep(p, text) {
  if (!p || isDone(p) || !text.trim()) return;
  p.rounds[p.currentRound].steps.push({ id: uid(), text: text.trim(), doneAt: null });
  commit();
  const i = $('.addstep input'); if (i) i.focus();
}
function removeStep(p, sid) {
  const r = p.rounds[p.currentRound];
  r.steps = r.steps.filter((s) => s.id !== sid);
  commit();
}
function deleteProject(p) {
  if (!confirm(`¿Eliminar "${p.name}" y todo su tiempo registrado? No se puede deshacer.`)) return;
  state.projects = state.projects.filter((x) => x !== p);
  const next = state.projects.find((x) => !isDone(x)) || state.projects[0];
  state.selectedId = next ? next.id : null;
  commit();
}
function deleteSession(p, sid) {
  if (!confirm('¿Borrar esta sesión de tiempo?')) return;
  p.sessions = p.sessions.filter((s) => s.id !== sid);
  commit();
}
function checkLevel(prev) {
  const l = level();
  if (l > prev) {
    setTimeout(() => {
      toast(`⭐ ¡Subiste a nivel ${l}!`);
      const s = $('.stat.level');
      const pt = s ? centerOf(s) : { x: innerWidth / 2, y: 60 };
      burst(pt.x, pt.y, 60, 1.2);
      sfx('level');
    }, 500);
  }
}

/* ---------- render ---------- */
function renderAll() { renderStats(); renderList(); renderMain(); tick(); }

function renderStats() {
  const xp = xpTotal(), lvl = level(), into = xp % XP_PER_LEVEL, st = streak();
  $('#stats').innerHTML = `
    <div class="stat"><span class="stat-label">Hoy</span><span class="stat-val" data-today></span></div>
    <div class="stat"><span class="stat-label">Logros hoy</span><span class="stat-val">✨ ${todayAchievements()}</span></div>
    <div class="stat"><span class="stat-label">Racha</span><span class="stat-val">🔥 ${st} ${st === 1 ? 'día' : 'días'}</span></div>
    <div class="stat level"><span class="stat-label">Nivel ${lvl}</span>
      <div class="xpbar"><i style="width:${(into / XP_PER_LEVEL) * 100}%"></i></div>
      <span class="xp">${into} / ${XP_PER_LEVEL} XP</span></div>`;
  $('#btnSound').textContent = state.settings.sound ? '🔊' : '🔇';
}

function renderList() {
  const act = activeSession();
  const open = state.projects.filter((p) => !isDone(p)).sort((a, b) => b.createdAt - a.createdAt);
  const done = state.projects.filter(isDone).sort((a, b) => b.completedAt - a.completedAt);
  const item = (p) => `
    <button class="proj ${p.id === state.selectedId ? 'sel' : ''} ${isDone(p) ? 'done' : ''}" data-action="select" data-id="${p.id}">
      <span class="proj-top">
        <span class="proj-name">${act && act.p === p ? '<i class="live"></i>' : ''}${esc(p.name)}</span>
        <span class="proj-time" data-timer="${p.id}" data-fmt="short"></span>
      </span>
      <span class="proj-bar"><i style="width:${Math.round(progress(p) * 100)}%"></i></span>
      <span class="proj-sub">${isDone(p) ? '🏆 Completado' : esc(p.rounds[p.currentRound]?.name)} · ${fmtDate(p.createdAt)}</span>
    </button>`;
  const html = (open.length ? `<h3>En curso (${open.length})</h3>${open.map(item).join('')}` : '')
    + (done.length ? `<h3>Completados (${done.length})</h3>${done.map(item).join('')}` : '');
  $('#projectList').innerHTML = html || '<p class="muted small" style="text-align:center">Aún no hay proyectos.</p>';
}

function renderMain() {
  const m = $('#main');
  const p = selected();
  if (!p) {
    m.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🛤️</div>
        <h2>Construye tu camino</h2>
        <p class="muted">Un clic crea el proyecto y arranca el cronómetro. Cada paso que completes ilumina el camino hasta la meta.</p>
        <button class="primary big" data-action="new">▶ Empezar un proyecto</button>
        <p class="muted small"><kbd>Espacio</kbd> iniciar/pausar · <kbd>N</kbd> siguiente paso</p>
      </div>`;
    return;
  }
  const running = isRunning(p), done = isDone(p), cur = p.rounds[p.currentRound];
  m.innerHTML = `
    <section class="card head">
      <input id="projName" class="proj-title" value="${esc(p.name)}" spellcheck="false" aria-label="Nombre del proyecto">
      <div class="meta">Iniciado ${fmtDate(p.createdAt)}, ${fmtTime(p.createdAt)} · Total <b data-timer="${p.id}" data-fmt="short"></b> · ${p.sessions.length} ${p.sessions.length === 1 ? 'sesión' : 'sesiones'}</div>
      <button class="ghost danger small" data-action="delete">Eliminar</button>
    </section>

    <section class="card timer ${running ? 'running' : ''}">
      <div class="timer-info">
        <div class="clock" data-timer="${p.id}" data-fmt="clock"></div>
        <div class="clock-sub">${done
          ? '🏆 Proyecto completado'
          : `En <b>${esc(cur.name)}</b> llevas <span data-round-timer="${p.id}:${p.currentRound}" data-fmt="short"></span>`}</div>
      </div>
      <button class="play ${running ? 'pause' : ''}" data-action="toggle">${running ? '⏸ Pausar' : '▶ Iniciar'}</button>
    </section>

    ${renderPath(p)}
    ${done ? renderDoneCard(p) : renderRoundCard(p)}
    ${renderSessions(p)}`;
}

function renderPath(p) {
  const done = isDone(p);
  let html = `
    <div class="milestone done start"><div class="node">▶</div>
      <div class="node-label">Inicio<small>${new Date(p.createdAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</small></div></div>`;
  p.rounds.forEach((r, i) => {
    const st = r.completedAt ? 'done' : (i === p.currentRound && !done ? 'current' : 'locked');
    const total = r.steps.length, n = r.steps.filter((s) => s.doneAt).length;
    const fill = st === 'done' ? 100 : st === 'current' && total ? (n / total) * 100 : 0;
    const dots = r.steps.map((s) => {
      const just = flash && flash.sid === s.id ? 'just' : '';
      return `<i class="dot ${s.doneAt ? 'lit' : ''} ${just}" title="${esc(s.text)}"></i>`;
    }).join('');
    const pop = flash && flash.pid === p.id && flash.ri === i ? 'pop' : '';
    html += `
      <div class="seg ${st}"><div class="seg-fill" style="width:${fill}%"></div><div class="dots">${dots}</div></div>
      <div class="milestone ${st} ${pop}" data-action="node" data-ri="${i}" title="${esc(r.name)}${r.completedAt ? ' · clic para reabrir' : ''}">
        <div class="node">${r.completedAt ? '✓' : esc(r.short)}</div>
        <div class="node-label">${esc(r.name)}<small data-round-timer="${p.id}:${i}" data-fmt="short"></small></div>
      </div>`;
  });
  html += `
    <div class="seg ${done ? 'done' : 'locked'}"><div class="seg-fill" style="width:${done ? 100 : 0}%"></div></div>
    <div class="milestone ${done ? 'done trophy' : 'locked goal'} ${flash && flash.pid === p.id && done ? 'pop' : ''}">
      <div class="node">🏆</div><div class="node-label">Meta</div></div>`;
  return `<section class="card path"><div class="track">${html}</div></section>`;
}

function renderRoundCard(p) {
  const ri = p.currentRound, r = p.rounds[ri];
  const n = r.steps.filter((s) => s.doneAt).length, total = r.steps.length;
  const ready = n === total;
  const nextId = r.steps.find((s) => !s.doneAt)?.id;
  const steps = r.steps.map((s) => `
    <li class="step ${s.doneAt ? 'done' : ''} ${s.id === nextId ? 'next' : ''} ${flash && flash.sid === s.id ? 'just' : ''}" data-action="step" data-sid="${s.id}">
      <span class="check">${s.doneAt ? '✓' : ''}</span>
      <span class="step-text">${esc(s.text)}</span>
      ${s.doneAt ? `<span class="step-time">${fmtTime(s.doneAt)}</span>` : ''}
      <button class="x" data-action="rmstep" data-sid="${s.id}" title="Quitar paso" aria-label="Quitar paso">×</button>
    </li>`).join('');
  const last = ri === p.rounds.length - 1;
  return `
    <section class="card round">
      <div class="round-head">
        <div><div class="eyebrow">Ronda ${ri + 1} de ${p.rounds.length}</div><h2>${esc(r.name)}</h2></div>
        <div class="round-count"><b>${n}</b>/${total}</div>
      </div>
      <ul class="steps">${steps}</ul>
      <form class="addstep"><input name="t" placeholder="+ Agregar paso a esta ronda" autocomplete="off"><button class="ghost" type="submit">Agregar</button></form>
      <button class="complete ${ready ? 'ready' : ''}" data-action="complete">${last ? '🏁 Completar ronda final' : `✓ Completar ronda y avanzar a ${esc(p.rounds[ri + 1].name)} →`}</button>
    </section>`;
}

function renderDoneCard(p) {
  return `
    <section class="card done-card">
      <div class="big-emoji">🏆</div>
      <h2>¡Proyecto completado!</h2>
      <p class="muted">Terminado ${fmtDate(p.completedAt)}, ${fmtTime(p.completedAt)} · ${fmtShort(projectTime(p))} en total</p>
      <div class="round-summary">${p.rounds.map((r, i) => `<div><b>${esc(r.name)}</b><span>${fmtShort(roundTime(p, i))}</span></div>`).join('')}</div>
      <button class="ghost" data-action="reopen" data-ri="${p.rounds.length - 1}">Reabrir última ronda</button>
    </section>`;
}

let sessionsOpen = false;
function renderSessions(p) {
  if (!p.sessions.length) return '';
  const rows = [...p.sessions].reverse().map((s) => {
    const live = s.end == null;
    const rn = s.round == null ? 'Extra' : (p.rounds[s.round]?.short ?? '?');
    return `
      <tr class="${live ? 'live-row' : ''}">
        <td>${fmtDate(s.start)}</td>
        <td>${fmtTime(s.start)} – ${live ? 'en curso' : fmtTime(s.end)}</td>
        <td class="num">${live ? `<span data-sess="${p.id}:${s.id}"></span>` : fmtShort(s.end - s.start)}</td>
        <td><span class="tag">${esc(rn)}</span></td>
        <td>${live ? '' : `<button class="x" data-action="rmsession" data-sid="${s.id}" title="Borrar sesión" aria-label="Borrar sesión">×</button>`}</td>
      </tr>`;
  }).join('');
  return `
    <section class="card sessions">
      <details id="sessDetails" ${sessionsOpen ? 'open' : ''}>
        <summary>Sesiones de tiempo (${p.sessions.length})</summary>
        <div class="table-wrap"><table>${rows}</table></div>
      </details>
    </section>`;
}

function tick() {
  $$('[data-timer]').forEach((e) => {
    const p = getProject(e.dataset.timer);
    if (p) e.textContent = e.dataset.fmt === 'short' ? fmtShort(projectTime(p)) : fmtClock(projectTime(p));
  });
  $$('[data-round-timer]').forEach((e) => {
    const [id, ri] = e.dataset.roundTimer.split(':');
    const p = getProject(id);
    if (p) e.textContent = e.dataset.fmt === 'clock' ? fmtClock(roundTime(p, +ri)) : fmtShort(roundTime(p, +ri));
  });
  $$('[data-sess]').forEach((e) => {
    const [pid, sid] = e.dataset.sess.split(':');
    const s = getProject(pid)?.sessions.find((x) => x.id === sid);
    if (s) e.textContent = fmtShort((s.end ?? now()) - s.start);
  });
  const t = $('[data-today]');
  if (t) t.textContent = fmtShort(todayMs());
  const a = activeSession();
  document.title = a ? `⏱ ${fmtClock(projectTime(a.p))} · ${a.p.name}` : 'Clock Management';
}

/* ---------- efectos: confeti, texto flotante, sonido ---------- */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fx = { c: $('#fx'), ctx: null, parts: [], raf: 0 };
fx.ctx = fx.c.getContext('2d');
function fxResize() {
  const dpr = devicePixelRatio || 1;
  fx.c.width = innerWidth * dpr; fx.c.height = innerHeight * dpr;
  fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
fxResize();
addEventListener('resize', fxResize);
const COLORS = ['#8b5cf6', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#60a5fa'];
function burst(x, y, count = 30, power = 1) {
  if (reduceMotion) return;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = (2 + Math.random() * 5) * power;
    fx.parts.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3 * power, age: 0, life: 55 + Math.random() * 45,
      size: 4 + Math.random() * 5, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, color: COLORS[i % COLORS.length],
    });
  }
  if (!fx.raf) fx.raf = requestAnimationFrame(fxLoop);
}
function fxLoop() {
  const ctx = fx.ctx;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  fx.parts = fx.parts.filter((p) => p.age < p.life);
  for (const p of fx.parts) {
    p.age++; p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.18; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
    ctx.restore();
  }
  fx.raf = fx.parts.length ? requestAnimationFrame(fxLoop) : 0;
}
function floatText(x, y, text) {
  const d = document.createElement('div');
  d.className = 'float-xp'; d.textContent = text;
  d.style.left = `${x}px`; d.style.top = `${y}px`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 1200);
}
function centerOf(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
const screenCenter = () => ({ x: innerWidth / 2, y: innerHeight / 2 });

let actx;
const SFX = {
  start: [[523, 784], 0.12, 0.08],
  stop: [[784, 523], 0.12, 0.08],
  step: [[988, 1319], 0.1, 0.06],
  round: [[523, 659, 784, 1047], 0.18, 0.09],
  project: [[523, 659, 784, 1047, 784, 1047, 1319], 0.24, 0.11],
  level: [[659, 880, 1175, 1568], 0.16, 0.08],
};
function sfx(name) {
  if (!state.settings.sound || !SFX[name]) return;
  const [freqs, dur, gap] = SFX[name];
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime + 0.01;
    freqs.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      const t = t0 + i * gap;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.05);
    });
  } catch { /* sin audio, no pasa nada */ }
}

function celebrateProject(p) {
  sfx('project');
  const w = innerWidth, h = innerHeight;
  [[0.2, 0.65], [0.8, 0.65], [0.5, 0.4], [0.3, 0.3], [0.7, 0.3]]
    .forEach(([x, y], i) => setTimeout(() => burst(w * x, h * y, 60, 1.4), i * 220));
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `
    <div class="trophy-card" role="dialog" aria-label="Proyecto completado">
      <div class="big-emoji">🏆</div>
      <h2>¡${esc(p.name)} completado!</h2>
      <p class="muted">${p.rounds.length} rondas · ${fmtShort(projectTime(p))} en total · +${XP.project} XP</p>
      <button class="primary">¡Vamos por el siguiente!</button>
    </div>`;
  o.addEventListener('click', (e) => { if (e.target === o || e.target.tagName === 'BUTTON') o.remove(); });
  document.body.appendChild(o);
  o.querySelector('button').focus();
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ---------- eventos ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const p = selected();
  switch (t.dataset.action) {
    case 'new': createProject(); break;
    case 'select': state.selectedId = t.dataset.id; commit(); break;
    case 'toggle': if (p) toggleTimer(p); break;
    case 'step': if (p) toggleStep(p, t.dataset.sid, t); break;
    case 'rmstep': if (p) removeStep(p, t.dataset.sid); break;
    case 'complete': if (p) completeRound(p, t); break;
    case 'node': if (p && p.rounds[+t.dataset.ri]?.completedAt) reopenRound(p, +t.dataset.ri); break;
    case 'reopen': if (p) reopenRound(p, +t.dataset.ri); break;
    case 'delete': if (p) deleteProject(p); break;
    case 'rmsession': if (p) deleteSession(p, t.dataset.sid); break;
  }
});

document.addEventListener('submit', (e) => {
  if (!e.target.classList.contains('addstep')) return;
  e.preventDefault();
  addStep(selected(), e.target.t.value);
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'projName') return;
  const p = selected();
  if (!p) return;
  p.name = e.target.value.trim() || 'Sin nombre';
  save();
  renderList();
  tick();
});

document.addEventListener('toggle', (e) => {
  if (e.target.id === 'sessDetails') sessionsOpen = e.target.open;
}, true);

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'projName' && e.key === 'Enter') { e.target.blur(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || $('dialog[open]') || $('.overlay')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName)) return;
  const p = selected();
  if (!p) return;
  if (e.code === 'Space') {
    e.preventDefault();
    toggleTimer(p);
  } else if (e.key.toLowerCase() === 'n' && !isDone(p)) {
    e.preventDefault();
    const next = p.rounds[p.currentRound].steps.find((s) => !s.doneAt);
    if (next) toggleStep(p, next.id, $(`.step[data-sid="${next.id}"]`));
    else completeRound(p, $('.complete'));
  }
});

$('#btnSound').addEventListener('click', () => {
  state.settings.sound = !state.settings.sound;
  commit();
  sfx('step');
});

$('#btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `clock-management-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#fileImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.projects)) throw new Error('formato');
    if (!confirm(`¿Importar ${data.projects.length} proyecto(s)? Esto reemplaza los datos actuales.`)) return;
    state = normalize(data);
    commit();
    toast('📥 Datos importados');
  } catch { toast('Ese archivo no parece un respaldo válido.'); }
});

/* ---------- plantilla ---------- */
let tplWork = [];
function renderTpl() {
  $('#tplRounds').innerHTML = tplWork.map((r, i) => `
    <fieldset class="tpl-round" data-i="${i}">
      <div class="tpl-row">
        <input name="short" class="tpl-short" value="${esc(r.short)}" maxlength="4" aria-label="Etiqueta corta" placeholder="A">
        <input name="name" class="tpl-name" value="${esc(r.name)}" aria-label="Nombre de la ronda" placeholder="Nombre de la ronda">
        <button type="button" class="x" data-tpl-rm="${i}" title="Quitar ronda" aria-label="Quitar ronda">×</button>
      </div>
      <textarea name="steps" rows="3" placeholder="Un paso por línea">${esc(r.steps.join('\n'))}</textarea>
    </fieldset>`).join('');
}
function readTpl() {
  return $$('.tpl-round').map((f) => ({
    short: f.querySelector('[name=short]').value.trim() || '?',
    name: f.querySelector('[name=name]').value.trim() || 'Ronda',
    steps: f.querySelector('[name=steps]').value.split('\n').map((s) => s.trim()).filter(Boolean),
  }));
}
$('#btnTemplate').addEventListener('click', () => {
  tplWork = clone(state.settings.template);
  renderTpl();
  $('#dlgTemplate').showModal();
});
$('#tplAdd').addEventListener('click', () => {
  tplWork = readTpl();
  tplWork.push({ short: String(tplWork.length + 1), name: `Ronda ${tplWork.length + 1}`, steps: [] });
  renderTpl();
});
$('#tplReset').addEventListener('click', () => { tplWork = clone(DEFAULT_TEMPLATE); renderTpl(); });
$('#tplRounds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tpl-rm]');
  if (!b) return;
  tplWork = readTpl();
  if (tplWork.length <= 1) { toast('Debe quedar al menos una ronda.'); return; }
  tplWork.splice(+b.dataset.tplRm, 1);
  renderTpl();
});
$('#tplForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  state.settings.template = readTpl();
  commit();
  toast('Plantilla guardada para proyectos nuevos.');
});

/* ---------- arranque ---------- */
if (!selected() && state.projects.length) state.selectedId = state.projects[0].id;
renderAll();
setInterval(tick, 1000);
// Guarda también al cambiar de pestaña, por si acaso.
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
