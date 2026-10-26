BEGIN;

ALTER TABLE movies.users
    ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Las cuentas creadas antes de la autenticación eran datos de prueba y no
-- tienen una contraseña recuperable. Se eliminan junto con sus interacciones.
DELETE FROM movies.users
WHERE password_hash IS NULL;

-- El esquema anterior permitía diferencias solamente por mayúsculas. Conserva
-- la cuenta más antigua si una instalación local contiene esos duplicados.
DELETE FROM movies.users duplicate
USING movies.users original
WHERE duplicate.user_id > original.user_id
  AND LOWER(duplicate.user_username) = LOWER(original.user_username);

DELETE FROM movies.users duplicate
USING movies.users original
WHERE duplicate.user_id > original.user_id
  AND LOWER(duplicate.user_email) = LOWER(original.user_email);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_ci
    ON movies.users (LOWER(user_username));

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_ci
    ON movies.users (LOWER(user_email));

ALTER TABLE movies.users
    ALTER COLUMN password_hash SET NOT NULL;

COMMIT;
