// Se debe crear archivo .env con las variables de entorno de la base de datos
// DB_USER=postgres
// DB_PASSWORD=<password_de_la_base_de_datos>
// DB_HOST=localhost
// DB_PORT=5432
// DB_DATABASE=movies

require('dotenv').config();

const express = require('express');

const { Pool } = require('pg');
const { getTmdbMovie } = require('./tmdb');

const app = express();
const port = process.env.PORT || 3500;

const escapeLikePattern = (value) => value.replace(/[\\%_]/g, '\\$&');

// Serve static files from the "views" directory
app.use(express.static('views'));

// Crear un "pool" de conexiones a PostgreSQL usando las variables de entorno
const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    options: `-c search_path=movies,public`, //modificar options de acuerdo al nombre del esquema
});

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
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error en la búsqueda.');
    }
});

// Cargar cada relación por separado evita multiplicar las filas de elenco y equipo.
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

// Ruta para listar todos los usuarios (PostgreSQL)
app.get('/usuarios', async (req, res) => {
    const usersQuery = `
      SELECT user_id, user_username, user_name, user_email
      FROM users
      ORDER BY user_username ASC
    `;

    try {
        const result = await db.query(usersQuery);

        res.render('usuarios', {
            users: result.rows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error al cargar los usuarios.');
    }
});


if (require.main === module) {
    app.listen(port, () => {
        console.log(`Servidor en ejecución en http://localhost:${port}`);
    });
}

module.exports = { app, db };
