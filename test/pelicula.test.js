const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

test('movie template handles absent dates, metadata, credits and TMDB data', async () => {
    const body = await ejs.renderFile(path.join(__dirname, '../views/pelicula.ejs'), {
        movie: {
            movie_id: 1,
            title: 'Película sin datos',
            release_date: null,
            overview: null,
            tagline: null,
            runtime: null,
            budget: null,
            revenue: null,
            popularity: null,
            vote_average: null,
            vote_count: null,
            movie_status: null,
        },
        cast: [], crew: [], genres: [], countries: [], languages: [], companies: [], keywords: [],
        tmdb: null,
    });

    assert.match(body, /Película sin datos/);
    assert.match(body, /No hay sinopsis disponible/);
    assert.match(body, /Sin póster disponible/);
    assert.match(body, /Sin datos de elenco/);
    assert.doesNotMatch(body, /Invalid Date|NaN|Ficha en TMDB|youtube-nocookie/);
});
