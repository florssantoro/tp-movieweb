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
        tmdb: null, users: [], ratingsAvailable: true,
    });

    assert.match(body, /Película sin datos/);
    assert.match(body, /No hay sinopsis disponible/);
    assert.match(body, /Sin póster disponible/);
    assert.match(body, /Sin datos de elenco/);
    assert.doesNotMatch(body, /Invalid Date|NaN|Ficha en TMDB|youtube-nocookie/);
});

test('movie template progressively reveals cast and groups crew by department', async () => {
    const cast = Array.from({ length: 13 }, (_, index) => ({
        person_id: index + 1,
        person_name: `Actor ${index + 1}`,
        character_name: `Personaje ${index + 1}`,
    }));
    const body = await ejs.renderFile(path.join(__dirname, '../views/pelicula.ejs'), {
        movie: { title: 'Película', release_date: null, overview: null },
        cast,
        crew: [
            { person_name: 'Directora', job: 'Director', department_name: 'Directing' },
            { person_name: 'Camarógrafa', job: 'Camera Operator', department_name: 'Camera' },
            { person_name: 'Compositor', job: 'Original Music Composer', department_name: 'Sound' },
        ],
        genres: [], countries: [], languages: [], companies: [], keywords: [], tmdb: null,
        users: [], ratingsAvailable: true,
    });

    assert.match(body, /Ver elenco completo \(13\)/);
    assert.ok(body.indexOf('Actor 12') < body.indexOf('movie-disclosure'));
    assert.ok(body.indexOf('Actor 13') > body.indexOf('movie-disclosure'));
    assert.equal((body.match(/href="\/actor\//g) || []).length, 13);
    assert.match(body, /Camera[\s\S]*Camarógrafa/);
    assert.match(body, /Sound[\s\S]*Compositor/);
});

test('movie template explains when ratings tables are unavailable', async () => {
    const body = await ejs.renderFile(path.join(__dirname, '../views/pelicula.ejs'), {
        movie: { movie_id: 1, title: 'Película', release_date: null, overview: null },
        cast: [], crew: [], genres: [], countries: [], languages: [], companies: [], keywords: [],
        tmdb: null, users: [], ratingsAvailable: false,
    });

    assert.match(body, /Las interacciones no están disponibles/);
    assert.doesNotMatch(body, /action="\/pelicula\/1\/interaccion"/);
});
