import { getDb } from './db.js';
import { json, errorResponse, corsHeaders, anioMesDeFecha } from './utils.js';
import { sugerirAccion } from './ai.js';

const HEADER_FIELDS = [
  'area_id', 'sector_id', 'planta_id', 'uet_id', 'uet_sector_id',
  'fecha', 'turno', 'evaluador', 'supervisor_lider', 'jefe_gerente', 'responsable',
];

// Algunos drivers de Postgres (ej. node-postgres/pg, usado en desarrollo
// local) deserializan columnas DATE como objetos Date de JS, que al pasar
// por JSON.stringify salen como timestamp ISO completo ("2026-08-31T00:00...")
// en vez de "2026-08-31". Eso rompe <input type="date">. @neondatabase/serverless
// (producción) ya devuelve texto plano, pero normalizamos igual para no
// depender del driver.
function normalizeDateField(row, field) {
  if (row && row[field] instanceof Date) {
    row[field] = row[field].toISOString().slice(0, 10);
  } else if (row && typeof row[field] === 'string' && row[field].length > 10) {
    row[field] = row[field].slice(0, 10);
  }
  return row;
}
function normalizeAudit(row) {
  return normalizeDateField(row, 'fecha');
}
function normalizePlanAccion(row) {
  return normalizeDateField(normalizeDateField(normalizeDateField(row, 'audit_fecha'), 'fecha_compromiso'), 'fecha_cierre');
}

async function recalcPuntajeTotal(sql, auditId) {
  const rows = await sql(
    `UPDATE audits SET
       puntaje_total = COALESCE((SELECT SUM(score) FROM audit_scores WHERE audit_id = $1), 0),
       updated_at = now()
     WHERE id = $1
     RETURNING id, puntaje_total`,
    [auditId]
  );
  return rows[0];
}

// -------------------------------------------------------------------------
// GET /catalogos
// -------------------------------------------------------------------------
async function getCatalogos(sql, env) {
  const areas = await sql('SELECT id, nombre, orden FROM areas ORDER BY orden');
  const sectores = await sql('SELECT id, area_id, nombre, orden FROM sectores ORDER BY orden');
  const plantas = await sql('SELECT id, nombre, orden FROM plantas ORDER BY orden');
  const uets = await sql('SELECT id, planta_id, nombre, orden FROM uets ORDER BY orden');
  const uetSectores = await sql('SELECT id, planta_id, nombre, orden FROM uet_sectores ORDER BY orden');

  return json({
    areas: areas.map((a) => ({
      ...a,
      sectores: sectores.filter((s) => s.area_id === a.id),
    })),
    plantas: plantas.map((p) => ({
      ...p,
      uets: uets.filter((u) => u.planta_id === p.id),
      uet_sectores: uetSectores.filter((s) => s.planta_id === p.id),
    })),
  }, env);
}

// -------------------------------------------------------------------------
// GET /rubrica/:tipo
// -------------------------------------------------------------------------
async function getRubrica(sql, env, tipo) {
  if (!['planta', 'panol', 'oficina'].includes(tipo)) {
    return errorResponse('Tipo de auditoría inválido', env, 404);
  }
  const categorias = await sql(
    'SELECT id, tag, label, sub, orden FROM rubric_categories WHERE audit_type = $1 ORDER BY orden',
    [tipo]
  );
  const items = await sql(
    `SELECT ri.id, ri.category_id, ri.nombre, ri.criterio_0, ri.criterio_1, ri.criterio_3, ri.criterio_5, ri.orden
     FROM rubric_items ri
     JOIN rubric_categories rc ON rc.id = ri.category_id
     WHERE rc.audit_type = $1
     ORDER BY ri.orden`,
    [tipo]
  );
  return json({
    audit_type: tipo,
    categorias: categorias.map((c) => ({
      ...c,
      items: items.filter((i) => i.category_id === c.id),
    })),
  }, env);
}

// -------------------------------------------------------------------------
// POST /auditorias
// -------------------------------------------------------------------------
async function createAuditoria(sql, env, body) {
  if (!body.audit_type || !['planta', 'panol', 'oficina'].includes(body.audit_type)) {
    return errorResponse('audit_type es requerido (planta | panol | oficina)', env);
  }
  if (!body.fecha || !body.evaluador) {
    return errorResponse('fecha y evaluador son requeridos', env);
  }

  const { anio, mes } = anioMesDeFecha(body.fecha);
  const objetivoRows = await sql(
    'SELECT objetivo FROM monthly_targets WHERE audit_type = $1 AND anio = $2 AND mes = $3',
    [body.audit_type, anio, mes]
  );
  const puntajeObjetivo = objetivoRows[0] ? objetivoRows[0].objetivo : null;

  const rows = await sql(
    `INSERT INTO audits
       (audit_type, area_id, sector_id, planta_id, uet_id, uet_sector_id,
        fecha, turno, evaluador, supervisor_lider, jefe_gerente,
        puntaje_objetivo, responsable, puntaje_total, estado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,'en_progreso')
     RETURNING *`,
    [
      body.audit_type, body.area_id || null, body.sector_id || null,
      body.planta_id || null, body.uet_id || null, body.uet_sector_id || null,
      body.fecha, body.turno || null, body.evaluador,
      body.supervisor_lider || null, body.jefe_gerente || null,
      puntajeObjetivo, body.responsable || body.evaluador,
    ]
  );
  return json(normalizeAudit(rows[0]), env, { status: 201 });
}

// -------------------------------------------------------------------------
// GET /auditorias  (listado con filtros — historial / soporte de dashboard)
// -------------------------------------------------------------------------
async function listAuditorias(sql, env, params) {
  const where = [];
  const values = [];
  let i = 1;

  for (const key of ['audit_type', 'planta_id', 'uet_id', 'uet_sector_id', 'area_id', 'sector_id', 'estado']) {
    if (params.get(key)) {
      where.push(`${key} = $${i++}`);
      values.push(params.get(key));
    }
  }
  if (params.get('desde')) {
    where.push(`fecha >= $${i++}`);
    values.push(params.get('desde'));
  }
  if (params.get('hasta')) {
    where.push(`fecha <= $${i++}`);
    values.push(params.get('hasta'));
  }

  const limit = Math.min(Number(params.get('limit')) || 100, 500);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await sql(
    `SELECT id, audit_type, fecha, evaluador, planta_id, uet_id, uet_sector_id,
            area_id, sector_id, puntaje_total, puntaje_objetivo, estado, created_at
     FROM audits
     ${whereSql}
     ORDER BY fecha DESC, id DESC
     LIMIT ${limit}`,
    values
  );
  return json(rows.map(normalizeAudit), env);
}

// -------------------------------------------------------------------------
// GET /auditorias/:id  (detalle completo)
// -------------------------------------------------------------------------
async function getAuditoria(sql, env, id) {
  const auditRows = await sql('SELECT * FROM audits WHERE id = $1', [id]);
  if (!auditRows[0]) return errorResponse('Auditoría no encontrada', env, 404);
  const audit = auditRows[0];

  const items = await sql(
    `SELECT ri.id AS rubric_item_id, ri.nombre, ri.criterio_0, ri.criterio_1, ri.criterio_3, ri.criterio_5, ri.orden,
            rc.id AS category_id, rc.tag, rc.label, rc.sub, rc.orden AS cat_orden,
            sc.id AS score_id, sc.score, sc.comentario
     FROM rubric_items ri
     JOIN rubric_categories rc ON rc.id = ri.category_id
     LEFT JOIN audit_scores sc ON sc.rubric_item_id = ri.id AND sc.audit_id = $1
     WHERE rc.audit_type = $2
     ORDER BY rc.orden, ri.orden`,
    [id, audit.audit_type]
  );

  const scoreIds = items.filter((it) => it.score_id).map((it) => it.score_id);
  let fotos = [];
  if (scoreIds.length) {
    fotos = await sql(
      `SELECT id, audit_score_id, r2_key, content_type, created_at
       FROM audit_photos WHERE audit_score_id = ANY($1::int[])`,
      [scoreIds]
    );
  }

  // Se buscan por audit_id + rubric_item_id (no solo audit_score_id): una
  // acción manual puede cargarse referenciando el ítem aunque todavía no
  // tenga audit_score_id asignado, y así también queda bien si en el futuro
  // se permite agregar una acción antes de puntuar el ítem.
  const acciones = await sql(
    `SELECT * FROM plan_accion WHERE audit_id = $1 ORDER BY created_at`,
    [id]
  );

  const categoriasMap = new Map();
  for (const it of items) {
    if (!categoriasMap.has(it.category_id)) {
      categoriasMap.set(it.category_id, {
        id: it.category_id, tag: it.tag, label: it.label, sub: it.sub, orden: it.cat_orden, items: [],
      });
    }
    categoriasMap.get(it.category_id).items.push({
      rubric_item_id: it.rubric_item_id,
      nombre: it.nombre,
      criterio_0: it.criterio_0, criterio_1: it.criterio_1, criterio_3: it.criterio_3, criterio_5: it.criterio_5,
      score_id: it.score_id,
      score: it.score,
      comentario: it.comentario,
      fotos: fotos.filter((f) => f.audit_score_id === it.score_id)
        .map((f) => ({ id: f.id, url: `/fotos/${f.r2_key}`, content_type: f.content_type, created_at: f.created_at })),
      acciones: acciones.filter((a) => a.rubric_item_id === it.rubric_item_id).map(normalizePlanAccion),
    });
  }

  return json({ ...normalizeAudit(audit), categorias: Array.from(categoriasMap.values()) }, env);
}

// -------------------------------------------------------------------------
// PUT /auditorias/:id  (actualiza encabezado)
// -------------------------------------------------------------------------
async function updateAuditoria(sql, env, id, body) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of HEADER_FIELDS) {
    // fecha es NOT NULL: si llega vacía (ej. un <input type="date"> que no
    // pudo parsear el valor previo) la ignoramos en vez de romper el UPDATE.
    if (key === 'fecha' && body.fecha === '') continue;
    if (key in body) {
      sets.push(`${key} = $${i++}`);
      values.push(body[key]);
    }
  }
  if ('estado' in body) {
    sets.push(`estado = $${i++}`);
    values.push(body.estado);
  }
  if (!sets.length) return errorResponse('Nada para actualizar', env);
  sets.push('updated_at = now()');
  values.push(id);

  const rows = await sql(
    `UPDATE audits SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  if (!rows[0]) return errorResponse('Auditoría no encontrada', env, 404);
  return json(normalizeAudit(rows[0]), env);
}

// -------------------------------------------------------------------------
// PUT /auditorias/:id/puntajes/:itemId  (upsert puntaje de un ítem)
// -------------------------------------------------------------------------
async function upsertPuntaje(sql, env, auditId, itemId, body) {
  if (![0, 1, 3, 5].includes(Number(body.score))) {
    return errorResponse('score debe ser 0, 1, 3 o 5', env);
  }
  const rows = await sql(
    `INSERT INTO audit_scores (audit_id, rubric_item_id, score, comentario, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (audit_id, rubric_item_id)
     DO UPDATE SET score = EXCLUDED.score, comentario = EXCLUDED.comentario, updated_at = now()
     RETURNING *`,
    [auditId, itemId, body.score, body.comentario || null]
  );
  const totales = await recalcPuntajeTotal(sql, auditId);

  let accion = null;
  if ([0, 1].includes(Number(body.score))) {
    accion = await generarSugerenciaSiCorresponde(sql, env, auditId, itemId, rows[0]);
  }

  return json({ score: rows[0], puntaje_total: totales.puntaje_total, accion_sugerida: accion ? normalizePlanAccion(accion) : null }, env);
}

// Genera (una sola vez por puntaje, ver índice único ux_plan_accion_ia_por_score)
// una sugerencia de acción correctiva con IA para un ítem recién puntuado en
// 0 o 1. Nunca tira: si Workers AI falla, el puntaje ya quedó guardado igual.
async function generarSugerenciaSiCorresponde(sql, env, auditId, itemId, scoreRow) {
  try {
    const existentes = await sql(
      `SELECT * FROM plan_accion WHERE audit_score_id = $1 AND origen = 'ia'`,
      [scoreRow.id]
    );
    if (existentes[0]) return existentes[0];

    const [audit] = await sql(
      `SELECT a.audit_type, COALESCE(us.nombre, s.nombre) AS sector_nombre
       FROM audits a
       LEFT JOIN uet_sectores us ON us.id = a.uet_sector_id
       LEFT JOIN sectores s ON s.id = a.sector_id
       WHERE a.id = $1`,
      [auditId]
    );
    const [item] = await sql(
      `SELECT nombre, criterio_0, criterio_1, criterio_3, criterio_5 FROM rubric_items WHERE id = $1`,
      [itemId]
    );
    if (!audit || !item) return null;

    const descripcion = await sugerirAccion(env, {
      item, score: Number(scoreRow.score), tipoAuditoria: audit.audit_type, sector: audit.sector_nombre,
    });
    if (!descripcion) return null;

    const inserted = await sql(
      `INSERT INTO plan_accion (audit_id, audit_score_id, rubric_item_id, descripcion, origen, estado)
       VALUES ($1, $2, $3, $4, 'ia', 'abierta')
       ON CONFLICT (audit_score_id) WHERE origen = 'ia' AND audit_score_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [auditId, scoreRow.id, itemId, descripcion]
    );
    return inserted[0] || null;
  } catch (err) {
    console.error('generarSugerenciaSiCorresponde falló:', err.message);
    return null;
  }
}

// -------------------------------------------------------------------------
// GET /plan-accion  (listado con filtros)
// -------------------------------------------------------------------------
async function listPlanAccion(sql, env, params) {
  const where = [];
  const values = [];
  let i = 1;

  if (params.get('estado')) { where.push(`pa.estado = $${i++}`); values.push(params.get('estado')); }
  // 'pendientes=1' trae abiertas + en_proceso (todo lo que no está cerrada) —
  // lo usa la pantalla de Revisión al abrir una auditoría nueva sobre un
  // sector que ya tuvo acciones cargadas antes.
  if (params.get('pendientes') === '1') { where.push(`pa.estado <> 'cerrada'`); }
  if (params.get('audit_type')) { where.push(`a.audit_type = $${i++}`); values.push(params.get('audit_type')); }
  if (params.get('planta_id')) { where.push(`a.planta_id = $${i++}`); values.push(params.get('planta_id')); }
  if (params.get('uet_sector_id')) { where.push(`a.uet_sector_id = $${i++}`); values.push(params.get('uet_sector_id')); }
  if (params.get('area_id')) { where.push(`a.area_id = $${i++}`); values.push(params.get('area_id')); }
  if (params.get('sector_id')) { where.push(`a.sector_id = $${i++}`); values.push(params.get('sector_id')); }
  if (params.get('audit_id')) { where.push(`pa.audit_id = $${i++}`); values.push(params.get('audit_id')); }
  if (params.get('exclude_audit_id')) { where.push(`pa.audit_id <> $${i++}`); values.push(params.get('exclude_audit_id')); }

  const limit = Math.min(Number(params.get('limit')) || 200, 500);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await sql(
    `SELECT pa.*, a.audit_type, a.fecha AS audit_fecha, ri.nombre AS item_nombre,
            COALESCE(us.nombre, s.nombre) AS sector_nombre, p.nombre AS planta_nombre
     FROM plan_accion pa
     JOIN audits a ON a.id = pa.audit_id
     LEFT JOIN rubric_items ri ON ri.id = pa.rubric_item_id
     LEFT JOIN uet_sectores us ON us.id = a.uet_sector_id
     LEFT JOIN sectores s ON s.id = a.sector_id
     LEFT JOIN plantas p ON p.id = a.planta_id
     ${whereSql}
     ORDER BY pa.estado = 'cerrada', pa.created_at DESC
     LIMIT ${limit}`,
    values
  );
  return json(rows.map(normalizePlanAccion), env);
}

// -------------------------------------------------------------------------
// POST /plan-accion  (acción manual)
// -------------------------------------------------------------------------
async function createPlanAccion(sql, env, body) {
  if (!body.audit_id || !body.descripcion) {
    return errorResponse('audit_id y descripcion son requeridos', env);
  }
  const rows = await sql(
    `INSERT INTO plan_accion (audit_id, audit_score_id, rubric_item_id, descripcion, origen, responsable, fecha_compromiso, estado)
     VALUES ($1, $2, $3, $4, 'manual', $5, $6, 'abierta')
     RETURNING *`,
    [body.audit_id, body.audit_score_id || null, body.rubric_item_id || null, body.descripcion, body.responsable || null, body.fecha_compromiso || null]
  );
  return json(normalizePlanAccion(rows[0]), env, { status: 201 });
}

// -------------------------------------------------------------------------
// PUT /plan-accion/:id
// -------------------------------------------------------------------------
async function updatePlanAccion(sql, env, id, body) {
  const campos = ['descripcion', 'responsable', 'fecha_compromiso', 'fecha_cierre', 'estado'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of campos) {
    if (key in body) { sets.push(`${key} = $${i++}`); values.push(body[key]); }
  }
  if (!sets.length) return errorResponse('Nada para actualizar', env);
  sets.push('updated_at = now()');
  values.push(id);
  const rows = await sql(`UPDATE plan_accion SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
  if (!rows[0]) return errorResponse('Acción no encontrada', env, 404);
  return json(normalizePlanAccion(rows[0]), env);
}

// -------------------------------------------------------------------------
// POST /plan-accion/:id/regenerar  (vuelve a pedirle la sugerencia a la IA)
// -------------------------------------------------------------------------
async function regenerarPlanAccion(sql, env, id) {
  const [existing] = await sql('SELECT * FROM plan_accion WHERE id = $1', [id]);
  if (!existing) return errorResponse('Acción no encontrada', env, 404);
  if (!existing.rubric_item_id || !existing.audit_score_id) {
    return errorResponse('Esta acción no tiene ítem asociado para regenerar', env);
  }
  const [audit] = await sql(
    `SELECT a.audit_type, COALESCE(us.nombre, s.nombre) AS sector_nombre
     FROM audits a LEFT JOIN uet_sectores us ON us.id = a.uet_sector_id
     LEFT JOIN sectores s ON s.id = a.sector_id WHERE a.id = $1`,
    [existing.audit_id]
  );
  const [item] = await sql(
    `SELECT nombre, criterio_0, criterio_1, criterio_3, criterio_5 FROM rubric_items WHERE id = $1`,
    [existing.rubric_item_id]
  );
  const [scoreRow] = await sql('SELECT score FROM audit_scores WHERE id = $1', [existing.audit_score_id]);
  const descripcion = await sugerirAccion(env, {
    item, score: Number(scoreRow.score), tipoAuditoria: audit.audit_type, sector: audit.sector_nombre,
  });
  if (!descripcion) return errorResponse('No se pudo generar una nueva sugerencia', env, 502);
  const rows = await sql(
    `UPDATE plan_accion SET descripcion = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [descripcion, id]
  );
  return json(normalizePlanAccion(rows[0]), env);
}

// -------------------------------------------------------------------------
// POST /auditorias/:id/puntajes/:itemId/fotos  (sube foto a R2)
// -------------------------------------------------------------------------
async function subirFoto(sql, env, request, auditId, itemId) {
  const scoreRows = await sql(
    'SELECT id FROM audit_scores WHERE audit_id = $1 AND rubric_item_id = $2',
    [auditId, itemId]
  );
  if (!scoreRows[0]) {
    return errorResponse('Guardá el puntaje del ítem antes de subir una foto', env);
  }
  const scoreId = scoreRows[0].id;
  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const key = `audits/${auditId}/${scoreId}/${crypto.randomUUID()}.${ext}`;

  const body = await request.arrayBuffer();
  await env.FOTOS.put(key, body, { httpMetadata: { contentType } });

  const rows = await sql(
    `INSERT INTO audit_photos (audit_score_id, r2_key, content_type)
     VALUES ($1, $2, $3) RETURNING *`,
    [scoreId, key, contentType]
  );
  return json({ id: rows[0].id, url: `/fotos/${key}`, content_type: contentType }, env, { status: 201 });
}

// -------------------------------------------------------------------------
// GET /fotos/:key  (proxy de lectura del objeto R2 — el bucket no es público)
// -------------------------------------------------------------------------
async function servirFoto(env, key) {
  const obj = await env.FOTOS.get(key);
  if (!obj) return new Response('No encontrada', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
}

// -------------------------------------------------------------------------
// DELETE /fotos/:fotoId
// -------------------------------------------------------------------------
async function borrarFoto(sql, env, fotoId) {
  const rows = await sql('SELECT r2_key FROM audit_photos WHERE id = $1', [fotoId]);
  if (!rows[0]) return errorResponse('Foto no encontrada', env, 404);
  await env.FOTOS.delete(rows[0].r2_key);
  await sql('DELETE FROM audit_photos WHERE id = $1', [fotoId]);
  return json({ ok: true }, env);
}

// -------------------------------------------------------------------------
// GET /dashboard  (radar + puntaje total + evolución + comparativo)
// -------------------------------------------------------------------------
async function getDashboard(sql, env, params) {
  const tipo = params.get('tipo') || 'planta';
  const plantaId = params.get('planta_id');
  const uetId = params.get('uet_id');
  const uetSectorId = params.get('uet_sector_id');
  const anio = Number(params.get('anio')) || new Date().getFullYear();

  const filtroBase = [`audit_type = $1`];
  const valoresBase = [tipo];
  let i = 2;
  if (plantaId) { filtroBase.push(`planta_id = $${i++}`); valoresBase.push(plantaId); }
  if (uetId) { filtroBase.push(`uet_id = $${i++}`); valoresBase.push(uetId); }
  if (uetSectorId) { filtroBase.push(`uet_sector_id = $${i++}`); valoresBase.push(uetSectorId); }
  const whereBase = filtroBase.join(' AND ');

  // Última auditoría (para radar + tarjeta de puntaje)
  const ultimas = await sql(
    `SELECT * FROM audits WHERE ${whereBase} ORDER BY fecha DESC, id DESC LIMIT 2`,
    valoresBase
  );
  const actual = ultimas[0] ? normalizeAudit(ultimas[0]) : null;
  const anterior = ultimas[1] ? normalizeAudit(ultimas[1]) : null;

  let radar = [];
  if (actual) {
    radar = await sql(
      `SELECT rc.tag, rc.label,
              COALESCE(SUM(sc.score), 0) AS logrado,
              COUNT(ri.id) * 5 AS maximo
       FROM rubric_categories rc
       JOIN rubric_items ri ON ri.category_id = rc.id
       LEFT JOIN audit_scores sc ON sc.rubric_item_id = ri.id AND sc.audit_id = $1
       WHERE rc.audit_type = $2
       GROUP BY rc.id, rc.tag, rc.label, rc.orden
       ORDER BY rc.orden`,
      [actual.id, tipo]
    );
  }

  const objetivos = await sql(
    'SELECT mes, objetivo FROM monthly_targets WHERE audit_type = $1 AND anio = $2 ORDER BY mes',
    [tipo, anio]
  );
  const promedios = await sql(
    `SELECT EXTRACT(MONTH FROM fecha)::int AS mes, AVG(puntaje_total) AS auditado
     FROM audits
     WHERE ${whereBase} AND EXTRACT(YEAR FROM fecha) = $${i}
     GROUP BY mes`,
    [...valoresBase, anio]
  );
  const evolucion = Array.from({ length: 12 }, (_, idx) => {
    const mes = idx + 1;
    const obj = objetivos.find((o) => o.mes === mes);
    const prom = promedios.find((p) => p.mes === mes);
    return {
      mes,
      objetivo: obj ? Number(obj.objetivo) : null,
      auditado: prom ? Number(prom.auditado) : null,
    };
  });

  let comparativo = [];
  if (tipo === 'planta') {
    const filtroComp = [`a.audit_type = $1`];
    const valoresComp = [tipo];
    let j = 2;
    if (plantaId) { filtroComp.push(`a.planta_id = $${j++}`); valoresComp.push(plantaId); }
    if (uetId) { filtroComp.push(`a.uet_id = $${j++}`); valoresComp.push(uetId); }
    comparativo = await sql(
      `SELECT DISTINCT ON (a.uet_sector_id) us.nombre AS sector, a.puntaje_total, a.fecha
       FROM audits a
       JOIN uet_sectores us ON us.id = a.uet_sector_id
       WHERE ${filtroComp.join(' AND ')} AND a.uet_sector_id IS NOT NULL
       ORDER BY a.uet_sector_id, a.fecha DESC, a.id DESC`,
      valoresComp
    );
  }

  const mesActual = new Date().getMonth() + 1;
  const objetivoMesActual = objetivos.find((o) => o.mes === mesActual);

  return json({
    audit_type: tipo,
    anio,
    radar: radar.map((r) => ({ tag: r.tag, label: r.label, pct: r.maximo ? Math.round((r.logrado / r.maximo) * 100) : null })),
    puntaje: actual ? {
      actual: Number(actual.puntaje_total),
      fecha: actual.fecha,
      objetivo_mes_actual: objetivoMesActual ? Number(objetivoMesActual.objetivo) : null,
      anterior: anterior ? Number(anterior.puntaje_total) : null,
      variacion: anterior ? Number(actual.puntaje_total) - Number(anterior.puntaje_total) : null,
      responsable: actual.responsable,
    } : null,
    evolucion,
    comparativo: comparativo.map((c) => ({ sector: c.sector, puntaje: Number(c.puntaje_total), fecha: normalizeAudit({ fecha: c.fecha }).fecha })),
    objetivo_mes_actual: objetivoMesActual ? Number(objetivoMesActual.objetivo) : null,
  }, env);
}

// Exportadas también con nombre para poder testear la lógica de negocio
// (queries SQL, recálculos) desde Node con un adaptador `sql` distinto
// (ver /sql/README de pruebas locales) sin pasar por el runtime de Workers.
export {
  recalcPuntajeTotal, getCatalogos, getRubrica, createAuditoria, listAuditorias,
  getAuditoria, updateAuditoria, upsertPuntaje, subirFoto, servirFoto, borrarFoto, getDashboard,
  listPlanAccion, createPlanAccion, updatePlanAccion, regenerarPlanAccion,
};

// -------------------------------------------------------------------------
// Router
// -------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    
    try {
      const sql = getDb(env);
      if (parts[0] === 'catalogos' && request.method === 'GET') {
        return await getCatalogos(sql, env);
      }
      if (parts[0] === 'rubrica' && parts[1] && request.method === 'GET') {
        return await getRubrica(sql, env, parts[1]);
      }
      if (parts[0] === 'dashboard' && request.method === 'GET') {
        return await getDashboard(sql, env, url.searchParams);
      }
      if (parts[0] === 'auditorias' && parts.length === 1) {
        if (request.method === 'GET') return await listAuditorias(sql, env, url.searchParams);
        if (request.method === 'POST') return await createAuditoria(sql, env, await request.json());
      }
      if (parts[0] === 'auditorias' && parts.length === 2) {
        const id = parts[1];
        if (request.method === 'GET') return await getAuditoria(sql, env, id);
        if (request.method === 'PUT') return await updateAuditoria(sql, env, id, await request.json());
      }
      if (parts[0] === 'auditorias' && parts[2] === 'puntajes' && parts.length === 4) {
        const [, auditId, , itemId] = parts;
        if (request.method === 'PUT') return await upsertPuntaje(sql, env, auditId, itemId, await request.json());
      }
      if (parts[0] === 'auditorias' && parts[2] === 'puntajes' && parts[4] === 'fotos' && parts.length === 5) {
        const [, auditId, , itemId] = parts;
        if (request.method === 'POST') return await subirFoto(sql, env, request, auditId, itemId);
      }
      if (parts[0] === 'fotos' && parts.length >= 2) {
        const key = parts.slice(1).join('/');
        if (request.method === 'GET') return await servirFoto(env, key);
        if (request.method === 'DELETE') return await borrarFoto(sql, env, parts[1]);
      }

      if (parts[0] === 'plan-accion' && parts.length === 1) {
        if (request.method === 'GET') return await listPlanAccion(sql, env, url.searchParams);
        if (request.method === 'POST') return await createPlanAccion(sql, env, await request.json());
      }
      if (parts[0] === 'plan-accion' && parts.length === 2 && request.method === 'PUT') {
        return await updatePlanAccion(sql, env, parts[1], await request.json());
      }
      if (parts[0] === 'plan-accion' && parts[2] === 'regenerar' && parts.length === 3 && request.method === 'POST') {
        return await regenerarPlanAccion(sql, env, parts[1]);
      }

      return errorResponse('No encontrado', env, 404);
    } catch (err) {
      console.error(err);
      return errorResponse(err.message || 'Error interno', env, 500);
    }
  },
};
