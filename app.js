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
const { getTmdbMovie, getTmdbPoster, getTmdbPersonPhoto, getTmdbPerson, searchTmdbMovies } = require('./tmdb');
const { logActivity, getTimeline, deleteUserActivity } = require('./activity');
const reviewStore = require('./reviews');
const { registerDiscovery, findGenres } = require('./discovery');

const app = express();
const port = process.env.PORT || 3500;
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : 'movieweb-local-development-secret');

if (!sessionSecret) throw new Error('SESSION_SECRET es obligatorio en producción.');

// Búsqueda sin importar tildes ni mayúsculas: "darin" encuentra "Darín" y "DARÍN".
// El texto buscado se convierte en una expresión regular donde cada vocal (y la ñ, la ç y la y) acepta
// todas sus variantes con tilde: "darin" -> "dar[iíìïîÍÌÏÎ]n". Se compara con ~* (regex sin distinguir mayúsculas).
// Es tan rápido como ILIKE y no necesita extensiones de PostgreSQL.
const LETTER_VARIANTS = {
    a: 'aáàäâãåÁÀÄÂÃÅ', e: 'eéèëêÉÈËÊ', i: 'iíìïîÍÌÏÎ', o: 'oóòöôõÓÒÖÔÕ', u: 'uúùüûÚÙÜÛ',
    n: 'nñÑ', c: 'cçÇ', y: 'yýÿÝ',
};
const BASE_LETTER = new Map(Object.entries(LETTER_VARIANTS).flatMap(([base, variants]) =>
    [...variants].map((letter) => [letter, base]).concat([[base.toUpperCase(), base]])));
function accentInsensitivePattern(value) {
    return [...String(value).slice(0, 100)].map((letter) => {
        const base = BASE_LETTER.get(letter) || BASE_LETTER.get(letter.toLowerCase());
        if (base) return `[${LETTER_VARIANTS[base]}]`;
        return /[\\^$.|?*+()[\]{}]/.test(letter) ? `\\${letter}` : letter;
    }).join('');
}
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

// Reseñas de todos los usuarios para una película: el resumen (promedio) y las más recientes.
// Solo cuenta las filas con puntuación u opinión: una favorita sin reseña no es una reseña.
async function loadCommunityReviews(movieId) {
    try {
        const [summary, reviews] = await Promise.all([
            db.query(`SELECT COUNT(*)::int AS total, COUNT(rating)::int AS ratings, ROUND(AVG(rating), 1) AS average
                FROM movie_user WHERE movie_id = $1 AND (rating IS NOT NULL OR opinion IS NOT NULL)`, [movieId]),
            db.query(`SELECT u.user_id, u.user_username, u.user_name, mu.rating, mu.opinion, mu.updated_at
                FROM movie_user mu
                INNER JOIN users u ON u.user_id = mu.user_id
                WHERE mu.movie_id = $1 AND (mu.rating IS NOT NULL OR mu.opinion IS NOT NULL)
                ORDER BY mu.updated_at DESC, u.user_username
                LIMIT 50`, [movieId]),
        ]);
        const { total, ratings, average } = summary.rows[0];
        return { available: true, total, ratings, average: average === null ? null : Number(average), items: reviews.rows };
    } catch (err) {
        // Sin las migraciones de usuarios (tablas o columna updated_at), la ficha se muestra igual.
        if (err.code === '42P01' || err.code === '42703') return { available: false, total: 0, ratings: 0, average: null, items: [] };
        throw err;
    }
}

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
    const pattern = accentInsensitivePattern(searchTerm);
    // $1: empieza con el texto; $2: alguna palabra empieza con el texto.
    const patterns = [`^${pattern}`, ` ${pattern}`];
    const run = (type, query) => (limitFor(type) ? db.query(query, [...patterns, limitFor(type)]) : Promise.resolve({ rows: [] }));

    try {
        const [movies, actors, directors, keywords] = await Promise.all([
            run('movie', `
                SELECT movie_id, title, release_date
                FROM movie
                WHERE title ~* $1 OR title ~* $2
                ORDER BY (title ~* $1) DESC, vote_count DESC NULLS LAST, title
                LIMIT $3`),
            run('actor', `
                SELECT person.person_id, person.person_name, COUNT(*) AS credits
                FROM person
                INNER JOIN movie_cast ON movie_cast.person_id = person.person_id
                WHERE person.person_name ~* $1 OR person.person_name ~* $2
                GROUP BY person.person_id, person.person_name
                ORDER BY (person.person_name ~* $1) DESC, COUNT(*) DESC, person.person_name
                LIMIT $3`),
            run('director', `
                SELECT person.person_id, person.person_name, COUNT(*) AS credits
                FROM person
                INNER JOIN movie_crew ON movie_crew.person_id = person.person_id AND movie_crew.job = 'Director'
                WHERE person.person_name ~* $1 OR person.person_name ~* $2
                GROUP BY person.person_id, person.person_name
                ORDER BY (person.person_name ~* $1) DESC, COUNT(*) DESC, person.person_name
                LIMIT $3`),
            run('keyword', `
                SELECT keyword.keyword_name, COUNT(*) AS movies
                FROM keyword
                INNER JOIN movie_keywords ON movie_keywords.keyword_id = keyword.keyword_id
                WHERE keyword.keyword_name ~* $1 OR keyword.keyword_name ~* $2
                GROUP BY keyword.keyword_name
                ORDER BY (keyword.keyword_name ~* $1) DESC, COUNT(*) DESC, keyword.keyword_name
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
            ...actors.rows.map((person) => {
                // Si también dirige, es una sola sugerencia: las dos cosas están en la misma página.
                const alsoDirects = directors.rows.some((director) => director.person_id === person.person_id);
                return {
                    type: 'actor', label: person.person_name,
                    detail: alsoDirects ? 'Actor y director' : `Actor · ${plural(person.credits, 'película', 'películas')}`,
                    url: `/persona/${person.person_id}`,
                };
            }),
            ...directors.rows.filter((person) => !actors.rows.some((actor) => actor.person_id === person.person_id)).map((person) => ({
                type: 'director', label: person.person_name, detail: `Director · ${plural(person.credits, 'película', 'películas')}`,
                url: `/persona/${person.person_id}`,
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

// Si una película no está en la base (por ejemplo, porque es muy nueva), se busca en TMDB y se incorpora a "movie"
// (con sus géneros en "movie_genres"). Así aparece en los resultados y desde ahí funciona como cualquier otra.
// Solo se incorporan películas con al menos 10 votos en TMDB, para no llenar la base de resultados sin importancia.
// Devuelve los ids que TMDB encontró (para mostrarlos aunque el título en la base no coincida con lo buscado)
// y cuántas películas se agregaron. Si TMDB no responde, la búsqueda sigue solo con la base.
const TMDB_IMPORT_MIN_VOTES = 10;
const TMDB_IMPORT_LIMIT = 5;

async function importMoviesFromTmdb(searchTerm) {
    try {
        const found = (await (app.locals.searchTmdbMovies || searchTmdbMovies)(searchTerm))
            .filter((movie) => movie.vote_count >= TMDB_IMPORT_MIN_VOTES)
            .slice(0, 10);
        if (!found.length) return { ids: [], added: 0 };

        const existing = new Set((await db.query('SELECT movie_id FROM movie WHERE movie_id = ANY($1::int[])',
            [found.map((movie) => movie.movie_id)])).rows.map((row) => row.movie_id));
        let added = 0;
        for (const movie of found.filter((candidate) => !existing.has(candidate.movie_id)).slice(0, TMDB_IMPORT_LIMIT)) {
            // Una sola sentencia: inserta la película y, solo si era nueva, sus géneros (los que existen en "genre").
            const result = await db.query(`
                WITH new_movie AS (
                    INSERT INTO movie (movie_id, title, overview, release_date, popularity, vote_average, vote_count)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (movie_id) DO NOTHING
                    RETURNING movie_id
                ), new_genres AS (
                    INSERT INTO movie_genres (movie_id, genre_id)
                    SELECT new_movie.movie_id, genre.genre_id
                    FROM new_movie JOIN genre ON genre.genre_id = ANY($8::int[])
                )
                SELECT COUNT(*)::int AS inserted FROM new_movie`, [
                movie.movie_id,
                movie.title.slice(0, 1000),
                movie.overview ? movie.overview.slice(0, 1000) : null,
                movie.release_date,
                movie.popularity === null ? null : Math.min(Math.max(movie.popularity, 0), 999999),
                movie.vote_average === null ? null : Math.min(Math.max(Math.round(movie.vote_average * 100) / 100, 0), 99.99),
                movie.vote_count,
                movie.genre_ids,
            ]);
            added += result.rows[0].inserted;
        }
        return { ids: found.map((movie) => movie.movie_id), added };
    } catch (err) {
        console.warn('No se pudieron incorporar películas desde TMDB:', err.message);
        return { ids: [], added: 0 };
    }
}

app.get('/buscar', async (req, res) => {
    const searchTerm = String(req.query.q || '').trim();
    const searchType = typeof req.query.tipo === 'string' && req.query.tipo ? req.query.tipo : 'all';
    if (!SEARCH_TYPES.has(searchType)) return res.status(400).send('Tipo de búsqueda inválido.');

    if (!searchTerm) {
        // Con "Palabras clave" elegido y sin texto, se sugieren las palabras clave con más películas (search_keyword.ejs).
        const popularKeywords = searchType === 'keyword'
            ? (await db.query(`SELECT k.keyword_name, COUNT(*)::int AS movies
                FROM keyword k JOIN movie_keywords mk ON mk.keyword_id = k.keyword_id
                GROUP BY k.keyword_name ORDER BY COUNT(*) DESC, k.keyword_name LIMIT 16`).catch(() => ({ rows: [] }))).rows
            : [];
        return res.render('resultado', {
            movies: [],
            genreMovies: [],
            matchedGenres: [],
            keywordMovies: [],
            actors: [],
            directors: [],
            emptySearch: true,
            searchType,
            popularKeywords,
        });
    }

    const value = [accentInsensitivePattern(searchTerm)];
    const searches = (type) => searchType === 'all' || searchType === type;
    const matchedGenres = searches('genre') ? findGenres(searchTerm) : [];

    const movieQuery = `
        SELECT movie_id, title
        FROM movie
        WHERE title ~* $1 OR movie_id = ANY($2::int[])
        ORDER BY title ASC
        LIMIT 50`;

    const actorQuery = `
        SELECT DISTINCT person.person_id, person.person_name
        FROM person
        INNER JOIN movie_cast ON person.person_id = movie_cast.person_id
        WHERE person.person_name ~* $1
        ORDER BY person.person_name ASC
        LIMIT 50`;

    const directorQuery = `
        SELECT DISTINCT person.person_id, person.person_name
        FROM person
        INNER JOIN movie_crew ON person.person_id = movie_crew.person_id
        WHERE movie_crew.job = 'Director' AND person.person_name ~* $1
        ORDER BY person.person_name ASC
        LIMIT 50`;

    const keywordMovieQuery = `
        SELECT movie.movie_id, movie.title, movie.release_date,
               STRING_AGG(DISTINCT keyword.keyword_name, ', ' ORDER BY keyword.keyword_name) AS keywords
        FROM keyword
        INNER JOIN movie_keywords ON movie_keywords.keyword_id = keyword.keyword_id
        INNER JOIN movie ON movie.movie_id = movie_keywords.movie_id
        WHERE keyword.keyword_name ~* $1
        GROUP BY movie.movie_id, movie.title, movie.release_date, movie.vote_count, movie.vote_average
        ORDER BY movie.vote_count DESC NULLS LAST, movie.vote_average DESC NULLS LAST, movie.title ASC
        LIMIT ${searchType === 'keyword' ? 48 : 12}`;

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
        // Primero se completan desde TMDB las películas que falten, así ya salen en la consulta de abajo.
        const imported = searches('movie') ? await importMoviesFromTmdb(searchTerm) : { ids: [], added: 0 };
        const [movies, actors, directors, keywordMovies, genreMovies] = await Promise.all([
            searches('movie') ? db.query(movieQuery, [...value, imported.ids]) : Promise.resolve({ rows: [] }),
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
            importedCount: imported.added,
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

// Las personas que vienen de TMDB llevan link solo si su página existe en nuestra base:
// /persona/:id necesita créditos en movie_cast o créditos como director.
async function markLinkablePeople(cast, crew) {
    const ids = [...new Set([...cast, ...crew].map((person) => person.person_id))];
    if (ids.length === 0) return { cast, crew };
    const [actors, directors] = await Promise.all([
        db.query('SELECT DISTINCT person_id FROM movie_cast WHERE person_id = ANY($1::int[])', [ids]),
        db.query("SELECT DISTINCT person_id FROM movie_crew WHERE job = 'Director' AND person_id = ANY($1::int[])", [ids]),
    ]);
    const actorIds = new Set(actors.rows.map((row) => row.person_id));
    const directorIds = new Set(directors.rows.map((row) => row.person_id));
    return {
        cast: cast.map((person) => ({ ...person, linkable: actorIds.has(person.person_id) || directorIds.has(person.person_id) })),
        crew: crew.map((person) => ({ ...person, linkable: person.job === 'Director' && (directorIds.has(person.person_id) || actorIds.has(person.person_id)) })),
    };
}

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
                // La película no está en la base: toda la ficha sale de TMDB.
                const people = await markLinkablePeople(remote.cast || [], remote.crew || []);
                return res.render('pelicula', { movie: remote.movie, tmdb: remote, genres: remote.genres || [],
                    cast: people.cast, crew: people.crew, countries: remote.countries || [], languages: remote.languages || [],
                    companies: remote.companies || [], keywords: remote.keywords || [], users: [],
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
        const communityReviews = ratingUsers.available ? await loadCommunityReviews(movieId) : null;
        const selectedUser = ratingUsers.available ? res.locals.currentUser : null;
        // Una película guardada desde TMDB está en la base sin elenco: se completa con TMDB, como los géneros.
        const people = cast.rows.length || crew.rows.length
            ? { cast: cast.rows, crew: crew.rows }
            : await markLinkablePeople(tmdb?.cast || [], tmdb?.crew || []);
        const orTmdb = (result, key) => (result.rows.length ? result.rows : tmdb?.[key] || []);
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
            cast: people.cast,
            crew: people.crew,
            genres: orTmdb(genres, 'genres'),
            countries: orTmdb(countries, 'countries'),
            languages: orTmdb(languages, 'languages'),
            companies: orTmdb(companies, 'companies'),
            keywords: orTmdb(keywords, 'keywords'),
            tmdb,
            users: ratingUsers.users,
            ratingsAvailable: ratingUsers.available,
            communityReviews,
            selectedUser,
            interaction,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar los datos de la película.');
    }
});

// Página única de una persona (PostgreSQL + TMDB): sus películas como actor (con el personaje)
// y como director (con el rol). Antes había una página para cada rol; ahora es una sola.
app.get('/persona/:id', async (req, res) => {
    const personId = Number(req.params.id);
    if (!validId(req.params.id)) return res.status(400).send('ID de persona inválido.');

    const personQuery = 'SELECT person_id, person_name FROM person WHERE person_id = $1';
    const actingQuery = `
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
    const directingQuery = `
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
        // La biografía y la carrera completa vienen de TMDB; si no responde, la página se muestra igual.
        const [personResult, actingResult, directingResult, tmdbPerson] = await Promise.all([
            db.query(personQuery, [personId]),
            db.query(actingQuery, [personId]),
            db.query(directingQuery, [personId]),
            Promise.resolve().then(() => (app.locals.loadTmdbPerson || getTmdbPerson)(personId)).catch(() => null),
        ]);

        if (personResult.rows.length === 0 || (actingResult.rows.length === 0 && directingResult.rows.length === 0)) {
            return res.status(404).send('Persona no encontrada.');
        }

        res.render('persona', {
            person: personResult.rows[0],
            actingCredits: actingResult.rows,
            directingCredits: directingResult.rows,
            tmdbPerson,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar la persona.');
    }
});

// Las direcciones viejas siguen funcionando: llevan a la página única de la persona.
for (const route of ['actor', 'director']) {
    app.get(`/${route}/:id`, (req, res) => {
        if (!validId(req.params.id)) return res.status(400).send(`ID de ${route} inválido.`);
        res.redirect(`/persona/${req.params.id}`);
    });
}

// Las URLs anteriores siguen funcionando, pero convergen en el buscador único.
// La búsqueda por palabra clave está integrada al buscador unificado (/buscar?tipo=keyword).
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
        await (app.locals.reviewStore || reviewStore).renameUser(res.locals.currentUser.user_id, values.user_username)
            .catch((err) => console.warn('No se pudo actualizar el username en las reseñas de MongoDB:', err.message));
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
            await (app.locals.reviewStore || reviewStore).removeUserReviews(userId);
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
// Deja el documento de la reseña en MongoDB igual a la opinión guardada en PostgreSQL.
// Si ya no hay opinión, borra el documento. Devuelve el id de la reseña (o null).
async function syncReview(userId, movieId) {
    const store = app.locals.reviewStore || reviewStore;
    try {
        const row = (await db.query(`SELECT mu.rating, mu.opinion, u.user_username, m.title
            FROM movie_user mu
            JOIN users u ON u.user_id = mu.user_id
            JOIN movie m ON m.movie_id = mu.movie_id
            WHERE mu.user_id = $1 AND mu.movie_id = $2`, [userId, movieId])).rows[0];
        if (!row?.opinion) {
            await store.removeReview(userId, movieId);
            return null;
        }
        return await store.saveReview({ userId, username: row.user_username, movieId, movieTitle: row.title, rating: row.rating, text: row.opinion });
    } catch (err) {
        // Si MongoDB no está disponible, la reseña igual queda guardada en PostgreSQL.
        console.warn('No se pudo sincronizar la reseña con MongoDB:', err.message);
        return null;
    }
}

async function recordActivity(userId, movieId, before, after, { reviewId = null } = {}) {
    const events = [];
    if (after.is_favorite && !before.is_favorite) {
        events.push({ type: 'ADDED_TO_FAVORITES', extra: {} });
    }
    if (after.rating !== null && after.rating !== before.rating) {
        events.push({ type: 'RATED_MOVIE', extra: { rating: after.rating } });
    }
    if (after.opinion && after.opinion !== before.opinion) {
        events.push({ type: 'WROTE_REVIEW', extra: { reviewId, opinion: after.opinion } });
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

// ---------- Reseñas (MongoDB): búsqueda, edición y borrado ----------

const REVIEWS_PER_PAGE = 12;

app.get('/resenas', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const page = Number(req.query.page || 1);
    if (!Number.isInteger(page) || page < 1 || page > 500) return res.status(400).send('Página inválida.');
    try {
        const result = await (app.locals.reviewStore || reviewStore).searchReviews({
            text: query, limit: REVIEWS_PER_PAGE, skip: (page - 1) * REVIEWS_PER_PAGE,
        });
        res.render('resenas', {
            available: Boolean(result), reviews: result?.items || [], total: result?.total || 0,
            query, page, totalPages: Math.max(1, Math.ceil((result?.total || 0) / REVIEWS_PER_PAGE)),
            notice: { editada: 'Tu reseña se actualizó.', borrada: 'Tu reseña se borró.' }[req.query.listo] || null,
        });
    } catch (err) {
        console.warn('No se pudieron buscar las reseñas en MongoDB:', err.message);
        res.render('resenas', { available: false, reviews: [], total: 0, query, page: 1, totalPages: 1, notice: null });
    }
});

// Busca la reseña y comprueba que sea del usuario logueado.
async function ownReview(req, res) {
    const review = await (app.locals.reviewStore || reviewStore).findReview(req.params.id);
    if (!review) {
        res.status(404).send('Reseña no encontrada.');
        return null;
    }
    if (review.userId !== res.locals.currentUser.user_id) {
        res.status(403).send('Solo podés modificar tus propias reseñas.');
        return null;
    }
    return review;
}

app.get('/resenas/:id/editar', requireAuth, async (req, res) => {
    try {
        const review = await ownReview(req, res);
        if (review) res.render('resena_editar', { review, error: null });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar la reseña.');
    }
});

app.post('/resenas/:id/editar', requireAuth, async (req, res) => {
    try {
        const review = await ownReview(req, res);
        if (!review) return;
        const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
        const ratingText = typeof req.body.rating === 'string' ? req.body.rating.trim() : '';
        const rating = ratingText === '' ? null : Number(ratingText);
        const invalid = !text ? 'La reseña no puede quedar vacía.'
            : text.length > 1000 ? 'La reseña admite hasta 1000 caracteres.'
            : rating !== null && !/^[1-5]$/.test(ratingText) ? 'La puntuación debe ser un número del 1 al 5.' : null;
        if (invalid) return res.status(400).render('resena_editar', { review: { ...review, text, rating }, error: invalid });

        const { userId, movieId } = review;
        const previous = (await db.query('SELECT rating, opinion, is_favorite FROM movie_user WHERE user_id = $1 AND movie_id = $2',
            [userId, movieId])).rows[0] || { rating: null, opinion: null, is_favorite: false };
        await db.query(`INSERT INTO movie_user (user_id, movie_id, rating, opinion) VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id, movie_id) DO UPDATE SET rating = EXCLUDED.rating, opinion = EXCLUDED.opinion`,
            [userId, movieId, rating, text]);
        const reviewId = await syncReview(userId, movieId);
        await recordActivity(userId, movieId, previous, { rating, opinion: text, is_favorite: previous.is_favorite }, { reviewId });
        res.redirect('/resenas?listo=editada');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al actualizar la reseña.');
    }
});

app.post('/resenas/:id/eliminar', requireAuth, async (req, res) => {
    try {
        const review = await ownReview(req, res);
        if (!review) return;
        const { userId, movieId } = review;
        // Borrar la reseña quita la puntuación y la opinión; la favorita y el estado se conservan.
        await db.query('UPDATE movie_user SET rating = NULL, opinion = NULL WHERE user_id = $1 AND movie_id = $2', [userId, movieId]);
        await db.query(`DELETE FROM movie_user WHERE user_id = $1 AND movie_id = $2
            AND rating IS NULL AND opinion IS NULL AND NOT is_favorite AND watch_status IS NULL`, [userId, movieId]);
        await syncReview(userId, movieId);
        res.redirect('/resenas?listo=borrada');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al borrar la reseña.');
    }
});

// Una película que solo está en TMDB se guarda en la tabla movie recién cuando un usuario interactúa con ella,
// así la clave foránea de movie_user sigue siendo válida. Devuelve false si TMDB tampoco la tiene.
async function ensureMovieSaved(movieId) {
    if ((await db.query('SELECT 1 FROM movie WHERE movie_id = $1', [movieId])).rowCount) return true;
    const remote = await (app.locals.loadTmdbMovie || getTmdbMovie)(movieId);
    if (!remote?.movie) return false;
    await db.query('INSERT INTO movie (movie_id, title, release_date) VALUES ($1, $2, $3) ON CONFLICT (movie_id) DO NOTHING',
        [movieId, remote.movie.title.slice(0, 1000), /^\d{4}-\d{2}-\d{2}$/.test(remote.movie.release_date || '') ? remote.movie.release_date : null]);
    return true;
}

// Botones rápidos de la ficha: prenden o apagan "Favorita", "Vista" o "Quiero ver" sin tocar la puntuación ni la opinión.
app.post('/pelicula/:id/estado', requireAuth, async (req, res) => {
    const movieId = Number(req.params.id);
    const userId = res.locals.currentUser.user_id;
    if (!validId(req.params.id)) return res.status(400).send('Película inválida.');
    if (!['favorite', 'watched', 'want_to_watch'].includes(req.body.toggle)) return res.status(400).send('Estado inválido.');

    try {
        if (!(await ensureMovieSaved(movieId))) return res.status(400).send('La película no está disponible.');
        const previous = (await db.query(
            'SELECT rating, opinion, is_favorite, watch_status FROM movie_user WHERE user_id = $1 AND movie_id = $2',
            [userId, movieId]
        )).rows[0] || { rating: null, opinion: null, is_favorite: false, watch_status: null };

        const next = { ...previous };
        if (req.body.toggle === 'favorite') next.is_favorite = !previous.is_favorite;
        // "Vista" y "Quiero ver" se reemplazan entre sí: una película no puede estar en los dos estados.
        else next.watch_status = previous.watch_status === req.body.toggle ? null : req.body.toggle;

        if (!next.is_favorite && !next.watch_status && next.rating === null && !next.opinion) {
            await db.query('DELETE FROM movie_user WHERE user_id = $1 AND movie_id = $2', [userId, movieId]);
        } else {
            await db.query(`INSERT INTO movie_user (user_id, movie_id, is_favorite, watch_status)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id, movie_id) DO UPDATE SET
                is_favorite = EXCLUDED.is_favorite, watch_status = EXCLUDED.watch_status`,
                [userId, movieId, next.is_favorite, next.watch_status]);
        }
        await recordActivity(userId, movieId, previous, next);
        res.redirect(`/pelicula/${movieId}`);
    } catch (err) {
        if (err.code === '42P01' || err.code === '42703') {
            return res.status(503).send('Las interacciones no están disponibles temporalmente.');
        }
        console.error(err);
        res.status(500).send('Error al guardar el estado de la película.');
    }
});

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
            !(await ensureMovieSaved(movieId))) {
            return res.status(400).send('La película no está disponible.');
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
            // Si la reseña quedó vacía y no hay favorita ni estado, la relación ya no guarda nada.
            await db.query(`DELETE FROM movie_user WHERE user_id = $1 AND movie_id = $2
                AND rating IS NULL AND opinion IS NULL AND NOT is_favorite AND watch_status IS NULL`, [userId, movieId]);
            const reviewId = await syncReview(userId, movieId);
            await recordActivity(userId, movieId, previous, { rating, opinion, is_favorite: previous.is_favorite }, { reviewId });
        } else if (remove || (!favorite && !watchStatus && rating === null && !opinion)) {
            await db.query('DELETE FROM movie_user WHERE user_id = $1 AND movie_id = $2', [userId, movieId]);
            await syncReview(userId, movieId);
        } else {
            await db.query(`INSERT INTO movie_user (user_id, movie_id, rating, opinion, is_favorite, watch_status)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (user_id, movie_id) DO UPDATE SET
                rating = EXCLUDED.rating, opinion = EXCLUDED.opinion,
                is_favorite = EXCLUDED.is_favorite, watch_status = EXCLUDED.watch_status`,
                [userId, movieId, rating, opinion, favorite, watchStatus]);
            const reviewId = await syncReview(userId, movieId);
            await recordActivity(userId, movieId, previous, { rating, opinion, is_favorite: favorite }, { reviewId });
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
