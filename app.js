// Se debe crear archivo .env con las variables de entorno de la base de datos
// DB_USER=postgres
// DB_PASSWORD=<password_de_la_base_de_datos>
// DB_HOST=localhost
// DB_PORT=5432
// DB_DATABASE=movies

require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const { Pool } = require('pg');
const { getTmdbMovie, getTmdbPoster } = require('./tmdb');

const app = express();
const port = process.env.PORT || 3500;
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : 'movieweb-local-development-secret');

if (!sessionSecret) throw new Error('SESSION_SECRET es obligatorio en producción.');

const escapeLikePattern = (value) => value.replace(/[\\%_]/g, '\\$&');
const validId = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647;

// Serve static files from the "views" directory
app.use(express.static('views'));

// Permite leer los datos enviados por formularios (req.body)
app.use(express.urlencoded({ extended: false }));
app.use(session({
    name: 'movieweb.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000,
    },
}));

// Crear un "pool" de conexiones a PostgreSQL usando las variables de entorno
const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    options: `-c search_path=movies,public`, //modificar options de acuerdo al nombre del esquema
});

async function loadRatingUsers() {
    const tables = await db.query(`
        SELECT to_regclass('movies.users') IS NOT NULL AS users_available,
               to_regclass('movies.movie_user') IS NOT NULL
               AND (SELECT count(*) = 2 FROM information_schema.columns
                    WHERE table_schema = 'movies' AND table_name = 'movie_user'
                    AND column_name IN ('is_favorite', 'watch_status')) AS ratings_available
    `);
    const available = tables.rows[0].users_available && tables.rows[0].ratings_available;

    return { available, users: [] };
}

app.use(async (req, res, next) => {
    res.locals.currentUser = null;
    if (!req.session.userId) return next();

    try {
        const result = await db.query(
            'SELECT user_id, user_username, user_name, user_email FROM users WHERE user_id = $1',
            [req.session.userId]
        );
        if (result.rows.length === 0) {
            req.session.userId = null;
        } else {
            res.locals.currentUser = result.rows[0];
        }
        next();
    } catch (err) {
        next(err);
    }
});

const requireAuth = (req, res, next) => {
    if (!res.locals.currentUser) return res.redirect('/login');
    next();
};

const userValues = (body) => ({
    user_username: String(body.user_username || '').trim(),
    user_name: String(body.user_name || '').trim(),
    user_email: String(body.user_email || '').trim().toLowerCase(),
});

const validateUserValues = (values) => {
    if (!values.user_username || !values.user_name || !values.user_email) return 'Completá todos los datos del perfil.';
    if (!/^[a-zA-Z0-9._-]{3,50}$/.test(values.user_username)) return 'El username debe tener entre 3 y 50 caracteres y usar letras, números, punto, guion o guion bajo.';
    if (values.user_name.length > 100) return 'El nombre admite hasta 100 caracteres.';
    if (values.user_email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.user_email)) return 'Ingresá un email válido.';
    return null;
};

const validatePassword = (password) => {
    if (password.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
    if (password.length > 72 || bcrypt.truncates(password)) return 'La contraseña es demasiado larga.';
    return null;
};

const canComparePassword = (password) => Boolean(password) && password.length <= 72 && !bcrypt.truncates(password);

// Configurar el motor de plantillas EJS
app.set('view engine', 'ejs');

// Ruta para la página de inicio
app.get('/', (req, res) => {
    res.render('index');
});

// Ruta para buscar películas en la base de datos PostgreSQL
app.get('/buscar', async (req, res) => {
    const searchTerm = String(req.query.q || '').trim();

    if (!searchTerm) {
        return res.render('resultado', {
            movies: [],
            actors: [],
            directors: [],
            emptySearch: true,
        });
    }

    const value = [`%${escapeLikePattern(searchTerm)}%`];

    const movieQuery = `
        SELECT movie_id, title
        FROM movie
        WHERE title ILIKE $1 ESCAPE '\\'
        ORDER BY title ASC
        LIMIT 50`;

    const actorQuery = `
        SELECT DISTINCT person.person_id, person.person_name
        FROM person
        INNER JOIN movie_cast ON person.person_id = movie_cast.person_id
        WHERE person.person_name ILIKE $1 ESCAPE '\\'
        ORDER BY person.person_name ASC
        LIMIT 50`;

    const directorQuery = `
        SELECT DISTINCT person.person_id, person.person_name
        FROM person
        INNER JOIN movie_crew ON person.person_id = movie_crew.person_id
        WHERE movie_crew.job = 'Director' AND person.person_name ILIKE $1 ESCAPE '\\'
        ORDER BY person.person_name ASC
        LIMIT 50`;

    try {
        const [movies, actors, directors] = await Promise.all([
            db.query(movieQuery, value),
            db.query(actorQuery, value),
            db.query(directorQuery, value)
        ]);

        res.render('resultado', {
            movies: movies.rows,
            actors: actors.rows,
            directors: directors.rows,
            emptySearch: false,
            query: searchTerm,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error en la búsqueda.');
    }
});

// Cargar cada relación por separado evita multiplicar las filas de elenco y equipo.
// Póster de una película para las tarjetas: redirige a la imagen de TMDB (la API key queda en el servidor).
app.get('/poster/:id', async (req, res) => {
    const movieId = Number(req.params.id);
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isInteger(movieId) || movieId > 2147483647) {
        return res.status(400).send('ID de película inválido.');
    }

    const posterUrl = await (app.locals.loadTmdbPoster || getTmdbPoster)(movieId);
    if (!posterUrl) {
        return res.status(404).send('Póster no disponible.');
    }

    res.set('Cache-Control', 'public, max-age=86400');
    res.redirect(posterUrl);
});

app.get('/pelicula/:id', async (req, res) => {
    const movieId = Number(req.params.id);
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isInteger(movieId) || movieId > 2147483647) {
        return res.status(400).send('ID de película inválido.');
    }

    try {
        const movieResult = await db.query('SELECT * FROM movie WHERE movie_id = $1', [movieId]);
        if (movieResult.rows.length === 0) {
            return res.status(404).send('Película no encontrada.');
        }

        const queries = [
            `SELECT DISTINCT p.person_id, p.person_name, mc.character_name, mc.cast_order,
                    g.gender
             FROM movie_cast mc
             JOIN person p ON p.person_id = mc.person_id
             LEFT JOIN gender g ON g.gender_id = mc.gender_id
             WHERE mc.movie_id = $1
             ORDER BY mc.cast_order NULLS LAST, p.person_name, mc.character_name`,
            `SELECT DISTINCT p.person_id, p.person_name, d.department_name, mc.job
             FROM movie_crew mc
             JOIN person p ON p.person_id = mc.person_id
             LEFT JOIN department d ON d.department_id = mc.department_id
             WHERE mc.movie_id = $1
             ORDER BY d.department_name NULLS LAST, mc.job, p.person_name`,
            `SELECT DISTINCT g.genre_name
             FROM movie_genres mg JOIN genre g ON g.genre_id = mg.genre_id
             WHERE mg.movie_id = $1 ORDER BY g.genre_name`,
            `SELECT DISTINCT c.country_name, c.country_iso_code
             FROM production_country pc JOIN country c ON c.country_id = pc.country_id
             WHERE pc.movie_id = $1 ORDER BY c.country_name`,
            `SELECT DISTINCT l.language_name, l.language_code, lr.language_role
             FROM movie_languages ml
             JOIN language l ON l.language_id = ml.language_id
             LEFT JOIN language_role lr ON lr.role_id = ml.language_role_id
             WHERE ml.movie_id = $1 ORDER BY lr.language_role, l.language_name`,
            `SELECT DISTINCT pc.company_name
             FROM movie_company mc JOIN production_company pc ON pc.company_id = mc.company_id
             WHERE mc.movie_id = $1 ORDER BY pc.company_name`,
            `SELECT DISTINCT k.keyword_name
             FROM movie_keywords mk JOIN keyword k ON k.keyword_id = mk.keyword_id
             WHERE mk.movie_id = $1 ORDER BY k.keyword_name`,
        ];
        const [cast, crew, genres, countries, languages, companies, keywords] = await Promise.all(
            queries.map((query) => db.query(query, [movieId]))
        );
        const tmdb = await (app.locals.loadTmdbMovie || getTmdbMovie)(movieId);
        const ratingUsers = await (app.locals.loadRatingUsers || loadRatingUsers)();
        const selectedUser = ratingUsers.available ? res.locals.currentUser : null;
        let interaction = null;
        if (selectedUser) {
            const result = await db.query(
                'SELECT is_favorite, watch_status, rating, opinion FROM movie_user WHERE user_id = $1 AND movie_id = $2',
                [selectedUser.user_id, movieId]
            );
            interaction = result.rows[0] || null;
        }

        res.render('pelicula', {
            movie: movieResult.rows[0],
            cast: cast.rows,
            crew: crew.rows,
            genres: genres.rows,
            countries: countries.rows,
            languages: languages.rows,
            companies: companies.rows,
            keywords: keywords.rows,
            tmdb,
            users: ratingUsers.users,
            ratingsAvailable: ratingUsers.available,
            selectedUser,
            interaction,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar los datos de la película.');
    }
});

// Ruta para mostrar la página de un actor específico (PostgreSQL)
app.get('/actor/:id', async (req, res) => {
    const actorId = Number(req.params.id);

    if (!Number.isInteger(actorId) || actorId <= 0) {
        return res.status(400).send('ID de actor inválido.');
    }

    const personQuery = `
      SELECT person_id, person_name
      FROM person
      WHERE person_id = $1
    `;

    const creditsQuery = `
      SELECT
        movie.movie_id,
        movie.title,
        movie.release_date,
        STRING_AGG(
          DISTINCT NULLIF(TRIM(movie_cast.character_name), ''),
          ', '
          ORDER BY NULLIF(TRIM(movie_cast.character_name), '')
        ) AS role
      FROM movie_cast
      INNER JOIN movie ON movie.movie_id = movie_cast.movie_id
      WHERE movie_cast.person_id = $1
      GROUP BY movie.movie_id, movie.title, movie.release_date
      ORDER BY movie.release_date DESC NULLS LAST, movie.title ASC
    `;

    try {
        const [personResult, creditsResult] = await Promise.all([
            db.query(personQuery, [actorId]),
            db.query(creditsQuery, [actorId]),
        ]);

        if (personResult.rows.length === 0 || creditsResult.rows.length === 0) {
            return res.status(404).send('Actor no encontrado.');
        }

        res.render('actor', {
            person: personResult.rows[0],
            credits: creditsResult.rows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar las películas del actor.');
    }
});

// Ruta para mostrar la página de un director específico (PostgreSQL)
app.get('/director/:id', async (req, res) => {
    const directorId = Number(req.params.id);

    if (!Number.isInteger(directorId) || directorId <= 0) {
        return res.status(400).send('ID de director inválido.');
    }

    const personQuery = `
      SELECT person_id, person_name
      FROM person
      WHERE person_id = $1
    `;

    const creditsQuery = `
      SELECT DISTINCT
        movie.movie_id,
        movie.title,
        movie.release_date,
        movie_crew.job AS role
      FROM movie_crew
      INNER JOIN movie ON movie.movie_id = movie_crew.movie_id
      WHERE movie_crew.person_id = $1 AND movie_crew.job = 'Director'
      ORDER BY movie.release_date DESC NULLS LAST, movie.title ASC
    `;

    try {
        const [personResult, creditsResult] = await Promise.all([
            db.query(personQuery, [directorId]),
            db.query(creditsQuery, [directorId]),
        ]);

        if (personResult.rows.length === 0 || creditsResult.rows.length === 0) {
            return res.status(404).send('Director no encontrado.');
        }

        res.render('director', {
            person: personResult.rows[0],
            credits: creditsResult.rows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar las películas del director.');
    }
});

// Página del buscador de palabras clave
app.get('/keyword', (req, res) => {
    res.render('search_keyword');
});

// Ruta para buscar películas por palabra clave (PostgreSQL)
app.get('/keyword/resultados', async (req, res) => {
    const searchTerm = String(req.query.q || '').trim();

    if (!searchTerm) {
        return res.render('resultados_keyword', {
            searchTerm,
            movies: [],
            emptySearch: true,
        });
    }

    const moviesQuery = `
      SELECT
        movie.movie_id,
        movie.title,
        movie.release_date,
        STRING_AGG(DISTINCT keyword.keyword_name, ', ' ORDER BY keyword.keyword_name) AS keywords
      FROM keyword
      INNER JOIN movie_keywords ON movie_keywords.keyword_id = keyword.keyword_id
      INNER JOIN movie ON movie.movie_id = movie_keywords.movie_id
      WHERE keyword.keyword_name ILIKE $1 ESCAPE '\\'
      GROUP BY movie.movie_id, movie.title, movie.release_date
      ORDER BY movie.title ASC
      LIMIT 100
    `;

    try {
        const result = await db.query(moviesQuery, [`%${escapeLikePattern(searchTerm)}%`]);

        res.render('resultados_keyword', {
            searchTerm,
            movies: result.rows,
            emptySearch: false,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error en la búsqueda por palabra clave.');
    }
});

app.get('/registro', (req, res) => {
    if (res.locals.currentUser) return res.redirect('/perfil');
    res.render('registro', { error: null, values: { user_username: '', user_name: '', user_email: '' } });
});

app.post('/registro', async (req, res) => {
    if (res.locals.currentUser) return res.redirect('/perfil');
    const values = userValues(req.body);
    const password = String(req.body.password || '');
    const passwordConfirmation = String(req.body.password_confirmation || '');
    const options = { values };
    const valuesError = validateUserValues(values);
    if (valuesError || !password) return res.status(400).render('registro', { ...options, error: valuesError || 'Completá todos los campos.' });
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).render('registro', { ...options, error: passwordError });
    if (password !== passwordConfirmation) {
        return res.status(400).render('registro', { ...options, error: 'Las contraseñas no coinciden.' });
    }
    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const result = await db.query(`INSERT INTO users (user_username, user_name, user_email, password_hash)
            VALUES ($1, $2, $3, $4) RETURNING user_id`,
            [values.user_username, values.user_name, values.user_email, passwordHash]);
        req.session.regenerate((err) => {
            if (err) return res.status(500).send('Error al iniciar la sesión.');
            req.session.userId = result.rows[0].user_id;
            res.redirect('/perfil');
        });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).render('registro', { ...options, error: 'Ya existe un usuario con ese username o email.' });
        }
        console.error(err);
        res.status(500).send('Error al crear el usuario.');
    }
});

app.get('/login', (req, res) => {
    if (res.locals.currentUser) return res.redirect('/perfil');
    res.render('login', { error: null, identifier: '' });
});

app.post('/login', async (req, res) => {
    if (res.locals.currentUser) return res.redirect('/perfil');
    const identifier = String(req.body.identifier || '').trim();
    const password = String(req.body.password || '');
    if (!identifier || identifier.length > 255 || !canComparePassword(password)) {
        return res.status(401).render('login', { error: 'Usuario o contraseña incorrectos.', identifier: identifier.slice(0, 255) });
    }
    try {
        const result = await db.query(`SELECT user_id, password_hash FROM users
            WHERE LOWER(user_username) = LOWER($1) OR LOWER(user_email) = LOWER($1) LIMIT 1`, [identifier]);
        const user = result.rows[0];
        if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).render('login', { error: 'Usuario o contraseña incorrectos.', identifier });
        }
        req.session.regenerate((err) => {
            if (err) return res.status(500).send('Error al iniciar la sesión.');
            req.session.userId = user.user_id;
            res.redirect('/perfil');
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al iniciar la sesión.');
    }
});

app.post('/logout', requireAuth, (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).send('Error al cerrar la sesión.');
        res.clearCookie('movieweb.sid');
        res.redirect('/');
    });
});

const renderUserProfile = async (res, user, isOwnProfile) => {
    const userId = user.user_id;
    const moviesQuery = `
      SELECT movie.movie_id, movie.title, movie.release_date,
             movie_user.rating, movie_user.opinion, movie_user.is_favorite, movie_user.watch_status
      FROM movie_user
      INNER JOIN movie ON movie.movie_id = movie_user.movie_id
      WHERE movie_user.user_id = $1
      ORDER BY movie.title ASC
    `;

    try {
        const moviesResult = await db.query(moviesQuery, [userId]);
        res.render('usuario', { user, movies: moviesResult.rows, isOwnProfile });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar el perfil del usuario.');
    }
};

app.get('/perfil', requireAuth, async (req, res) => {
    await renderUserProfile(res, res.locals.currentUser, true);
});

app.get('/perfil/editar', requireAuth, (req, res) => {
    res.render('perfil_editar', { error: null, success: null, values: res.locals.currentUser });
});

app.post('/perfil/editar', requireAuth, async (req, res) => {
    const values = userValues(req.body);
    const options = { values, success: null };
    const valuesError = validateUserValues(values);
    if (valuesError) return res.status(400).render('perfil_editar', { ...options, error: valuesError });
    try {
        await db.query(`UPDATE users SET user_username = $1, user_name = $2, user_email = $3 WHERE user_id = $4`,
            [values.user_username, values.user_name, values.user_email, res.locals.currentUser.user_id]);
        res.locals.currentUser = { ...res.locals.currentUser, ...values };
        res.render('perfil_editar', { values, error: null, success: 'Tus datos se actualizaron.' });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).render('perfil_editar', { ...options, error: 'Ya existe un usuario con ese username o email.' });
        }
        console.error(err);
        res.status(500).send('Error al actualizar el perfil.');
    }
});

app.post('/perfil/password', requireAuth, async (req, res) => {
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');
    const confirmation = String(req.body.password_confirmation || '');
    try {
        const result = await db.query('SELECT password_hash FROM users WHERE user_id = $1', [res.locals.currentUser.user_id]);
        if (!canComparePassword(currentPassword) || !result.rows[0]?.password_hash ||
            !(await bcrypt.compare(currentPassword, result.rows[0].password_hash))) {
            return res.status(400).render('perfil_editar', { error: 'La contraseña actual es incorrecta.', success: null, values: res.locals.currentUser });
        }
        const passwordError = validatePassword(newPassword);
        if (passwordError || newPassword !== confirmation) {
            return res.status(400).render('perfil_editar', { error: passwordError || 'Las contraseñas no coinciden.', success: null, values: res.locals.currentUser });
        }
        await db.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [await bcrypt.hash(newPassword, 10), res.locals.currentUser.user_id]);
        res.render('perfil_editar', { error: null, success: 'Tu contraseña se actualizó.', values: res.locals.currentUser });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al actualizar la contraseña.');
    }
});

app.post('/perfil/eliminar', requireAuth, async (req, res) => {
    const password = String(req.body.password || '');
    try {
        const result = await db.query('SELECT password_hash FROM users WHERE user_id = $1', [res.locals.currentUser.user_id]);
        if (!canComparePassword(password) || !result.rows[0]?.password_hash ||
            !(await bcrypt.compare(password, result.rows[0].password_hash))) {
            return res.status(400).render('perfil_editar', { error: 'Ingresá tu contraseña para eliminar la cuenta.', success: null, values: res.locals.currentUser });
        }
        await db.query('DELETE FROM users WHERE user_id = $1', [res.locals.currentUser.user_id]);
        req.session.destroy(() => {
            res.clearCookie('movieweb.sid');
            res.redirect('/');
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al eliminar la cuenta.');
    }
});

app.get('/usuarios', async (req, res) => {
    try {
        const result = await db.query('SELECT user_id, user_username, user_name FROM users ORDER BY user_username');
        res.render('usuarios', { users: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar los usuarios.');
    }
});

app.get('/usuarios/nuevo', (req, res) => res.redirect('/registro'));

app.get('/usuarios/:id', async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).send('ID de usuario inválido.');
    try {
        const result = await db.query('SELECT user_id, user_username, user_name FROM users WHERE user_id = $1', [Number(req.params.id)]);
        if (result.rows.length === 0) return res.status(404).send('Usuario no encontrado.');
        const isOwnProfile = res.locals.currentUser?.user_id === result.rows[0].user_id;
        await renderUserProfile(res, isOwnProfile ? res.locals.currentUser : result.rows[0], isOwnProfile);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar el perfil del usuario.');
    }
});

app.get('/usuarios/:id/editar', requireAuth, (req, res) => {
    if (!validId(req.params.id)) return res.status(400).send('ID de usuario inválido.');
    if (Number(req.params.id) !== res.locals.currentUser.user_id) return res.status(403).send('No podés editar otro usuario.');
    res.redirect('/perfil/editar');
});

app.post('/usuarios/:id/eliminar', (req, res) => res.status(404).send('Ruta no disponible.'));

// Guarda la interacción completa o solamente la valoración del endpoint anterior.
app.post(['/pelicula/:id/calificar', '/pelicula/:id/interaccion'], requireAuth, async (req, res) => {
    const legacy = req.path.endsWith('/calificar');
    const movieId = Number(req.params.id);
    const userId = res.locals.currentUser.user_id;
    if (!validId(req.params.id)) {
        return res.status(400).send('Película inválida.');
    }
    if (['rating', 'opinion', 'watch_status', 'is_favorite', 'action'].some((key) =>
        req.body[key] !== undefined && typeof req.body[key] !== 'string')) {
        return res.status(400).send('Datos de interacción inválidos.');
    }
    const ratingText = (req.body.rating || '').trim();
    const opinion = (req.body.opinion || '').trim() || null;
    const watchStatus = req.body.watch_status || null;
    const favorite = req.body.is_favorite === 'on';
    const remove = !legacy && req.body.action === 'remove';
    if (!legacy && (!['save', 'remove', undefined].includes(req.body.action) ||
        ![null, 'want_to_watch', 'watched'].includes(watchStatus) ||
        ![undefined, 'on'].includes(req.body.is_favorite))) {
        return res.status(400).send('Estado de interacción inválido.');
    }
    if (opinion && opinion.length > 1000) return res.status(400).send('La opinión admite hasta 1000 caracteres.');
    const rating = ratingText === '' ? null : Number(ratingText);

    if (rating !== null && !/^[1-5]$/.test(ratingText)) {
        return res.status(400).send('La puntuación debe ser un número del 1 al 5.');
    }

    const upsertQuery = `
      INSERT INTO movie_user (user_id, movie_id, rating, opinion)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, movie_id)
      DO UPDATE SET rating = EXCLUDED.rating, opinion = EXCLUDED.opinion
    `;

    try {
        const exists = await db.query(`SELECT EXISTS(SELECT 1 FROM users WHERE user_id = $1) AS valid_user,
            EXISTS(SELECT 1 FROM movie WHERE movie_id = $2) AS valid_movie`, [userId, movieId]);
        if (!exists.rows[0].valid_user || !exists.rows[0].valid_movie) {
            return res.status(400).send('El usuario o la película no existen.');
        }
        if (legacy) {
            await db.query(upsertQuery, [userId, movieId, rating, opinion]);
        } else if (remove || (!favorite && !watchStatus && rating === null && !opinion)) {
            await db.query('DELETE FROM movie_user WHERE user_id = $1 AND movie_id = $2', [userId, movieId]);
        } else {
            await db.query(`INSERT INTO movie_user (user_id, movie_id, rating, opinion, is_favorite, watch_status)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (user_id, movie_id) DO UPDATE SET
                rating = EXCLUDED.rating, opinion = EXCLUDED.opinion,
                is_favorite = EXCLUDED.is_favorite, watch_status = EXCLUDED.watch_status`,
                [userId, movieId, rating, opinion, favorite, watchStatus]);
        }
        res.redirect(`/pelicula/${movieId}#rate-heading`);
    } catch (err) {
        if (err.code === '42P01' || err.code === '42703') {
            return res.status(503).send('Las interacciones no están disponibles temporalmente.');
        }
        if (err.code === '23503') {
            return res.status(400).send('El usuario o la película no existen.');
        }
        console.error(err);
        res.status(500).send('Error al guardar la calificación.');
    }
});


if (require.main === module) {
    app.listen(port, () => {
        console.log(`Servidor en ejecución en http://localhost:${port}`);
    });
}

module.exports = { app, db };
