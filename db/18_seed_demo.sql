-- Datos de prueba: dos usuarios con algunas películas guardadas y reseñadas.
-- Contraseña de los dos: movieweb123 (el hash se generó con bcrypt).
-- Se puede ejecutar varias veces: no duplica nada.

BEGIN;

INSERT INTO movies.users (user_username, user_name, user_email, password_hash)
SELECT username, name, email, '$2b$10$3FHAjQVK.5bp1mRpaJMya.9MT6m8j9AiRG2QcFGoxgcFUAhIgzgvu'
FROM (VALUES
    ('demo_ana', 'Ana Demo', 'ana.demo@movieweb.test'),
    ('demo_bruno', 'Bruno Demo', 'bruno.demo@movieweb.test')
) AS demo (username, name, email)
WHERE NOT EXISTS (
    SELECT 1 FROM movies.users u
    WHERE LOWER(u.user_username) = LOWER(demo.username) OR LOWER(u.user_email) = LOWER(demo.email)
);

INSERT INTO movies.movie_user (user_id, movie_id, rating, opinion, is_favorite, watch_status)
SELECT u.user_id, demo.movie_id, demo.rating, demo.opinion, demo.is_favorite, demo.watch_status
FROM (VALUES
    ('demo_ana', 157336, 5, 'Una de las mejores películas de ciencia ficción. La música de Hans Zimmer es increíble.', TRUE, 'watched'),
    ('demo_ana', 238, 5, 'Un clásico que no envejece.', TRUE, 'watched'),
    ('demo_ana', 27205, NULL, NULL, FALSE, 'want_to_watch'),
    ('demo_bruno', 157336, 3, 'Muy linda visualmente, pero se me hizo larga.', FALSE, 'watched'),
    ('demo_bruno', 155, 5, 'El mejor Joker del cine.', TRUE, 'watched'),
    ('demo_bruno', 550, 4, NULL, FALSE, 'watched')
) AS demo (username, movie_id, rating, opinion, is_favorite, watch_status)
JOIN movies.users u ON u.user_username = demo.username
JOIN movies.movie m ON m.movie_id = demo.movie_id
ON CONFLICT (user_id, movie_id) DO NOTHING;

COMMIT;
