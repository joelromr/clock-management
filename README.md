# Clock Management

Cronómetro de proyectos con **micro-logros**: cada paso que completas avanza el riel hasta la meta, y si no pausas, cada logro vale más.

Sin dependencias ni build. Todo se guarda en el navegador (`localStorage`).

## Cómo abrirlo

```powershell
node serve.js
```

Luego entra a <http://localhost:5173>.

> Los datos viven en el navegador y en ese origen (`localhost:5173`). Si borras los datos del sitio, se pierden: usa **Menú → Exportar respaldo** de vez en cuando, e **Importar respaldo** para restaurar.

## Qué hace (v0.4)

- **+ Nuevo proyecto**: crea "Proyecto N" con fecha y hora, usando la plantilla predeterminada. El cronómetro **no** arranca solo: dale *Iniciar* o `Espacio`.
- **Un solo cronómetro activo**: si arrancas otro proyecto, el anterior se pausa solo.
- **Sigue contando con el navegador cerrado**: se guarda la hora de inicio, no un contador. Si vuelves después de más de 10 min sin la página abierta, te pregunta si ese tiempo cuenta: *Sí, cuenta*, *Descontar y seguir* o *Descontar y pausar*.
- **Camino de rondas**: Inicio → rondas de la plantilla → Meta.
  - Cada ronda tiene pasos (micro-logros). El tiempo se atribuye a la ronda en curso.
  - Clic en una estación completada para reabrirla.
- **Plantillas**: varias plantillas, una predeterminada para proyectos nuevos. Editarlas no cambia proyectos existentes. En el encabezado de cada proyecto puedes cambiar su plantilla: si el proyecto no ha iniciado, se aplica directo; si ya tiene avance, pide confirmación (el avance se pierde, el tiempo se conserva sin ronda asignada).
- **Ritmo** (tiempo seguido sin pausar):

  | Sin pausa | Ritmo | XP |
  | --- | --- | --- |
  | 0–30 min | Calentando | ×1 |
  | 30–60 min | En ritmo | ×1.5 |
  | 60–90 min | A fondo | ×2 |
  | 90–120 min | Vuelta rápida | ×2.5 |
  | 2 h o más | Tramo completo | ×3 |

  La meta es un tramo de 2 h sin pausa (en una jornada de 4.5–5 h, ~2 tramos). Cambiar de ronda no rompe el ritmo; pausar sí.
- **Pausa con fricción**: entre 30 min y 2 h, *Pausar* (o `Espacio`) hay que mantenerlo presionado, y cuesta más mientras más ritmo llevas: 1 s (En ritmo), 1.8 s (A fondo), 2.6 s (Vuelta rápida). Un clic corto solo te avisa qué perderías. Mientras sostienes suena un latido (más rápido en tramos altos). Si pausas, el golpe crece con el tramo: empujón suave (30–60 min), sacudida (60–90), sacudida fuerte con destello rojo y "estabas a N min del tramo completo" (90–120). Después de 2 h la pausa es libre: "pit stop merecido". Se puede apagar en el menú.
- **Imágenes de nivel** (apagadas por defecto; *Menú → Imágenes de nivel*): eliges una carpeta de tu computadora y, al subir de nivel, se desbloquea una imagen al azar (distinta a la anterior) en un marco de "foto de llegada" con obturador y flash. Respeta cualquier proporción. Esa imagen queda fija para el nivel: clic en el nivel (barra superior) la vuelve a mostrar. Para recordarla solo se guarda su ruta dentro de la carpeta. Se empieza en nivel 0: la primera imagen se gana al llegar a nivel 1.
  - Las imágenes **nunca se copian ni se suben**: se leen del disco al momento y se muestran desde memoria. Solo se guarda una referencia a la carpeta (IndexedDB) para no pedirla cada vez; *Olvidar carpeta* la borra.
  - Chrome/Edge recuerdan la carpeta (pueden pedir un clic de permiso al volver). Firefox/Safari no tienen esa API: ahí la eliges cada sesión.
- **Debug** (*Menú → Debug*, al final del menú; el panel aparece desplegado al final de la página): *modo prueba* con datos aparte (copia de los reales), reloj simulado (+1 min, +10 min, +30 min, +1 h), simular navegador cerrado 15 min, +50 XP y "Subir de nivel" (corren el flujo real, imagen incluida), y reiniciar la prueba. Una banda amarilla arriba indica que estás en modo prueba.
- **Descontar tiempo**: bajo el reloj, *−1 / −3 / −5 min* quitan minutos que no trabajaste (p. ej. ir al baño) de la sesión en curso (o la última), sin pausar. Se restan del tiempo **y también del ritmo** (el baño no suma hacia ningún multiplicador). Se puede deshacer y el historial muestra lo descontado.
- **Tiempos con segundos**: todo lo transcurrido se muestra sin redondear ("3m 07s", "1h 05m 12s").
- **Favicon**: cronómetro amarillo; con punto rojo mientras el reloj corre.
- **XP**: paso 10 × ritmo, ronda 50 × ritmo, proyecto 200. Nivel cada 500 XP, empezando en nivel 0.
- **Barra superior**: tiempo de hoy, logros de hoy, racha de días y nivel.
- **Menú**: sonido, tema (sistema / claro / oscuro), pausa con fricción, imágenes de nivel, exportar e importar respaldo y, al final, debug.
- **Feedback**: cada acción tiene un sonido corto y una animación discreta (crear, borrar, agregar o quitar pasos, reabrir, cambiar plantilla, interruptores, exportar, errores).
- **Confirmaciones** en un diálogo propio de la página (Esc cancela).
- **Sesiones**: historial de cada arranque/pausa con su ronda.

### Atajos

| Tecla | Acción |
| --- | --- |
| `Espacio` | Iniciar / pausar (mantener si llevas ritmo) |
| `N` | Marcar el siguiente paso (o cerrar la ronda si ya están todos) |

## Archivos

- `index.html` — estructura
- `styles.css` — estilo "hoja de cronometraje" (fuentes Barlow y JetBrains Mono desde Google Fonts, con respaldo local)
- `app.js` — estado, lógica, render y efectos
- `serve.js` — servidor estático mínimo con Node

## Ideas por rebotar

- Varios elementos por proyecto (p. ej. 10 cosas a evaluar, cada una con A, B y combinada) con una cuadrícula de progreso.
- Meta diaria de tiempo o de pasos, con anillo de progreso.
- Editar a mano horas de inicio/fin de una sesión.
- Insignias desbloqueables (primer proyecto, 5 en una semana, ronda récord, carrera sin pits, etc.).
- Estimado vs. real por ronda para ir afinando tiempos.
