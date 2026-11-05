const TMDB_API = 'https://api.themoviedb.org/3';
const POSTER_CACHE_LIMIT = 1000;
const PERSON_PHOTO_CACHE_LIMIT = 1000;

// Recuerda los pósters ya consultados (y los pedidos en curso) para no repetir llamadas a TMDB.
const posterCache = new Map();
const personPhotoCache = new Map();

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

const validPersonId = (id) => Number.isInteger(id) && id > 0 && id <= 2147483647;
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

// Convierte los datos de TMDB al mismo formato que devuelven las consultas a PostgreSQL,
// así la ficha de una película que no está en la base se arma con la misma plantilla.
function mapTmdbExtras(details) {
    const seenCrew = new Set();
    const originalLanguage = details.original_language;
    const spoken = Array.isArray(details.spoken_languages) ? details.spoken_languages : [];
    return {
        cast: (Array.isArray(details.credits?.cast) ? details.credits.cast : [])
            .filter((person) => validPersonId(person.id) && text(person.name))
            .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))
            .map((person) => ({
                person_id: person.id, person_name: text(person.name),
                character_name: text(person.character), cast_order: person.order ?? null,
            })),
        crew: (Array.isArray(details.credits?.crew) ? details.credits.crew : [])
            .filter((person) => validPersonId(person.id) && text(person.name) && text(person.job))
            .filter((person) => {
                const key = `${person.id}|${person.job}`;
                if (seenCrew.has(key)) return false;
                seenCrew.add(key);
                return true;
            })
            .map((person) => ({
                person_id: person.id, person_name: text(person.name),
                job: text(person.job), department_name: text(person.department),
            })),
        countries: (details.production_countries || []).filter((c) => text(c.name))
            .map((c) => ({ country_name: text(c.name), country_iso_code: c.iso_3166_1 || null })),
        languages: spoken.filter((l) => text(l.name) || text(l.english_name)).map((l) => ({
            language_name: text(l.name) || text(l.english_name), language_code: l.iso_639_1 || null,
            language_role: l.iso_639_1 && l.iso_639_1 === originalLanguage ? 'Original' : 'Spoken',
        })),
        companies: (details.production_companies || []).filter((c) => text(c.name))
            .map((c) => ({ company_name: text(c.name) })),
        keywords: (Array.isArray(details.keywords?.keywords) ? details.keywords.keywords : [])
            .filter((k) => text(k.name)).map((k) => ({ keyword_name: text(k.name) })),
    };
}

async function getTmdbMovie(movieId, { apiKey = process.env.TMDB_API_KEY, fetchImpl = fetch } = {}) {
    if (!apiKey) return null;

    async function request(path, language) {
        const url = new URL(`${TMDB_API}/movie/${movieId}${path}`);
        url.searchParams.set('api_key', apiKey);
        url.searchParams.set('language', language);
        // Una sola consulta trae también el tráiler, los créditos y las palabras clave.
        if (!path) url.searchParams.set('append_to_response', 'videos,credits,keywords');
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
                budget: details.budget ?? null, revenue: details.revenue ?? null, popularity: details.popularity ?? null,
            } : null,
            genres: (details.genres || []).map((g) => ({ genre_name: g.name })),
            ...mapTmdbExtras(details),
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

// Devuelve una foto chica de la persona para resultados de búsqueda, o null si TMDB no tiene una.
async function getTmdbPersonPhoto(personId, { apiKey = process.env.TMDB_API_KEY, fetchImpl = fetch, cache = personPhotoCache } = {}) {
    if (!apiKey) return null;
    if (cache.has(personId)) return cache.get(personId);

    const lookup = (async () => {
        const url = new URL(`${TMDB_API}/person/${personId}`);
        url.searchParams.set('api_key', apiKey);
        url.searchParams.set('language', 'es-AR');
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(3500) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
        const details = await response.json();
        return buildPosterUrl(details.profile_path, 'w185');
    })();

    if (cache.size >= PERSON_PHOTO_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(personId, lookup);

    try {
        return await lookup;
    } catch {
        if (cache.get(personId) === lookup) cache.delete(personId);
        return null;
    }
}

module.exports = { getTmdbMovie, getTmdbPoster, getTmdbPersonPhoto, buildPosterUrl };
