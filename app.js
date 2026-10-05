// app.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db');
const { connectMongo } = require('./mongo');
const { getMovieDetailsByTitle } = require('./services/tmdbService');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de motor de vistas EJS y middlewares
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// -------------------------------------------------------------
// 1. PÁGINA PRINCIPAL
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.render('index');
});

// -------------------------------------------------------------
// 2.1 BÚSQUEDA GENERAL (Películas, Actores, Directores)
// -------------------------------------------------------------
app.get('/buscar', async (req, res) => {
  const query = req.query.q || '';
  const searchPattern = `%${query}%`;

  try {
    // Buscar Películas
    const moviesQuery = `
      SELECT movie_id, title, release_date
      FROM movie
      WHERE title ILIKE $1
      LIMIT 10
    `;
    const moviesRes = await pool.query(moviesQuery, [searchPattern]);

    // Buscar Actores (en movie_cast)
    const actorsQuery = `
      SELECT DISTINCT p.person_id, p.person_name
      FROM person p
      JOIN movie_cast mc ON p.person_id = mc.person_id
      WHERE p.person_name ILIKE $1
      LIMIT 10
    `;
    const actorsRes = await pool.query(actorsQuery, [searchPattern]);

    // Buscar Directores (en movie_crew con job = 'Director')
    const directorsQuery = `
      SELECT DISTINCT p.person_id, p.person_name
      FROM person p
      JOIN movie_crew mc ON p.person_id = mc.person_id
      WHERE mc.job = 'Director' AND p.person_name ILIKE $1
      LIMIT 10
    `;
    const directorsRes = await pool.query(directorsQuery, [searchPattern]);

    res.render('resultado', {
      query,
      peliculas: moviesRes.rows,
      actores: actorsRes.rows,
      directores: directorsRes.rows
    });
  } catch (err) {
    console.error('Error en búsqueda general:', err);
    res.status(500).send('Error en el servidor al realizar la búsqueda.');
  }
});

// -------------------------------------------------------------
// 2.2 PERFIL DE ACTOR
// -------------------------------------------------------------
app.get('/actor/:id', async (req, res) => {
  const personId = req.params.id;
  try {
    const personRes = await pool.query('SELECT * FROM person WHERE person_id = $1', [personId]);
    if (personRes.rows.length === 0) return res.status(404).send('Persona no encontrada');

    const moviesRes = await pool.query(`
      SELECT m.movie_id, m.title, mc.character_name
      FROM movie m
      JOIN movie_cast mc ON m.movie_id = mc.movie_id
      WHERE mc.person_id = $1
    `, [personId]);

    res.render('actor', { persona: personRes.rows[0], peliculas: moviesRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar perfil de actor.');
  }
});

// -------------------------------------------------------------
// 2.2 PERFIL DE DIRECTOR
// -------------------------------------------------------------
app.get('/director/:id', async (req, res) => {
  const personId = req.params.id;
  try {
    const personRes = await pool.query('SELECT * FROM person WHERE person_id = $1', [personId]);
    if (personRes.rows.length === 0) return res.status(404).send('Persona no encontrada');

    const moviesRes = await pool.query(`
      SELECT m.movie_id, m.title, mc.job
      FROM movie m
      JOIN movie_crew mc ON m.movie_id = mc.movie_id
      WHERE mc.person_id = $1 AND mc.job = 'Director'
    `, [personId]);

    res.render('director', { persona: personRes.rows[0], peliculas: moviesRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar perfil de director.');
  }
});

// -------------------------------------------------------------
// 2.3 DETALLE DE PELÍCULA (PostgreSQL + TMDB)
// -------------------------------------------------------------
app.get('/pelicula/:id', async (req, res) => {
  const movieId = req.params.id;
  try {
    const dbRes = await pool.query('SELECT * FROM movie WHERE movie_id = $1', [movieId]);
    if (dbRes.rows.length === 0) return res.status(404).send('Película no encontrada');

    const movie = dbRes.rows[0];

    // Enriquecer con TMDB usando el título
    const tmdbData = await getMovieDetailsByTitle(movie.title);

    res.render('pelicula', { movie, tmdbData });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar detalle de película.');
  }
});

// Iniciar Servidor
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});