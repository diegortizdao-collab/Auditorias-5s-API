-- ============================================================================
-- Auditorías 5S Escorial — esquema Postgres (Neon)
-- Mismo patrón que la app de Confirmación de Rutinas: Neon + Cloudflare Worker
-- como API intermediaria, frontend estático en GitHub Pages. Fotos en R2
-- (solo se guarda la "key" del objeto acá, no el binario).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Catálogos generales (Screen 1 · área/sector organizacional)
--    Usado para clasificar CUALQUIER auditoría (Planta / Pañol / Oficina) al
--    crear un "Nuevo registro": 6 áreas, cada una con sus sub-sectores.
-- ---------------------------------------------------------------------------
CREATE TABLE areas (
    id          SERIAL PRIMARY KEY,
    nombre      TEXT NOT NULL UNIQUE,
    orden       SMALLINT NOT NULL
);

CREATE TABLE sectores (
    id          SERIAL PRIMARY KEY,
    area_id     INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    nombre      TEXT NOT NULL,
    orden       SMALLINT NOT NULL,
    UNIQUE (area_id, nombre)
);

-- ---------------------------------------------------------------------------
-- 2. Estructura productiva (específica de auditorías tipo "planta")
--    Planta -> UET -> Sector, tres campos independientes y seleccionables
--    (así lo pidió Diego) para poder segmentar el Dashboard por cualquiera
--    de los tres. "Sector" acá es el nombre físico (Armado Gas, Enlozado...),
--    NO el mismo catálogo que `sectores` de arriba.
-- ---------------------------------------------------------------------------
CREATE TABLE plantas (
    id          SERIAL PRIMARY KEY,
    nombre      TEXT NOT NULL UNIQUE,
    orden       SMALLINT NOT NULL
);

CREATE TABLE uets (
    id          SERIAL PRIMARY KEY,
    planta_id   INTEGER NOT NULL REFERENCES plantas(id) ON DELETE CASCADE,
    nombre      TEXT NOT NULL,
    orden       SMALLINT NOT NULL,
    UNIQUE (planta_id, nombre)
);

CREATE TABLE uet_sectores (
    id          SERIAL PRIMARY KEY,
    planta_id   INTEGER NOT NULL REFERENCES plantas(id) ON DELETE CASCADE,
    nombre      TEXT NOT NULL,
    orden       SMALLINT NOT NULL,
    UNIQUE (planta_id, nombre)
);
-- Nota: uet_sectores queda independiente de uets (no anidado 1 a 1) para que
-- el formulario permita elegir UET y Sector por separado, tal cual el pedido
-- original. Si en el uso real terminan siendo 1 a 1 (cada UET = un sector
-- físico), se puede sumar más adelante una tabla puente uet_sector_map sin
-- romper nada de lo de acá.

-- ---------------------------------------------------------------------------
-- 3. Rúbricas (S1 a S5) por tipo de auditoría
--    Contenido idéntico al ya validado en el preview HTML (gen_imprimible*.py)
-- ---------------------------------------------------------------------------
CREATE TYPE audit_type AS ENUM ('planta', 'panol', 'oficina');

CREATE TABLE rubric_categories (
    id          SERIAL PRIMARY KEY,
    audit_type  audit_type NOT NULL,
    tag         TEXT NOT NULL,          -- 'S1'..'S5'
    label       TEXT NOT NULL,          -- 'S1 - Clasificar'
    sub         TEXT NOT NULL,          -- 'Separar innecesarios'
    orden       SMALLINT NOT NULL,
    UNIQUE (audit_type, tag)
);

CREATE TABLE rubric_items (
    id           SERIAL PRIMARY KEY,
    category_id  INTEGER NOT NULL REFERENCES rubric_categories(id) ON DELETE CASCADE,
    nombre       TEXT NOT NULL,
    criterio_0   TEXT NOT NULL DEFAULT '',
    criterio_1   TEXT NOT NULL DEFAULT '',
    criterio_3   TEXT NOT NULL DEFAULT '',
    criterio_5   TEXT NOT NULL DEFAULT '',
    orden        SMALLINT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 4. Auditorías (encabezado — Screen 2 · Formulario)
-- ---------------------------------------------------------------------------
CREATE TABLE audits (
    id                SERIAL PRIMARY KEY,
    audit_type        audit_type NOT NULL,

    -- Screen 1: clasificación general (todos los tipos)
    area_id           INTEGER REFERENCES areas(id),
    sector_id         INTEGER REFERENCES sectores(id),

    -- Específico de tipo "planta" (también disponible para panol/oficina
    -- si en algún momento se realizan dentro de Suipacha/25 de Mayo)
    planta_id         INTEGER REFERENCES plantas(id),
    uet_id            INTEGER REFERENCES uets(id),
    uet_sector_id     INTEGER REFERENCES uet_sectores(id),

    fecha             DATE NOT NULL,
    turno             TEXT,                     -- 'Mañana' / 'Tarde' / 'Noche'
    evaluador         TEXT NOT NULL,
    supervisor_lider  TEXT,
    jefe_gerente      TEXT,

    -- Footer del imprimible (Hoja 1)
    puntaje_objetivo  NUMERIC(5,1),              -- snapshot de monthly_targets al momento de auditar
    revision          SMALLINT DEFAULT 1,
    responsable       TEXT,

    -- Denormalizado para lecturas rápidas de Dashboard (se recalcula en el
    -- Worker cada vez que se guarda un puntaje; no depende de trigger de DB)
    puntaje_total     NUMERIC(5,1),

    estado            TEXT NOT NULL DEFAULT 'en_progreso', -- 'en_progreso' | 'cerrada'
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audits_tipo_fecha ON audits (audit_type, fecha DESC);
CREATE INDEX idx_audits_planta_uet_sector ON audits (planta_id, uet_id, uet_sector_id);
CREATE INDEX idx_audits_area_sector ON audits (area_id, sector_id);

-- ---------------------------------------------------------------------------
-- 5. Puntajes por ítem (Screen 3 · Evaluación)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_scores (
    id              SERIAL PRIMARY KEY,
    audit_id        INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    rubric_item_id  INTEGER NOT NULL REFERENCES rubric_items(id),
    score           SMALLINT NOT NULL CHECK (score IN (0, 1, 3, 5)),
    comentario      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (audit_id, rubric_item_id)
);

CREATE INDEX idx_audit_scores_audit ON audit_scores (audit_id);

-- ---------------------------------------------------------------------------
-- 6. Fotos (R2). Solo se guarda la referencia al objeto; el binario vive en
--    el bucket de Cloudflare R2, subido a través del Worker.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_photos (
    id              SERIAL PRIMARY KEY,
    audit_score_id  INTEGER NOT NULL REFERENCES audit_scores(id) ON DELETE CASCADE,
    r2_key          TEXT NOT NULL UNIQUE,     -- ej: audits/{audit_id}/{score_id}/{uuid}.jpg
    content_type    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_photos_score ON audit_photos (audit_score_id);

-- ---------------------------------------------------------------------------
-- 7. Objetivos mensuales (línea "Objetivo" del Dashboard / footer del
--    imprimible). Planta arranca 30 (enero) -> 75 (diciembre) 2026, lineal.
--    Pañol/Oficina quedan sin filas (Dashboard muestra estado vacío) hasta
--    que Diego defina el objetivo para esos tipos.
-- ---------------------------------------------------------------------------
CREATE TABLE monthly_targets (
    id          SERIAL PRIMARY KEY,
    audit_type  audit_type NOT NULL,
    anio        SMALLINT NOT NULL,
    mes         SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
    objetivo    NUMERIC(5,1) NOT NULL,
    UNIQUE (audit_type, anio, mes)
);

-- ---------------------------------------------------------------------------
-- 8. Plan de acción — independiente de la solapa de auditoría (mismo patrón
--    que la app de Confirmación de Rutinas: abierta / en_proceso / cerrada,
--    con fecha de cierre para medir tiempos). Cuando un ítem se puntúa 0 o 1,
--    el Worker le pide a la IA (Cloudflare Workers AI) una acción correctiva
--    concreta usando el propio criterio de la rúbrica (criterio_actual vs.
--    criterio_5) y la guarda acá con origen='ia'. También se pueden cargar
--    acciones manuales, con o sin ítem asociado.
-- ---------------------------------------------------------------------------
CREATE TABLE plan_accion (
    id                SERIAL PRIMARY KEY,
    audit_id          INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    audit_score_id    INTEGER REFERENCES audit_scores(id) ON DELETE CASCADE,
    rubric_item_id    INTEGER REFERENCES rubric_items(id),
    descripcion       TEXT NOT NULL,
    origen            TEXT NOT NULL DEFAULT 'ia',      -- 'ia' | 'manual'
    responsable       TEXT,
    fecha_compromiso  DATE,
    fecha_cierre      DATE,
    estado            TEXT NOT NULL DEFAULT 'abierta', -- 'abierta' | 'en_proceso' | 'cerrada'
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_plan_accion_audit ON plan_accion (audit_id);
CREATE INDEX idx_plan_accion_estado ON plan_accion (estado);
-- Como mucho una sugerencia de IA por puntaje (evita duplicar en cada re-click);
-- acciones manuales sí pueden convivir varias sobre el mismo ítem.
CREATE UNIQUE INDEX ux_plan_accion_ia_por_score ON plan_accion (audit_score_id)
    WHERE origen = 'ia' AND audit_score_id IS NOT NULL;
