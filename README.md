# Clock Management

Cronómetro de proyectos con **micro-logros**: un clic crea el proyecto y arranca el reloj, y cada paso que completas ilumina el camino hasta la meta.

Sin dependencias ni build. Todo se guarda en el navegador (`localStorage`).

## Cómo abrirlo

```powershell
node serve.js
```

Luego entra a <http://localhost:5173>.

> Los datos viven en el navegador y en ese origen (`localhost:5173`). Si borras los datos del sitio, se pierden: usa **Exportar** de vez en cuando para respaldar en JSON, e **Importar** para restaurar.

## Qué hace (v0.3)

- **▶ Nuevo y arrancar**: crea "Proyecto N" con fecha/hora de inicio y arranca el cronómetro. El nombre se edita ahí mismo.
- **Un solo cronómetro activo**: si arrancas otro proyecto, el anterior se pausa solo.
- **Sigue contando con el navegador cerrado**: se guarda la hora de inicio, no un contador. Si vuelves después de más de 10 min sin la página abierta, te pregunta si ese tiempo cuenta: *Sí, cuenta*, *Descontar y seguir* o *Descontar y pausar* (corta la sesión en el momento en que se cerró).
- **Camino de rondas**: Inicio → Evaluación A → Evaluación B → Evaluación combinada → 🏆 Meta.
  - Cada ronda tiene pasos (micro-logros). Marcar uno da +10 XP, confeti y sonido.
  - Cerrar una ronda da +50 XP; terminar el proyecto da +200 XP y celebración.
  - El tiempo se atribuye a la ronda en la que estabas (se ve debajo de cada nodo).
  - Clic en un nodo completado para reabrir esa ronda.
- **Barra superior**: tiempo de hoy, logros de hoy, racha de días y nivel (500 XP por nivel).
- **Plantilla**: define rondas y pasos por defecto para proyectos nuevos.
- **Tema**: el botón de arriba alterna entre *sistema*, *claro* y *oscuro*; se recuerda.
- **Confirmaciones**: eliminar, reabrir o importar piden confirmación en un diálogo propio de la página (Esc cancela).
- **Sesiones**: historial de cada arranque/pausa con su ronda.

### Atajos

| Tecla | Acción |
| --- | --- |
| `Espacio` | Iniciar / pausar el proyecto seleccionado |
| `N` | Marcar el siguiente paso (o cerrar la ronda si ya están todos) |

## Archivos

- `index.html` — estructura
- `styles.css` — estilo "hoja de cronometraje" (modo claro/oscuro según el sistema; fuentes Barlow y JetBrains Mono desde Google Fonts, con respaldo local)
- `app.js` — estado, lógica, render y efectos
- `serve.js` — servidor estático mínimo con Node

## Ideas por rebotar

- Varios elementos por proyecto (p. ej. 10 cosas a evaluar, cada una con A, B y combinada) con una cuadrícula de progreso.
- Meta diaria de tiempo o de pasos, con anillo de progreso.
- Modo enfoque (pomodoro) ligado a la ronda actual.
- Editar a mano horas de inicio/fin de una sesión.
- Insignias desbloqueables (primer proyecto, 5 en una semana, ronda récord, etc.).
- Estimado vs. real por ronda para ir afinando tiempos.
