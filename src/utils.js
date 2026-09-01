export function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function json(data, env, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(env),
      ...(init.headers || {}),
    },
  });
}

export function errorResponse(message, env, status = 400) {
  return json({ error: message }, env, { status });
}

// Helper para armar el objetivo del mes vigente a partir de la fecha de la
// auditoría (YYYY-MM-DD) sin depender de zonas horarias del runtime.
export function anioMesDeFecha(fechaISO) {
  const [anio, mes] = fechaISO.split('-').map(Number);
  return { anio, mes };
}
