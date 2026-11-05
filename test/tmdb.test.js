const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getTmdbMovie, getTmdbPoster, getTmdbPersonPhoto } = require('../tmdb');

test('TMDB details use Spanish trailer when available', async () => {
    const calls = [];
    const result = await getTmdbMovie(238, {
        apiKey: 'test-key',
        fetchImpl: async (url) => {
            calls.push(url);
            return {
                ok: true,
                json: async () => ({
                    overview: 'Sinopsis en español',
                    poster_path: '/poster.jpg',
                    videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'abcdefghijk', official: true }] },
                }),
            };
        },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get('language'), 'es-AR');
    assert.equal(calls[0].searchParams.get('append_to_response'), 'videos,credits,keywords');
    assert.equal(result.posterUrl, 'https://image.tmdb.org/t/p/w500/poster.jpg');
    assert.equal(result.trailerUrl, 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(result.overview, 'Sinopsis en español');
});

test('TMDB falls back to English trailer without losing Spanish details', async () => {
    const calls = [];
    const result = await getTmdbMovie(238, {
        apiKey: 'test-key',
        fetchImpl: async (url) => {
            calls.push(url);
            return {
                ok: true,
                json: async () => url.pathname.endsWith('/videos')
                    ? { results: [{ site: 'YouTube', type: 'Trailer', key: 'zyxwvutsrqp' }] }
                    : { overview: 'Sinopsis en español', poster_path: null, videos: { results: [] } },
            };
        },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].searchParams.get('language'), 'en-US');
    assert.equal(result.overview, 'Sinopsis en español');
    assert.equal(result.trailerEmbedUrl, 'https://www.youtube-nocookie.com/embed/zyxwvutsrqp');
});

test('TMDB failures and missing data leave the PostgreSQL page usable', async () => {
    assert.equal(await getTmdbMovie(238, { apiKey: '' }), null);
    assert.equal(await getTmdbMovie(238, {
        apiKey: 'test-key',
        fetchImpl: async () => ({ ok: false, status: 404 }),
    }), null);
});

test('TMDB poster lookup returns a small poster URL and caches it', async () => {
    const calls = [];
    const cache = new Map();
    const options = {
        apiKey: 'test-key',
        cache,
        fetchImpl: async (url) => {
            calls.push(url);
            return { ok: true, status: 200, json: async () => ({ poster_path: '/poster.jpg' }) };
        },
    };

    const first = await getTmdbPoster(11, options);
    const second = await getTmdbPoster(11, options);

    assert.equal(first, 'https://image.tmdb.org/t/p/w342/poster.jpg');
    assert.equal(second, first);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get('language'), 'es-AR');
});

test('TMDB poster lookup remembers missing posters but retries after errors', async () => {
    const cache = new Map();
    let calls = 0;
    const missing = { apiKey: 'test-key', cache, fetchImpl: async () => { calls += 1; return { ok: false, status: 404 }; } };
    assert.equal(await getTmdbPoster(1, missing), null);
    assert.equal(await getTmdbPoster(1, missing), null);
    assert.equal(calls, 1);

    calls = 0;
    const failing = { apiKey: 'test-key', cache, fetchImpl: async () => { calls += 1; throw new Error('network'); } };
    assert.equal(await getTmdbPoster(2, failing), null);
    assert.equal(await getTmdbPoster(2, failing), null);
    assert.equal(calls, 2);

    assert.equal(await getTmdbPoster(3, { apiKey: '', cache }), null);
});

test('TMDB person photo lookup returns a small profile image and caches it', async () => {
    const calls = [];
    const cache = new Map();
    const options = {
        apiKey: 'test-key',
        cache,
        fetchImpl: async (url) => {
            calls.push(url);
            return { ok: true, status: 200, json: async () => ({ profile_path: '/profile.jpg' }) };
        },
    };

    const first = await getTmdbPersonPhoto(192, options);
    const second = await getTmdbPersonPhoto(192, options);

    assert.equal(first, 'https://image.tmdb.org/t/p/w185/profile.jpg');
    assert.equal(second, first);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/3/person/192');
});

test('TMDB details include cast, crew and the technical sheet in the PostgreSQL format', async () => {
    const result = await getTmdbMovie(55, {
        apiKey: 'test-key',
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({
                id: 55, title: 'Película remota', original_language: 'es', budget: 1000, revenue: 5000, popularity: 12.5,
                videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'abcdefghijk' }] },
                credits: {
                    cast: [
                        { id: 2, name: 'Segunda', character: 'Rol B', order: 1 },
                        { id: 1, name: 'Primera', character: 'Rol A', order: 0 },
                        { id: -5, name: 'Inválida', character: 'X', order: 2 },
                    ],
                    crew: [
                        { id: 9, name: 'Directora', job: 'Director', department: 'Directing' },
                        { id: 9, name: 'Directora', job: 'Director', department: 'Directing' },
                        { id: 8, name: 'Guionista', job: 'Screenplay', department: 'Writing' },
                    ],
                },
                keywords: { keywords: [{ id: 1, name: 'heist' }] },
                production_countries: [{ iso_3166_1: 'AR', name: 'Argentina' }],
                spoken_languages: [{ iso_639_1: 'es', name: 'Español', english_name: 'Spanish' }, { iso_639_1: 'en', name: 'English' }],
                production_companies: [{ id: 3, name: 'Productora' }],
            }),
        }),
    });

    assert.deepEqual(result.cast.map((person) => person.person_name), ['Primera', 'Segunda']);
    assert.deepEqual(result.cast[0], { person_id: 1, person_name: 'Primera', character_name: 'Rol A', cast_order: 0 });
    assert.deepEqual(result.crew, [
        { person_id: 9, person_name: 'Directora', job: 'Director', department_name: 'Directing' },
        { person_id: 8, person_name: 'Guionista', job: 'Screenplay', department_name: 'Writing' },
    ]);
    assert.deepEqual(result.keywords, [{ keyword_name: 'heist' }]);
    assert.deepEqual(result.countries, [{ country_name: 'Argentina', country_iso_code: 'AR' }]);
    assert.deepEqual(result.languages.map((l) => `${l.language_name} (${l.language_role})`), ['Español (Original)', 'English (Spoken)']);
    assert.deepEqual(result.companies, [{ company_name: 'Productora' }]);
    assert.equal(result.movie.budget, 1000);
});
