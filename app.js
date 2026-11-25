'use strict';

/* =========================================================
   Clock Management — cronómetro de proyectos con micro-logros
   Todo se guarda en localStorage (este navegador).
   ========================================================= */

const STORAGE_KEY = 'clock-management:v1';
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
const DEBUG_KEY = 'clock-management:debug';
const MODE_KEY = 'clock-management:mode';
let debugMode = false;
try { debugMode = localStorage.getItem(MODE_KEY) === 'debug'; } catch { /* sin storage */ }
const storageKey = () => (debugMode ? DEBUG_KEY : STORAGE_KEY);
let timeOffset = 0; // ms que se adelantó el reloj (solo en modo prueba)
let frozen = false; // true justo antes de recargar al cambiar de modo, para no sobrescribir

const DEFAULT_TPL_ID = 'tpl-default';
const DEFAULT_ROUNDS = [
  { short: 'A', name: 'Evaluación A', steps: ['Preparar material', 'Evaluar', 'Registrar resultados'] },
  { short: 'B', name: 'Evaluación B', steps: ['Preparar material', 'Evaluar', 'Registrar resultados'] },
  { short: 'A+B', name: 'Evaluación combinada', steps: ['Comparar A vs B', 'Conciliar diferencias', 'Resultado final'] },
];

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
  return {
    version: 2, projects: [], selectedId: null, lastSeen: null, away: null,
    settings: {
      sound: true, theme: 'system', friction: true, levelImages: false,
      templates: [{ id: DEFAULT_TPL_ID, name: 'Evaluación A / B / combinada', rounds: clone(DEFAULT_ROUNDS) }],
      defaultTemplateId: DEFAULT_TPL_ID,
    },
  };
}
function normalize(s) {
  const base = freshState();
  if (!s || !Array.isArray(s.projects)) return base;
  const old = s.settings || {};
  const st = {
    sound: old.sound ?? true,
    theme: old.theme ?? 'system',
    friction: old.friction ?? true,
    levelImages: old.levelImages ?? false,
    templates: old.templates,
    defaultTemplateId: old.defaultTemplateId,
  };
  // Migración v1 → v2: la plantilla única pasa a ser la predeterminada.
  if (!Array.isArray(st.templates) || !st.templates.length) {
    const rounds = Array.isArray(old.template) && old.template.length ? old.template : clone(DEFAULT_ROUNDS);
    st.templates = [{ id: DEFAULT_TPL_ID, name: 'Evaluación A / B / combinada', rounds }];
    st.defaultTemplateId = DEFAULT_TPL_ID;
    for (const p of s.projects) if (!p.templateId) p.templateId = DEFAULT_TPL_ID;
  }
  if (!st.templates.some((t) => t.id === st.defaultTemplateId)) st.defaultTemplateId = st.templates[0].id;
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
  state.lastSeen = now();
  try { localStorage.setItem(storageKey(), JSON.stringify(state)); }
  catch {
    if (!storageWarned) { storageWarned = true; toast('No se pudo guardar en el navegador. Usa Exportar para respaldar.'); }
  }
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
const buildRounds = (tpl) => tpl.rounds.map((t) => ({
  short: t.short, name: t.name, completedAt: null,
  steps: t.steps.map((text) => ({ id: uid(), text, doneAt: null })),
}));

/* --- ritmo --- */
// Inicio del tramo continuo: sesiones pegadas (fin == inicio de la siguiente) cuentan como una sola carrera.
function runStart(p) {
  const act = p.sessions.find((s) => s.end == null);
  if (!act) return null;
  let start = act.start, found = true;
  while (found) {
    found = false;
    for (const s of p.sessions) if (s.end === start) { start = s.start; found = true; break; }
  }
  return start;
}
function pace(p) {
  const st = p && runStart(p);
  if (st == null) return null;
  const minutes = (now() - st) / 60000;
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
  const a = activeSession();
  if (a) a.s.end = now();
  setAway(null);
  p.sessions.push({ id: uid(), start: now(), end: null, round: isDone(p) ? null : p.currentRound });
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
  if (pc) toast(`Mantén presionado ${fmtSec(pc.hold)} para pausar. Perderías el ritmo ×${pc.mult} (${Math.floor(pc.minutes)} min seguidos).`);
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
  const min = Math.floor(pc.minutes);
  if (sev === 1) toast(`Pausa. Perdiste el ritmo ×${pc.mult} (${min} min).`);
  else if (sev === 2) toast(`Se rompió tu ritmo ×${pc.mult} tras ${min} min seguidos.`);
  else toast(`Se rompió una racha de ${fmtShort(pc.minutes * 60000)} ×${pc.mult}. Estabas a ${Math.max(1, Math.ceil(GOAL_MIN - pc.minutes))} min del tramo completo.`);
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
      const r = indexedDB.open('clock-management', 1);
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
function renderAll() { renderStats(); renderMenu(); renderList(); renderMain(); renderDebug(); tick(); }

/* --- footer de debug --- */
function debugPaceText() {
  const a = activeSession();
  if (!a) return 'Ningún cronómetro corriendo.';
  const pc = pace(a.p);
  return `${esc(a.p.name)}: ${Math.floor(pc.minutes)} min seguidos · ${pc.label} ×${pc.mult} · ${needsHold(a.p) ? `pausa sostenida ${fmtSec(pc.hold)}` : 'pausa libre'}`;
}
// El panel de debug es preferencia de este navegador (no va en los datos), igual en modo real o de prueba.
const DEBUG_PANEL_KEY = 'clock-management:debug-panel';
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
    if (on && !localStorage.getItem(DEBUG_KEY)) localStorage.setItem(DEBUG_KEY, localStorage.getItem(STORAGE_KEY) || '');
    localStorage.setItem(MODE_KEY, on ? 'debug' : 'real');
  } catch { /* sin storage */ }
  location.reload();
}
function resetDebug(copyReal) {
  if (!debugMode) return;
  frozen = true;
  try { localStorage.setItem(DEBUG_KEY, copyReal ? localStorage.getItem(STORAGE_KEY) || '' : ''); } catch { /* sin storage */ }
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
  save();
  const last = state.lastSeen;
  state.debugOffset = (state.debugOffset || 0) + min * 60000;
  timeOffset = state.debugOffset;
  state.lastSeen = last; // la página "no estuvo abierta" durante ese lapso
  detectAway();
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
        <label class="tpl-pick">Plantilla ${tplSelectHTML(p)}</label>
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
      </div>
      <button class="btn btn-solid play ${hold ? `needs-hold hold-${pace(p).idx}` : ''}" data-action="toggle">${playLabel}</button>
      <div class="pace" data-pace="${p.id}"></div>
      ${renderAway(p)}
    </section>

    ${renderPath(p)}
    ${done ? renderDoneCard(p) : renderRoundCard(p)}
    ${renderSessions(p)}`;
}

function renderEmpty() {
  const tpl = defaultTemplate();
  const preview = { id: '', createdAt: now(), completedAt: null, currentRound: 0, sessions: [], rounds: buildRounds(tpl) };
  return `
    <section class="empty">
      <h2>En sus<br>marcas</h2>
      <p>Crea un proyecto y arranca el reloj cuando empieces. Cada paso que marques avanza el riel, estación por estación, hasta la meta. Si no pausas, cada logro vale más.</p>
      <button class="btn btn-solid btn-big" data-action="new">+ Nuevo proyecto</button>
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
    <li class="step ${s.doneAt ? 'done' : ''} ${s.id === nextId ? 'next' : ''} ${flash && flash.sid === s.id ? 'just' : ''} ${flash && flash.added === s.id ? 'added' : ''}" data-action="step" data-sid="${s.id}">
      <span class="check">${s.doneAt ? '✓' : ''}</span>
      <span class="step-text">${esc(s.text)}</span>
      ${s.doneAt ? `<span class="step-time">${s.xp && s.xp !== XP.step ? `+${s.xp} · ` : ''}${fmtTime(s.doneAt)}</span>` : ''}
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
    const rn = s.round == null ? '—' : (p.rounds[s.round]?.short ?? '—');
    return `
      <tr class="${live ? 'live-row' : ''}" data-sid="${s.id}">
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

let paceSeen = null; // { pid, idx } — para detectar cuando subes de ritmo
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
  d.className = `float-xp${mult > 1 ? ' boosted' : ''}`;
  d.textContent = `+${xp} XP${mult > 1 ? ` ×${mult}` : ''}`;
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
    case 'delete': if (p) deleteProject(p); break;
    case 'rmsession': if (p) deleteSession(p, t.dataset.sid); break;
    case 'away-keep': resolveAway('keep'); break;
    case 'away-resume': resolveAway('resume'); break;
    case 'away-stop': resolveAway('stop'); break;
  }
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
  a.download = `clock-management-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  sfx('save');
  toast(`Respaldo descargado: ${a.download}`);
});
$('#fileImport').addEventListener('change', async (e) => {
  closeMenu();
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
    sfx('save');
    toast(`Datos importados: ${state.projects.length} proyecto(s).`);
  } catch { sfx('error'); toast('Ese archivo no parece un respaldo válido.'); }
});

/* ---------- plantillas ---------- */
let tw = null; // copia de trabajo: { templates, defaultId, editId }
const twCurrent = () => tw.templates.find((t) => t.id === tw.editId);
function readRounds() {
  return $$('.tpl-round').map((f) => ({
    short: f.querySelector('[name=short]').value.trim() || '?',
    name: f.querySelector('[name=name]').value.trim() || 'Ronda',
    steps: f.querySelector('[name=steps]').value.split('\n').map((s) => s.trim()).filter(Boolean),
  }));
}
function syncTplForm() {
  const t = twCurrent();
  if (!t) return;
  t.name = $('#tplName').value.trim() || 'Sin nombre';
  t.rounds = readRounds();
}
function renderTplDialog() {
  const t = twCurrent();
  $('#tplSelect').innerHTML = tw.templates.map((x) =>
    `<option value="${x.id}" ${x.id === tw.editId ? 'selected' : ''}>${esc(x.name)}${x.id === tw.defaultId ? ' · predeterminada' : ''}</option>`).join('');
  $('#tplName').value = t.name;
  const d = $('#tplDefault');
  d.checked = t.id === tw.defaultId;
  d.disabled = d.checked;
  $('#tplRounds').innerHTML = t.rounds.map((r, i) => `
    <fieldset class="tpl-round" data-i="${i}">
      <div class="tpl-row">
        <input id="tplShort${i}" name="short" class="tpl-short" value="${esc(r.short)}" maxlength="4" aria-label="Etiqueta corta" placeholder="A">
        <input id="tplRoundName${i}" name="name" class="tpl-name" value="${esc(r.name)}" aria-label="Nombre de la ronda" placeholder="Nombre de la ronda">
        <button type="button" class="x" data-tpl-rm="${i}" title="Quitar ronda" aria-label="Quitar ronda">×</button>
      </div>
      <textarea id="tplSteps${i}" name="steps" rows="3" placeholder="Un paso por línea">${esc(r.steps.join('\n'))}</textarea>
    </fieldset>`).join('');
}
function openTemplates() {
  const cur = selected();
  tw = {
    templates: clone(state.settings.templates),
    defaultId: state.settings.defaultTemplateId,
    editId: cur && getTemplate(cur.templateId) ? cur.templateId : state.settings.defaultTemplateId,
  };
  renderTplDialog();
  $('#dlgTemplate').showModal();
}
$('#btnTemplate').addEventListener('click', () => { openTemplates(); sfx('tick'); });
$('#tplSelect').addEventListener('change', (e) => { syncTplForm(); tw.editId = e.target.value; renderTplDialog(); });
$('#tplName').addEventListener('input', (e) => {
  const opt = $('#tplSelect').selectedOptions[0];
  if (opt) opt.textContent = (e.target.value.trim() || 'Sin nombre') + (tw.editId === tw.defaultId ? ' · predeterminada' : '');
});
$('#tplNew').addEventListener('click', () => {
  syncTplForm();
  const t = { id: uid(), name: `Plantilla ${tw.templates.length + 1}`, rounds: clone(DEFAULT_ROUNDS) };
  tw.templates.push(t);
  tw.editId = t.id;
  renderTplDialog();
  $('#tplName').select();
  sfx('create');
});
$('#tplDup').addEventListener('click', () => {
  syncTplForm();
  const src = twCurrent();
  const t = { ...clone(src), id: uid(), name: `${src.name} (copia)` };
  tw.templates.push(t);
  tw.editId = t.id;
  renderTplDialog();
  $('#tplName').select();
  sfx('create');
});
$('#tplDel').addEventListener('click', () => {
  if (tw.templates.length <= 1) { sfx('error'); toast('Debe quedar al menos una plantilla.'); return; }
  tw.templates = tw.templates.filter((t) => t.id !== tw.editId);
  if (!tw.templates.some((t) => t.id === tw.defaultId)) tw.defaultId = tw.templates[0].id;
  tw.editId = tw.defaultId;
  renderTplDialog();
  sfx('remove');
});
$('#tplDefault').addEventListener('change', (e) => {
  if (e.target.checked) { syncTplForm(); tw.defaultId = tw.editId; renderTplDialog(); sfx('toggleOn'); }
});
$('#tplAdd').addEventListener('click', () => {
  syncTplForm();
  const t = twCurrent();
  t.rounds.push({ short: String(t.rounds.length + 1), name: `Ronda ${t.rounds.length + 1}`, steps: [] });
  renderTplDialog();
  sfx('tick');
  $(`#tplRoundName${t.rounds.length - 1}`)?.select();
});
$('#tplRounds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tpl-rm]');
  if (!b) return;
  syncTplForm();
  const t = twCurrent();
  if (t.rounds.length <= 1) { sfx('error'); toast('Debe quedar al menos una ronda.'); return; }
  t.rounds.splice(+b.dataset.tplRm, 1);
  renderTplDialog();
  sfx('remove');
});
$('#tplCancel').addEventListener('click', () => { $('#dlgTemplate').close(); sfx('toggleOff'); });
$('#tplSave').addEventListener('click', () => {
  syncTplForm();
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
detectAway();
if (!selected() && state.projects.length) state.selectedId = state.projects[0].id;
renderAll();
if (away) toast('Un cronómetro siguió corriendo mientras no estabas.');
setInterval(tick, 1000);
// Marca de "página abierta" cada 15 s: así sabemos cuándo se cerró el navegador.
setInterval(save, 15000);
addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
try { localStorage.removeItem('clock-management:debug-open'); } catch { /* llave vieja, ya no se usa */ }
// Enter dentro de los diálogos no debe cerrarlos sin guardar.
$$('dialog form').forEach((f) => f.addEventListener('submit', (e) => e.preventDefault()));
