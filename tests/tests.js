'use strict';

/* =========================================================
   Pruebas de Clock Management
   Cada prueba abre la app en un iframe con ?test: la app usa llaves
   "clock-management-test:*" y nunca toca tus datos reales.
   Los tiempos se prueban con un reloj controlado (Date.now del iframe),
   y una prueba aparte los compara contra el reloj real.
   ========================================================= */

const NS = 'clock-management-test';
const MIN = 60000;
const H = 60 * MIN;
const T0 = new Date(2026, 10, 25, 9, 0, 0).getTime(); // 25 nov 2026, 9:00 (hora local)
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- aserciones ---------- */
class Fail extends Error {}
const show = (v) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
function check(cond, msg) { if (!cond) throw new Fail(msg); }
function eq(got, want, msg) { if (got !== want) throw new Fail(`${msg}: esperaba ${show(want)}, obtuve ${show(got)}`); }
function near(got, want, tol, msg) {
  if (!(Math.abs(got - want) <= tol)) throw new Fail(`${msg}: esperaba ${want} ± ${tol}, obtuve ${got} (diferencia ${got - want})`);
}

/* ---------- datos de prueba ---------- */
function clearNS() { for (const k of Object.keys(localStorage)) if (k.startsWith(`${NS}:`)) localStorage.removeItem(k); }
// Tus datos reales, sin la marca de "última vez abierta" (que cambia sola si tienes la app abierta).
function realSnapshot() {
  const o = {};
  for (const k of Object.keys(localStorage).sort()) if (k.startsWith('clock-management:') && !k.endsWith('seen')) o[k] = localStorage.getItem(k);
  return JSON.stringify(o);
}
const ROUNDS = () => ['A', 'B', 'C'].map((L, i) => ({
  short: ['A', 'B', 'A+B'][i], name: ['Evaluación A', 'Evaluación B', 'Combinada'][i], completedAt: null,
  steps: [1, 2, 3].map((n) => ({ id: `${L}${n}`, text: `Paso ${L}${n}`, doneAt: null })),
}));
function proj(over = {}) {
  return { id: 'p1', name: 'Proyecto de prueba', createdAt: Date.now() - H, completedAt: null, currentRound: 0, templateId: 'tpl-default', sessions: [], rounds: ROUNDS(), ...over };
}
function makeState(over = {}) {
  return {
    version: 2, projects: [], selectedId: null, away: null,
    settings: {
      sound: false, theme: 'light', friction: true, levelImages: false, defaultTemplateId: 'tpl-default',
      templates: [{ id: 'tpl-default', name: 'Evaluación', rounds: ROUNDS().map((r) => ({ short: r.short, name: r.name, steps: r.steps.map((s) => s.text) })) }],
    },
    ...over,
  };
}

/* ---------- abrir la app ---------- */
function loaded(f) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Fail('La app no cargó en 10 s')), 10000);
    f.addEventListener('load', () => { clearTimeout(t); res(); }, { once: true });
  });
}
function attach(app) {
  const w = app.f.contentWindow;
  app.w = w;
  app.doc = w.document;
  // X.nombre lee cualquier variable o función global de la app (incluidas let/const).
  app.X = new Proxy({}, {
    get: (_, k) => w.eval(String(k)),
    set: (_, k, v) => { w.__set = v; w.eval(`${String(k)} = window.__set`); return true; },
  });
  app.$ = (s) => w.document.querySelector(s);
  app.$$ = (s) => [...w.document.querySelectorAll(s)];
  return app;
}
// Sin `seed`, la app arranca con una plantilla de 3 rondas (la que usan casi todas las pruebas);
// con `fresh: true` arranca de cero, como alguien que la abre por primera vez.
async function openApp({ seed, seen, mode, keep = false, fresh = false } = {}) {
  if (!keep) clearNS();
  if (seed !== undefined) localStorage.setItem(`${NS}:v1`, typeof seed === 'string' ? seed : JSON.stringify(seed));
  else if (!keep && !fresh) localStorage.setItem(`${NS}:v1`, JSON.stringify(makeState()));
  if (seen != null) localStorage.setItem(`${NS}:seen`, String(seen));
  if (mode) localStorage.setItem(`${NS}:mode`, mode);
  const f = document.createElement('iframe');
  f.src = '../index.html?test';
  const app = { f };
  const l = loaded(f);
  $('#stage').appendChild(f);
  await l;
  attach(app);
  app.X.state.settings.sound = false;
  return app;
}
// Reloj controlado: la app usa Date.now(); aquí lo movemos a mano.
// advance() simula que la página siguió abierta (refrescos y marca de "abierta"); suspend() no.
function fakeClock(app, start = Date.now()) {
  let t = start;
  app.w.Date.now = () => t;
  const alive = () => app.w.eval('lastBeat = Date.now(); touchSeen()');
  alive();
  return {
    get now() { return t; },
    advance(ms) { t += ms; alive(); },
    set(v) { t = v; alive(); },
    suspend(ms) { t += ms; },
  };
}
async function answer(app, ok = true) {
  for (let i = 0; i < 150 && !app.$('#dlgConfirm').open; i++) await sleep(10);
  check(app.$('#dlgConfirm').open, 'Se esperaba un diálogo de confirmación');
  app.$(ok ? '#confirmOk' : '#confirmCancel').click();
  await sleep(0);
}
function markAll(app, p, between = () => {}) {
  for (const s of p.rounds[p.currentRound].steps) if (!s.doneAt) { app.X.toggleStep(p, s.id); between(); }
}
const closeOverlays = (app) => app.$$('.overlay').forEach((o) => o.remove());
const key = (app, type, code, k) => app.doc.dispatchEvent(new app.w.KeyboardEvent(type, { code, key: k, bubbles: true }));

/* ---------- registro de pruebas ---------- */
const TESTS = [];
const test = (name, fn, opts = {}) => TESTS.push({ name, fn, ...opts });

/* =========================================================
   1. Formatos de tiempo
   ========================================================= */
test('Formatos de tiempo: sin redondeos, con segundos', async ({ open }) => {
  const { X } = await open();
  const clock = [[0, '00:00:00'], [999, '00:00:00'], [1000, '00:00:01'], [59999, '00:00:59'], [3599999, '00:59:59'], [H, '01:00:00'], [100 * H + 5 * MIN + 7000, '100:05:07'], [-5000, '00:00:00']];
  for (const [ms, want] of clock) eq(X.fmtClock(ms), want, `fmtClock(${ms})`);
  const short = [[0, '0s'], [59999, '59s'], [MIN, '1m 00s'], [187000, '3m 07s'], [H, '1h 00m 00s'], [3912000, '1h 05m 12s'], [-1, '0s']];
  for (const [ms, want] of short) eq(X.fmtShort(ms), want, `fmtShort(${ms})`);
  eq(X.fmtAmount(5 * MIN), '5 min', 'fmtAmount(5 min)');
  eq(X.fmtAmount(61000), '1m 01s', 'fmtAmount(61 s)');
});

/* =========================================================
   2. Medición de tiempo (reloj controlado, al milisegundo)
   ========================================================= */
test('Cronómetro: iniciar, pausar y reanudar suman exacto', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  eq(X.projectTime(p), 0, 'Proyecto nuevo sin tiempo');
  check(!X.isRunning(p), 'Un proyecto nuevo no arranca solo');
  X.toggleTimer(p);
  c.advance(H + 23 * MIN + 45678);
  eq(X.projectTime(p), 5025678, 'Tras 1h 23m 45.678s');
  X.tick();
  eq(app.$('.clock').textContent, '01:23:45', 'Reloj en pantalla');
  eq(app.$(`.proj[data-id="${p.id}"] .proj-time`).textContent, '1h 23m 45s', 'Tiempo en la lista');
  X.toggleTimer(p);
  c.advance(10 * MIN);
  eq(X.projectTime(p), 5025678, 'En pausa no avanza');
  X.toggleTimer(p);
  c.advance(15001);
  eq(X.projectTime(p), 5040679, 'Al reanudar suma lo nuevo');
  const saved = JSON.parse(localStorage.getItem(`${NS}:v1`));
  eq(saved.projects[0].sessions.length, 2, 'Dos sesiones guardadas');
});

test('Cambio de ronda con el reloj corriendo: sin perder ni duplicar tiempo', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(10 * MIN);
  markAll(app, p, () => c.advance(MIN));
  await X.completeRound(p);
  c.advance(7.5 * MIN);
  eq(p.sessions.length, 2, 'La ronda nueva abre otra sesión');
  eq(p.sessions[0].end, p.sessions[1].start, 'Sin hueco ni traslape entre sesiones');
  eq(X.projectTime(p), 20.5 * MIN, 'Total exacto');
  eq(X.roundTime(p, 0) + X.roundTime(p, 1), X.projectTime(p), 'La suma por rondas es el total');
  eq(X.pace(p).minutes, 20.5, 'El ritmo sigue contando a través del cambio de ronda');
});

test('Cambiar de proyecto: uno termina justo cuando empieza el otro', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const a = X.selected();
  X.toggleTimer(a);
  c.advance(5 * MIN);
  X.createProject();
  const b = X.selected();
  check(X.isRunning(a), 'Crear otro proyecto no detiene el que corre');
  X.toggleTimer(b);
  c.advance(3 * MIN);
  check(!X.isRunning(a) && X.isRunning(b), 'Solo uno corre a la vez');
  eq(a.sessions[0].end, b.sessions[0].start, 'A termina en el mismo milisegundo en que empieza B');
  eq(X.projectTime(a) + X.projectTime(b), 8 * MIN, 'A + B = tiempo transcurrido');
});

test('Completar el proyecto detiene el reloj exactamente', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  for (let r = 0; r < 3; r++) {
    c.advance(4 * MIN);
    markAll(app, p);
    await X.completeRound(p);
  }
  closeOverlays(app);
  check(X.isDone(p), 'Proyecto completado');
  check(!X.isRunning(p), 'El reloj se detuvo');
  c.advance(H);
  eq(X.projectTime(p), 12 * MIN, 'Después de completar no suma nada');
});

test('Reabrir una ronda con el reloj corriendo', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(6 * MIN);
  markAll(app, p);
  await X.completeRound(p);
  c.advance(2 * MIN);
  const pr = X.reopenRound(p, 0);
  await answer(app, true);
  await pr;
  c.advance(MIN);
  eq(p.currentRound, 0, 'Volvió a la ronda A');
  eq(p.sessions.length, 3, 'Tres tramos de sesión');
  for (let i = 1; i < p.sessions.length; i++) eq(p.sessions[i - 1].end, p.sessions[i].start, `Tramo ${i} pegado al anterior`);
  eq(X.projectTime(p), 9 * MIN, 'Total exacto');
  eq(X.roundTime(p, 0), 7 * MIN, 'Tiempo de la ronda A (6 + 1)');
});

test('Quitar rondas: la tarea salió corta y aun así se llega a la meta', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(5 * MIN);
  // Una ronda que viene, sin avance: se quita al instante, sin preguntar.
  check(app.$('.station[data-ri="2"] .rm-round'), 'La ronda pendiente tiene botón para quitarla');
  await X.removeRound(p, 2);
  eq(p.rounds.length, 2, 'Quedan dos rondas');
  eq(app.$$('.track .station[data-ri]').length, 2, 'El riel muestra dos rondas');
  // La ronda actual, con el reloj corriendo: pregunta y corta el tiempo exacto.
  c.advance(MIN);
  const pr = X.removeRound(p, 0);
  await answer(app, true);
  await pr;
  eq(p.rounds.length, 1, 'Queda una ronda');
  eq(p.rounds[0].name, 'Evaluación B', 'La siguiente ocupa su lugar');
  eq(p.currentRound, 0, 'Y es la actual');
  check(X.isRunning(p), 'El reloj sigue corriendo');
  eq(p.sessions[0].round, null, 'Lo ya medido se queda sin ronda');
  eq(p.sessions[0].end, p.sessions[1].start, 'Corte sin hueco ni traslape');
  eq(p.sessions[1].round, 0, 'Lo nuevo cuenta en la ronda actual');
  c.advance(2 * MIN);
  eq(X.projectTime(p), 8 * MIN, 'El total no pierde nada');
  eq(X.roundTime(p, 0), 2 * MIN, 'La ronda actual cuenta desde el corte');
  // La última pendiente no se puede quitar: la meta se alcanza cerrándola.
  check(!X.canRemoveRound(p, 0), 'La última ronda pendiente no se puede quitar');
  check(!app.$('.rm-round'), 'Ya no hay botón para quitar');
  await X.removeRound(p, 0);
  eq(p.rounds.length, 1, 'Sigue la ronda');
  markAll(app, p);
  await X.completeRound(p);
  closeOverlays(app);
  check(X.isDone(p), 'Proyecto completado con una sola ronda');
  check(!X.isRunning(p), 'El reloj se detuvo');
});

test('Quitar rondas: cancelar no cambia nada y las cerradas no se quitan', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(4 * MIN);
  markAll(app, p);
  await X.completeRound(p);
  c.advance(3 * MIN);
  X.toggleStep(p, p.rounds[1].steps[0].id);
  const before = JSON.stringify(p);
  const pr = X.removeRound(p, 1);
  await answer(app, false);
  await pr;
  eq(JSON.stringify(p), before, 'Cancelar deja todo igual');
  check(!X.canRemoveRound(p, 0), 'Una ronda cerrada no se quita');
  check(!app.$('.station[data-ri="0"] .rm-round'), 'Ni tiene botón');
  // Quitar una ronda futura que tenía tiempo de antes (por reabrir) recorre los índices.
  await X.removeRound(p, 2);
  eq(p.rounds.length, 2, 'Quedan dos rondas');
  eq(p.currentRound, 1, 'La actual no cambia');
  eq(X.roundTime(p, 0) + X.roundTime(p, 1), X.projectTime(p), 'La suma por rondas es el total');
});

test('Agregar rondas: al final, antes de la meta, sin tocar el tiempo', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(5 * MIN);
  app.$('.add-round').click();
  eq(p.rounds.length, 4, 'Ahora son cuatro rondas');
  eq(p.rounds[3].short, '04', 'Abreviatura numerada');
  eq(p.rounds[3].name, 'Ronda 04', 'Nombre numerado');
  eq(p.rounds[3].steps.length, 0, 'Empieza sin pasos');
  eq(p.currentRound, 0, 'La ronda actual no cambia');
  check(X.isRunning(p), 'El reloj sigue corriendo');
  eq(p.sessions.length, 1, 'Sin cortes de sesión');
  eq(app.$$('.track .station[data-ri]').length, 4, 'El riel muestra la nueva ronda');
  const saved = JSON.parse(localStorage.getItem(`${NS}:v1`));
  eq(saved.projects[0].rounds.length, 4, 'Se guardó');
  // La numeración no repite una abreviatura que ya existe.
  p.rounds[3].short = '05';
  X.addRound(p);
  eq(p.rounds[4].short, '06', 'Salta abreviaturas ocupadas');
  // Recorrerla: una ronda sin pasos se cierra directo.
  for (let r = 0; r < 4; r++) { markAll(app, p); await X.completeRound(p); }
  eq(p.currentRound, 4, 'Llegó a la ronda agregada');
  X.addStep(p, 'Paso nuevo');
  markAll(app, p);
  await X.completeRound(p);
  closeOverlays(app);
  check(X.isDone(p), 'Proyecto completado');
  check(!app.$('.add-round'), 'Un proyecto completado no ofrece agregar rondas');
  eq(X.projectTime(p), 5 * MIN, 'El tiempo es exacto');
});

test('Descontar: exacto, con tope y deshacer; también resta del ritmo', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(40 * MIN);
  X.deductTime(p, 5);
  eq(X.projectTime(p), 35 * MIN, 'Quita exactamente 5 min');
  eq(X.pace(p).minutes, 35, 'El ritmo también baja 5 min');
  X.deductTime(p, 5);
  X.deductTime(p, 1);
  eq(X.pace(p).minutes, 29, 'Con 29 min de ritmo');
  eq(X.pace(p).idx, 0, 'Bajar de 30 min regresa a "Calentando"');
  check(!X.needsHold(p), 'Y la pausa ya no pide sostener');
  X.undoDeduct();
  eq(X.projectTime(p), 30 * MIN, 'Deshacer devuelve exactamente lo último (1 min)');
  X.toggleTimer(p);
  X.toggleTimer(p);
  c.advance(90 * 1000);
  X.deductTime(p, 5);
  eq(X.sessionMs(X.deductTarget(p)), 0, 'No deja la sesión en negativo: solo quita lo que había (90 s)');
  eq(X.projectTime(p), 30 * MIN, 'El total no se ve afectado de más');
  X.renderAll();
  app.$('#sessDetails').open = true;
  check(app.$('.log').textContent.includes('−1m 30s'), 'El historial muestra lo descontado');
});

test('"Hoy" con una sesión que cruza la medianoche', async ({ open }) => {
  const midnight = new Date(2026, 10, 26, 0, 0, 0).getTime();
  // Caso 1: descuento hecho después de medianoche
  let app = await open();
  let c = fakeClock(app, midnight - 30 * MIN); // 23:30
  app.X.createProject();
  let p = app.X.selected();
  app.X.toggleTimer(p);
  c.advance(75 * MIN); // 00:45
  eq(app.X.todayMs(), 45 * MIN, 'Hoy cuenta solo desde medianoche');
  app.X.deductTime(p, 10);
  eq(app.X.todayMs(), 35 * MIN, 'El descuento hecho hoy se resta de hoy');
  eq(app.X.projectTime(p), 65 * MIN, 'El total del proyecto');
  app.f.remove();
  // Caso 2: descuento hecho antes de medianoche
  app = await open();
  c = fakeClock(app, midnight - 30 * MIN);
  app.X.createProject();
  p = app.X.selected();
  app.X.toggleTimer(p);
  c.advance(20 * MIN); // 23:50
  app.X.deductTime(p, 10);
  c.advance(55 * MIN); // 00:45
  eq(app.X.todayMs(), 45 * MIN, 'Un descuento de ayer no se resta de hoy');
  eq(app.X.projectTime(p), 65 * MIN, 'El total del proyecto');
});

test('Pantalla: reloj, lista, ronda y "Hoy" muestran lo mismo que se mide', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(2 * H + 3 * MIN + 4999);
  X.tick();
  eq(app.$('.clock').textContent, '02:03:04', 'Reloj grande');
  eq(app.$('[data-today]').textContent, '2h 03m 04s', 'Hoy');
  eq(app.$(`.proj[data-id="${p.id}"] .proj-time`).textContent, '2h 03m 04s', 'Lista');
  eq(app.$(`[data-round-timer="${p.id}:0"][data-fmt="short"]`).textContent, '2h 03m 04s', 'Tiempo de la ronda');
  check(app.doc.title.startsWith('02:03:04'), 'Título de la pestaña');
  c.advance(1);
  X.tick();
  eq(app.$('.clock').textContent, '02:03:05', 'Cambia en el milisegundo exacto');
});

test('Refresco de pantalla programado justo al cambio de segundo', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(10 * 1000 + 300); // 10.3 s: el siguiente segundo llega en 700 ms
  let captured = null;
  const real = app.w.setTimeout;
  app.w.setTimeout = (fn, ms) => { captured = ms; return real(fn, ms); };
  X.scheduleTick();
  app.w.setTimeout = real;
  near(captured, 704, 2, 'El siguiente refresco cae justo después del cambio de segundo');
});

/* =========================================================
   3. Persistencia: recargas, navegador cerrado, suspensión
   ========================================================= */
test('Recargar con el reloj corriendo: sigue exacto y sin avisos', async ({ open }) => {
  const start = Date.now() - 37 * MIN - 12345;
  const seed = makeState({ projects: [proj({ sessions: [{ id: 's1', start, end: null, round: 0 }] })], selectedId: 'p1' });
  const app = await open({ seed, seen: Date.now() - 5000 });
  const p = app.X.state.projects[0];
  near(app.X.projectTime(p), Date.now() - start, 30, 'El tiempo continúa desde la hora de inicio guardada');
  check(!app.X.away, 'Sin aviso de ausencia (la página estuvo abierta hace 5 s)');
});

test('Navegador cerrado: avisa y cada opción corta donde debe', async ({ open }) => {
  const base = Date.now();
  const start = base - 3 * H;
  const seen = base - 2 * H;
  const seed = () => makeState({ projects: [proj({ sessions: [{ id: 's1', start, end: null, round: 0 }] })], selectedId: 'p1' });
  // Descontar y pausar
  let app = await open({ seed: seed(), seen });
  check(app.X.away && app.X.away.from === seen, 'Detecta desde cuándo estuvo cerrada');
  check(!!app.$('.away'), 'Muestra el aviso');
  check(JSON.parse(localStorage.getItem(`${NS}:v1`)).away, 'El aviso queda guardado');
  app.$('[data-action="away-stop"]').click();
  let p = app.X.state.projects[0];
  eq(p.sessions[0].end, seen, 'La sesión termina cuando se cerró la página');
  eq(app.X.projectTime(p), H, 'Solo cuenta la hora que sí estuviste');
  check(!app.X.isRunning(p), 'Queda en pausa');
  app.f.remove();
  // Descontar y seguir
  app = await open({ seed: seed(), seen });
  app.$('[data-action="away-resume"]').click();
  p = app.X.state.projects[0];
  eq(p.sessions[0].end, seen, 'Corta donde se cerró');
  check(app.X.isRunning(p), 'Y sigue corriendo desde ahora');
  near(app.X.projectTime(p), H, 100, 'Total: la hora trabajada');
  app.f.remove();
  // Sí, cuenta
  app = await open({ seed: seed(), seen });
  app.$('[data-action="away-keep"]').click();
  p = app.X.state.projects[0];
  near(app.X.projectTime(p), Date.now() - start, 30, 'Cuenta todo el tiempo, hasta este instante');
  check(!app.X.away, 'El aviso desaparece');
});

test('El aviso de ausencia sobrevive si recargas sin contestarlo', async ({ open }) => {
  const start = Date.now() - 3 * H;
  const seen = Date.now() - 2 * H;
  const seed = makeState({ projects: [proj({ sessions: [{ id: 's1', start, end: null, round: 0 }] })], selectedId: 'p1' });
  const app = await open({ seed, seen });
  check(app.X.away, 'Primer aviso');
  const l = loaded(app.f);
  app.f.contentWindow.location.reload();
  await l;
  attach(app);
  check(app.X.away && app.X.away.from === seen, 'Tras recargar, el aviso sigue con la hora original');
  check(!!app.$('.away'), 'Y se muestra');
});

test('Computadora suspendida con la página abierta: también avisa', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, Date.now());
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(5 * MIN);
  const lastSeen = X.readSeen();
  c.suspend(30 * MIN); // sin refrescos: la máquina estaba dormida
  X.tick();
  check(X.away && X.away.from === lastSeen, 'Detecta la suspensión y desde cuándo');
  check(!!app.$('.away'), 'Muestra el aviso');
  app.$('[data-action="away-stop"]').click();
  eq(X.projectTime(p), 5 * MIN, 'Descontar deja solo lo trabajado antes de suspender');
});

test('Pestaña en segundo plano (refrescos lentos) no dispara avisos falsos', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, Date.now());
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  for (let i = 0; i < 20; i++) c.advance(MIN); // un refresco por minuto, como en pestañas ocultas
  X.tick();
  check(!X.away, 'Sin aviso');
  eq(X.projectTime(p), 20 * MIN, 'Y el tiempo es exacto');
});

/* =========================================================
   4. Ritmo, pausa sostenida y XP
   ========================================================= */
test('Ritmo: umbrales exactos y pausa sostenida por tramo', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(30 * MIN - 1);
  eq(X.pace(p).idx, 0, '29:59.999 → Calentando');
  check(!X.needsHold(p), 'Pausa libre antes de 30 min');
  c.advance(1);
  eq(X.pace(p).idx, 1, '30:00.000 → En ritmo');
  eq(X.holdMs(p), 1000, 'Sostener 1 s');
  c.advance(30 * MIN);
  eq(X.pace(p).idx, 2, '60 min → A fondo');
  eq(X.holdMs(p), 1800, 'Sostener 1.8 s');
  c.advance(30 * MIN);
  eq(X.pace(p).idx, 3, '90 min → Vuelta rápida');
  eq(X.holdMs(p), 2600, 'Sostener 2.6 s');
  c.advance(30 * MIN - 1);
  check(X.needsHold(p), '119:59.999 todavía pide sostener');
  c.advance(1);
  eq(X.pace(p).idx, 4, '120 min → Tramo completo');
  check(!X.needsHold(p), 'Después de 2 h la pausa es libre');
});

test('Ritmo: una sesión de duración cero no congela la página', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  const S = T0, T = T0 + 40 * MIN;
  // El orden pone primero la sesión vacía: antes esto ciclaba para siempre.
  p.sessions.push({ id: 'z0', start: T, end: T, round: 0 }, { id: 'z1', start: S, end: T, round: 0 }, { id: 'z2', start: T, end: null, round: 0 });
  c.set(T + 5 * MIN);
  eq(X.pace(p).minutes, 45, 'El tramo continuo se calcula bien');
});

test('Pausa sostenida: clic corto no pausa; sostener sí, y el golpe crece con el tramo', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  const tryLevel = async (minutes, wantBroke) => {
    c.advance(MIN); // una pausa real entre intentos: reanudar en el mismo milisegundo no rompería el ritmo
    X.toggleTimer(p);
    c.advance(minutes * MIN);
    X.renderAll();
    app.$('.play').click(); // clic corto (sin sostener)
    check(X.isRunning(p), `${minutes} min: un clic corto no pausa`);
    const ms = X.holdMs(p);
    X.startHold(p);
    await sleep(ms - 250);
    check(X.isRunning(p), `${minutes} min: antes de ${ms} ms todavía no pausa`);
    await sleep(500);
    check(!X.isRunning(p), `${minutes} min: sosteniendo ${ms} ms sí pausa`);
    check(app.$('.timer').classList.contains(`broke-${wantBroke}`), `${minutes} min: intensidad ${wantBroke}`);
  };
  await tryLevel(35, 1);
  await tryLevel(65, 2);
  await tryLevel(95, 3);
  c.advance(MIN);
  X.toggleTimer(p);
  c.advance(121 * MIN);
  X.renderAll();
  app.$('.play').click();
  check(!X.isRunning(p), 'Después de 2 h, un clic pausa');
  check(app.$('#toast').textContent.includes('Pit stop'), 'Y lo celebra como pit stop');
});

test('XP y niveles: valores exactos con y sin ritmo', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  let p = X.selected();
  for (let r = 0; r < 3; r++) { markAll(app, p); await X.completeRound(p); }
  closeOverlays(app);
  eq(X.xpTotal(), 440, 'Proyecto completo sin ritmo: 9×10 + 3×50 + 200');
  eq(X.level(), 0, 'Todavía nivel 0');
  X.createProject();
  p = X.selected();
  X.toggleTimer(p);
  c.advance(61 * MIN); // ×2
  markAll(app, p);
  eq(p.rounds[0].steps[0].xp, 20, 'Paso con ritmo ×2 vale 20');
  await X.completeRound(p);
  eq(p.rounds[0].xp, 100, 'Ronda con ritmo ×2 vale 100');
  eq(X.xpTotal(), 600, '440 + 60 + 100');
  eq(X.level(), 1, 'Nivel 1');
  X.toggleStep(p, p.rounds[1].steps[0].id);
  eq(X.xpTotal(), 620, 'Otro paso a ×2');
  X.toggleStep(p, p.rounds[1].steps[0].id);
  eq(X.xpTotal(), 600, 'Desmarcar lo quita exacto');
});

/* =========================================================
   5. Plantillas y datos
   ========================================================= */
test('Plantillas: crear, predeterminada y cambiar la de un proyecto', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.openTemplates();
  app.$('#tplNew').click();
  app.$('#tplName').value = 'Rápida';
  app.$('#tplDefault').checked = true;
  app.$('#tplDefault').dispatchEvent(new app.w.Event('change'));
  app.$('#tplSave').click();
  eq(X.state.settings.templates.length, 2, 'Se guardó la plantilla nueva');
  const quick = X.state.settings.templates.find((t) => t.name === 'Rápida');
  eq(X.state.settings.defaultTemplateId, quick.id, 'Es la predeterminada');
  X.createProject();
  const p = X.selected();
  eq(p.templateId, quick.id, 'Los proyectos nuevos la usan');
  const other = X.state.settings.templates.find((t) => t.id !== quick.id).id;
  await X.applyTemplate(p, other);
  check(!app.$('#dlgConfirm').open, 'Sin iniciar: se aplica sin preguntar');
  eq(p.templateId, other, 'Plantilla cambiada');
  X.toggleTimer(p);
  c.advance(5 * MIN);
  X.toggleStep(p, p.rounds[0].steps[0].id);
  const pr = X.applyTemplate(p, quick.id);
  await answer(app, true);
  await pr;
  eq(p.templateId, quick.id, 'Con avance: se aplica tras confirmar');
  eq(X.projectTime(p), 5 * MIN, 'El tiempo se conserva');
  check(X.isRunning(p), 'Y el reloj sigue');
  check(p.rounds.every((r) => r.steps.every((s) => !s.doneAt)), 'El avance se reinicia');
});

test('Empezar de cero: plantilla mínima (una ronda, dos pasos)', async ({ open }) => {
  const app = await open({ fresh: true });
  const { X } = app;
  const t = X.state.settings.templates;
  eq(t.length, 1, 'Una sola plantilla');
  eq(t[0].name, 'Plantilla 1', 'Se llama "Plantilla 1"');
  eq(JSON.stringify(t[0].rounds), JSON.stringify([{ short: '01', name: 'Ronda 01', steps: ['Paso 01', 'Paso 02'] }]), 'Una ronda con dos pasos');
  check(!JSON.stringify(X.state).includes('Evaluación'), 'Nada de "Evaluación A / B"');
  X.createProject();
  eq(X.selected().rounds.length, 1, 'Un proyecto nuevo la usa');
  X.openTemplates();
  app.$('#tplNew').click();
  eq(JSON.stringify(X.twCurrent().rounds), JSON.stringify(t[0].rounds), '"Nueva" usa el mismo punto de partida');
});

test('Editor de plantillas: lista + detalle, pegar, reordenar y modo texto', async ({ open }) => {
  const app = await open();
  const { X } = app;
  X.openTemplates();
  const before = X.twCurrent().rounds.length;
  app.$('[data-tpl="add-round"]').click();
  eq(X.twCurrent().rounds.length, before + 1, 'Agregar ronda');
  eq(X.twRound().short, String(before + 1).padStart(2, '0'), 'La ronda nueva se numera sola');
  const dt = new app.w.DataTransfer();
  dt.setData('text/plain', 'Uno\n- Dos\n\n• Tres');
  app.$('#tplNewStep').dispatchEvent(new app.w.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  eq(X.twRound().steps.join('|'), 'Uno|Dos|Tres', 'Pegar varias líneas crea un paso por línea');
  const ins = app.$$('.si-in');
  ins[2].dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
  eq(X.twRound().steps.join('|'), 'Uno|Tres|Dos', 'Alt+↑ sube el paso');
  const text = X.templateToText(X.twCurrent());
  const back = X.textToRounds(text);
  eq(JSON.stringify(back), JSON.stringify(X.twCurrent().rounds), 'Texto ida y vuelta conserva todo');
  app.$('#tplMode').click();
  app.$('#tplText').value = '# A · Primera\n- x\n- y\n\n# Segunda\nz';
  app.$('#tplMode').click();
  eq(X.twCurrent().rounds.map((r) => `${r.short}:${r.name}:${r.steps.length}`).join(' '), 'A:Primera:2 02:Segunda:1', 'El texto se convierte en rondas (la sin etiqueta se numera)');
  app.$('#tplMode').click();
  app.$('#tplText').value = 'sin rondas';
  app.$('#tplText').value = '';
  app.$('#tplSave').click();
  check(app.$('#dlgTemplate').open, 'Con el texto vacío no guarda');
  app.$('#tplText').value = '# Única\n- paso';
  app.$('#tplSave').click();
  check(!app.$('#dlgTemplate').open, 'Con texto válido guarda');
  eq(X.state.settings.templates[0].rounds.length, 1, 'Se guardó la plantilla escrita');
});

test('Migración desde la primera versión (una sola plantilla)', async ({ open }) => {
  const start = Date.now() - 2 * H;
  const old = {
    projects: [{ id: 'old1', name: 'Viejo', createdAt: start, completedAt: null, currentRound: 1, sessions: [{ id: 's', start, end: start + 50 * MIN, round: 0 }], rounds: ROUNDS() }],
    selectedId: 'old1',
    settings: { sound: false, template: [{ short: 'X', name: 'Ronda X', steps: ['uno', 'dos'] }] },
  };
  const app = await open({ seed: old });
  const { X } = app;
  eq(X.state.settings.templates.length, 1, 'Su plantilla pasa a ser la única');
  eq(X.state.settings.templates[0].rounds[0].name, 'Ronda X', 'Con sus rondas');
  eq(X.state.projects[0].templateId, 'tpl-default', 'El proyecto queda ligado a ella');
  eq(X.projectTime(X.state.projects[0]), 50 * MIN, 'El tiempo se conserva');
  check(!!app.$('.proj'), 'Se dibuja');
});

test('Datos dañados: la app arranca y repara en lugar de tronar', async ({ open }) => {
  let app = await open({ seed: '{esto no es JSON' });
  eq(app.X.state.projects.length, 0, 'JSON inválido → empieza vacía');
  app.f.remove();
  const now = Date.now();
  const bad = {
    projects: [
      null, 5, 'x',
      { name: 7, sessions: 'nada', rounds: null },
      { id: 'ok', name: 'Válido', sessions: [{ start: 'a' }, { start: 100, end: 50 }, { start: now - 2 * MIN, end: now - MIN }, null], rounds: [{ steps: [null, { text: 'a' }] }] },
      { id: 'ok', name: 'Id repetido', sessions: [], rounds: ROUNDS(), currentRound: 99 },
    ],
    selectedId: 'no-existe',
    settings: { templates: 'x', theme: 'neón' },
  };
  app = await open({ seed: bad });
  const { X } = app;
  eq(X.state.projects.length, 3, 'Se quedan los 3 objetos que eran proyectos');
  const valid = X.state.projects.find((p) => p.name === 'Válido');
  eq(valid.sessions.length, 1, 'Solo la sesión válida sobrevive');
  eq(X.projectTime(valid), MIN, 'Y su tiempo es correcto');
  eq(new Set(X.state.projects.map((p) => p.id)).size, 3, 'Los ids quedan únicos');
  const done = X.state.projects.find((p) => p.name === 'Id repetido');
  check(X.isDone(done) && done.currentRound === 3, 'Una ronda fuera de rango se acota');
  eq(X.state.settings.theme, 'system', 'Un tema inválido vuelve a "sistema"');
  for (const p of X.state.projects) { X.state.selectedId = p.id; X.renderAll(); }
  check(true, 'Se pudo mostrar cada proyecto');
});

test('Dos cronómetros corriendo en datos guardados: se deja solo uno', async ({ open }) => {
  const now = Date.now();
  const seed = makeState({
    projects: [
      proj({ id: 'a', sessions: [{ id: 'sa', start: now - 30 * MIN, end: null, round: 0 }] }),
      proj({ id: 'b', sessions: [{ id: 'sb', start: now - 10 * MIN, end: null, round: 0 }] }),
    ],
  });
  const app = await open({ seed, seen: now });
  const { X } = app;
  const running = X.state.projects.filter((p) => X.isRunning(p));
  eq(running.length, 1, 'Solo uno corre');
  eq(running[0].id, 'b', 'El más reciente');
  eq(X.state.projects[0].sessions[0].end, now - 10 * MIN, 'El otro se cierra donde empezó el más reciente');
});

test('Respaldo: exportar e importar conserva todo exacto', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(33 * MIN + 333);
  X.deductTime(p, 3);
  markAll(app, p);
  await X.completeRound(p);
  c.advance(MIN);
  const json = JSON.stringify(X.state);
  const back = X.normalize(JSON.parse(json));
  eq(X.projectTime(back.projects[0]), X.projectTime(p), 'Mismo tiempo total');
  eq(back.projects[0].sessions.length, p.sessions.length, 'Mismas sesiones');
  eq(X.roundTime(back.projects[0], 0), X.roundTime(p, 0), 'Mismo tiempo por ronda');
});

test('Importar: rechaza archivos inválidos y avisa si viene del modo prueba', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const input = app.$('#fileImport');
  const load = (text) => {
    const dt = new app.w.DataTransfer();
    dt.items.add(new app.w.File([text], 'respaldo.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new app.w.Event('change'));
  };
  load('no es json');
  await sleep(50);
  check(app.$('#toast').textContent.includes('no parece un respaldo'), 'Archivo inválido: mensaje claro');
  load(JSON.stringify({ projects: 5 }));
  await sleep(50);
  check(app.$('#toast').textContent.includes('no parece un respaldo'), 'Formato incorrecto: mensaje claro');
  load(JSON.stringify(makeState({ projects: [proj()], debugOffset: 5 * H })));
  for (let i = 0; i < 100 && !app.$('#dlgConfirm').open; i++) await sleep(10);
  eq(app.$('#confirmTitle').textContent, 'Respaldo del modo prueba', 'Avisa que viene del modo prueba');
  await answer(app, false);
  eq(X.state.projects.length, 0, 'Al cancelar no se importa nada');
});

/* =========================================================
   6. Estabilidad
   ========================================================= */
test('Dos pestañas abiertas: se sincronizan y no se pisan', async ({ open }) => {
  const A = await open();
  const B = await open({ keep: true });
  A.X.createProject();
  await sleep(80);
  eq(B.X.state.projects.length, 1, 'B ve el proyecto creado en A');
  const pB = B.X.state.projects[0];
  B.X.addStep(pB, 'Desde B');
  await sleep(80);
  check(A.X.state.projects[0].rounds[0].steps.some((s) => s.text === 'Desde B'), 'Los cambios de B llegan a A');
  A.X.toggleTimer(A.X.state.projects[0]);
  await sleep(80);
  check(B.X.isRunning(B.X.state.projects[0]), 'B ve el reloj corriendo');
  const before = localStorage.getItem(`${NS}:v1`);
  A.X.touchSeen();
  B.X.touchSeen();
  eq(localStorage.getItem(`${NS}:v1`), before, 'La marca de "abierta" no reescribe los datos');
  const inp = B.$('#addStepInput');
  inp.focus();
  inp.value = 'escribiendo…';
  A.X.createProject();
  await sleep(80);
  eq(B.X.state.projects.length, 2, 'B recibe el segundo proyecto');
  check(B.X.state.selectedId !== A.X.state.selectedId, 'Cada pestaña sigue viendo su propio proyecto');
  eq(B.$('#addStepInput').value, 'escribiendo…', 'Lo que escribías en B no se pierde');
});

test('Modo prueba aislado de tus datos', async ({ open }) => {
  const real = makeState({ projects: [proj()], selectedId: 'p1' });
  const app = await open({ seed: real });
  let l = loaded(app.f);
  app.X.switchMode(true);
  await l;
  attach(app);
  check(app.X.debugMode, 'Entró al modo prueba');
  eq(app.X.state.projects.length, 1, 'Con una copia de los proyectos');
  check(!app.X.away, 'Sin aviso de ausencia falso al entrar');
  const p = app.X.state.projects[0];
  app.X.toggleTimer(p);
  app.X.warp(60);
  app.X.addDebugXp(500);
  closeOverlays(app);
  const realNow = JSON.parse(localStorage.getItem(`${NS}:v1`));
  eq(realNow.projects[0].sessions.length, 0, 'Los datos reales no cambiaron');
  l = loaded(app.f);
  app.X.switchMode(false);
  await l;
  attach(app);
  check(!app.X.debugMode, 'De vuelta al modo real');
  eq(app.X.timeOffset, 0, 'Sin reloj adelantado');
  eq(app.X.state.projects[0].sessions.length, 0, 'Tus datos tal cual');
  app.f.remove();
  const leaked = makeState({ projects: [proj()], debugOffset: 5 * H, debugXp: 999 });
  const app2 = await open({ seed: leaked });
  near(app2.X.now(), Date.now(), 50, 'Fuera del modo prueba se ignora el reloj adelantado');
  eq(app2.X.xpTotal(), 0, 'Y el XP simulado');
});

test('Si el navegador no deja guardar, la app sigue midiendo y avisa', async ({ open }) => {
  const app = await open();
  const { X } = app;
  const c = fakeClock(app, T0);
  app.w.Storage.prototype.setItem = function setItem() { throw new app.w.DOMException('Lleno', 'QuotaExceededError'); };
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  c.advance(10 * MIN);
  eq(X.projectTime(p), 10 * MIN, 'Mide bien aunque no pueda guardar');
  check(X.storageWarned, 'Avisó que no se pudo guardar');
});

test('Seguridad: textos con HTML se muestran como texto y no se ejecutan', async ({ open }) => {
  const app = await open();
  const { X } = app;
  X.createProject();
  const p = X.selected();
  const evil = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
  const input = app.$('#projName');
  input.value = evil;
  input.dispatchEvent(new app.w.Event('input', { bubbles: true }));
  X.addStep(p, evil);
  X.state.settings.templates[0].name = evil;
  X.state.settings.templates[0].rounds[0].name = evil;
  X.renderAll();
  X.openTemplates();
  app.$('#dlgTemplate').close();
  X.toast(evil);
  await sleep(150);
  eq(app.w.__xss, undefined, 'Ningún HTML inyectado se ejecutó');
  check(app.$('.proj-name').textContent.includes('<img'), 'El nombre aparece como texto');
  check(!app.$('.proj-name img, .step-text img, #tplSelect img, .station img, #toast img'), 'No se crearon elementos con ese texto');
});

test('Teclado: Espacio inicia/pausa y N marca el siguiente paso', async ({ open }) => {
  const app = await open();
  const { X } = app;
  fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  app.doc.activeElement?.blur();
  key(app, 'keydown', 'Space', ' ');
  key(app, 'keyup', 'Space', ' ');
  check(X.isRunning(p), 'Espacio inicia');
  key(app, 'keydown', 'KeyN', 'n');
  check(!!p.rounds[0].steps[0].doneAt, 'N marca el primer paso');
  key(app, 'keydown', 'Space', ' ');
  key(app, 'keyup', 'Space', ' ');
  check(!X.isRunning(p), 'Espacio pausa al instante sin ritmo');
});

test('Eliminar un proyecto con el reloj corriendo', async ({ open }) => {
  const app = await open();
  const { X } = app;
  fakeClock(app, T0);
  X.createProject();
  const p = X.selected();
  X.toggleTimer(p);
  const pr = X.deleteProject(p);
  await answer(app, true);
  await pr;
  await sleep(300);
  eq(X.state.projects.length, 0, 'Se eliminó');
  eq(X.activeSession(), null, 'No queda ningún reloj corriendo');
  check(!!app.$('.empty'), 'Muestra la pantalla de inicio');
});

test('Rendimiento con mucho historial (300 proyectos, 12 000 sesiones)', async ({ open, note }) => {
  const projects = [];
  let t = Date.now() - 400 * 24 * H;
  for (let i = 0; i < 300; i++) {
    const sessions = [];
    for (let j = 0; j < 40; j++) { sessions.push({ id: `s${i}_${j}`, start: t, end: t + 20 * MIN, round: j % 3 }); t += 30 * MIN; }
    projects.push(proj({ id: `p${i}`, name: `Proyecto ${i}`, createdAt: sessions[0].start, sessions }));
  }
  projects[299].sessions.push({ id: 'live', start: Date.now() - MIN, end: null, round: 0 });
  const t0 = performance.now();
  const app = await open({ seed: makeState({ projects, selectedId: 'p299' }), seen: Date.now() });
  const boot = performance.now() - t0;
  const [render, tick] = app.w.eval(`(() => {
    const a = performance.now(); for (let i = 0; i < 5; i++) renderAll();
    const b = performance.now(); for (let i = 0; i < 20; i++) tick();
    const c = performance.now(); return [(b - a) / 5, (c - b) / 20];
  })()`);
  note(`Carga ${boot.toFixed(0)} ms · render completo ${render.toFixed(1)} ms · refresco por segundo ${tick.toFixed(1)} ms`);
  check(render < 400, `Render completo en menos de 400 ms (fue ${render.toFixed(1)} ms)`);
  check(tick < 40, `Refresco en menos de 40 ms (fue ${tick.toFixed(1)} ms)`);
});

/* =========================================================
   7. Tiempo real (sin reloj simulado)
   ========================================================= */
async function realtimeRun({ open, note }, phases, sampleEvery) {
  const app = await open();
  const { X } = app;
  X.createProject();
  const p = X.selected();
  app.doc.activeElement?.blur();
  // Para cada clic se toma la hora justo antes y justo después: lo medido por la app tiene que caer
  // dentro de esos límites (sin tolerancias inventadas).
  let samples = 0, misses = 0, skippedHidden = 0;
  let wallMin = 0, wallMax = 0, perfMin = 0, perfMax = 0;
  for (const [kind, ms] of phases) {
    if (kind === 'pause') { await sleep(ms); continue; }
    const w0 = Date.now(), p0 = performance.now();
    X.toggleTimer(p);
    const w1 = Date.now(), p1 = performance.now();
    while (performance.now() - p0 < ms) {
      await sleep(sampleEvery * (0.5 + Math.random()));
      if (document.hidden) { skippedHidden++; continue; }
      const shown = app.$('.clock').textContent;
      const measured = X.projectTime(p);
      samples++;
      // La pantalla debe mostrar el segundo medido; se tolera ≤120 ms justo en el cambio de segundo.
      if (shown !== X.fmtClock(measured) && shown !== X.fmtClock(measured - 120)) misses++;
    }
    const e0 = Date.now(), q0 = performance.now();
    X.toggleTimer(p);
    const e1 = Date.now(), q1 = performance.now();
    wallMin += e0 - w1; wallMax += e1 - w0;
    perfMin += q0 - p1; perfMax += q1 - p0;
  }
  const measured = X.projectTime(p);
  note(`Medido ${measured} ms · reloj del sistema entre ${wallMin} y ${wallMax} ms · reloj monotónico entre ${perfMin.toFixed(1)} y ${perfMax.toFixed(1)} ms · ${samples} lecturas de pantalla${skippedHidden ? ` (${skippedHidden} omitidas: pestaña oculta)` : ''}`);
  check(measured >= wallMin && measured <= wallMax, `Lo medido (${measured} ms) cae entre los clics según el reloj del sistema (${wallMin}–${wallMax} ms)`);
  // El reloj monotónico no se deja mover por ajustes de hora; se permiten 2 ms por la resolución de Date.now.
  check(measured >= perfMin - 2 && measured <= perfMax + 2, `Lo medido (${measured} ms) cae entre los clics según el reloj monotónico (${perfMin.toFixed(1)}–${perfMax.toFixed(1)} ms)`);
  eq(misses, 0, 'Lecturas en que la pantalla no coincidía con lo medido');
}
test('Tiempo real: lo medido coincide con el reloj del sistema (~40 s)', (ctx) =>
  realtimeRun(ctx, [['run', 15000], ['pause', 5000], ['run', 15000]], 600), { realtime: true, timeout: 90000 });
test('Tiempo real, prueba larga (5 min)', (ctx) =>
  realtimeRun(ctx, [['run', 300000]], 2500), { long: true, timeout: 360000 });

/* =========================================================
   Corredor
   ========================================================= */
function row(i, name) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td class="n">${i + 1}</td><td></td><td><span class="st wait">En espera</span></td><td class="detail"></td><td class="ms"></td>`;
  tr.children[1].textContent = name;
  $('#results').appendChild(tr);
  return tr;
}
function setRow(tr, status, label, detail, ms) {
  tr.children[2].innerHTML = `<span class="st ${status}">${label}</span>`;
  const d = tr.children[3];
  d.textContent = '';
  for (const line of detail) {
    const div = document.createElement('div');
    div.textContent = line.text;
    if (line.err) div.className = 'err';
    d.appendChild(div);
  }
  tr.children[4].textContent = ms == null ? '' : ms.toFixed(0);
}
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Fail(`Se tardó más de ${ms / 1000} s`)), ms))]);
}

async function runAll() {
  $('#run').disabled = true;
  $('#results').textContent = '';
  $('#summary').textContent = 'Corriendo…';
  $('#summary').className = '';
  const realBefore = realSnapshot();
  const list = TESTS.filter((t) => !t.skip);
  const rows = list.map((t, i) => row(i, t.name));
  const integrity = row(list.length, 'Tus datos reales siguen idénticos');
  let pass = 0, fail = 0, skipped = 0;
  const started = performance.now();
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const tr = rows[i];
    if ((t.realtime && !$('#realtime').checked) || (t.long && !$('#long').checked)) {
      setRow(tr, 'skip', 'Omitida', [{ text: 'Desactivada arriba.' }]);
      skipped++;
      continue;
    }
    setRow(tr, 'run', 'Corriendo', []);
    tr.scrollIntoView({ block: 'nearest' });
    const apps = [];
    const notes = [];
    const ctx = {
      open: async (o) => { const a = await openApp(o); apps.push(a); return a; },
      note: (text) => notes.push({ text }),
    };
    const t0 = performance.now();
    try {
      await withTimeout(Promise.resolve().then(() => t.fn(ctx)), t.timeout || 25000);
      const errs = apps.flatMap((a) => { try { return a.f.contentWindow ? a.w.__errors || [] : []; } catch { return []; } });
      if (errs.length) throw new Fail(`Errores en la app: ${errs.join(' | ')}`);
      setRow(tr, 'pass', 'Pasó', notes, performance.now() - t0);
      pass++;
    } catch (e) {
      const msg = e instanceof Fail ? e.message : `Error inesperado: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ← ') : e}`;
      setRow(tr, 'fail', 'Falló', [...notes, { text: msg, err: true }], performance.now() - t0);
      fail++;
    } finally {
      for (const a of apps) a.f.remove();
      $('#stage').textContent = '';
      clearNS();
    }
  }
  const same = realSnapshot() === realBefore;
  setRow(integrity, same ? 'pass' : 'fail', same ? 'Pasó' : 'Falló',
    [{ text: same ? 'Ninguna llave clock-management:* cambió durante las pruebas.' : 'Algo cambió en tus datos reales durante las pruebas.', err: !same }]);
  same ? pass++ : fail++;
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  $('#summary').textContent = `${pass} pasaron · ${fail} fallaron${skipped ? ` · ${skipped} omitidas` : ''} · ${secs} s`;
  $('#summary').className = fail ? 'bad' : 'ok';
  $('#run').disabled = false;
  window.__results = { pass, fail, skipped, rows: rows.map((r) => [r.children[1].textContent, r.children[2].textContent, r.children[3].textContent]) };
}

$('#run').addEventListener('click', runAll);
if (/[?&]auto\b/.test(location.search)) runAll();
