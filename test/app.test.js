const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

const { app, db } = require('../app');

let baseUrl;
let server;

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    await db.end();
});

test('empty search shows guidance without result sections', async () => {
    const response = await fetch(`${baseUrl}/buscar?q=%20%20`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Ingresá una película, actor o director/);
    assert.doesNotMatch(body, /<h2>Películas<\/h2>/);
});

test('SQL wildcard characters are searched as literal text', async () => {
    for (const query of ['%', '_']) {
        const response = await fetch(`${baseUrl}/buscar?q=${encodeURIComponent(query)}`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.ok(body.length < 20_000, `La búsqueda ${query} devolvió demasiados datos.`);
    }
});

test('actor profile includes films and character roles', async () => {
    const actor = await db.query(`
        SELECT person_id
        FROM movie_cast
        WHERE NULLIF(TRIM(character_name), '') IS NOT NULL
        LIMIT 1
    `);
    assert.ok(actor.rows.length > 0, 'La base debe contener al menos un actor con personaje.');

    const response = await fetch(`${baseUrl}/actor/${actor.rows[0].person_id}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /<strong>Personaje:<\/strong>/);
    assert.match(body, /href="\/pelicula\/\d+"/);
});

test('director profile includes films and role', async () => {
    const director = await db.query(`
        SELECT person_id
        FROM movie_crew
        WHERE job = 'Director'
        LIMIT 1
    `);
    assert.ok(director.rows.length > 0, 'La base debe contener al menos un director.');

    const response = await fetch(`${baseUrl}/director/${director.rows[0].person_id}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /<strong>Rol:<\/strong> Director/);
    assert.match(body, /href="\/pelicula\/\d+"/);
});

test('person profile routes validate IDs and missing records', async () => {
    const invalidActor = await fetch(`${baseUrl}/actor/not-an-id`);
    const missingDirector = await fetch(`${baseUrl}/director/2147483647`);

    assert.equal(invalidActor.status, 400);
    assert.equal(missingDirector.status, 404);
});
