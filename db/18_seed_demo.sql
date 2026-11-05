-- Datos de prueba para la demo: 8 usuarios con películas guardadas, puntuadas y reseñadas.
-- Contraseña de todos: movieweb123 (el hash se generó con bcrypt).
-- Las fechas son relativas ("hace N días") para que los timelines se vean como actividad real.
-- Se puede ejecutar varias veces: no duplica nada.

BEGIN;

INSERT INTO movies.users (user_username, user_name, user_email, password_hash)
SELECT username, name, email, '$2b$10$3FHAjQVK.5bp1mRpaJMya.9MT6m8j9AiRG2QcFGoxgcFUAhIgzgvu'
FROM (VALUES
    ('demo_ana',      'Ana Demo',          'ana.demo@movieweb.test'),
    ('demo_bruno',    'Bruno Demo',        'bruno.demo@movieweb.test'),
    ('sofi.cine',     'Sofía Ramírez',     'sofia.ramirez@movieweb.test'),
    ('nico_films',    'Nicolás Pereyra',   'nicolas.pereyra@movieweb.test'),
    ('cami.martinez', 'Camila Martínez',   'camila.martinez@movieweb.test'),
    ('juanpi.rojas',  'Juan Pablo Rojas',  'juanpablo.rojas@movieweb.test'),
    ('lu.fernandez',  'Lucía Fernández',   'lucia.fernandez@movieweb.test'),
    ('tomi.vera',     'Tomás Vera',        'tomas.vera@movieweb.test')
) AS demo (username, name, email)
WHERE NOT EXISTS (
    SELECT 1 FROM movies.users u
    WHERE LOWER(u.user_username) = LOWER(demo.username) OR LOWER(u.user_email) = LOWER(demo.email)
);

INSERT INTO movies.movie_user (user_id, movie_id, rating, opinion, is_favorite, watch_status, created_at, updated_at)
SELECT u.user_id, demo.movie_id, demo.rating, demo.opinion, demo.is_favorite, demo.watch_status,
       NOW() - (demo.hours_ago || ' hours')::interval, NOW() - (demo.hours_ago || ' hours')::interval
FROM (VALUES
    -- Interstellar (157336)
    ('demo_ana',      157336, 5, 'Una de las mejores películas de ciencia ficción. La música de Hans Zimmer es increíble.', TRUE,  'watched', 900),
    ('demo_bruno',    157336, 3, 'Muy linda visualmente, pero se me hizo larga.', FALSE, 'watched', 610),
    ('nico_films',    157336, 5, 'La escena del planeta de las olas me dejó sin aire. Nolan en su mejor momento.', TRUE, 'watched', 75),
    ('sofi.cine',     157336, 4, 'Emocionante de punta a punta. El final es medio enredado, pero la relación padre e hija te parte.', FALSE, 'watched', 300),
    ('cami.martinez', 157336, 5, 'Lloré con la escena de los mensajes. Hay que verla en el cine o con buen sonido.', TRUE, 'watched', 20),
    -- Inception (27205)
    ('nico_films',    27205, 5, 'La vi tres veces y cada vez entiendo algo nuevo. El trompo al final es una genialidad.', TRUE, 'watched', 140),
    ('juanpi.rojas',  27205, 4, 'Muy original. Le sobra un poco de explicación en la primera hora.', FALSE, 'watched', 410),
    ('tomi.vera',     27205, 4, 'La pelea en el pasillo girando es de lo mejor que vi en acción.', FALSE, 'watched', 52),
    ('demo_ana',      27205, NULL, NULL, FALSE, 'want_to_watch', 880),
    -- The Dark Knight (155)
    ('demo_bruno',    155, 5, 'El mejor Joker del cine.', TRUE, 'watched', 590),
    ('nico_films',    155, 5, 'No es una película de superhéroes, es un policial. Heath Ledger está en otro nivel.', TRUE, 'watched', 95),
    ('juanpi.rojas',  155, 5, 'De las pocas películas de cómics que me banco. Oscura y tensa todo el tiempo.', FALSE, 'watched', 230),
    ('tomi.vera',     155, 4, 'Muy buena, aunque prefiero las de Marvel. El camión dado vuelta es épico.', FALSE, 'watched', 33),
    -- Titanic (597)
    ('cami.martinez', 597, 5, 'Mi película favorita desde chica. La música, el vestuario, todo.', TRUE, 'watched', 200),
    ('juanpi.rojas',  597, 2, 'Técnicamente impecable, pero tres horas de romance no son para mí. Y entraban los dos en la puerta.', FALSE, 'watched', 160),
    ('sofi.cine',     597, 4, 'Un clásico. La segunda mitad, con el barco hundiéndose, es cine catástrofe del mejor.', FALSE, 'watched', 520),
    -- Avatar (19995)
    ('tomi.vera',     19995, 4, 'Visualmente es una locura, la vi en 3D y fue otra experiencia.', FALSE, 'watched', 70),
    ('sofi.cine',     19995, 2, 'Preciosa, pero la historia es Pocahontas con azules.', FALSE, 'watched', 340),
    ('demo_bruno',    19995, 3, 'Entretenida, aunque no me acuerdo de casi nada del guion.', FALSE, 'watched', 450),
    -- Fight Club (550)
    ('demo_bruno',    550, 4, NULL, FALSE, 'watched', 470),
    ('juanpi.rojas',  550, 5, 'La primera regla del club de la pelea es... verla sin spoilers. El giro final me voló la cabeza.', TRUE, 'watched', 110),
    ('nico_films',    550, 4, 'Envejeció rarísimo pero sigue siendo muy provocadora.', FALSE, 'watched', 260),
    -- The Lord of the Rings: The Fellowship of the Ring (120)
    ('lu.fernandez',  120, 5, 'La empecé a ver por tercera vez este año. La Comunidad es la mejor de las tres.', TRUE, 'watched', 15),
    ('demo_ana',      120, 4, 'Larguísima pero vale cada minuto. Las Minas de Moria son lo mejor.', FALSE, 'watched', 700),
    ('tomi.vera',     120, 3, 'Linda, pero me dormí en la parte de Rivendel.', FALSE, 'watched', 380),
    -- Harry Potter and the Philosopher's Stone (671)
    ('lu.fernandez',  671, 5, 'Pura nostalgia. Cada vez que la veo me dan ganas de recibir mi carta de Hogwarts.', TRUE, 'watched', 45),
    ('cami.martinez', 671, 4, 'Ideal para un domingo de lluvia.', FALSE, 'watched', 120),
    -- Star Wars (11) y The Empire Strikes Back (1891)
    ('lu.fernandez',  11, 4, 'La que empezó todo. Algunos efectos se notan viejos, pero tiene una magia que no tienen las nuevas.', FALSE, 'watched', 180),
    ('lu.fernandez',  1891, 5, 'La mejor de toda la saga, sin discusión. Ese final...', TRUE, 'watched', 8),
    ('demo_bruno',    1891, NULL, NULL, FALSE, 'want_to_watch', 30),
    -- The Godfather (238)
    ('demo_ana',      238, 5, 'Un clásico que no envejece.', TRUE, 'watched', 860),
    ('sofi.cine',     238, 5, 'Cada escena es una clase de cine. Marlon Brando es inolvidable.', TRUE, 'watched', 150),
    ('juanpi.rojas',  238, 4, 'Lenta al principio, pero cuando arranca no la podés dejar.', FALSE, 'watched', 640),
    -- The Shawshank Redemption (278)
    ('sofi.cine',     278, 5, 'La esperanza es algo bueno, tal vez lo mejor de todo. Me la recomendaron mil veces y tenían razón.', TRUE, 'watched', 60),
    ('demo_ana',      278, NULL, NULL, FALSE, 'want_to_watch', 40),
    -- The Matrix (603)
    ('nico_films',    603, 5, 'Cambió el cine de acción para siempre. La escena de las balas en cámara lenta sigue siendo icónica.', FALSE, 'watched', 330),
    ('tomi.vera',     603, 4, 'Pastilla roja, siempre.', TRUE, 'watched', 90),
    -- The Avengers (24428) y Guardians of the Galaxy (118340)
    ('tomi.vera',     24428, 5, 'Ver a todos juntos por primera vez fue un evento. La escena de Hulk con Loki es lo más gracioso.', TRUE, 'watched', 26),
    ('demo_bruno',    24428, 4, 'Pochoclera en el mejor sentido.', FALSE, 'watched', 560),
    ('tomi.vera',     118340, 5, 'La banda sonora es un temazo atrás de otro. Groot es mi personaje favorito.', TRUE, 'watched', 12),
    ('cami.martinez', 118340, 4, NULL, FALSE, 'watched', 85),
    -- Toy Story (862)
    ('cami.martinez', 862, 5, 'Te hace reír de chico y llorar de grande.', TRUE, 'watched', 40),
    -- Se7en (807) y The Silence of the Lambs (274)
    ('juanpi.rojas',  807, 5, 'Qué hay en la caja... de los finales más perturbadores del cine.', TRUE, 'watched', 6),
    ('juanpi.rojas',  274, 5, 'Anthony Hopkins aparece pocos minutos y se lleva toda la película.', FALSE, 'watched', 48),
    ('sofi.cine',     274, NULL, NULL, FALSE, 'want_to_watch', 4),
    -- Back to the Future (105) y Forrest Gump (13)
    ('demo_bruno',    105, 5, 'Perfecta. La vería todos los años.', TRUE, 'watched', 520),
    ('cami.martinez', 13, 5, 'La vida es como una caja de bombones. La banda sonora es hermosa.', FALSE, 'watched', 220),
    ('lu.fernandez',  13, NULL, NULL, FALSE, 'want_to_watch', 2)
) AS demo (username, movie_id, rating, opinion, is_favorite, watch_status, hours_ago)
JOIN movies.users u ON u.user_username = demo.username
JOIN movies.movie m ON m.movie_id = demo.movie_id
ON CONFLICT (user_id, movie_id) DO NOTHING;

COMMIT;
