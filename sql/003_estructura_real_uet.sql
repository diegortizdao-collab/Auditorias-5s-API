-- ============================================================================
-- 003 — Estructura real Planta > UET > (Grupo opcional) > Sector
--
-- El seed original (001) puso las 5 UET bajo Suipacha y los sectores como una
-- lista plana por planta, sin relación real con su UET (por eso el
-- segmentador de "UET" en el formulario no filtraba el "Sector": eran dos
-- catálogos independientes). Esta migración:
--   1. Vincula cada sector a su UET real (y, donde corresponde, a un grupo
--      intermedio dentro de esa UET: Soldadura en UET 4, Pintura/Prensa en
--      UET 5 de Suipacha).
--   2. Reubica en la planta correcta los sectores que estaban mal cargados
--      (Cocinas, Enlozado, Estampado, Corte son de 25 de Mayo, no Suipacha).
--   3. Suma las UET que faltaban (Matricería y Mantenimiento en cada planta)
--      y los sectores que faltaban (Welding, Prearmado, el segundo "Gema").
--   4. Reasigna las auditorías YA CARGADAS para que su planta/UET quede
--      consistente con el catálogo corregido (no se toca ningún puntaje,
--      foto ni plan de acción — solo la etiqueta de dónde se hizo la
--      auditoría).
--
-- Es seguro volver a correrla si algo falla a mitad de camino: usa
-- IF NOT EXISTS / NOT EXISTS / ON CONFLICT en cada paso.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Nueva tabla: grupo intermedio opcional dentro de una UET.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uet_grupos (
    id      SERIAL PRIMARY KEY,
    uet_id  INTEGER NOT NULL REFERENCES uets(id) ON DELETE CASCADE,
    nombre  TEXT NOT NULL,
    orden   SMALLINT NOT NULL,
    UNIQUE (uet_id, nombre)
);

-- uet_sectores pasa a colgar de una UET real y, opcionalmente, de un grupo.
ALTER TABLE uet_sectores ADD COLUMN IF NOT EXISTS uet_id INTEGER REFERENCES uets(id);
ALTER TABLE uet_sectores ADD COLUMN IF NOT EXISTS grupo_id INTEGER REFERENCES uet_grupos(id);

-- ---------------------------------------------------------------------------
-- 2. UET 1/2/3 son de 25 de Mayo, no de Suipacha (el seed las puso todas
--    bajo Suipacha por error).
-- ---------------------------------------------------------------------------
UPDATE uets SET planta_id = (SELECT id FROM plantas WHERE nombre = '25 de Mayo')
WHERE nombre IN ('UET 1', 'UET 2', 'UET 3')
  AND planta_id = (SELECT id FROM plantas WHERE nombre = 'Suipacha');

-- ---------------------------------------------------------------------------
-- 3. UET que faltaban: Matricería y Mantenimiento en cada planta.
-- ---------------------------------------------------------------------------
INSERT INTO uets (planta_id, nombre, orden)
SELECT p.id, v.nombre, v.orden
FROM plantas p
JOIN (VALUES
    ('Suipacha',   'Matricería Suipacha',      6),
    ('Suipacha',   'Mantenimiento Suipacha',   7),
    ('25 de Mayo', 'Matricería 25 de Mayo',    4),
    ('25 de Mayo', 'Mantenimiento 25 de Mayo', 5)
) AS v(planta_nombre, nombre, orden) ON v.planta_nombre = p.nombre
WHERE NOT EXISTS (
    SELECT 1 FROM uets WHERE uets.planta_id = p.id AND uets.nombre = v.nombre
);

-- ---------------------------------------------------------------------------
-- 4. Grupos dentro de UET 4 y UET 5 (Suipacha).
-- ---------------------------------------------------------------------------
INSERT INTO uet_grupos (uet_id, nombre, orden)
SELECT u.id, v.grupo_nombre, v.orden
FROM uets u
JOIN (VALUES
    ('UET 4', 'Soldadura', 1),
    ('UET 5', 'Pintura',   1),
    ('UET 5', 'Prensa',    2)
) AS v(uet_nombre, grupo_nombre, orden) ON v.uet_nombre = u.nombre
WHERE NOT EXISTS (
    SELECT 1 FROM uet_grupos WHERE uet_grupos.uet_id = u.id AND uet_grupos.nombre = v.grupo_nombre
);

-- ---------------------------------------------------------------------------
-- 5. Sectores existentes: vincular a su UET/grupo real, corregir planta y
--    renombrar los que quedaron con un nombre distinto al que usa Diego.
--    (Se matchea por nombre actual, tal cual quedó del seed original.)
-- ---------------------------------------------------------------------------

-- 5a. Sectores de UET 4 (Suipacha) que cuelgan directo (sin grupo).
UPDATE uet_sectores us SET uet_id = u.id
FROM uets u
WHERE u.nombre = 'UET 4' AND us.planta_id = u.planta_id
  AND us.nombre IN ('Armado Gas', 'Armado Eléctrico', 'Calefones');

-- 5b. Grupo Soldadura (UET 4, Suipacha) — incluye renombrar las líneas y
--     quedarse con el "Gema" existente como el de Suipacha. Restringido a
--     planta_id = Suipacha para no tocar el "Gema" homónimo de 25 de Mayo.
UPDATE uet_sectores us SET uet_id = g.uet_id, grupo_id = g.id
FROM uet_grupos g JOIN uets u ON u.id = g.uet_id
WHERE u.nombre = 'UET 4' AND g.nombre = 'Soldadura'
  AND us.planta_id = u.planta_id
  AND us.nombre IN ('Línea 1 Soldadura', 'Línea 2 Soldadura', 'Gema');

UPDATE uet_sectores SET nombre = 'Soldadura Línea 1' WHERE nombre = 'Línea 1 Soldadura';
UPDATE uet_sectores SET nombre = 'Soldadura Línea 2' WHERE nombre = 'Línea 2 Soldadura';

-- 5c. Grupo Pintura (UET 5, Suipacha) — "Circuito de camisas" pasa a llamarse
--     "Armado de Camisas".
UPDATE uet_sectores SET nombre = 'Armado de Camisas' WHERE nombre = 'Circuito de camisas';
UPDATE uet_sectores us SET uet_id = g.uet_id, grupo_id = g.id
FROM uet_grupos g JOIN uets u ON u.id = g.uet_id
WHERE u.nombre = 'UET 5' AND g.nombre = 'Pintura'
  AND us.planta_id = u.planta_id
  AND us.nombre IN ('Cabina de Pintura', 'Horno de Pirolisis', 'Armado de Camisas');

-- 5d. Grupo Prensa (UET 5, Suipacha).
UPDATE uet_sectores us SET uet_id = g.uet_id, grupo_id = g.id
FROM uet_grupos g JOIN uets u ON u.id = g.uet_id
WHERE u.nombre = 'UET 5' AND g.nombre = 'Prensa'
  AND us.planta_id = u.planta_id
  AND us.nombre IN ('LC06/Laser', 'Prensas y Omera', 'Circuito de manijas', 'EP04');

-- 5e. Sectores que en realidad son de 25 de Mayo (corrige planta_id además
--     de vincular a su UET): Cocinas -> UET 1, Enlozado -> UET 2,
--     Estampado/Corte -> UET 3.
UPDATE uet_sectores us SET
    planta_id = u.planta_id,
    uet_id = u.id
FROM uets u
WHERE u.nombre = 'UET 1' AND u.planta_id = (SELECT id FROM plantas WHERE nombre = '25 de Mayo')
  AND us.nombre IN ('Línea 1 Cocinas', 'Línea 2 Cocinas', 'Línea 3 Cocinas');

UPDATE uet_sectores us SET
    planta_id = u.planta_id,
    uet_id = u.id
FROM uets u
WHERE u.nombre = 'UET 2' AND u.planta_id = (SELECT id FROM plantas WHERE nombre = '25 de Mayo')
  AND us.nombre IN ('Enlozado');

UPDATE uet_sectores us SET
    planta_id = u.planta_id,
    uet_id = u.id
FROM uets u
WHERE u.nombre = 'UET 3' AND u.planta_id = (SELECT id FROM plantas WHERE nombre = '25 de Mayo')
  AND us.nombre IN ('Estampado', 'Corte');

-- 5f. Mantenimiento — "Taller" y "Pañol/Depósito" (ambas plantas) pasan a
--     colgar de su UET "Mantenimiento ..." y "Pañol/Depósito" se renombra a
--     "Pañol" para que coincida con el nombre que usa Diego.
UPDATE uet_sectores SET nombre = 'Pañol' WHERE nombre = 'Pañol/Depósito';

UPDATE uet_sectores us SET uet_id = u.id
FROM uets u
WHERE u.nombre = 'Mantenimiento Suipacha'
  AND us.planta_id = (SELECT id FROM plantas WHERE nombre = 'Suipacha')
  AND us.nombre IN ('Taller', 'Pañol');

UPDATE uet_sectores us SET uet_id = u.id
FROM uets u
WHERE u.nombre = 'Mantenimiento 25 de Mayo'
  AND us.planta_id = (SELECT id FROM plantas WHERE nombre = '25 de Mayo')
  AND us.nombre IN ('Taller', 'Pañol');

-- ---------------------------------------------------------------------------
-- 6. Sectores nuevos que no existían todavía.
-- ---------------------------------------------------------------------------
INSERT INTO uet_sectores (planta_id, uet_id, grupo_id, nombre, orden)
SELECT u.planta_id, u.id, NULL, v.nombre, v.orden
FROM uets u
JOIN (VALUES
    ('UET 1', 'Prearmado', 5),
    ('UET 2', 'Welding',   1),
    ('UET 2', 'Gema',      3)
) AS v(uet_nombre, nombre, orden) ON v.uet_nombre = u.nombre
WHERE u.planta_id = (SELECT id FROM plantas WHERE nombre = '25 de Mayo')
  AND NOT EXISTS (
      SELECT 1 FROM uet_sectores WHERE uet_sectores.uet_id = u.id AND uet_sectores.nombre = v.nombre
  );

-- Matricería: un único sector homónimo por ahora (sin sub-sectores).
INSERT INTO uet_sectores (planta_id, uet_id, grupo_id, nombre, orden)
SELECT u.planta_id, u.id, NULL, u.nombre, 1
FROM uets u
WHERE u.nombre IN ('Matricería Suipacha', 'Matricería 25 de Mayo')
  AND NOT EXISTS (
      SELECT 1 FROM uet_sectores WHERE uet_sectores.uet_id = u.id
  );

-- ---------------------------------------------------------------------------
-- 7. Propagar la corrección a las auditorías YA CARGADAS: si el sector de
--    una auditoría cambió de planta/UET, la auditoría se actualiza para
--    quedar consistente (no se toca fecha, puntajes, fotos ni plan de
--    acción — solo planta_id/uet_id).
-- ---------------------------------------------------------------------------
UPDATE audits a SET
    planta_id = us.planta_id,
    uet_id = us.uet_id
FROM uet_sectores us
WHERE a.uet_sector_id = us.id
  AND (a.planta_id IS DISTINCT FROM us.planta_id OR a.uet_id IS DISTINCT FROM us.uet_id);

-- ---------------------------------------------------------------------------
-- 8. Verificación — correr esto y avisar si aparece alguna fila (no debería
--    quedar ningún sector productivo sin UET asignada).
-- ---------------------------------------------------------------------------
SELECT us.id, us.nombre, p.nombre AS planta
FROM uet_sectores us
JOIN plantas p ON p.id = us.planta_id
WHERE us.uet_id IS NULL
ORDER BY p.nombre, us.nombre;
