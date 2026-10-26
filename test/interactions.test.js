const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { app, db } = require('../app');

let server, baseUrl, userId, otherUserId, cookie;
before(async () => {
    const suffix = `interactions-${Date.now()}`;
    const result = await db.query('INSERT INTO users (user_username, user_name, user_email, password_hash) VALUES ($1, $1, $2, $3) RETURNING user_id', [suffix, `${suffix}@example.com`, await bcrypt.hash('Password-123!', 4)]);
    userId = result.rows[0].user_id;
    const otherSuffix = `other-${suffix}`;
    const other = await db.query('INSERT INTO users (user_username, user_name, user_email, password_hash) VALUES ($1, $1, $2, $3) RETURNING user_id', [otherSuffix, `${otherSuffix}@example.com`, await bcrypt.hash('Password-456!', 4)]);
    otherUserId = other.rows[0].user_id;
    app.locals.loadTmdbMovie = async () => null;
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ identifier: suffix, password: 'Password-123!' }) });
    cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (userId || otherUserId) await db.query('DELETE FROM users WHERE user_id = ANY($1::int[])', [[userId, otherUserId].filter(Boolean)]);
    await db.end();
});
const post = (values, route = 'interaccion', movie = '238') => fetch(`${baseUrl}/pelicula/${movie}/${route}`, {
    method: 'POST', redirect: 'manual', headers: { cookie }, body: new URLSearchParams(values),
});
const saved = async () => (await db.query('SELECT is_favorite, watch_status, rating, opinion FROM movie_user WHERE user_id = $1 AND movie_id = 238', [userId])).rows;

test('interaction lifecycle preserves independent states and legacy ratings', async () => {
    assert.equal((await post({ is_favorite: 'on', watch_status: 'want_to_watch', rating: '4', opinion: '<script>opinión</script>' })).status, 302);
    assert.deepEqual(await saved(), [{ is_favorite: true, watch_status: 'want_to_watch', rating: 4, opinion: '<script>opinión</script>' }]);
    const detail = await fetch(`${baseUrl}/pelicula/238`, { headers: { cookie } });
    const html = await detail.text();
    assert.equal(detail.status, 200);
    assert.match(html, /name="is_favorite" checked/);
    assert.match(html, /value="want_to_watch" selected/);
    assert.match(html, /value="4" selected/);
    assert.match(html, /&lt;script&gt;opinión&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>opinión/);
    const profile = await (await fetch(`${baseUrl}/perfil`, { headers: { cookie } })).text();
    assert.match(profile, /Favorita/);
    assert.match(profile, /Quiero ver/);
    assert.equal((profile.match(/class="row-title"/g) || []).length, 1);

    assert.equal((await post({ rating: '5', opinion: 'Nueva opinión' }, 'calificar')).status, 302);
    assert.deepEqual(await saved(), [{ is_favorite: true, watch_status: 'want_to_watch', rating: 5, opinion: 'Nueva opinión' }]);
    assert.equal((await post({ watch_status: 'watched' })).status, 302);
    assert.deepEqual(await saved(), [{ is_favorite: false, watch_status: 'watched', rating: null, opinion: null }]);
    assert.equal((await post({ is_favorite: 'on', watch_status: 'watched' })).status, 302);
    assert.equal((await saved())[0].is_favorite, true);
    assert.equal((await post({ rating: '3' })).status, 302);
    assert.deepEqual(await saved(), [{ is_favorite: false, watch_status: null, rating: 3, opinion: null }]);
    assert.equal((await post({ opinion: 'Solo opinión' })).status, 302);
    assert.equal((await saved())[0].opinion, 'Solo opinión');
    assert.equal((await post({ action: 'remove' })).status, 302);
    assert.deepEqual(await saved(), []);
    assert.equal((await post({ is_favorite: 'on' })).status, 302);
    assert.equal((await post({})).status, 302);
    assert.deepEqual(await saved(), []);
    assert.match(await (await fetch(`${baseUrl}/perfil`, { headers: { cookie } })).text(), /todavía no guardó películas ni valoraciones/);
});

test('invalid interactions are rejected without changing saved data', async () => {
    await post({ is_favorite: 'on' });
    const original = await saved();
    for (const values of [
        { watch_status: 'invalid' }, { rating: '6' }, { rating: '1.5' },
        { rating: '1e0' }, { opinion: 'x'.repeat(1001) }, { is_favorite: 'false' },
    ]) assert.equal((await post(values)).status, 400, JSON.stringify(values));
    assert.equal((await post({}, 'interaccion', '2147483647')).status, 400);
    assert.deepEqual(await saved(), original);
    const queryCannotSwitchUser = await fetch(`${baseUrl}/pelicula/238?user_id=2147483647`, { headers: { cookie } });
    assert.equal(queryCannotSwitchUser.status, 200);
    assert.match(await queryCannotSwitchUser.text(), /interactions-/);
    await assert.rejects(db.query('UPDATE movie_user SET watch_status = $1 WHERE user_id = $2', ['invalid', userId]), { code: '23514' });
});

test('a logged-in user cannot edit, delete or overwrite another user data', async () => {
    await db.query(`INSERT INTO movie_user (user_id, movie_id, rating, opinion, is_favorite, watch_status)
        VALUES ($1, 238, 5, 'Otra persona', TRUE, 'watched')
        ON CONFLICT (user_id, movie_id) DO UPDATE SET
        rating = EXCLUDED.rating, opinion = EXCLUDED.opinion,
        is_favorite = EXCLUDED.is_favorite, watch_status = EXCLUDED.watch_status`, [otherUserId]);

    const editOther = await fetch(`${baseUrl}/usuarios/${otherUserId}/editar`, { redirect: 'manual', headers: { cookie } });
    assert.equal(editOther.status, 403);
    const deleteOther = await fetch(`${baseUrl}/usuarios/${otherUserId}/eliminar`, { method: 'POST', redirect: 'manual', headers: { cookie } });
    assert.equal(deleteOther.status, 404);

    const spoofedInteraction = await post({
        user_id: String(otherUserId),
        action: 'save',
        rating: '2',
        opinion: 'Usuario autenticado',
        watch_status: 'want_to_watch',
    });
    assert.equal(spoofedInteraction.status, 302);

    const otherInteraction = await db.query('SELECT rating, opinion, is_favorite, watch_status FROM movie_user WHERE user_id = $1 AND movie_id = 238', [otherUserId]);
    assert.deepEqual(otherInteraction.rows, [{ rating: 5, opinion: 'Otra persona', is_favorite: true, watch_status: 'watched' }]);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM users WHERE user_id = $1', [otherUserId])).rows[0].count, 1);
});

test('migration supports a fresh installation and preserves existing rows when repeated', async () => {
    const client = await db.connect();
    const schema = `interaction_test_${process.pid}`;
    const initial = fs.readFileSync(path.join(__dirname, '../db/13_users.sql'), 'utf8').replaceAll('movies.', `${schema}.`);
    const migration = fs.readFileSync(path.join(__dirname, '../db/14_movie_interactions.sql'), 'utf8').replaceAll('movies.', `${schema}.`);
    const authMigration = fs.readFileSync(path.join(__dirname, '../db/15_user_auth.sql'), 'utf8').replaceAll('movies.', `${schema}.`);
    try {
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`CREATE TABLE ${schema}.movie (movie_id INT PRIMARY KEY); INSERT INTO ${schema}.movie VALUES (1)`);
        await client.query(initial);
        await client.query(migration);
        await client.query(`ALTER TABLE ${schema}.users ADD COLUMN password_hash VARCHAR(255)`);
        await client.query(`
            INSERT INTO ${schema}.users (user_username, user_name, user_email, password_hash) VALUES
                ('legacy', 'Legacy', 'legacy@example.com', NULL),
                ('CaseUser', 'First', 'first@example.com', 'hash-1'),
                ('caseuser', 'Duplicate username', 'second@example.com', 'hash-2'),
                ('EmailOne', 'First email', 'same@example.com', 'hash-3'),
                ('EmailTwo', 'Duplicate email', 'SAME@example.com', 'hash-4');
            INSERT INTO ${schema}.movie_user (user_id, movie_id, rating, opinion) VALUES (1, 1, 4, 'Legacy')
        `);
        await client.query(authMigration);
        await client.query(authMigration);
        const users = await client.query(`SELECT user_username, user_email, password_hash FROM ${schema}.users ORDER BY user_id`);
        assert.deepEqual(users.rows, [
            { user_username: 'CaseUser', user_email: 'first@example.com', password_hash: 'hash-1' },
            { user_username: 'EmailOne', user_email: 'same@example.com', password_hash: 'hash-3' },
        ]);
        assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${schema}.movie_user`)).rows[0].count, 0);
        assert.equal((await client.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'password_hash'`, [schema])).rows[0].is_nullable, 'NO');
        await client.query(migration);
    } finally {
        await client.query('ROLLBACK');
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        client.release();
    }
});
