-- ============================================================================
-- 004 — Competencias anuales
--    Agrega el soporte para auditorías "de competencia": participan sectores
--    (y subsectores) de la planta que compiten entre sí una vez al año. Usan
--    el mismo tipo de auditoría (y por lo tanto la misma rúbrica/puntaje) que
--    una auditoría normal, pero el encabezado de ubicación se completa a mano
--    (comp_planta/comp_uet/comp_sector/comp_subsector) en vez de usar los
--    catálogos (planta_id/uet_id/uet_sector_id/area_id/sector_id quedan NULL),
--    porque la competencia incluye subsectores que el catálogo general no
--    tiene cargados. `es_competencia` las marca para que todas las consultas
--    de Dashboard/Historial/Plan de Acción las excluyan por defecto y así no
--    se mezclen con el promedio "habitual" — tienen su propia pantalla de
--    indicadores (GET /competencia).
-- ============================================================================

ALTER TABLE audits ADD COLUMN IF NOT EXISTS es_competencia BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS comp_planta     TEXT;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS comp_uet        TEXT;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS comp_sector     TEXT;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS comp_subsector  TEXT;

-- Acelera tanto el filtro "excluir competencia" (el caso común, todas las
-- consultas de Dashboard/Historial/Plan de Acción) como la pantalla de
-- Indicadores de Competencia (que sí filtra es_competencia = true).
CREATE INDEX IF NOT EXISTS idx_audits_competencia
    ON audits (es_competencia, audit_type, fecha);
