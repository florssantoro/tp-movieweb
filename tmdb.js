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

// Busca películas por título en TMDB (para incorporar a la base las que no están, por ejemplo las más nuevas).
// Pide los datos en inglés, igual que los títulos de la base de la cátedra.
// Guarda cada búsqueda una hora para no repetir la llamada; si TMDB falla devuelve [] y no se guarda.
const SEARCH_CACHE_LIMIT = 200;
const SEARCH_CACHE_MS = 60 * 60_000;
const searchCache = new Map();

async function searchTmdbMovies(query, { apiKey = process.env.TMDB_API_KEY, fetchImpl = fetch, cache = searchCache } = {}) {
    const term = typeof query === 'string' ? query.trim().slice(0, 100) : '';
    if (!apiKey || term.length < 2) return [];
    const key = term.toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.movies;

    try {
        const url = new URL(`${TMDB_API}/search/movie`);
        url.searchParams.set('api_key', apiKey);
        url.searchParams.set('query', term);
        url.searchParams.set('language', 'en-US');
        url.searchParams.set('include_adult', 'false');
        url.searchParams.set('page', '1');
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(2500) });
        if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
        const data = await response.json();
        const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
        const movies = (Array.isArray(data.results) ? data.results : [])
            .filter((movie) => validPersonId(movie.id) && !movie.adult && text(movie.title))
            .map((movie) => ({
                movie_id: movie.id,
                title: text(movie.title),
                overview: text(movie.overview),
                release_date: /^\d{4}-\d{2}-\d{2}$/.test(movie.release_date || '') ? movie.release_date : null,
                popularity: number(movie.popularity),
                vote_average: number(movie.vote_average),
                vote_count: Number.isInteger(movie.vote_count) ? movie.vote_count : 0,
                genre_ids: (Array.isArray(movie.genre_ids) ? movie.genre_ids : []).filter(validPersonId),
            }));
        if (cache.size >= SEARCH_CACHE_LIMIT) cache.delete(cache.keys().next().value);
        cache.set(key, { movies, expiresAt: Date.now() + SEARCH_CACHE_MS });
        return movies;
    } catch {
        return [];
    }
}

// ---------- Personas (actores, directores y equipo) ----------
// Biografía, datos personales y la carrera completa en cine según TMDB.
const PERSON_CACHE_LIMIT = 300;
const PERSON_CACHE_MS = 6 * 60 * 60_000;
const personCache = new Map();

const DEPARTMENTS = {
    Acting: 'Actuación', Directing: 'Dirección', Writing: 'Guion', Production: 'Producción', Sound: 'Sonido',
    Camera: 'Fotografía', Editing: 'Montaje', Art: 'Arte', Crew: 'Equipo', 'Visual Effects': 'Efectos visuales',
    'Costume & Make-Up': 'Vestuario y maquillaje', Lighting: 'Iluminación', Creator: 'Creación',
};
const JOBS = {
    Director: 'Dirección', Screenplay: 'Guion', Writer: 'Guion', Story: 'Historia', Novel: 'Novela original',
    Characters: 'Personajes', Producer: 'Producción', 'Executive Producer': 'Producción ejecutiva',
    'Co-Producer': 'Coproducción', 'Original Music Composer': 'Música original', Music: 'Música',
    'Director of Photography': 'Dirección de fotografía', Editor: 'Montaje', 'Casting': 'Casting',
    'Thanks': 'Agradecimientos', 'Songs': 'Canciones', 'Theme Song Performance': 'Interpretación del tema principal',
};
const translateDepartment = (name) => DEPARTMENTS[name] || name;
const translateJob = (name) => JOBS[name] || name;

const dateParts = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
};
const formatDate = (date) => date.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
function ageBetween(from, to) {
    let age = to.getUTCFullYear() - from.getUTCFullYear();
    if (to.getUTCMonth() < from.getUTCMonth() || (to.getUTCMonth() === from.getUTCMonth() && to.getUTCDate() < from.getUTCDate())) age -= 1;
    return age;
}

// Ordena de la más nueva a la más vieja; las que no tienen fecha (en desarrollo) van primero.
const byDateDesc = (a, b) => (b.release_date || '9999').localeCompare(a.release_date || '9999') || a.title.localeCompare(b.title);

function mapMovieCredit(credit) {
    const releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(credit.release_date || '') ? credit.release_date : null;
    return { movie_id: credit.id, title: text(credit.title), release_date: releaseDate, year: releaseDate ? Number(releaseDate.slice(0, 4)) : null };
}

function mapTmdbPerson(details, englishBiography, now = new Date()) {
    const credits = details.movie_credits || {};
    const valid = (credit) => validPersonId(credit.id) && text(credit.title) && !credit.adult;

    // Como actor: una fila por película (si hizo varios personajes, se juntan).
    const castByMovie = new Map();
    for (const credit of (Array.isArray(credits.cast) ? credits.cast : []).filter(valid)) {
        const current = castByMovie.get(credit.id) || { ...mapMovieCredit(credit), characters: [] };
        const character = text(credit.character);
        if (character && !current.characters.includes(character)) current.characters.push(character);
        castByMovie.set(credit.id, current);
    }
    const acting = [...castByMovie.values()]
        .map(({ characters, ...credit }) => ({ ...credit, role: characters.join(' / ') || null }))
        .sort(byDateDesc);

    // Detrás de cámara: una fila por película con todos sus trabajos; la dirección va aparte.
    const crewByMovie = new Map();
    for (const credit of (Array.isArray(credits.crew) ? credits.crew : []).filter((credit) => valid(credit) && text(credit.job))) {
        const isDirecting = credit.job === 'Director';
        const key = `${isDirecting ? 'directing' : 'other'}|${credit.id}`;
        const current = crewByMovie.get(key) || { ...mapMovieCredit(credit), isDirecting, jobs: [] };
        const job = translateJob(text(credit.job));
        if (!current.jobs.includes(job)) current.jobs.push(job);
        crewByMovie.set(key, current);
    }
    const crew = [...crewByMovie.values()].map(({ jobs, ...credit }) => ({ ...credit, role: jobs.join(', ') })).sort(byDateDesc);

    const birth = dateParts(details.birthday);
    const death = dateParts(details.deathday);
    const biography = text(details.biography) || text(englishBiography);
    const imdbId = details.external_ids?.imdb_id || details.imdb_id;
    const instagram = details.external_ids?.instagram_id;

    return {
        name: text(details.name),
        biography,
        biographyLanguage: text(details.biography) ? 'es' : (biography ? 'en' : null),
        knownFor: text(details.known_for_department) ? translateDepartment(details.known_for_department) : null,
        gender: details.gender === 1 ? 'female' : details.gender === 2 ? 'male' : null,
        birthday: birth ? formatDate(birth) : null,
        deathday: death ? formatDate(death) : null,
        age: birth ? ageBetween(birth, death || now) : null,
        placeOfBirth: text(details.place_of_birth),
        alsoKnownAs: (Array.isArray(details.also_known_as) ? details.also_known_as : []).map(text).filter(Boolean).slice(0, 4),
        acting,
        directing: crew.filter((credit) => credit.isDirecting).map(({ isDirecting, ...credit }) => credit),
        otherCrew: crew.filter((credit) => !credit.isDirecting).map(({ isDirecting, ...credit }) => credit),
        links: [
            { label: 'TMDB', url: `https://www.themoviedb.org/person/${details.id}` },
            ...(typeof imdbId === 'string' && /^nm\d+$/.test(imdbId) ? [{ label: 'IMDb', url: `https://www.imdb.com/name/${imdbId}/` }] : []),
            ...(typeof instagram === 'string' && /^[A-Za-z0-9._]{1,30}$/.test(instagram) ? [{ label: 'Instagram', url: `https://www.instagram.com/${instagram}/` }] : []),
        ],
    };
}

async function getTmdbPerson(personId, { apiKey = process.env.TMDB_API_KEY, fetchImpl = fetch, cache = personCache, now } = {}) {
    if (!apiKey || !validPersonId(personId)) return null;
    const cached = cache.get(personId);
    if (cached && cached.expiresAt > Date.now()) return cached.person;

    async function request(language, append) {
        const url = new URL(`${TMDB_API}/person/${personId}`);
        url.searchParams.set('api_key', apiKey);
        url.searchParams.set('language', language);
        if (append) url.searchParams.set('append_to_response', 'movie_credits,external_ids');
        // Las personas con muchas películas traen respuestas grandes (TMDB puede tardar varios segundos).
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
        return response.json();
    }

    try {
        const details = await request('es-AR', true);
        if (!details || details.id !== personId) {
            cache.set(personId, { person: null, expiresAt: Date.now() + PERSON_CACHE_MS });
            return null;
        }
        // Si no hay biografía en español, se usa la de inglés (es opcional: si falla, sigue sin biografía).
        let englishBiography = null;
        if (!text(details.biography)) {
            try { englishBiography = (await request('en-US', false))?.biography; } catch { /* sin biografía */ }
        }
        const person = mapTmdbPerson(details, englishBiography, now);
        if (cache.size >= PERSON_CACHE_LIMIT) cache.delete(cache.keys().next().value);
        cache.set(personId, { person, expiresAt: Date.now() + PERSON_CACHE_MS });
        return person;
    } catch {
        return null;
    }
}

module.exports = { getTmdbMovie, getTmdbPoster, getTmdbPersonPhoto, getTmdbPerson, searchTmdbMovies, buildPosterUrl };
