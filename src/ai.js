// Sugerencia de acción correctiva vía Cloudflare Workers AI. Se dispara
// automáticamente cuando un ítem se puntúa 0 o 1 (ver upsertPuntaje en
// index.js). El propio criterio de la rúbrica (qué dice el 0/1 obtenido vs.
// qué dice el 5 ideal) es el contexto — el modelo no inventa el diagnóstico,
// solo redacta la acción concreta para cerrar esa brecha.

const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

const CRITERIO_POR_SCORE = { 0: 'criterio_0', 1: 'criterio_1', 3: 'criterio_3', 5: 'criterio_5' };

const TIPO_LABEL = { planta: 'planta industrial', panol: 'pañol', oficina: 'oficina' };

function buildPrompt({ item, score, tipoAuditoria, sector }) {
  const criterioActual = item[CRITERIO_POR_SCORE[score]] || '(sin descripción)';
  const criterioIdeal = item.criterio_5 || '(sin descripción)';

  const system = `Sos un asesor de Mejora Continua especializado en 5S (metodología Lean). ` +
    `Te dan un ítem de auditoría 5S mal puntuado y redactás UNA acción correctiva concreta, ` +
    `breve (máximo 2 frases) y accionable para un operario o líder de sector. ` +
    `Respondé solo con la acción, en español rioplatense, sin introducciones ni viñetas.`;

  const user = `Auditoría 5S — tipo: ${TIPO_LABEL[tipoAuditoria] || tipoAuditoria}${sector ? `, sector: ${sector}` : ''}.
Ítem evaluado: "${item.nombre}".
Situación actual (puntaje ${score}): ${criterioActual}
Objetivo (puntaje 5): ${criterioIdeal}

¿Qué acción concreta hay que tomar para pasar de la situación actual al objetivo?`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Devuelve el texto de la acción sugerida, o null si Workers AI no está
// disponible o falla — nunca debe romper el guardado del puntaje.
export async function sugerirAccion(env, { item, score, tipoAuditoria, sector }) {
  if (!env.AI) return null;
  try {
    const messages = buildPrompt({ item, score, tipoAuditoria, sector });
    const result = await env.AI.run(MODEL, { messages, max_tokens: 180 });
    const texto = (result && (result.response || result.result?.response) || '').trim();
    return texto || null;
  } catch (err) {
    console.error('sugerirAccion falló:', err.message);
    return null;
  }
}
