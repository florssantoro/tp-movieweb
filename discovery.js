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
];

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
            const [trending, top, picks] = await Promise.all([
                (app.locals.loadTrending || getTrending)(),
                db.query('SELECT * FROM movie WHERE vote_count >= 200 ORDER BY vote_average DESC NULLS LAST, vote_count DESC, movie_id LIMIT 6'),
                suggestions(res.locals.currentUser?.user_id).catch(() => []),
            ]);
            res.render('index', { trending, top: cards(top.rows), picks, genres });
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
module.exports = { registerDiscovery, loadTrending, getTrending };
