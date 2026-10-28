const { getTmdbMovie, buildPosterUrl } = require('./tmdb');

// A shared, bounded feed: concurrent visitors reuse the same request.
let cachedFeed;
let expiresAt = 0;
let pending;
async function loadTrending({ apiKey = process.env.TMDB_API_KEY, fetchImpl = fetch, detailLoader = getTmdbMovie } = {}) {
    if (!apiKey) return [];
    try {
        const url = new URL('https://api.themoviedb.org/3/trending/movie/week');
        url.searchParams.set('api_key', apiKey);
        url.searchParams.set('language', 'es-AR');
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(3500) });
        if (!response.ok) return [];
        const data = await response.json();
        const movies = (Array.isArray(data.results) ? data.results : []).filter((m) =>
            Number.isInteger(m.id) && m.id > 0 && m.id <= 2147483647 && !m.adult && typeof m.title === 'string').slice(0, 6);
        return await Promise.all(movies.map(async (m) => {
            const details = await detailLoader(m.id, { apiKey, fetchImpl });
            return {
                movie_id: m.id, title: m.title, overview: m.overview || '',
                release_date: m.release_date, vote_average: m.vote_average,
                posterUrl: buildPosterUrl(m.poster_path, 'w342'),
                backdropUrl: buildPosterUrl(m.backdrop_path, 'w1280'),
                trailerEmbedUrl: details?.trailerEmbedUrl, trailerUrl: details?.trailerUrl,
            };
        }));
    } catch { return []; }
}

async function getTrending() {
    if (cachedFeed && Date.now() < expiresAt) return cachedFeed;
    if (pending) return pending;
    pending = loadTrending().then((movies) => {
        if (movies.length) cachedFeed = movies;
        expiresAt = Date.now() + (movies.length ? 30 * 60_000 : 30_000);
        return cachedFeed || [];
    }).finally(() => { pending = null; });
    return pending;
}

const genres = [
    { id: 27, name: 'Terror', description: 'Para mirar con la luz encendida.' },
    { id: 18, name: 'Drama', description: 'Historias que se quedan con vos.' },
    { id: 35, name: 'Comedia', description: 'Una buena excusa para reír.' },
    { id: 28, name: 'Acción', description: 'Sin un minuto de respiro.' },
    { id: 878, name: 'Ciencia ficción', description: 'Más allá de lo imaginable.' },
    { id: 16, name: 'Animación', description: 'Otros mundos, grandes historias.' },
    { id: 12, name: 'Aventura', description: 'Historias para salir de lo conocido.' },
    { id: 80, name: 'Crimen', description: 'Casos, secretos y decisiones al límite.' },
    { id: 99, name: 'Documental', description: 'Historias reales para mirar de cerca.' },
    { id: 10751, name: 'Familia', description: 'Para compartir en cualquier edad.' },
    { id: 14, name: 'Fantasía', description: 'Mundos donde todo puede pasar.' },
    { id: 10769, name: 'Cine extranjero', description: 'Otras miradas, otros lugares.' },
    { id: 36, name: 'Historia', description: 'El pasado vuelve a escena.' },
    { id: 10402, name: 'Música', description: 'Ritmo, escenarios y grandes voces.' },
    { id: 9648, name: 'Misterio', description: 'Nada es exactamente lo que parece.' },
    { id: 10749, name: 'Romance', description: 'Encuentros que cambian una historia.' },
    { id: 10770, name: 'Película de TV', description: 'Historias hechas para la pantalla chica.' },
    { id: 53, name: 'Thriller', description: 'Tensión que no te deja respirar.' },
    { id: 10752, name: 'Bélica', description: 'Conflictos que marcaron generaciones.' },
    { id: 37, name: 'Western', description: 'Fronteras, polvo y ley.' },
];

function selectUniqueGenreFeatures(rows) {
    const candidatesByGenre = new Map();
    for (const row of rows) {
        if (!candidatesByGenre.has(row.genre_id)) candidatesByGenre.set(row.genre_id, []);
        candidatesByGenre.get(row.genre_id).push(row);
    }
    for (const candidates of candidatesByGenre.values()) {
        candidates.sort((a, b) => Number(a.position) - Number(b.position));
    }

    const featureByGenre = new Map();
    const genreByMovie = new Map();
    function assign(genreId, visitedMovies, visitedGenres) {
        if (visitedGenres.has(genreId)) return false;
        visitedGenres.add(genreId);
        for (const candidate of candidatesByGenre.get(genreId) || []) {
            if (visitedMovies.has(candidate.movie_id)) continue;
            visitedMovies.add(candidate.movie_id);
            const currentGenre = genreByMovie.get(candidate.movie_id);
            if (currentGenre === undefined || assign(currentGenre, visitedMovies, visitedGenres)) {
                genreByMovie.set(candidate.movie_id, genreId);
                featureByGenre.set(genreId, candidate);
                return true;
            }
        }
        return false;
    }

    const constrainedFirst = [...candidatesByGenre.entries()].sort(([, a], [, b]) =>
        a.length - b.length || Number(a[0]?.movie_count || 0) - Number(b[0]?.movie_count || 0));
    for (const [genreId] of constrainedFirst) assign(genreId, new Set(), new Set());
    return featureByGenre;
}

function registerDiscovery(app, db, requireAuth) {
    const cards = (rows) => rows.map((m) => ({ ...m, posterUrl: `/poster/${m.movie_id}` }));
    async function suggestions(userId, mood = '') {
        const moodGenre = { terror: 27, comedia: 35, drama: 18 }[mood] || null;
        const result = await db.query(`SELECT m.* FROM movie m
            WHERE m.vote_count >= 200
            AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM movie_genres g WHERE g.movie_id = m.movie_id AND g.genre_id = $2))
            AND ($3::boolean = FALSE OR m.runtime BETWEEN 1 AND 100)
            AND NOT EXISTS (SELECT 1 FROM movie_user u WHERE u.movie_id = m.movie_id AND u.user_id = $1 AND u.watch_status = 'watched')
            ORDER BY (SELECT count(*) FROM movie_genres g WHERE g.movie_id = m.movie_id AND g.genre_id IN
                (SELECT mg.genre_id FROM movie_genres mg JOIN movie_user u ON u.movie_id = mg.movie_id
                 WHERE u.user_id = $1 AND (u.is_favorite OR u.rating >= 4))) DESC,
                m.vote_average DESC NULLS LAST, m.vote_count DESC, m.movie_id
            LIMIT 6`, [userId || null, moodGenre, mood === 'corta']);
        return cards(result.rows);
    }
    app.get('/', async (req, res, next) => {
        try {
            const [trending, top, picks, genreFeatures] = await Promise.all([
                (app.locals.loadTrending || getTrending)(),
                db.query('SELECT * FROM movie WHERE vote_count >= 200 ORDER BY vote_average DESC NULLS LAST, vote_count DESC, movie_id LIMIT 6'),
                suggestions(res.locals.currentUser?.user_id).catch(() => []),
                db.query(`SELECT genre_id, movie_id, title, movie_count, position FROM (
                    SELECT mg.genre_id, m.movie_id, m.title,
                        count(*) OVER (PARTITION BY mg.genre_id) AS movie_count,
                        row_number() OVER (PARTITION BY mg.genre_id
                            ORDER BY m.vote_average DESC NULLS LAST, m.vote_count DESC, m.movie_id) AS position
                    FROM movie_genres mg JOIN movie m ON m.movie_id = mg.movie_id
                    WHERE mg.genre_id = ANY($1::int[]) AND m.vote_count >= 200
                ) ranked WHERE position <= 50`, [genres.map((genre) => genre.id)]).catch(() => ({ rows: [] })),
            ]);
            const featuredByGenre = selectUniqueGenreFeatures(genreFeatures.rows);
            const homeGenres = genres.flatMap((genre) => {
                const featured = featuredByGenre.get(genre.id);
                return featured ? [{ ...genre, movieCount: Number(featured.movie_count),
                    posterUrl: `/poster/${featured.movie_id}` }] : [];
            });
            res.render('index', { trending, top: cards(top.rows), picks, genres: homeGenres });
        } catch (error) { next(error); }
    });
    app.get('/explorar', async (req, res, next) => {
        const page = Number(req.query.page || 1);
        const genre = req.query.genero ? genres.find((g) => String(g.id) === req.query.genero) : null;
        const order = req.query.orden || 'rating';
        if (!Number.isInteger(page) || page < 1 || page > 500 || (req.query.genero && !genre) || !['rating', 'popular'].includes(order)) return res.status(400).send('Filtros inválidos.');
        try {
            const result = await db.query(`SELECT m.* FROM movie m WHERE m.vote_count >= 200
                AND ($1::int IS NULL OR EXISTS (SELECT 1 FROM movie_genres g WHERE g.movie_id = m.movie_id AND g.genre_id = $1))
                ORDER BY ${order === 'popular' ? 'm.popularity' : 'm.vote_average'} DESC NULLS LAST, m.movie_id
                LIMIT 25 OFFSET $2`, [genre?.id || null, (page - 1) * 24]);
            const query = new URLSearchParams({ orden: order });
            if (genre) query.set('genero', genre.id);
            res.render('explorar', { title: genre ? `Películas de ${genre.name.toLowerCase()}` : 'Mejor puntuadas', movies: cards(result.rows.slice(0,24)), genres, genre, order, page, hasNext: result.rows.length > 24, query: query.toString() });
        } catch (error) { next(error); }
    });
    app.get('/que-ver', async (req, res, next) => {
        const mood = req.query.animo || '';
        if (!['', 'terror', 'comedia', 'drama', 'corta'].includes(mood)) return res.status(400).send('Selección inválida.');
        try { res.render('sugerencias', { movies: await suggestions(res.locals.currentUser?.user_id, mood), mood }); }
        catch (error) { next(error); }
    });
    app.get('/mi-lista', requireAuth, async (req, res, next) => {
        const filter = req.query.filtro || 'want_to_watch';
        const conditions = { want_to_watch: "u.watch_status = 'want_to_watch'", watched: "u.watch_status = 'watched'", favorite: 'u.is_favorite', all: 'TRUE' };
        if (!Object.hasOwn(conditions, filter)) return res.status(400).send('Filtro inválido.');
        try {
            const result = await db.query(`SELECT m.*, u.rating, u.is_favorite, u.watch_status FROM movie m
                JOIN movie_user u ON u.movie_id = m.movie_id WHERE u.user_id = $1 AND ${conditions[filter]} ORDER BY m.title, m.movie_id`, [res.locals.currentUser.user_id]);
            res.render('mi_lista', { movies: cards(result.rows), filter });
        } catch (error) { next(error); }
    });
}
module.exports = { registerDiscovery, loadTrending, getTrending, selectUniqueGenreFeatures };
