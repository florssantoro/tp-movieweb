const TMDB_API = 'https://api.themoviedb.org/3';

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

        const posterPath = details.poster_path;
        return {
            overview: details.overview?.trim() || null,
            posterUrl: typeof posterPath === 'string' && /^\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/.test(posterPath)
                ? `https://image.tmdb.org/t/p/w500${posterPath}` : null,
            trailerUrl: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
            trailerEmbedUrl: trailer ? `https://www.youtube-nocookie.com/embed/${trailer.key}` : null,
            url: `https://www.themoviedb.org/movie/${movieId}`,
        };
    } catch {
        return null;
    }
}

module.exports = { getTmdbMovie };
