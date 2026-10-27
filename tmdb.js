const TMDB_API = 'https://api.themoviedb.org/3';
const POSTER_CACHE_LIMIT = 1000;

// Recuerda los pósters ya consultados (y los pedidos en curso) para no repetir llamadas a TMDB.
const posterCache = new Map();

function buildPosterUrl(posterPath, size) {
    return typeof posterPath === 'string' && /^\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/.test(posterPath)
        ? `https://image.tmdb.org/t/p/${size}${posterPath}` : null;
}

function selectTrailer(videos) {
    const candidates = (videos || []).filter((video) =>
        video.site === 'YouTube' && video.type === 'Trailer' &&
        /^[a-zA-Z0-9_-]{11}$/.test(video.key || '')
    );
    candidates.sort((a, b) => Number(Boolean(b.official)) - Number(Boolean(a.official)));
    return candidates[0] || null;
}

async function getTmdbMovie(movieId, { apiKey = process.env.TMDB_API_KEY, fetchImpl = fetch } = {}) {
    if (!apiKey) return null;

    async function request(path, language) {
        const url = new URL(`${TMDB_API}/movie/${movieId}${path}`);
        url.searchParams.set('api_key', apiKey);
        url.searchParams.set('language', language);
        if (!path) url.searchParams.set('append_to_response', 'videos');
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(3500) });
        if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
        return response.json();
    }

    try {
        const details = await request('', 'es-AR');
        let trailer = selectTrailer(details.videos?.results);
        if (!trailer) {
            try {
                const englishVideos = await request('/videos', 'en-US');
                trailer = selectTrailer(englishVideos.results);
            } catch {
                // Keep the movie details when the optional trailer lookup fails.
            }
        }

        return {
            movie: details.id === movieId && typeof details.title === 'string' ? {
                movie_id: movieId, title: details.title, release_date: details.release_date || null,
                runtime: details.runtime, tagline: details.tagline, movie_status: details.status,
                vote_average: details.vote_average, vote_count: details.vote_count,
            } : null,
            genres: (details.genres || []).map((g) => ({ genre_name: g.name })),
            overview: details.overview?.trim() || null,
            posterUrl: buildPosterUrl(details.poster_path, 'w500'),
            trailerUrl: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
            trailerEmbedUrl: trailer ? `https://www.youtube-nocookie.com/embed/${trailer.key}` : null,
            url: `https://www.themoviedb.org/movie/${movieId}`,
        };
    } catch {
        return null;
    }
}

// Devuelve solo la URL del póster (tamaño chico, para las tarjetas), o null si no hay.
async function getTmdbPoster(movieId, { apiKey = process.env.TMDB_API_KEY, fetchImpl = fetch, cache = posterCache } = {}) {
    if (!apiKey) return null;
    if (cache.has(movieId)) return cache.get(movieId);

    const lookup = (async () => {
        const url = new URL(`${TMDB_API}/movie/${movieId}`);
        url.searchParams.set('api_key', apiKey);
        url.searchParams.set('language', 'es-AR');
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(3500) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
        const details = await response.json();
        return buildPosterUrl(details.poster_path, 'w342');
    })();

    if (cache.size >= POSTER_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(movieId, lookup);

    try {
        return await lookup;
    } catch {
        // Un error temporal no se recuerda: el próximo pedido vuelve a intentar.
        if (cache.get(movieId) === lookup) cache.delete(movieId);
        return null;
    }
}

module.exports = { getTmdbMovie, getTmdbPoster, buildPosterUrl };
