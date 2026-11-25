'use strict';

/* =========================================================
   Clock Management — cronómetro de proyectos con micro-logros
   Todo se guarda en localStorage (este navegador).
   ========================================================= */

const STORAGE_KEY = 'clock-management:v1';
const XP = { step: 10, round: 50, project: 200 };
const XP_PER_LEVEL = 500;
const AWAY_THRESHOLD = 10 * 60 * 1000; // a partir de 10 min sin la página abierta, preguntamos

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
const fmtClockHTML = (ms) => fmtClock(ms).replace(/:/g, '<span class="sep">:</span>');
function fmtShort(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const h = Math.floor(m / 60);
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}
const fmtDate = (t) => new Date(t).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtDay = (t) => new Date(t).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
const fmtTime = (t) => new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- almacenamiento ---------- */
let storageWarned = false;
function freshState() {
  return { version: 1, projects: [], selectedId: null, lastSeen: null, settings: { sound: true, theme: 'system', template: clone(DEFAULT_TEMPLATE) } };
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
  state.lastSeen = now();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch {
    if (!storageWarned) { storageWarned = true; toast('No se pudo guardar en el navegador. Usa Exportar para respaldar.'); }
  }
}

let state = normalize(load());
let flash = null; // { pid, ri?, sid? } — qué animar en el próximo render
let away = null;  // { pid, sid, from } — cronómetro que siguió corriendo con la página cerrada
function setAway(v) { away = v; state.away = v; }

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
  toast('Cronómetro corriendo. Cámbiale el nombre si quieres.');
  requestAnimationFrame(() => { const i = $('#projName'); if (i) { i.focus(); i.select(); } });
}

function startTimer(p) {
  const a = activeSession();
  if (a) a.s.end = now();
  setAway(null);
  p.sessions.push({ id: uid(), start: now(), end: null, round: isDone(p) ? null : p.currentRound });
}
function stopTimer() { const a = activeSession(); if (a) a.s.end = now(); setAway(null); }
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
  floatText(pt.x, pt.y, `+${XP.step}`);
  sfx('step');
  if (r.steps.every((s) => s.doneAt)) toast(`Todo listo en ${r.name}. Cierra la ronda.`);
  checkLevel(lvl);
}

async function completeRound(p, el) {
  if (isDone(p)) return;
  const ri = p.currentRound, r = p.rounds[ri];
  const pending = r.steps.filter((s) => !s.doneAt).length;
  if (pending && !(await ask('Faltan pasos', `Quedan ${pending} paso(s) sin marcar en "${r.name}". ¿Cerrar la ronda de todos modos?`, 'Cerrar ronda'))) return;
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
    const node = $(`.station[data-ri="${ri}"]`);
    const np = node ? centerOf(node) : pt;
    burst(pt.x, pt.y, 50, 1.2);
    burst(np.x, np.y, 40, 1);
    floatText(np.x, np.y, `+${XP.round}`);
    sfx('round');
    toast(`${r.name} completada. Sigue: ${p.rounds[p.currentRound].name}.`);
  }
  checkLevel(lvl);
}

async function reopenRound(p, ri) {
  const r = p.rounds[ri];
  if (!r) return;
  if (!(await ask('Reabrir ronda', `¿Reabrir "${r.name}"? Las rondas posteriores también se reabren.`, 'Reabrir'))) return;
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
async function deleteProject(p) {
  if (!(await ask('Eliminar proyecto', `Se borra "${p.name}" con todo su tiempo registrado. No se puede deshacer.`, 'Eliminar', true))) return;
  state.projects = state.projects.filter((x) => x !== p);
  const next = state.projects.find((x) => !isDone(x)) || state.projects[0];
  state.selectedId = next ? next.id : null;
  commit();
}
async function deleteSession(p, sid) {
  if (!(await ask('Borrar sesión', 'Se quita esta sesión y su tiempo del proyecto.', 'Borrar', true))) return;
  p.sessions = p.sessions.filter((s) => s.id !== sid);
  commit();
}
function checkLevel(prev) {
  const l = level();
  if (l > prev) {
    setTimeout(() => {
      toast(`Subiste a nivel ${l}.`);
      const s = $('.stat.level');
      const pt = s ? centerOf(s) : { x: innerWidth / 2, y: 60 };
      burst(pt.x, pt.y, 60, 1.2);
      sfx('level');
    }, 500);
  }
}

/* --- tiempo que corrió con la página cerrada --- */
function detectAway() {
  const a = activeSession();
  const last = state.lastSeen;
  if (a && last && last > a.s.start && now() - last > AWAY_THRESHOLD) {
    setAway({ pid: a.p.id, sid: a.s.id, from: last });
    state.selectedId = a.p.id;
  }
}
function resolveAway(mode) {
  if (!away) return;
  const p = getProject(away.pid);
  const s = p?.sessions.find((x) => x.id === away.sid && x.end == null);
  if (s && mode !== 'keep') {
    s.end = away.from; // cortamos la sesión en el momento en que se cerró la página
    if (mode === 'resume') p.sessions.push({ id: uid(), start: now(), end: null, round: s.round });
    sfx(mode === 'resume' ? 'start' : 'stop');
  }
  setAway(null);
  commit();
}

/* ---------- render ---------- */
function renderAll() { renderStats(); renderList(); renderMain(); tick(); }

function renderStats() {
  const xp = xpTotal(), lvl = level(), into = xp % XP_PER_LEVEL, st = streak();
  $('#stats').innerHTML = `
    <div class="stat"><span class="stat-label">Hoy</span><span class="stat-val" data-today></span></div>
    <div class="stat"><span class="stat-label">Logros hoy</span><span class="stat-val">${todayAchievements()}</span></div>
    <div class="stat"><span class="stat-label">Racha</span><span class="stat-val">${st} <small>${st === 1 ? 'día' : 'días'}</small></span></div>
    <div class="stat level"><span class="stat-label">Nivel ${lvl} · ${into}/${XP_PER_LEVEL} XP</span>
      <div class="xpbar"><i style="width:${(into / XP_PER_LEVEL) * 100}%"></i></div></div>`;
  $('#btnSound').textContent = state.settings.sound ? 'Sonido: sí' : 'Sonido: no';
}

function renderList() {
  const act = activeSession();
  const open = state.projects.filter((p) => !isDone(p)).sort((a, b) => b.createdAt - a.createdAt);
  const done = state.projects.filter(isDone).sort((a, b) => b.completedAt - a.completedAt);
  const item = (p) => `
    <button class="proj ${p.id === state.selectedId ? 'sel' : ''} ${isDone(p) ? 'done' : ''}" data-action="select" data-id="${p.id}">
      <span class="proj-name">${act && act.p === p ? '<i class="live"></i>' : ''}${esc(p.name)}</span>
      <span class="proj-time" data-timer="${p.id}" data-fmt="short"></span>
      <span class="proj-bar"><i style="width:${Math.round(progress(p) * 100)}%"></i></span>
      <span class="proj-sub">${isDone(p) ? '<b>Completado</b>' : `Ronda ${esc(p.rounds[p.currentRound]?.short)}`} · ${fmtDay(p.createdAt)}</span>
    </button>`;
  const html = (open.length ? `<div class="list-head"><span>En curso</span><span>${open.length}</span></div>${open.map(item).join('')}` : '')
    + (done.length ? `<div class="list-head"><span>Completados</span><span>${done.length}</span></div>${done.map(item).join('')}` : '');
  $('#projectList').innerHTML = html || '<p class="list-empty">Aún no hay proyectos.</p>';
}

function dialSVG() {
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0, a = (i * 6 * Math.PI) / 180, r1 = major ? 35 : 39, r2 = 43;
    const f = (n) => n.toFixed(2);
    ticks += `<line class="tk${major ? ' major' : ''}" x1="${f(50 + r1 * Math.sin(a))}" y1="${f(50 - r1 * Math.cos(a))}" x2="${f(50 + r2 * Math.sin(a))}" y2="${f(50 - r2 * Math.cos(a))}"/>`;
  }
  return `<svg class="dial" viewBox="0 0 100 100" aria-hidden="true">
    <circle class="face" cx="50" cy="50" r="47"/>${ticks}
    <line class="min-hand" data-dial-min x1="50" y1="50" x2="50" y2="27"/>
    <line class="hand" data-dial-sec x1="50" y1="60" x2="50" y2="9"/>
    <circle class="hub" cx="50" cy="50" r="3.5"/></svg>`;
}

function renderAway(p) {
  if (!away || away.pid !== p.id || !p.sessions.some((s) => s.id === away.sid && s.end == null)) return '';
  return `
    <div class="away">
      <p>Siguió contando con el navegador cerrado: <b>${fmtShort(now() - away.from)}</b> desde las ${fmtTime(away.from)}. ¿Ese tiempo cuenta?</p>
      <div class="away-actions">
        <button class="btn btn-small" data-action="away-keep">Sí, cuenta</button>
        <button class="btn btn-small" data-action="away-resume">Descontar y seguir</button>
        <button class="btn btn-small" data-action="away-stop">Descontar y pausar</button>
      </div>
    </div>`;
}

function renderMain() {
  const m = $('#main');
  const p = selected();
  if (!p) { m.innerHTML = renderEmpty(); return; }
  const running = isRunning(p), done = isDone(p), cur = p.rounds[p.currentRound];
  m.innerHTML = `
    <section class="head">
      <input id="projName" class="proj-title" value="${esc(p.name)}" spellcheck="false" aria-label="Nombre del proyecto">
      <div class="meta">
        <span>Inicio <b>${fmtDate(p.createdAt)}, ${fmtTime(p.createdAt)}</b></span>
        <span>Total <b data-timer="${p.id}" data-fmt="short"></b></span>
        <span><b>${p.sessions.length}</b> ${p.sessions.length === 1 ? 'sesión' : 'sesiones'}</span>
      </div>
      <button class="btn btn-danger btn-small" data-action="delete">Eliminar</button>
    </section>

    <section class="timer ${running ? 'running' : ''}" data-dial="${p.id}">
      ${dialSVG()}
      <div class="timer-info">
        <div class="status">${running ? '<i class="live"></i>En marcha' : 'En pausa'}</div>
        <div class="clock" data-timer="${p.id}" data-fmt="clock"></div>
        <div class="clock-sub">${done
          ? 'Proyecto completado'
          : `En <b>${esc(cur.name)}</b> llevas <span data-round-timer="${p.id}:${p.currentRound}" data-fmt="short"></span>`}</div>
      </div>
      <button class="btn btn-solid play" data-action="toggle">${running ? '<span class="bars"></span>Pausar' : '<span class="tri"></span>Iniciar'}</button>
      ${renderAway(p)}
    </section>

    ${renderPath(p)}
    ${done ? renderDoneCard(p) : renderRoundCard(p)}
    ${renderSessions(p)}`;
}

function renderEmpty() {
  const preview = {
    id: '', createdAt: now(), completedAt: null, currentRound: 0, sessions: [],
    rounds: state.settings.template.map((t) => ({ short: t.short, name: t.name, completedAt: null, steps: t.steps.map((text) => ({ id: '', text, doneAt: null })) })),
  };
  return `
    <section class="empty">
      <h2>Arranca<br>el reloj</h2>
      <p>Un clic crea el proyecto y empieza a contar. Cada paso que marques avanza el riel, estación por estación, hasta la meta.</p>
      <button class="btn btn-solid btn-big" data-action="new"><span class="tri"></span>Empezar un proyecto</button>
      ${renderPath(preview)}
    </section>`;
}

function renderPath(p) {
  const done = isDone(p);
  let html = `
    <div class="station done start"><div class="box"></div>
      <div class="label">Inicio<small>${fmtDay(p.createdAt)}</small></div></div>`;
  p.rounds.forEach((r, i) => {
    const st = r.completedAt ? 'done' : (i === p.currentRound && !done ? 'current' : 'locked');
    const total = r.steps.length, n = r.steps.filter((s) => s.doneAt).length;
    const fill = st === 'done' ? 100 : st === 'current' && total ? Math.round((n / total) * 100) : 0;
    const ticks = r.steps.map((s) => `<i class="tick ${s.doneAt ? 'lit' : ''} ${flash && flash.sid === s.id ? 'just' : ''}" title="${esc(s.text)}"></i>`).join('');
    const pop = flash && flash.pid === p.id && flash.ri === i ? 'pop' : '';
    html += `
      <div class="seg ${st}"><div class="seg-fill" style="width:${fill}%"></div><div class="ticks">${ticks}</div></div>
      <div class="station ${st} ${pop}" data-action="node" data-ri="${i}" title="${esc(r.name)}${r.completedAt ? ' · clic para reabrir' : ''}">
        <div class="box">${r.completedAt ? '✓' : esc(r.short)}</div>
        <div class="label"><span class="lname">${esc(r.name)}</span><small data-round-timer="${p.id}:${i}" data-fmt="short"></small></div>
      </div>`;
  });
  const popGoal = flash && flash.pid === p.id && done ? 'pop' : '';
  html += `
    <div class="seg ${done ? 'done' : 'locked'}"><div class="seg-fill" style="width:${done ? 100 : 0}%"></div></div>
    <div class="station goal ${done ? 'done' : 'locked'} ${popGoal}" title="Meta"><div class="box"></div><div class="label">Meta</div></div>`;
  return `<section class="path" aria-label="Avance por rondas"><div class="track">${html}</div></section>`;
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
    <section class="round">
      <div class="round-head">
        <div><div class="eyebrow">Ronda ${ri + 1} de ${p.rounds.length} · ${esc(r.short)}</div><h2>${esc(r.name)}</h2></div>
        <div class="round-count"><b>${n}</b>/${total}</div>
      </div>
      <ul class="steps">${steps}</ul>
      <form class="addstep"><input id="addStepInput" name="t" placeholder="Agregar paso a esta ronda" autocomplete="off"><button class="btn btn-small" type="submit">Agregar</button></form>
      <button class="btn complete ${ready ? 'ready' : ''}" data-action="complete">${last ? 'Cerrar ronda final y llegar a la meta' : `Cerrar ronda y pasar a ${esc(p.rounds[ri + 1].name)}`}</button>
    </section>`;
}

function renderDoneCard(p) {
  return `
    <section class="done-card">
      <span class="stamp">Completado</span>
      <p>${fmtDate(p.completedAt)}, ${fmtTime(p.completedAt)} · ${fmtShort(projectTime(p))} en total</p>
      <table class="summary">${p.rounds.map((r, i) => `<tr><td>${esc(r.name)}</td><td>${fmtShort(roundTime(p, i))}</td></tr>`).join('')}</table>
      <button class="btn btn-small" data-action="reopen" data-ri="${p.rounds.length - 1}">Reabrir última ronda</button>
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
        <td class="mono">${fmtTime(s.start)} – ${live ? 'en curso' : fmtTime(s.end)}</td>
        <td class="num">${live ? `<span data-sess="${p.id}:${s.id}"></span>` : fmtShort(s.end - s.start)}</td>
        <td><span class="tag">${esc(rn)}</span></td>
        <td>${live ? '' : `<button class="x" data-action="rmsession" data-sid="${s.id}" title="Borrar sesión" aria-label="Borrar sesión">×</button>`}</td>
      </tr>`;
  }).join('');
  return `
    <section class="sessions">
      <details id="sessDetails" ${sessionsOpen ? 'open' : ''}>
        <summary>Sesiones de tiempo · ${p.sessions.length}</summary>
        <div class="table-wrap"><table class="log">
          <thead><tr><th>Fecha</th><th>Horario</th><th class="num">Duración</th><th>Ronda</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </details>
    </section>`;
}

function tick() {
  $$('[data-timer]').forEach((e) => {
    const p = getProject(e.dataset.timer);
    if (!p) return;
    const ms = projectTime(p);
    if (e.dataset.fmt === 'short') e.textContent = fmtShort(ms);
    else e.innerHTML = fmtClockHTML(ms);
  });
  $$('[data-round-timer]').forEach((e) => {
    const [id, ri] = e.dataset.roundTimer.split(':');
    const p = getProject(id);
    if (p) e.textContent = fmtShort(roundTime(p, +ri));
  });
  $$('[data-sess]').forEach((e) => {
    const [pid, sid] = e.dataset.sess.split(':');
    const s = getProject(pid)?.sessions.find((x) => x.id === sid);
    if (s) e.textContent = fmtShort((s.end ?? now()) - s.start);
  });
  const dial = $('[data-dial]');
  if (dial) {
    const p = getProject(dial.dataset.dial);
    if (p) {
      const sec = Math.floor(projectTime(p) / 1000);
      $('[data-dial-sec]', dial).style.transform = `rotate(${sec * 6}deg)`;
      $('[data-dial-min]', dial).style.transform = `rotate(${sec * 0.1}deg)`;
    }
  }
  const t = $('[data-today]');
  if (t) t.textContent = fmtShort(todayMs());
  const a = activeSession();
  document.title = a ? `${fmtClock(projectTime(a.p))} · ${a.p.name}` : 'Clock Management';
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
// Papelitos con los colores de la hoja: amarillo señal, tinta, verde, rojo y papel.
const confettiColors = () => [cssVar('--signal'), cssVar('--ink'), cssVar('--signal'), cssVar('--go'), cssVar('--stop'), cssVar('--sheet')];
function burst(x, y, count = 30, power = 1) {
  if (reduceMotion) return;
  const colors = confettiColors();
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = (2 + Math.random() * 5) * power;
    fx.parts.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3 * power, age: 0, life: 55 + Math.random() * 45,
      size: 4 + Math.random() * 5, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, color: colors[i % colors.length],
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
  d.className = 'float-xp'; d.textContent = `${text} XP`;
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
    <div class="finish-card" role="dialog" aria-label="Proyecto completado">
      <span class="stamp">Completado</span>
      <h2>${esc(p.name)}</h2>
      <p>${p.rounds.length} rondas · ${fmtShort(projectTime(p))} en total · +${XP.project} XP</p>
      <div class="finish-actions">
        <button class="btn btn-solid" data-finish="new"><span class="tri"></span>Nuevo y arrancar</button>
        <button class="btn" data-finish="close">Cerrar</button>
      </div>
    </div>`;
  o.addEventListener('click', (e) => {
    const b = e.target.closest('[data-finish]');
    if (e.target !== o && !b) return;
    e.stopPropagation();
    o.remove();
    if (b?.dataset.finish === 'new') createProject();
  });
  document.body.appendChild(o);
  o.querySelector('[data-finish="close"]').focus();
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
    case 'away-keep': resolveAway('keep'); break;
    case 'away-resume': resolveAway('resume'); break;
    case 'away-stop': resolveAway('stop'); break;
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
  // En botones también respondemos (si no, tras un clic los atajos dejan de servir); Enter sigue activando el botón.
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
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

/* ---------- tema: sistema → claro → oscuro ---------- */
const THEME_LABEL = { system: 'Tema: sistema', light: 'Tema: claro', dark: 'Tema: oscuro' };
function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  $('#btnTheme').textContent = THEME_LABEL[t] || THEME_LABEL.system;
}
$('#btnTheme').addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
  applyTheme();
  save();
});

/* ---------- confirmación dentro de la página (en lugar de confirm()) ---------- */
function ask(title, text, okLabel = 'Aceptar', danger = false) {
  return new Promise((resolve) => {
    const d = $('#dlgConfirm');
    const ok = $('#confirmOk');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    ok.textContent = okLabel;
    ok.className = danger ? 'btn btn-danger-solid' : 'btn btn-solid';
    const done = (value) => (e) => {
      e?.preventDefault();
      ok.onclick = $('#confirmCancel').onclick = d.oncancel = null;
      d.close();
      resolve(value);
    };
    ok.onclick = done(true);
    $('#confirmCancel').onclick = done(false);
    d.oncancel = done(false); // tecla Esc
    d.showModal();
    (danger ? $('#confirmCancel') : ok).focus();
  });
}

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
    if (!(await ask('Importar respaldo', `Se cargan ${data.projects.length} proyecto(s) y se reemplazan los datos actuales.`, 'Importar', true))) return;
    state = normalize(data);
    applyTheme();
    setAway(null);
    commit();
    toast('Datos importados.');
  } catch { toast('Ese archivo no parece un respaldo válido.'); }
});

/* ---------- plantilla ---------- */
let tplWork = [];
function renderTpl() {
  $('#tplRounds').innerHTML = tplWork.map((r, i) => `
    <fieldset class="tpl-round" data-i="${i}">
      <div class="tpl-row">
        <input id="tplShort${i}" name="short" class="tpl-short" value="${esc(r.short)}" maxlength="4" aria-label="Etiqueta corta" placeholder="A">
        <input id="tplName${i}" name="name" class="tpl-name" value="${esc(r.name)}" aria-label="Nombre de la ronda" placeholder="Nombre de la ronda">
        <button type="button" class="x" data-tpl-rm="${i}" title="Quitar ronda" aria-label="Quitar ronda">×</button>
      </div>
      <textarea id="tplSteps${i}" name="steps" rows="3" placeholder="Un paso por línea">${esc(r.steps.join('\n'))}</textarea>
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
applyTheme();
away = state.away || null;
detectAway();
if (!selected() && state.projects.length) state.selectedId = state.projects[0].id;
renderAll();
if (away) toast('Un cronómetro siguió corriendo mientras no estabas.');
setInterval(tick, 1000);
// Marca de "página abierta" cada 15 s: así sabemos cuándo se cerró el navegador.
setInterval(save, 15000);
addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
