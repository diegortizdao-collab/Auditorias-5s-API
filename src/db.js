import { neon } from '@neondatabase/serverless';

// Devuelve un cliente Neon listo para hacer queries con template strings
// parametrizados: sql`SELECT * FROM audits WHERE id = ${id}`
// (@neondatabase/serverless arma la query parametrizada por vos — nunca
// concatenar valores a mano acá adentro).
export function getDb(env) {
  if (!env.DATABASE_URL) {
    throw new Error('Falta DATABASE_URL (configurar con: npx wrangler secret put DATABASE_URL)');
  }
  return neon(env.DATABASE_URL);
}
