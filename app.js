'use strict';

/* =========================================================
   Clock Management — cronómetro de proyectos con micro-logros
   Todo se guarda en localStorage (este navegador).
   ========================================================= */

const APP_VERSION = '1.0.0';

// Con ?test (página tests/) todo usa llaves aparte: las pruebas nunca tocan tus datos.
const TEST_MODE = /[?&]test(?:[=&]|$)/.test(location.search);
const NS = TEST_MODE ? 'clock-management-test' : 'clock-management';
if (TEST_MODE) { // las pruebas leen aquí cualquier error que ocurra en la app
  window.__errors = [];
  addEventListener('error', (e) => window.__errors.push(String(e.message || e.error)));
  addEventListener('unhandledrejection', (e) => window.__errors.push(`Promesa: ${e.reason?.message || e.reason}`));
}

const STORAGE_KEY = `${NS}:v1`;
const XP = { step: 10, round: 50, project: 200 };
const XP_PER_LEVEL = 500;
const AWAY_THRESHOLD = 10 * 60 * 1000; // a partir de 10 min sin la página abierta, preguntamos

// Ritmo: minutos seguidos sin pausar → multiplicador de XP.
// Meta: tramos de 2 h sin pausa. `hold` = ms que hay que mantener "Pausar" en ese tramo:
// crece mientras más ritmo llevas (máximo entre 1 h 30 y 2 h). Antes de 30 min y después
// de la meta la pausa es libre (después de la meta cuenta como "pit stop merecido").
const PACE = [
  { min: 0, mult: 1, label: 'Calentando', hold: 0 },
  { min: 30, mult: 1.5, label: 'En ritmo', hold: 1000 },
  { min: 60, mult: 2, label: 'A fondo', hold: 1800 },
  { min: 90, mult: 2.5, label: 'Vuelta rápida', hold: 2600 },
  { min: 120, mult: 3, label: 'Tramo completo', hold: 0 },
];
const GOAL_MIN = PACE[PACE.length - 1].min;

// Modo prueba: datos en otra llave y reloj que se puede adelantar.
const DEBUG_KEY = `${NS}:debug`;
const MODE_KEY = `${NS}:mode`;
let debugMode = false;
try { debugMode = localStorage.getItem(MODE_KEY) === 'debug'; } catch { /* sin storage */ }
const storageKey = () => (debugMode ? DEBUG_KEY : STORAGE_KEY);
// "Última vez que la página estuvo abierta": llave propia, para que una pestaña vieja nunca
// sobrescriba tus datos solo por actualizar esta marca.
const seenKey = () => `${NS}:${debugMode ? 'debug-' : ''}seen`;
let timeOffset = 0; // ms que se adelantó el reloj (solo en modo prueba)
let frozen = false; // true justo antes de recargar al cambiar de modo, para no sobrescribir

const DEFAULT_TPL_ID = 'tpl-default';
const DEFAULT_TPL_NAME = 'Plantilla 1';
// Punto de partida mínimo (al empezar de cero y con "Nueva"): una ronda con dos pasos.
const DEFAULT_ROUNDS = [{ short: '01', name: 'Ronda 01', steps: ['Paso 01', 'Paso 02'] }];

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = (o) => JSON.parse(JSON.stringify(o));
const now = () => Date.now() + timeOffset;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
const fmtClockHTML = (ms) => fmtClock(ms).replace(/:/g, '<span class="sep">:</span>');
// Tiempo transcurrido, sin redondear a minutos: "45s", "3m 07s", "1h 05m 12s".
function fmtShort(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}
// Cantidades exactas (lo que descuentas): "5 min"; si no son minutos cerrados, con segundos.
const fmtAmount = (ms) => (ms % 60000 === 0 ? `${ms / 60000} min` : fmtShort(ms));
const fmtDate = (t) => new Date(t).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtDay = (t) => new Date(t).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
const fmtTime = (t) => new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const startOfToday = () => { const d = new Date(now()); d.setHours(0, 0, 0, 0); return d.getTime(); };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- almacenamiento ---------- */
let storageWarned = false;
function freshState() {
  return {
    version: 2, projects: [], selectedId: null, lastSeen: null, away: null,
    settings: {
      sound: true, theme: 'system', friction: true, levelImages: false,
      templates: [{ id: DEFAULT_TPL_ID, name: DEFAULT_TPL_NAME, rounds: clone(DEFAULT_ROUNDS) }],
      defaultTemplateId: DEFAULT_TPL_ID,
    },
  };
}
// Repara lo que venga (localStorage, respaldo importado, versión vieja) para que la app nunca truene:
// tipos correctos, sesiones válidas, un solo cronómetro corriendo, ids únicos.
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v, d) => (typeof v === 'string' ? v : d);
function cleanRounds(list, withState) {
  return (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object').map((r, ri) => {
    const base = { short: str(r.short, String(ri + 1)), name: str(r.name, `Ronda ${ri + 1}`) };
    if (!withState) return { ...base, steps: (Array.isArray(r.steps) ? r.steps : []).filter((x) => typeof x === 'string') };
    const out = { ...base, completedAt: isNum(r.completedAt) ? r.completedAt : null };
    if (isNum(r.xp)) out.xp = r.xp;
    out.steps = (Array.isArray(r.steps) ? r.steps : []).filter((x) => x && typeof x === 'object').map((x) => {
      const st = { id: str(x.id, '') || uid(), text: str(x.text, ''), doneAt: isNum(x.doneAt) ? x.doneAt : null };
      if (isNum(x.xp)) st.xp = x.xp;
      return st;
    });
    return out;
  });
}
function cleanSession(x) {
  if (!x || typeof x !== 'object' || !isNum(x.start)) return null;
  const end = x.end == null ? null : (isNum(x.end) && x.end >= x.start ? x.end : undefined);
  if (end === undefined) return null;
  const s = { id: str(x.id, '') || uid(), start: x.start, end, round: Number.isInteger(x.round) && x.round >= 0 ? x.round : null };
  if (isNum(x.deducted) && x.deducted > 0) s.deducted = x.deducted;
  if (Array.isArray(x.deductions)) {
    const d = x.deductions.filter((y) => y && isNum(y.at) && isNum(y.ms) && y.ms > 0).map((y) => ({ at: y.at, ms: y.ms }));
    if (d.length) s.deductions = d;
  }
  return s;
}
function normalize(s) {
  const base = freshState();
  if (!s || typeof s !== 'object' || !Array.isArray(s.projects)) return base;
  const old = s.settings && typeof s.settings === 'object' ? s.settings : {};
  const st = {
    sound: typeof old.sound === 'boolean' ? old.sound : true,
    theme: ['system', 'light', 'dark'].includes(old.theme) ? old.theme : 'system',
    friction: typeof old.friction === 'boolean' ? old.friction : true,
    levelImages: typeof old.levelImages === 'boolean' ? old.levelImages : false,
    templates: old.templates,
    defaultTemplateId: old.defaultTemplateId,
  };
  // Migración v1 → v2: la plantilla única pasa a ser la predeterminada.
  const migrating = !Array.isArray(st.templates) || !st.templates.length;
  if (migrating) {
    const rounds = Array.isArray(old.template) && old.template.length ? old.template : clone(DEFAULT_ROUNDS);
    st.templates = [{ id: DEFAULT_TPL_ID, name: Array.isArray(old.template) && old.template.length ? 'Evaluación A / B / combinada' : DEFAULT_TPL_NAME, rounds }];
    st.defaultTemplateId = DEFAULT_TPL_ID;
  }
  st.templates = st.templates.filter((t) => t && typeof t === 'object')
    .map((t) => ({ id: str(t.id, '') || uid(), name: str(t.name, 'Plantilla'), rounds: cleanRounds(t.rounds, false) }))
    .filter((t) => t.rounds.length);
  if (!st.templates.length) st.templates = clone(base.settings.templates);
  if (!st.templates.some((t) => t.id === st.defaultTemplateId)) st.defaultTemplateId = st.templates[0].id;

  const ids = new Set();
  s.projects = s.projects.filter((p) => p && typeof p === 'object').map((p, i) => {
    let rounds = cleanRounds(p.rounds, true);
    if (!rounds.length) rounds = cleanRounds(DEFAULT_ROUNDS.map((r) => ({ ...r, steps: r.steps.map((text) => ({ text })) })), true);
    const sessions = (Array.isArray(p.sessions) ? p.sessions : []).map(cleanSession).filter(Boolean).sort((a, b) => a.start - b.start);
    let cur = Number.isInteger(p.currentRound) ? Math.min(Math.max(p.currentRound, 0), rounds.length) : 0;
    let completedAt = isNum(p.completedAt) ? p.completedAt : null;
    if (completedAt != null && cur < rounds.length) cur = rounds.length; // completado manda
    if (cur >= rounds.length) completedAt = completedAt ?? rounds[rounds.length - 1].completedAt ?? Date.now();
    let id = str(p.id, '') || uid();
    if (ids.has(id)) id = uid();
    ids.add(id);
    const out = {
      ...p, id, name: str(p.name, `Proyecto ${i + 1}`),
      createdAt: isNum(p.createdAt) ? p.createdAt : sessions[0]?.start ?? Date.now(),
      completedAt, currentRound: cur, rounds, sessions,
    };
    if (migrating && !out.templateId) out.templateId = DEFAULT_TPL_ID;
    if (out.templateId != null && typeof out.templateId !== 'string') delete out.templateId;
    return out;
  });
  // Un solo cronómetro corriendo: si hubiera varios, sigue el más reciente y los demás se cierran donde empezó ese.
  const live = s.projects.flatMap((p) => p.sessions.filter((x) => x.end == null));
  if (live.length > 1) {
    live.sort((a, b) => b.start - a.start);
    for (const x of live.slice(1)) x.end = Math.max(x.start, live[0].start);
  }
  if (!s.projects.some((p) => p.id === s.selectedId)) s.selectedId = null;
  if (s.away && !(typeof s.away === 'object' && isNum(s.away.from) && typeof s.away.pid === 'string')) s.away = null;
  if (s.levelImage && !(typeof s.levelImage === 'object' && typeof s.levelImage.key === 'string' && isNum(s.levelImage.level))) s.levelImage = null;
  for (const k of ['debugOffset', 'debugXp']) if (s[k] != null && !isNum(s[k])) delete s[k];
  s.settings = st;
  s.version = 2;
  return s;
}
function load() {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function save() {
  if (frozen) return;
  try { localStorage.setItem(storageKey(), JSON.stringify(state)); }
  catch {
    if (!storageWarned) { storageWarned = true; toast('No se pudo guardar en el navegador. Usa Exportar para respaldar.'); }
  }
  touchSeen();
}
function touchSeen() {
  try { localStorage.setItem(seenKey(), String(now())); } catch { /* sin storage */ }
}
function readSeen() {
  try {
    const v = Number(localStorage.getItem(seenKey()));
    if (v > 0) return v;
  } catch { /* sin storage */ }
  return isNum(state.lastSeen) ? state.lastSeen : null; // datos de versiones anteriores
}

let state = normalize(load());
if (debugMode) timeOffset = state.debugOffset || 0;
let flash = null;   // { pid, ri?, sid? } — qué animar en el próximo render
let broke = 0;      // 1–3: el próximo render sacude el reloj según qué tan caro fue pausar
let away = null;    // { pid, sid, from } — cronómetro que siguió corriendo con la página cerrada
function setAway(v) { away = v; state.away = v; }

/* ---------- consultas ---------- */
const getProject = (id) => state.projects.find((p) => p.id === id);
const getTemplate = (id) => state.settings.templates.find((t) => t.id === id);
const defaultTemplate = () => getTemplate(state.settings.defaultTemplateId) || state.settings.templates[0];
const selected = () => getProject(state.selectedId);
const isDone = (p) => p.completedAt != null;
const isRunning = (p) => p.sessions.some((s) => s.end == null);
const isStarted = (p) => p.sessions.length > 0 || p.rounds.some((r) => r.completedAt || r.steps.some((s) => s.doneAt));
function activeSession() {
  for (const p of state.projects) {
    const s = p.sessions.find((x) => x.end == null);
    if (s) return { p, s };
  }
  return null;
}
// Tiempo neto de una sesión: lo transcurrido menos lo que descontaste (baño, interrupciones).
const sessionMs = (s, n = now()) => Math.max(0, (s.end ?? n) - s.start - (s.deducted || 0));
// Cada descuento ocupa los minutos justo antes de cuando lo hiciste ("me fui 5 min, ya volví").
// Se apilan hacia atrás sin traslaparse; sirve para repartir bien el descuento si la sesión cruza la medianoche.
function deductionIntervals(s) {
  let list = Array.isArray(s.deductions) && s.deductions.length ? s.deductions : null;
  if (!list) list = s.deducted ? [{ at: s.end ?? now(), ms: s.deducted }] : []; // datos sin detalle
  const sorted = [...list].sort((x, y) => x.at - y.at);
  const out = [];
  let floor = Infinity;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const end = Math.min(sorted[i].at, floor);
    out.push([end - sorted[i].ms, end]);
    floor = end - sorted[i].ms;
  }
  return out;
}
function sessionsTime(p, filter) {
  const n = now();
  let t = 0;
  for (const s of p.sessions) if (!filter || filter(s)) t += sessionMs(s, n);
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
const buildRounds = (tpl) => tpl.rounds.map((t) => ({
  short: t.short, name: t.name, completedAt: null,
  steps: t.steps.map((text) => ({ id: uid(), text, doneAt: null })),
}));

/* --- ritmo --- */
// Tramo continuo: sesiones pegadas (fin == inicio de la siguiente) cuentan como una sola carrera.
// Lo que descontaste en esas sesiones también se resta del ritmo: el baño no suma hacia ningún multiplicador.
function runInfo(p) {
  const act = p.sessions.find((s) => s.end == null);
  if (!act) return null;
  let start = act.start, deducted = act.deducted || 0, found = true;
  const used = new Set([act]); // cada sesión una sola vez: una sesión de duración cero no debe ciclar
  while (found) {
    found = false;
    for (const s of p.sessions) {
      if (!used.has(s) && s.end === start) { used.add(s); start = s.start; deducted += s.deducted || 0; found = true; break; }
    }
  }
  return { start, deducted };
}
function pace(p) {
  const run = p && runInfo(p);
  if (!run) return null;
  const minutes = Math.max(0, now() - run.start - run.deducted) / 60000;
  let idx = 0;
  PACE.forEach((t, i) => { if (minutes >= t.min) idx = i; });
  return { ...PACE[idx], idx, minutes, next: PACE[idx + 1] || null };
}
const currentMult = (p) => (isRunning(p) ? pace(p)?.mult ?? 1 : 1);
function needsHold(p) {
  if (!p || !state.settings.friction || !isRunning(p)) return false;
  const pc = pace(p);
  return !!pc && pc.mult > 1 && pc.minutes < GOAL_MIN;
}

/* --- XP --- */
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
      for (const s of r.steps) if (s.doneAt) xp += s.xp ?? XP.step;
      if (r.completedAt) xp += r.xp ?? XP.round;
    }
    if (p.completedAt) xp += XP.project;
  }
  if (debugMode) xp += state.debugXp || 0; // XP simulado, solo existe en modo prueba
  return xp;
}
// Empiezas en nivel 0; cada nivel desde el 1 se gana (y desbloquea su imagen).
const level = () => Math.floor(xpTotal() / XP_PER_LEVEL);
function todayMs() {
  const s0 = startOfToday(), n = now();
  let t = 0;
  for (const p of state.projects) for (const s of p.sessions) {
    const a = Math.max(s.start, s0), b = s.end ?? n;
    if (b <= a) continue;
    let ded = 0; // solo la parte de los descuentos que cae hoy
    for (const [d0, d1] of deductionIntervals(s)) ded += Math.max(0, Math.min(d1, b) - Math.max(d0, a));
    t += Math.max(0, b - a - ded);
  }
  return t;
}
const todayAchievements = () => { const s0 = startOfToday(); return achievementTimes().filter((t) => t >= s0).length; };
function streak() {
  const days = new Set(achievementTimes().map(dayKey));
  for (const p of state.projects) for (const s of p.sessions) days.add(dayKey(s.start));
  const d = new Date(now()); d.setHours(12, 0, 0, 0);
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1); // hoy aún no cuenta: la racha sigue viva
  let n = 0;
  while (days.has(dayKey(d.getTime()))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ---------- acciones ---------- */
function commit() { save(); renderAll(); scheduleTick(); }

// Feedback visual discreto: entrada de lo nuevo, salida de lo que se borra, destello de lo que cambió.
let enter = null; // { pid, list } — el próximo render anima la entrada de ese proyecto
function leave(els, then) {
  const list = els.filter(Boolean);
  if (reduceMotion || !list.length) { then(); return; }
  list.forEach((e) => e.classList.add('leaving'));
  setTimeout(then, 220);
}
function flashEl(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth; // reinicia la animación
  el.classList.add('flash');
}

function createProject() {
  const tpl = defaultTemplate();
  const p = {
    id: uid(),
    name: `Proyecto ${state.projects.length + 1}`,
    createdAt: now(),
    completedAt: null,
    currentRound: 0,
    templateId: tpl.id,
    sessions: [],
    rounds: buildRounds(tpl),
  };
  state.projects.push(p);
  state.selectedId = p.id;
  enter = { pid: p.id, list: true };
  commit();
  enter = null;
  sfx('create');
  toast('Proyecto creado. Dale Iniciar (o Espacio) cuando arranques.');
  requestAnimationFrame(() => { const i = $('#projName'); if (i) { i.focus(); i.select(); } });
}

function startTimer(p) {
  const t = now(); // un solo instante: si otro proyecto corría, termina exactamente donde empieza este
  const a = activeSession();
  if (a) a.s.end = t;
  setAway(null);
  p.sessions.push({ id: uid(), start: t, end: null, round: isDone(p) ? null : p.currentRound });
}
function stopTimer() { const a = activeSession(); if (a) a.s.end = now(); setAway(null); }
function toggleTimer(p) {
  if (isRunning(p)) {
    const pc = pace(p);
    stopTimer();
    if (pc && pc.minutes >= GOAL_MIN) {
      sfx('round');
      toast(`Pit stop merecido: ${fmtShort(pc.minutes * 60000)} seguidos. Descansa y vuelve por otro tramo.`);
    } else sfx('stop');
  } else { startTimer(p); sfx('start'); }
  commit();
}
// Cuando cambia la ronda con el cronómetro corriendo, cortamos la sesión para atribuir bien el tiempo.
// El corte es exacto (fin == inicio), así que el ritmo no se rompe.
function splitRunningSession(p) {
  const s = p.sessions.find((x) => x.end == null);
  if (!s) return;
  const t = now();
  s.end = t;
  if (!isDone(p)) p.sessions.push({ id: uid(), start: t, end: null, round: p.currentRound });
}

/* --- descontar tiempo (sin pausar; se resta del tiempo y también del ritmo) --- */
let lastDeduct = null; // { pid, sid, ms } — para "Deshacer"
const deductTarget = (p) => p.sessions.find((s) => s.end == null) || p.sessions[p.sessions.length - 1];
function deductTime(p, min, btn) {
  const s = deductTarget(p);
  if (!s) return;
  const ms = Math.min(min * 60000, sessionMs(s));
  if (ms < 1000) { sfx('error'); toast('Esta sesión no tiene tiempo para descontar.'); return; }
  const pt = btn ? centerOf(btn) : null;
  // Se registra cuándo: el descuento ocupa los minutos justo antes (o antes del fin, si la sesión ya terminó).
  if (!s.deductions && s.deducted) s.deductions = [{ at: s.end ?? now(), ms: s.deducted }]; // dato viejo sin detalle
  s.deductions = [...(s.deductions || []), { at: s.end ?? now(), ms }];
  s.deducted = (s.deducted || 0) + ms;
  lastDeduct = { pid: p.id, sid: s.id, ms };
  commit();
  sfx('deduct');
  const clock = $('.clock');
  if (clock) { clock.classList.remove('dip'); void clock.offsetWidth; clock.classList.add('dip'); }
  if (pt) floatText(pt.x, pt.y - 18, `−${fmtAmount(ms)}`);
  toast(`Descontados ${fmtAmount(ms)} de esta sesión y del ritmo.`);
}
function undoDeduct() {
  const d = lastDeduct;
  const s = d && getProject(d.pid)?.sessions.find((x) => x.id === d.sid);
  lastDeduct = null;
  if (!s) { commit(); return; }
  s.deducted = Math.max(0, (s.deducted || 0) - d.ms);
  if (!s.deducted) delete s.deducted;
  if (Array.isArray(s.deductions)) { // quita el último descuento de esa cantidad
    for (let i = s.deductions.length - 1; i >= 0; i--) if (s.deductions[i].ms === d.ms) { s.deductions.splice(i, 1); break; }
    if (!s.deductions.length || !s.deducted) delete s.deductions;
  }
  commit();
  sfx('undo');
  toast(`Descuento deshecho: +${fmtAmount(d.ms)}.`);
}

/* --- favicon: punto rojo mientras el reloj corre --- */
const FAVICON_RUNNING = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="10" fill="#f5c400"/>
  <rect x="26" y="5" width="12" height="7" rx="2" fill="#15181d"/>
  <circle cx="32" cy="36" r="20" fill="#f8f9f6" stroke="#15181d" stroke-width="5"/>
  <line x1="32" y1="36" x2="42" y2="27" stroke="#c8372d" stroke-width="4.5" stroke-linecap="round"/>
  <circle cx="32" cy="36" r="3.5" fill="#15181d"/>
  <circle cx="50" cy="14" r="11" fill="#c8372d" stroke="#f8f9f6" stroke-width="3"/>
</svg>`)}`;
let faviconRunning = null;
function setFavicon(running) {
  if (running === faviconRunning) return;
  faviconRunning = running;
  const link = $('#favicon');
  if (link) link.href = running ? FAVICON_RUNNING : 'favicon.svg';
}

/* --- pausa sostenida --- */
// Mientras más ritmo llevas, más cuesta pausar: más tiempo sosteniendo, latido más rápido,
// y al soltar la pausa el golpe es más fuerte (sonido, sacudida, mensaje).
let holdTimer = null, holdBeat = null, holdDoneAt = 0;
const holdMs = (p) => pace(p)?.hold || 0;
const fmtSec = (ms) => `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`;
const BEAT_MS = [0, 340, 250, 170]; // latido mientras sostienes, por tramo
function stopBeat() { clearInterval(holdBeat); holdBeat = null; }
function startHold(p) {
  if (holdTimer) return;
  const pc = pace(p);
  const ms = pc.hold;
  const btn = $('.play');
  if (btn) { btn.style.setProperty('--hold', `${ms}ms`); btn.classList.add('holding'); }
  sfx('beat');
  holdBeat = setInterval(() => sfx('beat'), BEAT_MS[pc.idx] || 300);
  holdTimer = setTimeout(() => { holdTimer = null; stopBeat(); holdDoneAt = now(); pauseWithLoss(p); }, ms);
}
function cancelHold() {
  if (!holdTimer) return;
  clearTimeout(holdTimer);
  holdTimer = null;
  stopBeat();
  $('.play')?.classList.remove('holding');
  sfx('relief');
  holdHint();
}
function holdHint() {
  const pc = pace(selected());
  if (pc) toast(`Mantén presionado ${fmtSec(pc.hold)} para pausar. Perderías el ritmo ×${pc.mult} (${fmtShort(pc.minutes * 60000)} seguidos).`);
}
function pauseWithLoss(p) {
  const pc = pace(p);
  const sev = Math.min(Math.max(pc?.idx || 1, 1), 3); // 1: 30–60 · 2: 60–90 · 3: 90–120
  stopTimer();
  sfx(`break${sev}`);
  broke = sev;
  commit();
  broke = 0;
  if (sev === 3) vignette();
  if (!pc) return;
  const run = fmtShort(pc.minutes * 60000);
  if (sev === 1) toast(`Pausa. Perdiste el ritmo ×${pc.mult} (${run}).`);
  else if (sev === 2) toast(`Se rompió tu ritmo ×${pc.mult} tras ${run} seguidos.`);
  else toast(`Se rompió una racha de ${run} ×${pc.mult}. Estabas a ${fmtShort((GOAL_MIN - pc.minutes) * 60000)} del tramo completo.`);
}
// Destello rojo en los bordes: solo para la pausa más cara.
function vignette() {
  if (reduceMotion) return;
  const v = document.createElement('div');
  v.className = 'vignette';
  document.body.appendChild(v);
  setTimeout(() => v.remove(), 1000);
}

function toggleStep(p, sid, el) {
  if (isDone(p)) return;
  const r = p.rounds[p.currentRound];
  const st = r.steps.find((s) => s.id === sid);
  if (!st) return;
  if (st.doneAt) { st.doneAt = null; delete st.xp; commit(); sfx('undo'); return; }
  const lvl = level();
  const mult = currentMult(p);
  const pt = el ? centerOf(el.querySelector('.check') || el) : screenCenter();
  st.doneAt = now();
  st.xp = Math.round(XP.step * mult);
  flash = { pid: p.id, sid };
  commit();
  flash = null;
  burst(pt.x, pt.y, mult > 1 ? 36 : 26, mult > 1 ? 1.1 : 0.9);
  floatText(pt.x, pt.y, st.xp, mult);
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
  const mult = currentMult(p);
  const pt = el && el.isConnected ? centerOf(el) : screenCenter();
  r.completedAt = now();
  r.xp = Math.round(XP.round * mult);
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
    floatText(np.x, np.y, r.xp, mult);
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
  flash = { pid: p.id, ri };
  commit();
  flash = null;
  sfx('undo');
  toast(`${r.name} reabierta.`);
}

async function applyTemplate(p, tplId) {
  const tpl = getTemplate(tplId);
  if (!p || !tpl || p.templateId === tplId) return;
  if (isStarted(p)) {
    const ok = await ask('Cambiar plantilla',
      `Las rondas y pasos de "${p.name}" se reemplazan por los de "${tpl.name}". El avance marcado se pierde; el tiempo registrado se conserva, sin ronda asignada.`,
      'Cambiar plantilla', true);
    if (!ok) { renderMain(); tick(); return; }
  }
  const t = now();
  const running = p.sessions.find((s) => s.end == null);
  for (const s of p.sessions) s.round = null;
  if (running) running.end = t;
  p.rounds = buildRounds(tpl);
  p.currentRound = 0;
  p.completedAt = null;
  p.templateId = tpl.id;
  if (running) p.sessions.push({ id: uid(), start: t, end: null, round: 0 });
  enter = { pid: p.id };
  commit();
  enter = null;
  sfx('create');
  toast(`Plantilla aplicada: ${tpl.name}.`);
}

function addStep(p, text) {
  if (!p || isDone(p) || !text.trim()) return;
  const step = { id: uid(), text: text.trim(), doneAt: null };
  p.rounds[p.currentRound].steps.push(step);
  flash = { pid: p.id, added: step.id };
  commit();
  flash = null;
  sfx('tick');
  const i = $('.addstep input'); if (i) i.focus();
}
function removeStep(p, sid) {
  sfx('remove');
  leave([$(`.step[data-sid="${sid}"]`)], () => {
    const r = p.rounds[p.currentRound];
    r.steps = r.steps.filter((s) => s.id !== sid);
    commit();
  });
}
/* --- editar nombres sobre la marcha --- */
const PENCIL = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M11 2.5l2.5 2.5L6 12.5l-3.2.7.7-3.2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
// Cambia el texto de `el` por un campo. Lo escrito se guarda al vuelo (si algo redibuja la
// pantalla a media edición, no se pierde); Enter o salir del campo confirma, Escape deshace.
function inlineEdit(el, get, set) {
  if (!el || el.querySelector('.inline-edit')) return;
  const orig = get();
  const inp = document.createElement('input');
  inp.className = 'inline-edit';
  inp.value = orig;
  inp.maxLength = 120;
  inp.spellcheck = false;
  el.replaceChildren(inp);
  inp.focus();
  inp.select();
  let closed = false;
  const finish = (keep) => {
    if (closed) return;
    closed = true;
    const v = inp.value.trim();
    set(keep && v ? v : orig);
    save();
    if (keep && v && v !== orig) sfx('tick');
    queueMicrotask(commit); // fuera de cualquier redibujo en curso
  };
  inp.addEventListener('input', () => { const v = inp.value.trim(); if (v) { set(v); save(); } });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', (e) => e.stopPropagation()); // que el clic no marque el paso ni la estación
  inp.addEventListener('dblclick', (e) => e.stopPropagation());
}
function renameRound(p, ri, el) {
  const r = p && p.rounds[ri];
  if (!r) return;
  inlineEdit(el || $(`[data-rename-round="${ri}"]`), () => r.name, (v) => { r.name = v; });
}
function renameStep(p, sid) {
  const st = p && p.rounds[p.currentRound]?.steps.find((s) => s.id === sid);
  if (!st) return;
  inlineEdit($(`.step[data-sid="${sid}"] .step-text`), () => st.text, (v) => { st.text = v; });
}

/* --- guardar el proyecto como plantilla --- */
const roundsShape = (rounds) => JSON.stringify(rounds.map((r) => [r.short, r.name, r.steps.map((s) => (typeof s === 'string' ? s : s.text))]));
function differsFromTemplate(p) {
  const t = getTemplate(p.templateId);
  return !t || roundsShape(t.rounds) !== roundsShape(p.rounds);
}
function saveAsTemplate(p) {
  if (!p) return;
  const names = new Set(state.settings.templates.map((t) => t.name));
  let name = p.name, n = 2;
  while (names.has(name)) name = `${p.name} (${n++})`;
  const tpl = { id: uid(), name, rounds: p.rounds.map((r) => ({ short: r.short, name: r.name, steps: r.steps.map((s) => s.text) })) };
  state.settings.templates.push(tpl);
  p.templateId = tpl.id;
  commit();
  sfx('create');
  const sel = $('#projTpl');
  if (sel) { const pt = centerOf(sel); burst(pt.x, pt.y, 24, 0.8); }
  toast(`Plantilla "${name}" guardada. Ya la puedes elegir en proyectos nuevos.`);
}

// Agrega una ronda vacía al final (antes de la meta); sus pasos se agregan cuando llegues a ella.
function addRound(p) {
  if (!p || isDone(p)) return;
  const used = new Set(p.rounds.map((r) => r.short));
  let n = p.rounds.length + 1;
  while (used.has(String(n).padStart(2, '0'))) n++;
  const short = String(n).padStart(2, '0');
  const ri = p.rounds.push({ short, name: `Ronda ${short}`, completedAt: null, steps: [] }) - 1;
  flash = { pid: p.id, ri };
  commit();
  flash = null;
  sfx('create');
  const track = $('.path');
  if (track) track.scrollLeft = track.scrollWidth;
  toast(`Ronda ${short} agregada: ponle nombre. Sus pasos los agregas cuando llegues a ella.`);
  renameRound(p, ri, $(`.station[data-ri="${ri}"] .lname`));
}
// Se puede quitar una ronda que no esté cerrada, mientras quede otra pendiente:
// la meta siempre se alcanza cerrando una ronda (con su celebración y su XP).
function canRemoveRound(p, ri) {
  const r = p.rounds[ri];
  if (!r || r.completedAt || isDone(p)) return false;
  return p.rounds.some((x, i) => i !== ri && !x.completedAt);
}
async function removeRound(p, ri) {
  if (!canRemoveRound(p, ri)) {
    if (p.rounds[ri] && !p.rounds[ri].completedAt) toast('Es la última ronda pendiente: ciérrala para llegar a la meta.');
    return;
  }
  const r = p.rounds[ri];
  const marked = r.steps.filter((s) => s.doneAt).length;
  const timed = p.sessions.some((s) => s.round === ri);
  if (marked || timed) {
    const what = [marked ? `${marked} paso(s) marcado(s)` : '', timed ? 'tiempo registrado' : ''].filter(Boolean).join(' y ');
    const detail = [marked ? 'Los pasos marcados se van con ella, junto con su XP.' : '', timed ? 'El tiempo se queda en el proyecto, ya sin ronda asignada.' : ''].filter(Boolean).join(' ');
    if (!(await ask('Quitar ronda', `"${r.name}" tiene ${what}. ${detail}`, 'Quitar ronda', true))) return;
  }
  sfx('remove');
  const st = $(`.station[data-ri="${ri}"]`);
  await new Promise((done) => leave([st, st?.previousElementSibling], () => { dropRound(p, ri); done(); }));
  const left = p.rounds.length - p.currentRound;
  toast(left === 1
    ? `${r.name} quitada. ${p.rounds[p.currentRound].name} es la última: ciérrala y llegas a la meta.`
    : `${r.name} quitada.`);
}
function dropRound(p, ri) {
  const t = now();
  const live = p.sessions.find((s) => s.end == null);
  // Si corría en la ronda que se va: lo ya medido se queda sin ronda y, desde este
  // milisegundo, sigue en la nueva ronda actual (corte exacto, igual que al cambiar de ronda).
  if (live && live.round === ri && live.start < t) {
    live.end = t;
    live.round = null;
    p.sessions.push({ id: uid(), start: t, end: null, round: ri });
  }
  for (const s of p.sessions) {
    if (s.end != null && s.round === ri) s.round = null;
    else if (s.round > ri) s.round--;
  }
  const wasCurrent = ri === p.currentRound;
  p.rounds.splice(ri, 1);
  if (ri < p.currentRound) p.currentRound--;
  if (wasCurrent) p.currentRound = p.rounds.findIndex((x) => !x.completedAt);
  const running = p.sessions.find((s) => s.end == null);
  if (running && running.round != null) running.round = p.currentRound;
  commit();
}
async function deleteProject(p) {
  if (!(await ask('Eliminar proyecto', `Se borra "${p.name}" con todo su tiempo registrado. No se puede deshacer.`, 'Eliminar', true))) return;
  sfx('remove');
  leave([$(`.proj[data-id="${p.id}"]`), $('#main')], () => {
    state.projects = state.projects.filter((x) => x !== p);
    const next = state.projects.find((x) => !isDone(x)) || state.projects[0];
    state.selectedId = next ? next.id : null;
    if (next) enter = { pid: next.id };
    commit();
    enter = null;
    toast(`"${p.name}" eliminado.`);
  });
}
async function deleteSession(p, sid) {
  if (!(await ask('Borrar sesión', 'Se quita esta sesión y su tiempo del proyecto.', 'Borrar', true))) return;
  sfx('remove');
  leave([$(`tr[data-sid="${sid}"]`)], () => {
    p.sessions = p.sessions.filter((s) => s.id !== sid);
    commit();
    toast('Sesión borrada.');
  });
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
      if (state.settings.levelImages) setTimeout(() => showLevelImage(l), 700);
    }, 500);
  }
}

/* --- imágenes de nivel: carpeta local, solo lectura ---
   Lo único que se guarda (en IndexedDB) es la *referencia* a la carpeta para no pedirla cada vez.
   Las imágenes se leen del disco al momento y se muestran desde memoria; nunca se copian ni se suben. */
const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;
const gallery = { handle: null, name: '', sources: [], status: 'none' }; // none | needs-permission | ready | session | empty | missing
const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(NS, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = fn(db.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  get(k) { return this.run('readonly', (s) => s.get(k)); },
  set(k, v) { return this.run('readwrite', (s) => s.put(v, k)); },
  del(k) { return this.run('readwrite', (s) => s.delete(k)); },
};
// `key` = ruta relativa dentro de la carpeta (p. ej. "fotos/playa.jpg"): es lo único que se recuerda.
async function scanDir(dir, depth = 0, out = [], prefix = '') {
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && IMG_EXT.test(entry.name)) out.push({ key: prefix + entry.name, getFile: () => entry.getFile() });
    else if (entry.kind === 'directory' && depth < 2) await scanDir(entry, depth + 1, out, `${prefix}${entry.name}/`);
  }
  return out;
}
async function loadGallery(interactive = false) {
  if (!gallery.handle) return;
  try {
    let perm = await gallery.handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted' && interactive) perm = await gallery.handle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') { gallery.status = 'needs-permission'; renderMenu(); return; }
    gallery.sources = await scanDir(gallery.handle);
    gallery.status = gallery.sources.length ? 'ready' : 'empty';
  } catch {
    gallery.sources = [];
    gallery.status = 'missing';
  }
  renderMenu();
}
async function pickFolder() {
  if (!window.showDirectoryPicker) { $('#dirFallback').click(); return; } // Firefox/Safari: solo por esta sesión
  try {
    const h = await window.showDirectoryPicker({ id: 'cm-level-images', mode: 'read' });
    gallery.handle = h;
    gallery.name = h.name;
    try { await idb.set('imgDir', h); } catch { /* sin IndexedDB: funciona solo esta sesión */ }
    await loadGallery(true);
    if (gallery.status === 'ready') toast(`Carpeta "${h.name}": ${gallery.sources.length} imágenes. Solo se leen en tu equipo.`);
    else if (gallery.status === 'empty') toast(`La carpeta "${h.name}" no tiene imágenes.`);
  } catch (e) {
    if (e.name !== 'AbortError') toast('No se pudo abrir la carpeta.');
  }
}
async function forgetFolder() {
  try { await idb.del('imgDir'); } catch { /* nada que borrar */ }
  Object.assign(gallery, { handle: null, name: '', sources: [], status: 'none' });
  renderMenu();
  toast('Carpeta olvidada. No queda ninguna referencia guardada.');
}
async function initGallery() {
  if (!state.settings.levelImages || gallery.handle || !window.indexedDB) return;
  try {
    const h = await idb.get('imgDir');
    if (h) { gallery.handle = h; gallery.name = h.name; await loadGallery(false); }
  } catch { /* sin IndexedDB */ }
}
function folderLabel() {
  const n = gallery.sources.length;
  switch (gallery.status) {
    case 'ready': return `${gallery.name} · ${n}`;
    case 'session': return `${n} · solo esta sesión`;
    case 'needs-permission': return `${gallery.name} · dar permiso`;
    case 'empty': return `${gallery.name} · sin imágenes`;
    case 'missing': return 'No encontrada · elegir';
    default: return 'Elegir';
  }
}

// Cada nivel (desde el 1) desbloquea una imagen al azar y queda fija para ese nivel (state.levelImage).
// mode: 'new' = acabas de subir (elige otra y la fija) · 'current' = volver a ver la del nivel actual
function pickSource(mode, lvl) {
  const cur = state.levelImage;
  if (mode === 'current' && cur && cur.level === lvl) {
    const same = gallery.sources.find((s) => s.key === cur.key);
    if (same) return same;
  }
  let pool = gallery.sources;
  if (cur && pool.length > 1) pool = pool.filter((s) => s.key !== cur.key); // que no repita la anterior
  const src = pool[Math.floor(Math.random() * pool.length)];
  state.levelImage = { level: lvl, key: src.key };
  save();
  return src;
}

async function showLevelImage(lvl, { manual = false, mode = 'new' } = {}) {
  if (!state.settings.levelImages || $('.photo-overlay')) return;
  if (lvl < 1) {
    if (manual) { sfx('tick'); flashEl($('.stat.level')); } if (manual) toast(`Tu primera imagen se desbloquea al llegar a nivel 1. Te faltan ${XP_PER_LEVEL - xpTotal()} XP.`);
    return;
  }
  if (gallery.status === 'needs-permission') await loadGallery(true);
  if (!gallery.sources.length) {
    if (manual) { sfx('error'); toast('Elige una carpeta con imágenes en Menú → Carpeta.'); }
    return;
  }
  const src = pickSource(mode, lvl);
  let url;
  try { url = URL.createObjectURL(await src.getFile()); }
  catch { gallery.status = 'missing'; gallery.sources = []; renderMenu(); toast('No encontré la carpeta de imágenes.'); return; }
  const stamp = new Date(now());
  const o = document.createElement('div');
  o.className = 'overlay photo-overlay';
  o.innerHTML = `
    <figure class="photo-finish" role="dialog" aria-label="Imagen de nivel ${lvl}">
      <div class="pf-head"><span>Foto de llegada</span><span>${fmtTime(stamp)} · ${pad(stamp.getSeconds())}s</span></div>
      <div class="pf-frame">
        <img alt="" src="${url}">
        <div class="pf-shutter"><i></i><i></i></div>
        <div class="pf-flash"></div>
        <span class="pf-corner tl"></span><span class="pf-corner tr"></span><span class="pf-corner bl"></span><span class="pf-corner br"></span>
      </div>
      <figcaption>
        <span class="pf-level">Nivel ${lvl}</span>
        <span class="pf-meta">${fmtDate(stamp)}</span>
      </figcaption>
      <button class="btn btn-solid pf-close">Seguir</button>
    </figure>`;
  const close = () => {
    o.remove();
    URL.revokeObjectURL(url);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
  o.addEventListener('click', (e) => { if (e.target === o || e.target.closest('.pf-close')) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(o);
  const img = o.querySelector('img');
  try { await img.decode(); } catch { /* se muestra igual */ }
  requestAnimationFrame(() => {
    o.classList.add('open');
    sfx('shutter');
    setTimeout(() => { const pt = centerOf(o.querySelector('.pf-frame')); burst(pt.x, pt.y, 50, 1.3); }, 450);
  });
}

/* --- tiempo que corrió con la página cerrada --- */
// Sirve al abrir la página y también si la computadora se suspendió con la página abierta.
function detectAway(last = readSeen()) {
  const a = activeSession();
  if (away && a && away.sid === a.s.id) return false; // ya hay un aviso pendiente de esa sesión: se respeta el primero
  if (a && last && last > a.s.start && now() - last > AWAY_THRESHOLD) {
    setAway({ pid: a.p.id, sid: a.s.id, from: last });
    state.selectedId = a.p.id;
    return true;
  }
  return false;
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
function renderAll() { renderStats(); renderMenu(); renderList(); renderMain(); renderDebug(); tick(); }

/* --- footer de debug --- */
function debugPaceText() {
  const a = activeSession();
  if (!a) return 'Ningún cronómetro corriendo.';
  const pc = pace(a.p);
  return `${esc(a.p.name)}: ${fmtShort(pc.minutes * 60000)} de ritmo · ${pc.label} ×${pc.mult} · ${needsHold(a.p) ? `pausa sostenida ${fmtSec(pc.hold)}` : 'pausa libre'}`;
}
// El panel de debug es preferencia de este navegador (no va en los datos), igual en modo real o de prueba.
const DEBUG_PANEL_KEY = `${NS}:debug-panel`;
let debugPanel = false;
try { debugPanel = localStorage.getItem(DEBUG_PANEL_KEY) === '1'; } catch { /* sin storage */ }
function setDebugPanel(on) {
  debugPanel = on;
  try { localStorage.setItem(DEBUG_PANEL_KEY, on ? '1' : '0'); } catch { /* sin storage */ }
  renderMenu();
  renderDebug();
}
function renderDebug() {
  $('#debugBanner').hidden = !debugMode;
  $('#debugFooter').hidden = !debugPanel;
  document.body.classList.toggle('debug-mode', debugMode);
  const dis = debugMode ? '' : 'disabled';
  $('#debugBody').innerHTML = `
    <div class="debug-row">
      <span class="debug-label">Modo prueba</span>
      <button class="btn btn-small ${debugMode ? 'btn-solid' : ''}" data-debug="toggle">${debugMode ? 'Salir del modo prueba' : 'Entrar al modo prueba'}</button>
      <span class="debug-note">${debugMode
        ? 'Trabajas sobre una copia aparte. Tus datos reales siguen intactos.'
        : 'Copia tus proyectos a un espacio aparte para probar sin tocarlos.'}</span>
    </div>
    <div class="debug-row">
      <span class="debug-label">Reloj simulado</span>
      <b class="debug-val">+${fmtShort(timeOffset)}</b>
      ${[1, 10, 30, 60].map((m) => `<button class="btn btn-small" data-debug="warp" data-min="${m}" ${dis}>+${m < 60 ? `${m} min` : '1 h'}</button>`).join('')}
      <button class="btn btn-small" data-debug="away" ${dis}>Simular navegador cerrado 15 min</button>
    </div>
    <div class="debug-row">
      <span class="debug-label">Nivel</span>
      <b class="debug-val">${level()} · ${xpTotal() % XP_PER_LEVEL}/${XP_PER_LEVEL}</b>
      <button class="btn btn-small" data-debug="xp" data-xp="50" ${dis}>+50 XP</button>
      <button class="btn btn-small" data-debug="levelup" ${dis}>Subir de nivel</button>
      <span class="debug-note">Imágenes: ${state.settings.levelImages ? esc(folderLabel()) : 'apagadas (Menú → Imágenes de nivel)'}</span>
    </div>
    <div class="debug-row">
      <span class="debug-label">Ritmo</span>
      <span class="debug-note" id="debugPace">${debugPaceText()}</span>
    </div>
    <div class="debug-row">
      <span class="debug-label">Tramos</span>
      <span class="debug-note">${PACE.map((t) => `${t.min} min · ${t.label} ×${t.mult} · ${t.hold ? `pausa ${fmtSec(t.hold)}` : 'pausa libre'}`).join(' / ')}</span>
    </div>
    <div class="debug-row">
      <span class="debug-label">Versión</span>
      <span class="debug-note">${APP_VERSION} · pruebas automáticas en <a href="tests/" target="_blank" rel="noopener">tests/</a></span>
    </div>
    ${debugMode ? `
    <div class="debug-row">
      <span class="debug-label">Datos de prueba</span>
      <button class="btn btn-small" data-debug="reset">Reiniciar con mis datos reales</button>
      <button class="btn btn-small" data-debug="blank">Empezar en blanco</button>
    </div>` : ''}`;
}
function switchMode(on) {
  save();
  frozen = true; // que el pagehide no escriba encima al recargar
  try {
    if (on && !localStorage.getItem(DEBUG_KEY)) {
      localStorage.setItem(DEBUG_KEY, localStorage.getItem(STORAGE_KEY) || '');
      localStorage.setItem(`${NS}:debug-seen`, String(Date.now())); // copia recién hecha: sin "ausencia" falsa
    }
    localStorage.setItem(MODE_KEY, on ? 'debug' : 'real');
  } catch { /* sin storage */ }
  location.reload();
}
function resetDebug(copyReal) {
  if (!debugMode) return;
  frozen = true;
  try {
    localStorage.setItem(DEBUG_KEY, copyReal ? localStorage.getItem(STORAGE_KEY) || '' : '');
    localStorage.setItem(`${NS}:debug-seen`, String(Date.now()));
  } catch { /* sin storage */ }
  location.reload();
}
function warp(min) {
  if (!debugMode) return;
  state.debugOffset = (state.debugOffset || 0) + min * 60000;
  timeOffset = state.debugOffset;
  save();
  renderAll();
  sfx('tick');
  flashEl($('.debug-val'));
}
// Suma XP simulado y corre el mismo flujo que al ganarlo de verdad (toast, confeti, imagen).
function addDebugXp(amount) {
  if (!debugMode || !amount) return;
  const prev = level();
  state.debugXp = (state.debugXp || 0) + amount;
  commit();
  if (level() > prev) checkLevel(prev);
  else { sfx('step'); const b = $('[data-debug=xp]'); if (b) { const pt = centerOf(b); floatText(pt.x, pt.y, amount); } }
}
function simulateAway(min) {
  if (!debugMode) return;
  if (!activeSession()) { sfx('error'); toast('Primero inicia un cronómetro.'); return; }
  touchSeen();
  const last = readSeen(); // la página "deja de estar abierta" aquí
  state.debugOffset = (state.debugOffset || 0) + min * 60000;
  timeOffset = state.debugOffset;
  detectAway(last);
  commit();
  if (away) toast('Un cronómetro siguió corriendo mientras no estabas.');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-debug]');
  if (!b || b.disabled) return;
  switch (b.dataset.debug) {
    case 'toggle': case 'exit': switchMode(!debugMode); break;
    case 'warp': warp(+b.dataset.min); break;
    case 'away': simulateAway(15); break;
    case 'reset': resetDebug(true); break;
    case 'blank': resetDebug(false); break;
    case 'xp': addDebugXp(+b.dataset.xp); break;
    case 'levelup': addDebugXp(XP_PER_LEVEL - (xpTotal() % XP_PER_LEVEL)); break;
  }
});

function renderStats() {
  const xp = xpTotal(), lvl = level(), into = xp % XP_PER_LEVEL, st = streak();
  $('#stats').innerHTML = `
    <div class="stat"><span class="stat-label">Hoy</span><span class="stat-val" data-today></span></div>
    <div class="stat"><span class="stat-label">Logros hoy</span><span class="stat-val">${todayAchievements()}</span></div>
    <div class="stat"><span class="stat-label">Racha</span><span class="stat-val">${st} <small>${st === 1 ? 'día' : 'días'}</small></span></div>
    <div class="stat level ${state.settings.levelImages ? 'clickable' : ''}" ${state.settings.levelImages ? `role="button" tabindex="0" title="${lvl >= 1 ? `Ver la imagen del nivel ${lvl}` : 'La primera imagen se desbloquea en nivel 1'}"` : ''}><span class="stat-label">Nivel ${lvl} · ${into}/${XP_PER_LEVEL} XP</span>
      <div class="xpbar"><i style="width:${(into / XP_PER_LEVEL) * 100}%"></i></div></div>`;
}

const THEME_LABEL = { system: 'Sistema', light: 'Claro', dark: 'Oscuro' };
function renderMenu() {
  $('#mSound b').textContent = state.settings.sound ? 'Sí' : 'No';
  $('#mTheme b').textContent = THEME_LABEL[state.settings.theme] || THEME_LABEL.system;
  $('#mFriction b').textContent = state.settings.friction ? 'Sí' : 'No';
  const imgs = state.settings.levelImages;
  $('#mImages b').textContent = imgs ? 'Sí' : 'No';
  $('#mFolder').hidden = !imgs;
  $('#mFolder b').textContent = folderLabel();
  $('#mForget').hidden = !imgs || !gallery.handle;
  $('#mDebug b').textContent = debugPanel ? 'Sí' : 'No';
}

function renderList() {
  const act = activeSession();
  const open = state.projects.filter((p) => !isDone(p)).sort((a, b) => b.createdAt - a.createdAt);
  const done = state.projects.filter(isDone).sort((a, b) => b.completedAt - a.completedAt);
  const item = (p) => `
    <button class="proj ${p.id === state.selectedId ? 'sel' : ''} ${isDone(p) ? 'done' : ''} ${enter?.list && enter.pid === p.id ? 'arrive' : ''}" data-action="select" data-id="${p.id}">
      <span class="proj-name">${act && act.p === p ? '<i class="live"></i>' : ''}${esc(p.name)}</span>
      <span class="proj-time" data-timer="${p.id}" data-fmt="short"></span>
      <span class="proj-bar"><i style="width:${Math.round(progress(p) * 100)}%"></i></span>
      <span class="proj-sub">${isDone(p) ? '<b>Completado</b>' : (isStarted(p) ? `Ronda ${esc(p.rounds[p.currentRound]?.short)}` : 'Sin iniciar')} · ${fmtDay(p.createdAt)}</span>
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

function paceHTML(p) {
  const max = GOAL_MIN;
  const minLabel = (m) => (m % 60 ? `${m} min` : `${m / 60} h`);
  const marks = PACE.slice(1).map((t) => `<span class="pace-mark" style="left:${(t.min / max) * 100}%"><em>×${t.mult}</em></span>`).join('');
  const pc = pace(p);
  if (!pc) {
    return `<div class="pace-bar"><i style="width:0%"></i>${marks}</div>
      <div class="pace-text">Sin ritmo. Meta: ${minLabel(GOAL_MIN)} sin pausa (×${PACE[PACE.length - 1].mult}). El ×${PACE[1].mult} llega a los ${minLabel(PACE[1].min)}.</div>`;
  }
  const fill = Math.min(pc.minutes / max, 1) * 100;
  const run = fmtShort(pc.minutes * 60000);
  const tail = pc.next
    ? ` · ×${pc.next.mult} a los ${minLabel(pc.next.min)}`
    : ' · meta cumplida, la pausa es libre';
  return `<div class="pace-bar tier-${pc.idx} ${pc.next ? '' : 'goal'}"><i style="width:${fill}%"></i>${marks}</div>
    <div class="pace-text"><b>${pc.label} ×${pc.mult}</b> · ${run} sin pausa${tail}</div>`;
}

function tplSelectHTML(p) {
  const known = getTemplate(p.templateId);
  const opts = state.settings.templates.map((t) => `<option value="${t.id}" ${t.id === p.templateId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  return `<select id="projTpl" aria-label="Plantilla del proyecto">${known ? '' : '<option value="" selected disabled>Sin plantilla</option>'}${opts}</select>`;
}
// Si el proyecto ya no coincide con su plantilla (rondas o pasos cambiados), ofrece guardarlo como una nueva.
const saveTplHTML = (p) => (differsFromTemplate(p)
  ? '<button class="link-btn" data-action="savetpl" title="Crea una plantilla nueva con las rondas y pasos de este proyecto">Guardar como plantilla</button>' : '');

function renderMain() {
  const m = $('#main');
  m.classList.remove('leaving');
  m.classList.toggle('enter', !!enter && enter.pid === state.selectedId);
  const p = selected();
  if (!p) { m.innerHTML = renderEmpty(); return; }
  const running = isRunning(p), done = isDone(p), cur = p.rounds[p.currentRound];
  const hold = needsHold(p);
  const playLabel = running
    ? `<span class="play-main"><span class="bars"></span>Pausar</span>${hold ? `<small class="hold-hint">mantén ${fmtSec(holdMs(p))}</small>` : ''}`
    : '<span class="play-main"><span class="tri"></span>Iniciar</span>';
  m.innerHTML = `
    <section class="head">
      <input id="projName" class="proj-title" value="${esc(p.name)}" spellcheck="false" aria-label="Nombre del proyecto">
      <div class="meta">
        <span>Creado <b>${fmtDate(p.createdAt)}, ${fmtTime(p.createdAt)}</b></span>
        <span>Total <b data-timer="${p.id}" data-fmt="short"></b></span>
        <span><b>${p.sessions.length}</b> ${p.sessions.length === 1 ? 'sesión' : 'sesiones'}</span>
        <span class="tpl-pick"><label class="tpl-pick">Plantilla ${tplSelectHTML(p)}</label>${saveTplHTML(p)}</span>
      </div>
      <button class="btn btn-danger btn-small" data-action="delete">Eliminar</button>
    </section>

    <section class="timer ${running ? 'running' : ''} ${broke ? `broke broke-${broke}` : ''}" data-dial="${p.id}">
      ${dialSVG()}
      <div class="timer-info">
        <div class="status">${running ? '<i class="live"></i>En marcha' : (isStarted(p) ? 'En pausa' : 'Sin iniciar')}</div>
        <div class="clock" data-timer="${p.id}" data-fmt="clock"></div>
        <div class="clock-sub">${done
          ? 'Proyecto completado'
          : `En <b>${esc(cur.name)}</b> llevas <span data-round-timer="${p.id}:${p.currentRound}" data-fmt="short"></span>`}</div>
        ${renderDeduct(p)}
      </div>
      <button class="btn btn-solid play ${hold ? `needs-hold hold-${pace(p).idx}` : ''}" data-action="toggle">${playLabel}</button>
      <div class="pace" data-pace="${p.id}"></div>
      ${renderAway(p)}
    </section>

    ${renderPath(p)}
    ${done ? renderDoneCard(p) : renderRoundCard(p)}
    ${renderSessions(p)}`;
}

// Botones para quitar minutos que no trabajaste (sin pausar). Actúan sobre la sesión en curso, o la última.
function renderDeduct(p) {
  const s = deductTarget(p);
  if (!s) return '';
  const undo = lastDeduct && lastDeduct.pid === p.id && lastDeduct.sid === s.id
    ? `<button class="chip chip-undo" data-action="undo-deduct">Deshacer −${fmtAmount(lastDeduct.ms)}</button>` : '';
  const total = s.deducted ? `<span class="deduct-total">${fmtAmount(s.deducted)} descontados ${s.end == null ? 'en esta sesión' : 'de la última sesión'}</span>` : '';
  return `
    <div class="deduct" title="Quita minutos que no trabajaste (p. ej. ir al baño) sin pausar. Se restan del tiempo y también del ritmo.">
      <span class="deduct-label">Descontar</span>
      ${[1, 3, 5].map((m) => `<button class="chip" data-action="deduct" data-min="${m}">−${m} min</button>`).join('')}
      ${undo}${total}
    </div>`;
}

function renderEmpty() {
  const tpl = defaultTemplate();
  const preview = { id: '', createdAt: now(), completedAt: null, currentRound: 0, sessions: [], rounds: buildRounds(tpl) };
  return `
    <section class="empty">
      <h2>En sus<br>marcas</h2>
      <p>Crea un proyecto y arranca el reloj cuando empieces. Cada paso que marques avanza el riel, estación por estación, hasta la meta. Si no pausas, cada logro vale más.</p>
      <button class="btn btn-solid btn-big" data-action="new">+ Nuevo proyecto</button>
      ${renderSnakePath(preview)}
    </section>`;
}

// Vista previa de la plantilla en forma de serpiente: avanza a la derecha, baja con una curva,
// regresa a la izquierda... Así una plantilla larga cabe completa, sin barra de desplazamiento.
const SNAKE = { station: 42, seg: 90, pad: 48 }; // medidas en px (deben coincidir con styles.css)
function renderSnakePath(p) {
  const items = [{ cls: 'done start', box: '', label: `Inicio<small>${fmtDay(p.createdAt)}</small>`, ticks: 0 }];
  p.rounds.forEach((r, i) => items.push({
    cls: i === 0 ? 'current' : 'locked', box: esc(r.short), ticks: r.steps.length,
    label: `<span class="lname">${esc(r.name)}</span>`, title: esc(r.name),
  }));
  items.push({ cls: 'goal locked', box: '', label: 'Meta', ticks: 0 });
  // Cuántas estaciones caben por fila según el ancho disponible.
  const main = $('#main');
  const width = (main ? main.clientWidth - 64 : 800) - SNAKE.pad * 2;
  const perRow = Math.max(2, Math.floor((width - SNAKE.station) / (SNAKE.station + SNAKE.seg)) + 1);
  const ticks = (n) => `<div class="ticks">${'<i class="tick"></i>'.repeat(n)}</div>`;
  let html = '';
  for (let r = 0; r * perRow < items.length; r++) {
    const row = items.slice(r * perRow, (r + 1) * perRow);
    const reverse = r % 2 === 1;
    const more = (r + 1) * perRow < items.length;
    const cells = row.map((it, j) => `
      ${j > 0 ? `<div class="seg locked">${ticks(it.ticks)}</div>` : ''}
      <div class="station ${it.cls}"${it.title ? ` title="${it.title}"` : ''}>
        <div class="box">${it.box}</div>
        <div class="label">${it.label}</div>
      </div>`).join('');
    html += `
      <div class="snake-row${reverse ? ' rev' : ''}" style="--per-row:${perRow}">
        ${cells}
        ${more ? `<div class="snake-turn ${reverse ? 'left' : 'right'}"></div>` : ''}
      </div>`;
  }
  return `<section class="path snake" aria-label="Recorrido de la plantilla"><div class="snake-track">${html}</div></section>`;
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
        ${canRemoveRound(p, i) ? `<button class="x rm-round" data-action="rmround" data-ri="${i}" title="Quitar ronda" aria-label="Quitar ${esc(r.name)}">×</button>` : ''}
        <div class="label"><span class="lname" ${r.completedAt ? '' : `data-rename-round="${i}" title="Doble clic para renombrar"`}>${esc(r.name)}</span><small data-round-timer="${p.id}:${i}" data-fmt="short"></small></div>
      </div>`;
  });
  const popGoal = flash && flash.pid === p.id && done ? 'pop' : '';
  html += `
    <div class="seg ${done ? 'done' : 'locked'}"><div class="seg-fill" style="width:${done ? 100 : 0}%"></div>${done ? '' : '<button class="add-round" data-action="addround" title="Agregar una ronda antes de la meta" aria-label="Agregar ronda">+</button>'}</div>
    <div class="station goal ${done ? 'done' : 'locked'} ${popGoal}" title="Meta"><div class="box"></div><div class="label">Meta</div></div>`;
  return `<section class="path" aria-label="Avance por rondas"><div class="track">${html}</div></section>`;
}

function renderRoundCard(p) {
  const ri = p.currentRound, r = p.rounds[ri];
  const n = r.steps.filter((s) => s.doneAt).length, total = r.steps.length;
  const ready = n === total;
  const nextId = r.steps.find((s) => !s.doneAt)?.id;
  const steps = r.steps.map((s) => `
    <li class="step ${s.doneAt ? 'done' : ''} ${s.id === nextId ? 'next' : ''} ${flash && flash.sid === s.id ? 'just' : ''} ${flash && flash.added === s.id ? 'added' : ''}" data-action="step" data-sid="${s.id}">
      <span class="check">${s.doneAt ? '✓' : ''}</span>
      <span class="step-text">${esc(s.text)}</span>
      ${s.doneAt ? `<span class="step-time">${s.xp && s.xp !== XP.step ? `+${s.xp} · ` : ''}${fmtTime(s.doneAt)}</span>` : ''}
      <button class="x ed" data-action="editstep" data-sid="${s.id}" title="Renombrar paso" aria-label="Renombrar paso">${PENCIL}</button>
      <button class="x" data-action="rmstep" data-sid="${s.id}" title="Quitar paso" aria-label="Quitar paso">×</button>
    </li>`).join('');
  const last = ri === p.rounds.length - 1;
  return `
    <section class="round">
      <div class="round-head">
        <div><div class="eyebrow">Ronda ${ri + 1} de ${p.rounds.length} · ${esc(r.short)}</div>
          <h2><span class="rname" data-rename-round="${ri}" title="Doble clic para renombrar">${esc(r.name)}</span><button class="x ed" data-action="editround" data-ri="${ri}" title="Renombrar ronda" aria-label="Renombrar ronda">${PENCIL}</button></h2></div>
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
    const rn = s.round == null ? '—' : (p.rounds[s.round]?.short ?? '—');
    return `
      <tr class="${live ? 'live-row' : ''}" data-sid="${s.id}">
        <td>${fmtDate(s.start)}</td>
        <td class="mono">${fmtTime(s.start)} – ${live ? 'en curso' : fmtTime(s.end)}</td>
        <td class="num">${live ? `<span data-sess="${p.id}:${s.id}"></span>` : fmtShort(sessionMs(s))}${s.deducted ? `<small class="deducted">−${fmtAmount(s.deducted)}</small>` : ''}</td>
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

let paceSeen = null; // { pid, idx } — para detectar cuando subes de ritmo

// Si entre un refresco y otro pasaron más de 10 min de reloj real, la computadora se suspendió
// (o el navegador congeló la pestaña) con el cronómetro corriendo: se pregunta igual que al reabrir.
let lastBeat = Date.now();
function checkSleep() {
  const real = Date.now();
  const gap = real - lastBeat;
  lastBeat = real;
  if (gap <= AWAY_THRESHOLD || !detectAway()) return false;
  save();
  renderAll();
  toast('El cronómetro siguió corriendo mientras la computadora estaba suspendida.');
  return true;
}

// El refresco se programa para justo después de que cambie el siguiente segundo de lo que estás viendo,
// así el reloj en pantalla nunca va atrasado.
let tickTimer = 0;
function scheduleTick() {
  clearTimeout(tickTimer);
  let delay = 1000;
  const a = activeSession();
  if (a) {
    const n = now();
    const watched = [projectTime(a.p), roundTime(a.p, a.p.currentRound), todayMs(), sessionMs(a.s, n)];
    const pc = pace(a.p);
    if (pc) watched.push(pc.minutes * 60000);
    delay = Math.min(...watched.map((v) => 1000 - (v % 1000))) + 4;
  }
  tickTimer = setTimeout(() => { tick(); scheduleTick(); }, Math.min(Math.max(delay, 15), 1000));
}

function tick() {
  if (checkSleep()) return;
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
    if (s) e.textContent = fmtShort(sessionMs(s));
  });
  $$('[data-pace]').forEach((e) => { const p = getProject(e.dataset.pace); if (p) e.innerHTML = paceHTML(p); });
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
  setFavicon(!!a);
  checkPace(a);
  const dp = $('#debugPace');
  if (dp) dp.innerHTML = debugPaceText();
}
function checkPace(a) {
  if (!a) { paceSeen = null; return; }
  const pc = pace(a.p);
  const prev = paceSeen;
  paceSeen = { pid: a.p.id, idx: pc.idx };
  if (prev && prev.pid === a.p.id && pc.idx > prev.idx) {
    const goal = !pc.next;
    sfx(goal ? 'project' : 'level');
    toast(goal
      ? `Tramo completo: ${fmtShort(pc.minutes * 60000)} sin pausa. Cada logro vale ×${pc.mult} y la pausa ya es libre.`
      : `${pc.label}: desde ahora cada logro vale ×${pc.mult}.`);
    if (state.selectedId === a.p.id && !holdTimer) {
      renderAll();
      const el = $('.pace-bar');
      if (el) {
        const pt = centerOf(el);
        burst(pt.x, pt.y, goal ? 80 : 40, goal ? 1.4 : 1);
        if (goal) setTimeout(() => burst(pt.x - 120, pt.y, 50, 1.2), 200);
      }
    }
  }
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
function floatText(x, y, xp, mult = 1) {
  const d = document.createElement('div');
  const text = typeof xp === 'string'; // texto libre (p. ej. "−5m") en lugar de XP
  d.className = `float-xp${mult > 1 ? ' boosted' : ''}${text ? ' minus' : ''}`;
  d.textContent = text ? xp : `+${xp} XP${mult > 1 ? ` ×${mult}` : ''}`;
  d.style.left = `${x}px`; d.style.top = `${y}px`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 1200);
}
function centerOf(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
const screenCenter = () => ({ x: innerWidth / 2, y: innerHeight / 2 });

let actx;
// [frecuencias, duración, separación, forma de onda, volumen]
const SFX = {
  start: [[523, 784], 0.12, 0.08],
  stop: [[784, 523], 0.12, 0.08],
  step: [[988, 1319], 0.1, 0.06],
  round: [[523, 659, 784, 1047], 0.18, 0.09],
  project: [[523, 659, 784, 1047, 784, 1047, 1319], 0.24, 0.11],
  level: [[659, 880, 1175, 1568], 0.16, 0.08],
  // Pausa con ritmo: mientras más caro, más largo, más grave y más áspero.
  break1: [[523, 392], 0.16, 0.1, 'triangle', 0.1],
  break2: [[440, 349, 262], 0.2, 0.1, 'sawtooth', 0.05],
  break3: [[392, 330, 262, 196, 147], 0.28, 0.12, 'sawtooth', 0.07],
  beat: [[110], 0.07, 0, 'sine', 0.22],          // latido mientras sostienes Pausar
  relief: [[660, 880], 0.06, 0.05, 'triangle', 0.06], // soltaste antes: no pausó
  // Acciones generales: cortas y bajitas.
  create: [[587, 880], 0.09, 0.06, 'triangle', 0.12],
  remove: [[294, 196], 0.14, 0.08, 'sine', 0.2],
  undo: [[880, 659], 0.07, 0.05, 'triangle', 0.08],
  tick: [[1568], 0.03, 0, 'triangle', 0.05],
  toggleOn: [[880, 1175], 0.05, 0.04, 'triangle', 0.07],
  toggleOff: [[1175, 880], 0.05, 0.04, 'triangle', 0.07],
  save: [[659, 988], 0.1, 0.07, 'triangle', 0.12],
  error: [[220, 208], 0.09, 0.07, 'square', 0.04],
  deduct: [[988, 784, 659], 0.05, 0.045, 'triangle', 0.08], // como rebobinar

  shutter: [[1800, 2400, 600], 0.03, 0.045, 'square', 0.05],
};
function sfx(name) {
  if (!state.settings.sound || !SFX[name]) return;
  const [freqs, dur, gap, type = 'triangle', vol = 0.16] = SFX[name];
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime + 0.01;
    freqs.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = f;
      const t = t0 + i * gap;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
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
        <button class="btn btn-solid" data-finish="new">+ Nuevo proyecto</button>
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
  // El aviso vive en la capa superior del navegador (popover). Volver a mostrarlo lo pone encima
  // de cualquier diálogo abierto, así nunca queda detrás del fondo borroso.
  if (t.showPopover) {
    try { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); } catch { /* navegador viejo: z-index normal */ }
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

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
    $('#confirmCancel').onclick = (e) => { sfx('toggleOff'); done(false)(e); };
    d.oncancel = (e) => { sfx('toggleOff'); done(false)(e); }; // tecla Esc
    d.showModal();
    sfx('tick');
    (danger ? $('#confirmCancel') : ok).focus();
  });
}

/* ---------- eventos ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const p = selected();
  switch (t.dataset.action) {
    case 'new': createProject(); break;
    case 'select':
      if (t.dataset.id !== state.selectedId) { state.selectedId = t.dataset.id; enter = { pid: t.dataset.id }; commit(); enter = null; }
      break;
    case 'toggle':
      if (!p || now() - holdDoneAt < 600) break; // el clic que sigue a una pausa sostenida no cuenta
      if (needsHold(p)) { if (e.detail === 0) holdHint(); } // con ritmo, se pausa manteniendo presionado
      else toggleTimer(p);
      break;
    case 'step': if (p) toggleStep(p, t.dataset.sid, t); break;
    case 'rmstep': if (p) removeStep(p, t.dataset.sid); break;
    case 'complete': if (p) completeRound(p, t); break;
    case 'node': if (p && p.rounds[+t.dataset.ri]?.completedAt) reopenRound(p, +t.dataset.ri); break;
    case 'reopen': if (p) reopenRound(p, +t.dataset.ri); break;
    case 'rmround': if (p) removeRound(p, +t.dataset.ri); break;
    case 'addround': if (p) addRound(p); break;
    case 'editround': if (p) renameRound(p, +t.dataset.ri, $('.round-head .rname')); break;
    case 'editstep': if (p) renameStep(p, t.dataset.sid); break;
    case 'savetpl': if (p) saveAsTemplate(p); break;
    case 'delete': if (p) deleteProject(p); break;
    case 'rmsession': if (p) deleteSession(p, t.dataset.sid); break;
    case 'away-keep': resolveAway('keep'); break;
    case 'away-resume': resolveAway('resume'); break;
    case 'away-stop': resolveAway('stop'); break;
    case 'deduct': if (p) deductTime(p, +t.dataset.min, t); break;
    case 'undo-deduct': undoDeduct(); break;
  }
});

// Doble clic al nombre de una ronda (en el riel o en la tarjeta) para renombrarla.
document.addEventListener('dblclick', (e) => {
  const el = e.target.closest('[data-rename-round]');
  const p = selected();
  if (el && p) renameRound(p, +el.dataset.renameRound, el);
});

// Pausa sostenida con mouse o dedo.
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.target.closest('.play')) return;
  const p = selected();
  if (needsHold(p)) { e.preventDefault(); startHold(p); }
});
document.addEventListener('pointerup', cancelHold);
document.addEventListener('pointercancel', cancelHold);

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

document.addEventListener('change', (e) => {
  if (e.target.id === 'projTpl') applyTemplate(selected(), e.target.value);
});

document.addEventListener('toggle', (e) => {
  if (e.target.id === 'sessDetails') sessionsOpen = e.target.open;
}, true);

const typing = (el) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'projName' && e.key === 'Enter') { e.target.blur(); return; }
  if (e.key === 'Escape' && !$('#menu').hidden) { closeMenu(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || $('dialog[open]') || $('.overlay')) return;
  // En botones también respondemos (si no, tras un clic los atajos dejan de servir); Enter sigue activando el botón.
  if (typing(e.target)) return;
  const p = selected();
  if (!p) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (e.repeat) return;
    if (needsHold(p)) startHold(p);
    else toggleTimer(p);
  } else if (e.key.toLowerCase() === 'n' && !isDone(p)) {
    e.preventDefault();
    const next = p.rounds[p.currentRound].steps.find((s) => !s.doneAt);
    if (next) toggleStep(p, next.id, $(`.step[data-sid="${next.id}"]`));
    else completeRound(p, $('.complete'));
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || typing(e.target)) return;
  e.preventDefault();
  cancelHold();
});

/* ---------- menú ---------- */
function closeMenu() { $('#menu').hidden = true; $('#btnMenu').setAttribute('aria-expanded', 'false'); }
$('#btnMenu').addEventListener('click', () => {
  const m = $('#menu');
  m.hidden = !m.hidden;
  $('#btnMenu').setAttribute('aria-expanded', String(!m.hidden));
  if (!m.hidden) sfx('tick');
});
document.addEventListener('click', (e) => { if (!$('#menu').hidden && !e.target.closest('.menu-wrap')) closeMenu(); });

const toggleSfx = (on) => sfx(on ? 'toggleOn' : 'toggleOff');
$('#mSound').addEventListener('click', () => {
  state.settings.sound = !state.settings.sound;
  save(); renderMenu();
  toggleSfx(true); // si se apagó, sfx() ya no suena: el silencio es la respuesta
});
$('#mDebug').addEventListener('click', () => {
  setDebugPanel(!debugPanel);
  toggleSfx(debugPanel);
  if (debugPanel) {
    closeMenu();
    toast('Panel de debug abierto al final de la página.');
    $('#debugFooter').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'end' });
    flashEl($('#debugFooter'));
  }
});
function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
$('#mTheme').addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
  applyTheme(); save(); renderMenu();
  sfx('tick');
});
$('#mFriction').addEventListener('click', () => {
  state.settings.friction = !state.settings.friction;
  commit();
  toggleSfx(state.settings.friction);
  toast(state.settings.friction ? 'Con ritmo activo, pausar pide mantener presionado.' : 'Pausa sin fricción: un clic y listo.');
});
$('#mImages').addEventListener('click', async () => {
  state.settings.levelImages = !state.settings.levelImages;
  commit();
  toggleSfx(state.settings.levelImages);
  if (!state.settings.levelImages) { toast('Imágenes de nivel apagadas.'); return; }
  await initGallery();
  if (!gallery.handle && !gallery.sources.length) pickFolder(); // primera vez: elegir carpeta de una vez
  else toast('Imágenes de nivel activas.');
});
$('#mFolder').addEventListener('click', () => {
  if (gallery.status === 'needs-permission') loadGallery(true);
  else pickFolder();
});
$('#mForget').addEventListener('click', forgetFolder);
$('#dirFallback').addEventListener('change', (e) => {
  const files = [...e.target.files].filter((f) => IMG_EXT.test(f.name));
  e.target.value = '';
  // Misma ruta relativa que con la API de carpetas, para que la imagen fijada coincida.
  gallery.sources = files.map((f) => ({ key: f.webkitRelativePath.split('/').slice(1).join('/') || f.name, getFile: async () => f }));
  gallery.name = files[0]?.webkitRelativePath?.split('/')[0] || '';
  gallery.status = files.length ? 'session' : 'empty';
  renderMenu();
  toast(files.length ? `${files.length} imágenes listas (solo esta sesión).` : 'Esa carpeta no tiene imágenes.');
});
// Clic (o Enter) en el nivel: muestra una imagen al azar.
const showCurrentLevelImage = () => showLevelImage(level(), { manual: true, mode: 'current' });
document.addEventListener('click', (e) => { if (e.target.closest('.stat.level.clickable')) showCurrentLevelImage(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest?.('.stat.level.clickable')) showCurrentLevelImage();
});
$('#mExport').addEventListener('click', () => {
  closeMenu();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `clock-management-${debugMode ? 'PRUEBA-' : ''}${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  sfx('save');
  toast(debugMode ? `Respaldo del modo prueba descargado: ${a.download}` : `Respaldo descargado: ${a.download}`);
});
$('#fileImport').addEventListener('change', async (e) => {
  closeMenu();
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || !Array.isArray(data.projects)) throw new Error('formato');
    // Un respaldo hecho en modo prueba trae horas adelantadas: se avisa antes de mezclarlo con lo real.
    const fromTest = !debugMode && (isNum(data.debugOffset) || isNum(data.debugXp));
    const msg = fromTest
      ? `Este archivo viene del modo prueba${data.debugOffset ? ` (reloj adelantado ${fmtShort(data.debugOffset)})` : ''}: sus horas no coinciden con las reales. Se cargarían ${data.projects.length} proyecto(s) y se reemplazarían tus datos actuales.`
      : `Se cargan ${data.projects.length} proyecto(s) y se reemplazan los datos actuales.`;
    if (!(await ask(fromTest ? 'Respaldo del modo prueba' : 'Importar respaldo', msg, fromTest ? 'Importar igual' : 'Importar', true))) return;
    state = normalize(data);
    applyTheme();
    setAway(null);
    commit();
    sfx('save');
    toast(`Datos importados: ${state.projects.length} proyecto(s).`);
  } catch { sfx('error'); toast('Ese archivo no parece un respaldo válido.'); }
});

/* ---------- plantillas ----------
   Editor en dos columnas: lista de rondas (izquierda) y la ronda elegida con sus pasos (derecha).
   "Editar como texto" cambia a un solo texto: "# 01 · Nombre" por ronda y "- paso" por paso. */
let tw = null; // copia de trabajo: { templates, defaultId, editId, ri, mode, text }
const twCurrent = () => tw.templates.find((t) => t.id === tw.editId);
const twRound = () => twCurrent().rounds[tw.ri];
const isAutoShort = (s) => /^\d+$/.test(s || '') || !(s || '').trim(); // números se renumeran solos
// Las etiquetas numéricas siguen la posición (01, 02, …); las escritas a mano (A, B, TEST) se respetan.
function renumber(t) {
  t.rounds.forEach((r, i) => { if (isAutoShort(r.short)) r.short = pad(i + 1); });
}
function syncName() {
  const t = tw && twCurrent();
  if (t) t.name = $('#tplName').value.trim() || 'Sin nombre';
}
const splitLines = (text) => text.split(/\r?\n/).map((s) => s.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);

/* --- texto ↔ rondas --- */
function templateToText(t) {
  return t.rounds.map((r) => [`# ${r.short || ''} · ${r.name}`, ...r.steps.map((s) => `- ${s}`)].join('\n')).join('\n\n');
}
function textToRounds(text) {
  const rounds = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const body = line.replace(/^#+\s*/, '');
      const m = body.match(/^(\S{1,4})\s*[·|:]\s*(.+)$/); // "01 · Nombre", "A: Nombre"
      rounds.push(m ? { short: m[1], name: m[2].trim(), steps: [] } : { short: '', name: body || `Ronda ${rounds.length + 1}`, steps: [] });
    } else {
      if (!rounds.length) rounds.push({ short: '', name: 'Ronda 1', steps: [] });
      const step = line.replace(/^[-*•]\s*/, '').trim();
      if (step) rounds[rounds.length - 1].steps.push(step);
    }
  }
  return rounds;
}
// Lleva lo escrito en modo texto a la plantilla. Devuelve false si no hay ninguna ronda.
function applyText() {
  if (tw.mode !== 'text') return true;
  const rounds = textToRounds($('#tplText')?.value ?? tw.text ?? '');
  if (!rounds.length) { sfx('error'); toast('Escribe al menos una ronda: una línea que empiece con #.'); return false; }
  const t = twCurrent();
  t.rounds = rounds;
  renumber(t);
  tw.ri = Math.min(tw.ri, rounds.length - 1);
  return true;
}

/* --- render --- */
function renderTplDialog() {
  const t = twCurrent();
  $('#tplSelect').innerHTML = tw.templates.map((x) =>
    `<option value="${x.id}" ${x.id === tw.editId ? 'selected' : ''}>${esc(x.name)}${x.id === tw.defaultId ? ' · predeterminada' : ''}</option>`).join('');
  $('#tplName').value = t.name;
  const d = $('#tplDefault');
  d.checked = t.id === tw.defaultId;
  d.disabled = d.checked;
  $('#tplMode').textContent = tw.mode === 'text' ? 'Editar visual' : 'Editar como texto';
  if (tw.mode === 'text') renderTplText();
  else {
    $('#tplBody').innerHTML = `
      <div class="tpl-cols">
        <aside class="tpl-list">
          <div class="tpl-list-head"><span>Rondas · <b id="tplCount"></b></span>
            <button type="button" class="tpl-act" data-tpl="number" title="Etiquetas 01, 02, 03…">Numerar</button></div>
          <ol id="tplRoundList" class="tpl-rounds"></ol>
          <button type="button" class="tpl-add" data-tpl="add-round">+ Agregar ronda</button>
        </aside>
        <section class="tpl-detail" id="tplDetail"></section>
      </div>`;
    renderTplList();
    renderTplDetail();
  }
}
function renderTplList() {
  const t = twCurrent();
  $('#tplCount').textContent = t.rounds.length;
  $('#tplRoundList').innerHTML = t.rounds.map((r, i) => `
    <li class="tpl-ri ${i === tw.ri ? 'sel' : ''}" data-ri="${i}" draggable="true" tabindex="0" title="Arrastra para reordenar (o Alt+↑/↓)">
      <span class="grip" aria-hidden="true"></span>
      <span class="ri-short">${esc(r.short || pad(i + 1))}</span>
      <span class="ri-name">${esc(r.name || 'Sin nombre')}</span>
      <span class="ri-count">${r.steps.length}</span>
    </li>`).join('');
}
function renderTplDetail(focus) {
  const r = twRound();
  const i = tw.ri;
  const last = twCurrent().rounds.length;
  $('#tplDetail').innerHTML = `
    <div class="tpl-detail-head">
      <span class="tpl-pos">Ronda ${i + 1} de ${last}</span>
      <div class="tpl-acts">
        <button type="button" class="tpl-act" data-tpl="dup-round">Duplicar ronda</button>
        <button type="button" class="tpl-act" data-tpl="copy-steps" title="Pone estos mismos pasos en todas las rondas">Copiar pasos a todas</button>
        <button type="button" class="tpl-act danger" data-tpl="del-round">Eliminar ronda</button>
      </div>
    </div>
    <div class="tpl-names">
      <input id="tplShort" class="tpl-short-in" maxlength="4" value="${esc(r.short)}" placeholder="${pad(i + 1)}" aria-label="Etiqueta corta" title="Etiqueta corta (en número se renumera sola)">
      <input id="tplRoundName" class="tpl-rname" value="${esc(r.name)}" placeholder="Nombre de la ronda" aria-label="Nombre de la ronda">
    </div>
    <ol class="tpl-steps" id="tplSteps">${r.steps.map((s, si) => `
      <li class="tpl-step" data-si="${si}" draggable="true">
        <span class="grip" aria-hidden="true"></span>
        <span class="si-n">${si + 1}</span>
        <input class="si-in" data-si="${si}" value="${esc(s)}" aria-label="Paso ${si + 1}">
        <button type="button" class="x" data-tpl="del-step" data-si="${si}" title="Quitar paso" aria-label="Quitar paso ${si + 1}">×</button>
      </li>`).join('')}
    </ol>
    <input id="tplNewStep" class="tpl-newstep" placeholder="Agregar paso · Enter para el siguiente · pega varias líneas de golpe" aria-label="Agregar paso">`;
  if (focus === 'new') $('#tplNewStep').focus();
  else if (Number.isInteger(focus)) { const el = $(`.si-in[data-si="${focus}"]`); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  else if (focus === 'name') $('#tplRoundName').select();
}
function renderTplText() {
  if (tw.text == null) tw.text = templateToText(twCurrent());
  $('#tplBody').innerHTML = `
    <div class="tpl-textmode">
      <div class="tpl-textcol">
        <textarea id="tplText" spellcheck="false" aria-label="Plantilla como texto">${esc(tw.text)}</textarea>
        <p class="tpl-help"><code># 01 · Nombre</code> empieza una ronda · <code>- paso</code> agrega un paso · las líneas vacías no cuentan.</p>
      </div>
      <aside class="tpl-preview" id="tplPreview" aria-label="Vista previa"></aside>
    </div>`;
  renderTplPreview();
}
function renderTplPreview() {
  const rounds = textToRounds($('#tplText').value);
  $('#tplPreview').innerHTML = rounds.length
    ? `<div class="tpl-list-head"><span>Vista previa · <b>${rounds.length}</b> rondas</span></div>
       <ol class="tpl-rounds">${rounds.map((r, i) => `<li class="tpl-ri"><span class="ri-short">${esc(isAutoShort(r.short) ? pad(i + 1) : r.short)}</span><span class="ri-name">${esc(r.name)}</span><span class="ri-count">${r.steps.length}</span></li>`).join('')}</ol>`
    : '<p class="tpl-help">Escribe una línea que empiece con <code>#</code> para la primera ronda.</p>';
}

/* --- acciones --- */
function moveItem(list, from, to) {
  if (from === to || to < 0 || to >= list.length) return false;
  list.splice(to, 0, list.splice(from, 1)[0]);
  return true;
}
function selectRound(i) {
  tw.ri = i;
  renderTplList();
  renderTplDetail();
}
function addSteps(lines, at) {
  const r = twRound();
  if (!lines.length) return;
  r.steps.splice(at ?? r.steps.length, 0, ...lines);
  renderTplList();
  renderTplDetail('new');
  sfx('tick');
}
function tplAction(kind, el) {
  const t = twCurrent();
  const r = twRound();
  switch (kind) {
    case 'add-round':
      t.rounds.push({ short: pad(t.rounds.length + 1), name: `Ronda ${t.rounds.length + 1}`, steps: [] });
      tw.ri = t.rounds.length - 1;
      renderTplList(); renderTplDetail('name'); sfx('create');
      break;
    case 'dup-round':
      t.rounds.splice(tw.ri + 1, 0, { ...clone(r), short: isAutoShort(r.short) ? '' : r.short, name: `${r.name} (copia)` });
      tw.ri += 1; renumber(t);
      renderTplList(); renderTplDetail('name'); sfx('create');
      break;
    case 'del-round':
      if (t.rounds.length <= 1) { sfx('error'); toast('Debe quedar al menos una ronda.'); return; }
      t.rounds.splice(tw.ri, 1);
      tw.ri = Math.min(tw.ri, t.rounds.length - 1); renumber(t);
      renderTplList(); renderTplDetail(); sfx('remove');
      break;
    case 'copy-steps': {
      const steps = r.steps.filter((s) => s.trim());
      if (!steps.length) { sfx('error'); toast('Esta ronda no tiene pasos para copiar.'); return; }
      t.rounds.forEach((x) => { x.steps = [...steps]; });
      renderTplList(); sfx('save');
      toast(`Los ${steps.length} pasos de "${r.name}" quedaron en las ${t.rounds.length} rondas. Ajusta las que cambien.`);
      flashEl($('#tplRoundList'));
      break;
    }
    case 'del-step':
      r.steps.splice(+el.dataset.si, 1);
      renderTplList(); renderTplDetail(Math.max(0, +el.dataset.si - 1)); sfx('remove');
      break;
    case 'number':
      t.rounds.forEach((x, i) => { x.short = pad(i + 1); });
      renderTplList(); renderTplDetail(); sfx('tick');
      break;
  }
}

function openTemplates() {
  const cur = selected();
  tw = {
    templates: clone(state.settings.templates),
    defaultId: state.settings.defaultTemplateId,
    editId: cur && getTemplate(cur.templateId) ? cur.templateId : state.settings.defaultTemplateId,
    ri: 0, mode: 'visual', text: null,
  };
  renderTplDialog();
  $('#dlgTemplate').showModal();
}
// Antes de cambiar de plantilla o de modo: guarda lo escrito en la copia de trabajo.
function settleEditor() {
  syncName();
  if (tw.mode === 'text') { if (!applyText()) return false; tw.text = null; }
  return true;
}

$('#btnTemplate').addEventListener('click', () => { openTemplates(); sfx('tick'); });
$('#tplSelect').addEventListener('change', (e) => {
  if (!settleEditor()) { e.target.value = tw.editId; return; }
  tw.editId = e.target.value; tw.ri = 0;
  renderTplDialog();
});
$('#tplName').addEventListener('input', (e) => {
  const opt = $('#tplSelect').selectedOptions[0];
  if (opt) opt.textContent = (e.target.value.trim() || 'Sin nombre') + (tw.editId === tw.defaultId ? ' · predeterminada' : '');
});
$('#tplNew').addEventListener('click', () => {
  if (!settleEditor()) return;
  // Punto de partida mínimo: una ronda con dos pasos, para crecer con "Duplicar ronda".
  const t = { id: uid(), name: `Plantilla ${tw.templates.length + 1}`, rounds: clone(DEFAULT_ROUNDS) };
  tw.templates.push(t);
  tw.editId = t.id; tw.ri = 0;
  renderTplDialog();
  $('#tplName').select();
  sfx('create');
});
$('#tplDup').addEventListener('click', () => {
  if (!settleEditor()) return;
  const src = twCurrent();
  const t = { ...clone(src), id: uid(), name: `${src.name} (copia)` };
  tw.templates.push(t);
  tw.editId = t.id; tw.ri = 0;
  renderTplDialog();
  $('#tplName').select();
  sfx('create');
});
$('#tplDel').addEventListener('click', () => {
  if (tw.templates.length <= 1) { sfx('error'); toast('Debe quedar al menos una plantilla.'); return; }
  tw.templates = tw.templates.filter((t) => t.id !== tw.editId);
  if (!tw.templates.some((t) => t.id === tw.defaultId)) tw.defaultId = tw.templates[0].id;
  tw.editId = tw.defaultId; tw.ri = 0; tw.text = null;
  renderTplDialog();
  sfx('remove');
});
$('#tplDefault').addEventListener('change', (e) => {
  if (!e.target.checked) return;
  if (!settleEditor()) { e.target.checked = false; return; }
  tw.defaultId = tw.editId;
  renderTplDialog();
  sfx('toggleOn');
});
$('#tplMode').addEventListener('click', () => {
  if (tw.mode === 'text') {
    if (!applyText()) return;
    tw.mode = 'visual'; tw.text = null;
  } else {
    tw.mode = 'text'; tw.text = null;
  }
  renderTplDialog();
  sfx('tick');
  if (tw.mode === 'text') $('#tplText').focus();
});

// Clics: elegir ronda y acciones.
$('#tplBody').addEventListener('click', (e) => {
  const act = e.target.closest('[data-tpl]');
  if (act) { tplAction(act.dataset.tpl, act); return; }
  const item = e.target.closest('#tplRoundList .tpl-ri');
  if (item) selectRound(+item.dataset.ri);
});
// Escribir: se guarda al momento en la copia de trabajo.
$('#tplBody').addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'tplText') { tw.text = el.value; renderTplPreview(); return; }
  if (tw.mode !== 'visual') return;
  const r = twRound();
  const li = $(`#tplRoundList .tpl-ri[data-ri="${tw.ri}"]`);
  if (el.id === 'tplShort') { r.short = el.value.trim(); if (li) li.querySelector('.ri-short').textContent = r.short || pad(tw.ri + 1); }
  else if (el.id === 'tplRoundName') { r.name = el.value; if (li) li.querySelector('.ri-name').textContent = r.name || 'Sin nombre'; }
  else if (el.classList.contains('si-in')) r.steps[+el.dataset.si] = el.value;
});
// Teclado: Enter crea el siguiente paso, Retroceso en un paso vacío lo borra, Alt+↑/↓ reordena.
$('#tplBody').addEventListener('keydown', (e) => {
  const el = e.target;
  if (tw.mode !== 'visual') return;
  const r = twRound();
  if (el.id === 'tplNewStep' && e.key === 'Enter') {
    e.preventDefault();
    const v = el.value.trim();
    if (v) addSteps([v]);
  } else if (el.classList.contains('si-in')) {
    const si = +el.dataset.si;
    if (e.key === 'Enter') { e.preventDefault(); addSteps([''], si + 1); renderTplDetail(si + 1); }
    else if (e.key === 'Backspace' && !el.value) { e.preventDefault(); r.steps.splice(si, 1); renderTplList(); renderTplDetail(si > 0 ? si - 1 : 'new'); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const to = si + (e.key === 'ArrowUp' ? -1 : 1);
      if (moveItem(r.steps, si, to)) { renderTplDetail(to); sfx('tick'); }
    }
  } else if (el.matches('#tplRoundList .tpl-ri')) {
    const ri = +el.dataset.ri;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRound(ri); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const to = ri + (e.key === 'ArrowUp' ? -1 : 1);
      if (moveItem(twCurrent().rounds, ri, to)) {
        tw.ri = to; renumber(twCurrent());
        renderTplList(); renderTplDetail(); sfx('tick');
        $(`#tplRoundList .tpl-ri[data-ri="${to}"]`)?.focus();
      }
    }
  }
});
// Pegar varias líneas: cada línea es un paso.
$('#tplBody').addEventListener('paste', (e) => {
  const el = e.target;
  if (tw.mode !== 'visual' || !(el.id === 'tplNewStep' || el.classList.contains('si-in'))) return;
  const lines = splitLines(e.clipboardData?.getData('text') || '');
  if (lines.length < 2) return;
  e.preventDefault();
  const at = el.classList.contains('si-in') ? +el.dataset.si + 1 : undefined;
  addSteps(lines, at);
  toast(`${lines.length} pasos agregados.`);
});
// Arrastrar para reordenar rondas y pasos.
let tplDrag = null; // { kind: 'ri' | 'si', from }
$('#tplBody').addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('.tpl-ri[data-ri], .tpl-step');
  if (!li || tw.mode !== 'visual') return;
  tplDrag = li.classList.contains('tpl-step') ? { kind: 'si', from: +li.dataset.si } : { kind: 'ri', from: +li.dataset.ri };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
  li.classList.add('dragging');
});
$('#tplBody').addEventListener('dragover', (e) => {
  if (!tplDrag) return;
  const li = e.target.closest(tplDrag.kind === 'si' ? '.tpl-step' : '#tplRoundList .tpl-ri');
  $$('.drop-at').forEach((x) => x.classList.remove('drop-at'));
  if (!li) return;
  e.preventDefault();
  li.classList.add('drop-at');
});
$('#tplBody').addEventListener('drop', (e) => {
  if (!tplDrag) return;
  const li = e.target.closest(tplDrag.kind === 'si' ? '.tpl-step' : '#tplRoundList .tpl-ri');
  if (!li) return;
  e.preventDefault();
  const to = +(tplDrag.kind === 'si' ? li.dataset.si : li.dataset.ri);
  if (tplDrag.kind === 'si') {
    if (moveItem(twRound().steps, tplDrag.from, to)) { renderTplDetail(); sfx('tick'); }
  } else if (moveItem(twCurrent().rounds, tplDrag.from, to)) {
    tw.ri = to; renumber(twCurrent());
    renderTplList(); renderTplDetail(); sfx('tick');
  }
});
$('#tplBody').addEventListener('dragend', () => {
  tplDrag = null;
  $$('.dragging, .drop-at').forEach((x) => x.classList.remove('dragging', 'drop-at'));
});

$('#tplCancel').addEventListener('click', () => { $('#dlgTemplate').close(); sfx('toggleOff'); });
$('#tplSave').addEventListener('click', () => {
  if (!settleEditor()) return;
  // Limpieza al guardar: sin pasos vacíos, nombres con texto, etiquetas completas.
  for (const t of tw.templates) {
    t.rounds.forEach((r, i) => {
      r.name = (r.name || '').trim() || `Ronda ${i + 1}`;
      r.steps = r.steps.map((s) => s.trim()).filter(Boolean);
      if (!(r.short || '').trim()) r.short = pad(i + 1);
    });
  }
  state.settings.templates = tw.templates;
  state.settings.defaultTemplateId = tw.defaultId;
  $('#dlgTemplate').close();
  commit();
  sfx('save');
  toast('Plantillas guardadas. Los proyectos existentes no cambian.');
});

/* ---------- arranque ---------- */
applyTheme();
initGallery();
away = state.away || null;
if (detectAway()) save(); // el aviso se guarda: si recargas sin contestarlo, sigue ahí
if (!selected() && state.projects.length) state.selectedId = state.projects[0].id;
renderAll();
if (away) toast('Un cronómetro siguió corriendo mientras no estabas.');
scheduleTick();
// Marca de "página abierta" cada 15 s (en su propia llave): así sabemos cuándo se cerró el navegador.
touchSeen();
setInterval(touchSeen, 15000);
addEventListener('pagehide', touchSeen);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) touchSeen();
  else { tick(); scheduleTick(); } // al volver a la pestaña, el reloj se pone al día de inmediato
});

// Varias pestañas abiertas: cuando otra guarda cambios, esta los adopta (y no los pisa).
addEventListener('storage', (e) => {
  if (frozen || e.key !== storageKey() || !e.newValue) return;
  let next;
  try { next = normalize(JSON.parse(e.newValue)); } catch { return; }
  const keepSel = state.selectedId;
  state = next;
  if (keepSel && getProject(keepSel)) state.selectedId = keepSel; // cada pestaña sigue viendo su proyecto
  if (debugMode) timeOffset = state.debugOffset || 0;
  away = state.away || null;
  // Conserva el foco y lo que estés escribiendo en esta pestaña.
  const f = document.activeElement;
  const fid = f && f.id;
  const val = f && 'value' in f ? f.value : null;
  const [s0, s1] = f && 'selectionStart' in f ? [f.selectionStart, f.selectionEnd] : [null, null];
  renderAll();
  scheduleTick();
  const g = fid && document.getElementById(fid);
  if (g && g !== f) {
    if (val != null && fid !== 'projName') g.value = val;
    g.focus();
    try { if (s0 != null) g.setSelectionRange(s0, s1); } catch { /* no aplica */ }
  }
});
try { localStorage.removeItem(`${NS}:debug-open`); } catch { /* llave vieja, ya no se usa */ }
// La serpiente de la pantalla de inicio se reacomoda si cambia el ancho de la ventana.
let snakeResize = 0;
addEventListener('resize', () => {
  clearTimeout(snakeResize);
  snakeResize = setTimeout(() => { if (!selected()) renderMain(); }, 150);
});
// Enter dentro de los diálogos no debe cerrarlos sin guardar.
$$('dialog form').forEach((f) => f.addEventListener('submit', (e) => e.preventDefault()));
