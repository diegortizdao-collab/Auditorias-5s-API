-- Migración idempotente: suma la tabla plan_accion a una base que ya corrió
-- schema.sql antes de que existiera esta funcionalidad. Si estás arrancando
-- de cero, no hace falta correr esto — ya está incluido en schema.sql.
CREATE TABLE IF NOT EXISTS plan_accion (
    id                SERIAL PRIMARY KEY,
    audit_id          INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    audit_score_id    INTEGER REFERENCES audit_scores(id) ON DELETE CASCADE,
    rubric_item_id    INTEGER REFERENCES rubric_items(id),
    descripcion       TEXT NOT NULL,
    origen            TEXT NOT NULL DEFAULT 'ia',
    responsable       TEXT,
    fecha_compromiso  DATE,
    fecha_cierre      DATE,
    estado            TEXT NOT NULL DEFAULT 'abierta',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plan_accion_audit ON plan_accion (audit_id);
CREATE INDEX IF NOT EXISTS idx_plan_accion_estado ON plan_accion (estado);
CREATE UNIQUE INDEX IF NOT EXISTS ux_plan_accion_ia_por_score ON plan_accion (audit_score_id)
    WHERE origen = 'ia' AND audit_score_id IS NOT NULL;
