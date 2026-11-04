// Se debe crear archivo .env con las variables de entorno de la base de datos
// DB_USER=postgres
// DB_PASSWORD=<password_de_la_base_de_datos>
// DB_HOST=localhost
// DB_PORT=5432
// DB_DATABASE=movies

require('dotenv').config();

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const { Pool } = require('pg');
const { getTmdbMovie, getTmdbPoster, getTmdbPersonPhoto } = require('./tmdb');
const { logActivity, getTimeline, deleteUserActivity } = require('./activity');
const { registerDiscovery, findGenres } = require('./discovery');

const app = express();
const port = process.env.PORT || 3500;
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : 'movieweb-local-development-secret');

if (!sessionSecret) throw new Error('SESSION_SECRET es obligatorio en producción.');

const escapeLikePattern = (value) => value.replace(/[\\%_]/g, '\\$&');
const validId = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647;
const SEARCH_TYPES = new Set(['all', 'movie', 'actor', 'director', 'genre', 'keyword']);

// Archivos estáticos (CSS, JS, imágenes). Las plantillas EJS quedan fuera de esta carpeta.
app.use(express.static(path.join(__dirname, 'public')));

// Crear un "pool" de conexiones a PostgreSQL usando las variables de entorno
const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    options: `-c search_path=movies,public`, //modificar options de acuerdo al nombre del esquema
});

// Permite leer los datos enviados por formularios (req.body)
app.use(express.urlencoded({ extended: false }));
// Las sesiones se guardan en PostgreSQL (tabla movies.session) para que sobrevivan a un reinicio.
app.use(session({
    name: 'movieweb.sid',
    secret: sessionSecret,
    store: new PgSession({ pool: db, schemaName: 'movies', tableName: 'session', createTableIfMissing: true }),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000,
    },
}));

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

// Evita que el historial restaure formularios de acceso después de iniciar sesión.
app.use(['/login', '/registro'], (req, res, next) => {
    res.set({
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        Expires: '0',
    });
    next();
});

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
registerDiscovery(app, db, requireAuth);

// Ruta para buscar películas en la base de datos PostgreSQL
// Autocompletado del buscador: sugerencias mientras se escribe (como Google).
// Prioriza lo que empieza con el texto y después lo que tiene una palabra que empieza con él.
const SUGGESTION_LIMITS = { all: { genre: 2, movie: 4, actor: 2, director: 1, keyword: 2 }, single: 8 };

app.get('/buscar/sugerencias', async (req, res) => {
    const searchTerm = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const searchType = typeof req.query.tipo === 'string' && req.query.tipo ? req.query.tipo : 'all';
    if (!SEARCH_TYPES.has(searchType)) return res.status(400).json({ error: 'Tipo de búsqueda inválido.' });
    if (searchTerm.length < 2) return res.json({ suggestions: [] });

    const limitFor = (type) => {
        if (searchType === 'all') return SUGGESTION_LIMITS.all[type];
        return searchType === type ? SUGGESTION_LIMITS.single : 0;
    };
    const escaped = escapeLikePattern(searchTerm);
    // $1: empieza con el texto; $2: alguna palabra empieza con el texto.
    const patterns = [`${escaped}%`, `% ${escaped}%`];
    const run = (type, query) => (limitFor(type) ? db.query(query, [...patterns, limitFor(type)]) : Promise.resolve({ rows: [] }));

    try {
        const [movies, actors, directors, keywords] = await Promise.all([
            run('movie', `
                SELECT movie_id, title, release_date
                FROM movie
                WHERE title ILIKE $1 ESCAPE '\\' OR title ILIKE $2 ESCAPE '\\'
                ORDER BY (title ILIKE $1 ESCAPE '\\') DESC, vote_count DESC NULLS LAST, title
                LIMIT $3`),
            run('actor', `
                SELECT person.person_id, person.person_name, COUNT(*) AS credits
                FROM person
                INNER JOIN movie_cast ON movie_cast.person_id = person.person_id
                WHERE person.person_name ILIKE $1 ESCAPE '\\' OR person.person_name ILIKE $2 ESCAPE '\\'
                GROUP BY person.person_id, person.person_name
                ORDER BY (person.person_name ILIKE $1 ESCAPE '\\') DESC, COUNT(*) DESC, person.person_name
                LIMIT $3`),
            run('director', `
                SELECT person.person_id, person.person_name, COUNT(*) AS credits
                FROM person
                INNER JOIN movie_crew ON movie_crew.person_id = person.person_id AND movie_crew.job = 'Director'
                WHERE person.person_name ILIKE $1 ESCAPE '\\' OR person.person_name ILIKE $2 ESCAPE '\\'
                GROUP BY person.person_id, person.person_name
                ORDER BY (person.person_name ILIKE $1 ESCAPE '\\') DESC, COUNT(*) DESC, person.person_name
                LIMIT $3`),
            run('keyword', `
                SELECT keyword.keyword_name, COUNT(*) AS movies
                FROM keyword
                INNER JOIN movie_keywords ON movie_keywords.keyword_id = keyword.keyword_id
                WHERE keyword.keyword_name ILIKE $1 ESCAPE '\\' OR keyword.keyword_name ILIKE $2 ESCAPE '\\'
                GROUP BY keyword.keyword_name
                ORDER BY (keyword.keyword_name ILIKE $1 ESCAPE '\\') DESC, COUNT(*) DESC, keyword.keyword_name
                LIMIT $3`),
        ]);

        const year = (date) => (date ? new Date(date).getUTCFullYear() : null);
        const plural = (count, one, many) => `${count} ${Number(count) === 1 ? one : many}`;
        const suggestions = [
            ...findGenres(searchTerm).slice(0, limitFor('genre')).map((genre) => ({
                type: 'genre', label: genre.name, detail: 'Género', url: `/explorar?genero=${genre.id}`,
            })),
            ...movies.rows.map((movie) => ({
                type: 'movie', label: movie.title, detail: year(movie.release_date) ? `Película · ${year(movie.release_date)}` : 'Película',
                url: `/pelicula/${movie.movie_id}`,
            })),
            ...actors.rows.map((person) => ({
                type: 'actor', label: person.person_name, detail: `Actor · ${plural(person.credits, 'película', 'películas')}`,
                url: `/actor/${person.person_id}`,
            })),
            ...directors.rows.map((person) => ({
                type: 'director', label: person.person_name, detail: `Director · ${plural(person.credits, 'película', 'películas')}`,
                url: `/director/${person.person_id}`,
            })),
            ...keywords.rows.map((keyword) => ({
                type: 'keyword', label: keyword.keyword_name, detail: `Palabra clave · ${plural(keyword.movies, 'película', 'películas')}`,
                url: `/buscar?tipo=keyword&q=${encodeURIComponent(keyword.keyword_name)}`,
            })),
        ];

        res.set('Cache-Control', 'no-store');
        res.json({ suggestions });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al buscar sugerencias.' });
    }
});

app.get('/buscar', async (req, res) => {
    const searchTerm = String(req.query.q || '').trim();
    const searchType = typeof req.query.tipo === 'string' && req.query.tipo ? req.query.tipo : 'all';
    if (!SEARCH_TYPES.has(searchType)) return res.status(400).send('Tipo de búsqueda inválido.');

    if (!searchTerm) {
        return res.render('resultado', {
            movies: [],
            genreMovies: [],
            matchedGenres: [],
            keywordMovies: [],
            actors: [],
            directors: [],
            emptySearch: true,
            searchType,
        });
    }

    const value = [`%${escapeLikePattern(searchTerm)}%`];
    const searches = (type) => searchType === 'all' || searchType === type;
    const matchedGenres = searches('genre') ? findGenres(searchTerm) : [];

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

    const keywordMovieQuery = `
        SELECT movie.movie_id, movie.title, movie.release_date,
               STRING_AGG(DISTINCT keyword.keyword_name, ', ' ORDER BY keyword.keyword_name) AS keywords
        FROM keyword
        INNER JOIN movie_keywords ON movie_keywords.keyword_id = keyword.keyword_id
        INNER JOIN movie ON movie.movie_id = movie_keywords.movie_id
        WHERE keyword.keyword_name ILIKE $1 ESCAPE '\\'
        GROUP BY movie.movie_id, movie.title, movie.release_date, movie.vote_count, movie.vote_average
        ORDER BY movie.vote_count DESC NULLS LAST, movie.vote_average DESC NULLS LAST, movie.title ASC
        LIMIT 12`;

    const genreMovieQuery = `
        SELECT movie.movie_id, movie.title, movie.release_date,
               ARRAY_AGG(DISTINCT movie_genres.genre_id ORDER BY movie_genres.genre_id) AS genre_ids
        FROM movie_genres
        INNER JOIN movie ON movie.movie_id = movie_genres.movie_id
        WHERE movie_genres.genre_id = ANY($1::int[]) AND movie.vote_count >= 200
        GROUP BY movie.movie_id, movie.title, movie.release_date, movie.vote_average, movie.vote_count
        ORDER BY movie.vote_average DESC NULLS LAST, movie.vote_count DESC NULLS LAST, movie.title ASC
        LIMIT 12`;

    try {
        const [movies, actors, directors, keywordMovies, genreMovies] = await Promise.all([
            searches('movie') ? db.query(movieQuery, value) : Promise.resolve({ rows: [] }),
            searches('actor') ? db.query(actorQuery, value) : Promise.resolve({ rows: [] }),
            searches('director') ? db.query(directorQuery, value) : Promise.resolve({ rows: [] }),
            searches('keyword') ? db.query(keywordMovieQuery, value) : Promise.resolve({ rows: [] }),
            matchedGenres.length
                ? db.query(genreMovieQuery, [matchedGenres.map((genre) => genre.id)])
                : Promise.resolve({ rows: [] }),
        ]);
        const directMovieIds = new Set(movies.rows.map((movie) => movie.movie_id));
        const genreById = new Map(matchedGenres.map((genre) => [genre.id, genre.name]));
        const filteredGenreMovies = genreMovies.rows
            .filter((movie) => !directMovieIds.has(movie.movie_id))
            .map((movie) => ({
                ...movie,
                genreNames: movie.genre_ids.map((genreId) => genreById.get(Number(genreId))).filter(Boolean).join(', '),
            }));
        const shownMovieIds = new Set([...directMovieIds, ...filteredGenreMovies.map((movie) => movie.movie_id)]);

        res.render('resultado', {
            movies: movies.rows,
            genreMovies: filteredGenreMovies,
            matchedGenres,
            keywordMovies: keywordMovies.rows.filter((movie) => !shownMovieIds.has(movie.movie_id)),
            actors: actors.rows,
            directors: directors.rows,
            emptySearch: false,
            searchQuery: searchTerm,
            searchType,
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

// La API key queda en el servidor; el navegador recibe solo una redirección a la imagen pública.
app.get('/persona/:id/foto', async (req, res) => {
    const personId = Number(req.params.id);
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isInteger(personId) || personId > 2147483647) {
        return res.status(400).send('ID de persona inválido.');
    }

    const photoUrl = await (app.locals.loadTmdbPersonPhoto || getTmdbPersonPhoto)(personId);
    if (!photoUrl) return res.status(404).send('Foto no disponible.');

    res.set('Cache-Control', 'public, max-age=86400');
    res.redirect(photoUrl);
});

app.get('/pelicula/:id', async (req, res) => {
    const movieId = Number(req.params.id);
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isInteger(movieId) || movieId > 2147483647) {
        return res.status(400).send('ID de película inválido.');
    }

    try {
        const movieResult = await db.query('SELECT * FROM movie WHERE movie_id = $1', [movieId]);
        if (movieResult.rows.length === 0) {
            const remote = await (app.locals.loadTmdbMovie || getTmdbMovie)(movieId);
            if (remote?.movie) {
                return res.render('pelicula', { movie: remote.movie, tmdb: remote, genres: remote.genres || [],
                    cast: [], crew: [], countries: [], languages: [], companies: [], keywords: [], users: [],
                    ratingsAvailable: (await loadRatingUsers()).available, selectedUser: res.locals.currentUser, interaction: null });
            }
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
            movie: Object.fromEntries(Object.entries({ ...tmdb?.movie, ...movieResult.rows[0] }).map(([key, value]) =>
                [key, value ?? tmdb?.movie?.[key] ?? null])),
            cast: cast.rows,
            crew: crew.rows,
            genres: genres.rows.length ? genres.rows : tmdb?.genres || [],
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

    if (!validId(req.params.id)) {
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

    if (!validId(req.params.id)) {
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

// Las URLs anteriores siguen funcionando, pero convergen en el buscador único.
app.get('/keyword', (req, res) => res.redirect('/buscar?tipo=keyword'));
app.get('/keyword/resultados', (req, res) => {
    const searchTerm = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    res.redirect(searchTerm ? `/buscar?tipo=keyword&q=${encodeURIComponent(searchTerm)}` : '/buscar?tipo=keyword');
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
            // Guarda la sesión antes de redirigir, para que el pedido siguiente ya la encuentre.
            req.session.save((saveErr) => {
                if (saveErr) return res.status(500).send('Error al iniciar la sesión.');
                res.redirect('/perfil');
            });
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
            // Guarda la sesión antes de redirigir, para que el pedido siguiente ya la encuentre.
            req.session.save((saveErr) => {
                if (saveErr) return res.status(500).send('Error al iniciar la sesión.');
                res.redirect('/perfil');
            });
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

const PROFILE_PAGE_SIZE = 20;
const PROFILE_ORDERS = {
    title: 'movie.title ASC, movie.movie_id ASC',
    rating: 'movie_user.rating DESC NULLS LAST, movie.title ASC, movie.movie_id ASC',
    recent: 'movie_user.updated_at DESC, movie.movie_id DESC',
};

const renderUserProfile = async (req, res, user, isOwnProfile) => {
    const userId = user.user_id;
    const order = typeof req.query.orden === 'string' ? req.query.orden : 'title';
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Object.hasOwn(PROFILE_ORDERS, order) || !Number.isInteger(page) || page < 1 || page > 500) {
        return res.status(400).send('Filtros de perfil inválidos.');
    }

    const moviesQuery = `
      SELECT movie.movie_id, movie.title, movie.release_date,
             movie_user.rating, movie_user.opinion, movie_user.is_favorite, movie_user.watch_status,
             movie_user.created_at, movie_user.updated_at
      FROM movie_user
      INNER JOIN movie ON movie.movie_id = movie_user.movie_id
      WHERE movie_user.user_id = $1
      ORDER BY ${PROFILE_ORDERS[order]}
      LIMIT $2 OFFSET $3
    `;

    try {
        const totalResult = await db.query('SELECT count(*)::int AS count FROM movie_user WHERE user_id = $1', [userId]);
        const totalMovies = totalResult.rows[0].count;
        const totalPages = Math.max(1, Math.ceil(totalMovies / PROFILE_PAGE_SIZE));
        if (page > totalPages) {
            const profilePath = isOwnProfile ? '/perfil' : `/usuarios/${userId}`;
            return res.redirect(`${profilePath}?orden=${order}&page=${totalPages}`);
        }
        const moviesResult = await db.query(moviesQuery, [userId, PROFILE_PAGE_SIZE, (page - 1) * PROFILE_PAGE_SIZE]);

        // El timeline viene de MongoDB. Si no está disponible, el perfil se muestra igual.
        let activity = [];
        let activityAvailable = true;
        try {
            activity = await (app.locals.getTimeline || getTimeline)(userId);
        } catch (err) {
            activityAvailable = false;
            console.warn('No se pudo leer la actividad de MongoDB:', err.message);
        }

        res.render('usuario', {
            user,
            movies: moviesResult.rows,
            totalMovies,
            isOwnProfile,
            activity,
            activityAvailable,
            order,
            page,
            totalPages,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar el perfil del usuario.');
    }
};

app.get('/perfil', requireAuth, async (req, res) => {
    await renderUserProfile(req, res, res.locals.currentUser, true);
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
    const userId = res.locals.currentUser.user_id;
    try {
        const result = await db.query('SELECT password_hash FROM users WHERE user_id = $1', [userId]);
        if (!canComparePassword(password) || !result.rows[0]?.password_hash ||
            !(await bcrypt.compare(password, result.rows[0].password_hash))) {
            return res.status(400).render('perfil_editar', { error: 'Ingresá tu contraseña para eliminar la cuenta.', success: null, values: res.locals.currentUser });
        }
        await db.query('DELETE FROM users WHERE user_id = $1', [userId]);
        try {
            await (app.locals.deleteUserActivity || deleteUserActivity)(userId);
        } catch (err) {
            // MongoDB no debe impedir que el usuario elimine su cuenta principal.
            console.warn('No se pudo eliminar la actividad de MongoDB:', err.message);
        }
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
        await renderUserProfile(req, res, isOwnProfile ? res.locals.currentUser : result.rows[0], isOwnProfile);
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

// Compara la interacción anterior con la nueva y registra en MongoDB lo que cambió.
async function recordActivity(userId, movieId, before, after) {
    const events = [];
    if (after.is_favorite && !before.is_favorite) {
        events.push({ type: 'ADDED_TO_FAVORITES', extra: {} });
    }
    if (after.rating !== null && after.rating !== before.rating) {
        events.push({ type: 'RATED_MOVIE', extra: { rating: after.rating } });
    }
    if (after.opinion && after.opinion !== before.opinion) {
        events.push({ type: 'WROTE_REVIEW', extra: { opinion: after.opinion } });
    }
    if (events.length === 0) return;

    const movie = await db.query('SELECT title FROM movie WHERE movie_id = $1', [movieId]).catch(() => null);
    const movieTitle = movie?.rows[0]?.title || null;
    // Cada evento se registra por separado: si uno falla, los demás igual se guardan.
    for (const event of events) {
        try {
            await (app.locals.logActivity || logActivity)(userId, event.type, { movieId, movieTitle, ...event.extra });
        } catch (err) {
            // Si MongoDB no está disponible, la interacción ya quedó guardada en PostgreSQL.
            console.warn('No se pudo registrar la actividad en MongoDB:', err.message);
        }
    }
}

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
        if (!remove && (legacy || favorite || watchStatus || rating !== null || opinion) &&
            !(await db.query('SELECT 1 FROM movie WHERE movie_id = $1', [movieId])).rowCount) {
            const remote = await (app.locals.loadTmdbMovie || getTmdbMovie)(movieId);
            if (!remote?.movie) return res.status(400).send('La película no está disponible.');
            // Persist only when the signed-in user saves it, so the existing FK remains valid.
            await db.query('INSERT INTO movie (movie_id, title, release_date) VALUES ($1, $2, $3) ON CONFLICT (movie_id) DO NOTHING',
                [movieId, remote.movie.title.slice(0, 1000), /^\d{4}-\d{2}-\d{2}$/.test(remote.movie.release_date || '') ? remote.movie.release_date : null]);
        }
        const exists = await db.query(`SELECT EXISTS(SELECT 1 FROM users WHERE user_id = $1) AS valid_user,
            EXISTS(SELECT 1 FROM movie WHERE movie_id = $2) AS valid_movie`, [userId, movieId]);
        if (!exists.rows[0].valid_user || !exists.rows[0].valid_movie) {
            return res.status(400).send('El usuario o la película no existen.');
        }
        const previous = (await db.query(
            'SELECT rating, opinion, is_favorite FROM movie_user WHERE user_id = $1 AND movie_id = $2',
            [userId, movieId]
        )).rows[0] || { rating: null, opinion: null, is_favorite: false };

        if (legacy) {
            await db.query(upsertQuery, [userId, movieId, rating, opinion]);
            await recordActivity(userId, movieId, previous, { rating, opinion, is_favorite: previous.is_favorite });
        } else if (remove || (!favorite && !watchStatus && rating === null && !opinion)) {
            await db.query('DELETE FROM movie_user WHERE user_id = $1 AND movie_id = $2', [userId, movieId]);
        } else {
            await db.query(`INSERT INTO movie_user (user_id, movie_id, rating, opinion, is_favorite, watch_status)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (user_id, movie_id) DO UPDATE SET
                rating = EXCLUDED.rating, opinion = EXCLUDED.opinion,
                is_favorite = EXCLUDED.is_favorite, watch_status = EXCLUDED.watch_status`,
                [userId, movieId, rating, opinion, favorite, watchStatus]);
            await recordActivity(userId, movieId, previous, { rating, opinion, is_favorite: favorite });
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
