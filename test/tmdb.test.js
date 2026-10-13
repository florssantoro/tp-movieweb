const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getTmdbMovie } = require('../tmdb');

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
    assert.equal(calls[0].searchParams.get('append_to_response'), 'videos');
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
