-- Borra las tablas que agregó el grupo (usuarios, interacciones y sesiones).
-- No toca las tablas de películas provistas por la cátedra.
-- Uso: psql -d movies -U postgres -f 99_drop_tables.sql   (o: npm run dev:drop)

BEGIN;

DROP TABLE IF EXISTS movies.movie_user CASCADE;
DROP TABLE IF EXISTS movies.users CASCADE;
DROP TABLE IF EXISTS movies.session CASCADE;
DROP FUNCTION IF EXISTS movies.set_movie_user_updated_at();

COMMIT;
