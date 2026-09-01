# Auditorías 5S — API (Cloudflare Worker)

API para la app de Auditorías 5S de Escorial. Mismo patrón que **Confirmación
de Rutinas**: Neon (Postgres) + Cloudflare Worker como intermediario, sin
Supabase. Acá además se suma **Cloudflare R2** para las fotos de cada ítem.

No tiene login (v1) — cualquiera con la URL puede leer y escribir.

## 1. Crear la base en Neon

1. Entrá a [neon.tech](https://neon.tech) y creá un proyecto nuevo (o usá el
   mismo que ya tenés para Confirmación de Rutinas, con una base separada).
2. Copiá la **connection string** (la que empieza `postgresql://...`).
3. Corré el schema y los datos semilla contra esa base. Con `psql` instalado:
   ```bash
   psql "TU_CONNECTION_STRING" -f sql/schema.sql
   psql "TU_CONNECTION_STRING" -f sql/seed.sql
   ```
   Si no tenés `psql` a mano, se puede pegar el contenido de los dos archivos
   en el **SQL Editor** que trae el panel de Neon.

## 2. Crear el bucket de fotos (R2)

Necesitás una cuenta de Cloudflare (la misma que ya usás para Confirmación de
Rutinas sirve).

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create auditorias-5s-fotos
```

## 2.1 Workers AI (sugerencia automática de acciones)

Cuando un ítem se puntúa **0 o 1**, el Worker le pide a **Cloudflare Workers
AI** (modelo `@cf/meta/llama-3.1-8b-instruct`) que redacte una acción
correctiva, usando como contexto el propio criterio de la rúbrica (qué dice
el 0/1 obtenido vs. qué dice el 5 ideal). No hace falta crear nada aparte:
usa la misma cuenta de Cloudflare y ya está declarado en `wrangler.toml`
(`[ai]` / `binding = "AI"`). El free tier diario de Workers AI alcanza de
sobra para este uso. Si por algún motivo Workers AI no responde, el puntaje
se guarda igual — la sugerencia simplemente no se genera esa vez (se puede
reintentar luego con "Regenerar" desde el frontend).

## 3. Configurar y desplegar el Worker

```bash
npx wrangler secret put DATABASE_URL
# pegar la connection string de Neon cuando lo pida
```

Editá `wrangler.toml` y poné en `ALLOWED_ORIGIN` la URL real de GitHub Pages
del frontend (la sabés después del paso de deploy del frontend — se puede
volver a este paso y actualizar).

```bash
npx wrangler deploy
```

Wrangler va a imprimir la URL del Worker, algo como:
`https://auditorias-5s-api.<tu-subdominio>.workers.dev`

Esa es la URL que hay que poner en `config.js` del frontend.

## 4. Desarrollo local

```bash
npm run dev
```

Ojo: `wrangler dev` sin flags habla con el Neon real (no hay una base local
"de prueba" en este setup, al igual que en Confirmación de Rutinas) — usar
con cuidado o crear un segundo proyecto/branch de Neon para pruebas.

## Estructura

- `src/index.js` — todas las rutas (catálogos, rúbrica, auditorías, puntajes,
  fotos, dashboard, plan de acción).
- `src/ai.js` — arma el prompt y llama a Workers AI para sugerir la acción
  correctiva de un ítem mal puntuado.
- `src/db.js` — cliente de Neon (`@neondatabase/serverless`).
- `src/utils.js` — helpers de CORS y respuestas JSON.
- `sql/schema.sql` — tablas (incluye `plan_accion`).
- `sql/002_plan_accion.sql` — migración idempotente para sumar `plan_accion`
  a una base que ya corrió `schema.sql` antes de que existiera esta
  funcionalidad. Si arrancás de cero con `schema.sql`, no hace falta correrla.
- `sql/seed.sql` — áreas/sectores/plantas/UET/rúbricas S1-S5 (Planta, Pañol,
  Oficina) y objetivos mensuales 2026 de Planta (30 en enero → 75 en
  diciembre, lineal). Generado automáticamente desde los mismos datos ya
  usados en el preview de diseño — ver `gen_seed_sql.py` si hace falta
  regenerarlo tras un cambio de rúbrica.

## Endpoints

| Método | Ruta | Uso |
|---|---|---|
| GET | `/catalogos` | áreas/sectores, plantas/UET/sectores |
| GET | `/rubrica/:tipo` | rúbrica S1-S5 de `planta`/`panol`/`oficina` |
| GET | `/auditorias` | listado (filtros: tipo, planta_id, uet_id, uet_sector_id, area_id, sector_id, estado, desde, hasta, limit) |
| POST | `/auditorias` | crea auditoría |
| GET | `/auditorias/:id` | detalle completo (header + puntajes + fotos + acciones por ítem) |
| PUT | `/auditorias/:id` | actualiza encabezado / cierra (`estado`) |
| PUT | `/auditorias/:id/puntajes/:itemId` | guarda puntaje + comentario de un ítem (si el puntaje es 0 o 1, dispara la sugerencia de IA y la devuelve en `accion_sugerida`) |
| POST | `/auditorias/:id/puntajes/:itemId/fotos` | sube una foto (binario) |
| GET | `/fotos/:key` | sirve una foto desde R2 |
| DELETE | `/fotos/:id` | borra una foto |
| GET | `/dashboard` | radar, evolución, comparativo (filtros: tipo, planta_id, uet_id, uet_sector_id, anio) |
| GET | `/plan-accion` | lista acciones (IA + manuales) de todas las auditorías (filtros: estado, `pendientes=1` [abierta + en_proceso, todo lo no cerrado], audit_type, planta_id, uet_sector_id, area_id, sector_id, audit_id, `exclude_audit_id`, limit) |
| POST | `/plan-accion` | crea una acción manual (`audit_id` + `descripcion` requeridos; opcionales: `rubric_item_id`, `audit_score_id`, `responsable`, `fecha_compromiso`) |
| PUT | `/plan-accion/:id` | actualiza una acción (descripcion, responsable, fecha_compromiso, fecha_cierre, estado: `abierta`/`en_proceso`/`cerrada`) |
| POST | `/plan-accion/:id/regenerar` | vuelve a pedirle a la IA una sugerencia para esa misma acción (solo acciones de origen IA) |

Toda la lógica fue probada end-to-end contra Postgres local (schema + seed +
flujo completo crear→puntuar→cerrar→dashboard, y el plan de acción:
sugerencia automática en puntaje 0/1 con Workers AI ausente localmente sin
romper nada, alta/edición/cierre de acciones manuales, filtros, y el ciclo
completo de "abrir auditoría nueva sobre un sector con acciones pendientes →
revisarlas y puntuar → verlas cerradas") antes de la entrega.

## El ciclo de mejora: Plan de Acción ↔ próxima auditoría

Cuando se abre una auditoría nueva sobre un sector que ya tuvo acciones
correctivas sin cerrar (de cualquier auditoría anterior de ese mismo
sector), el frontend consulta `GET /plan-accion?pendientes=1&...` con los
filtros de ubicación de la auditoría recién creada, **antes** de mostrar el
formulario. Si hay algo pendiente, primero se revisan esas acciones —lo que
cierra el círculo del plan de acción con la puntuación de la auditoría
siguiente, en vez de quedar como una lista separada que nadie vuelve a
mirar.
