const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
// Los tests no usan el MongoDB real: sin MONGO_URL, activity.js no se conecta.
process.env.MONGO_URL = '';
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
    assert.match(html, /action-favorite" type="submit" aria-pressed="true"/);
    assert.match(html, /action-want" type="submit" aria-pressed="true"/);
    assert.match(html, /aria-label="Quitar de Quiero ver"><span aria-hidden="true">✓<\/span>En Quiero ver/);
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

test('profile movie library supports sorting, dates and pagination', async () => {
    await db.query('DELETE FROM movie_user WHERE user_id = $1', [userId]);
    try {
        await db.query(`
            WITH selected AS (
                SELECT movie_id, row_number() OVER (ORDER BY movie_id) AS position
                FROM movie
                ORDER BY movie_id
                LIMIT 21
            )
            INSERT INTO movie_user (user_id, movie_id, rating, created_at, updated_at)
            SELECT $1, movie_id, (((position - 1) % 5) + 1)::smallint,
                   CURRENT_TIMESTAMP - (position::text || ' days')::interval,
                   CURRENT_TIMESTAMP - (position::text || ' days')::interval
            FROM selected
        `, [userId]);

        const defaultResponse = await fetch(`${baseUrl}/perfil`, { headers: { cookie } });
        const defaultProfile = await defaultResponse.text();
        assert.equal(defaultResponse.status, 200);
        assert.match(defaultProfile, /Películas <span class="count">21<\/span>/);
        assert.equal((defaultProfile.match(/class="row-title"/g) || []).length, 20);
        assert.match(defaultProfile, /Ordenar películas/);
        assert.match(defaultProfile, /<button class="btn btn-ghost btn-sm" type="submit">Aplicar<\/button>/);
        assert.match(defaultProfile, /Guardada\s+<time/);
        assert.match(defaultProfile, /Página 1 de 2/);
        assert.match(defaultProfile, /href="\/perfil\?orden=title&amp;page=2"/);

        const expectedRating = (await db.query(`SELECT movie_id FROM movie_user JOIN movie USING (movie_id)
            WHERE user_id = $1 ORDER BY rating DESC NULLS LAST, title ASC, movie_id ASC LIMIT 1`, [userId])).rows[0].movie_id;
        const ratingProfile = await (await fetch(`${baseUrl}/perfil?orden=rating`, { headers: { cookie } })).text();
        assert.match(ratingProfile, /<option value="rating" selected>Mejor puntuación<\/option>/);
        assert.equal(Number(ratingProfile.match(/class="row-title" href="\/pelicula\/(\d+)"/)[1]), expectedRating);

        const expectedRecent = (await db.query(`SELECT movie_id FROM movie_user WHERE user_id = $1
            ORDER BY updated_at DESC, movie_id DESC LIMIT 1`, [userId])).rows[0].movie_id;
        const recentProfile = await (await fetch(`${baseUrl}/perfil?orden=recent`, { headers: { cookie } })).text();
        assert.equal(Number(recentProfile.match(/class="row-title" href="\/pelicula\/(\d+)"/)[1]), expectedRecent);

        const secondPage = await (await fetch(`${baseUrl}/perfil?orden=title&page=2`, { headers: { cookie } })).text();
        assert.equal((secondPage.match(/class="row-title"/g) || []).length, 1);
        assert.match(secondPage, /Página 2 de 2/);

        for (const query of ['orden=invalid', 'page=0', 'page=1.5']) {
            assert.equal((await fetch(`${baseUrl}/perfil?${query}`, { headers: { cookie } })).status, 400);
        }
        const beyondLastPage = await fetch(`${baseUrl}/perfil?orden=recent&page=500`, { redirect: 'manual', headers: { cookie } });
        assert.equal(beyondLastPage.status, 302);
        assert.equal(beyondLastPage.headers.get('location'), '/perfil?orden=recent&page=2');
    } finally {
        await db.query('DELETE FROM movie_user WHERE user_id = $1', [userId]);
    }
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
    const timestampMigration = fs.readFileSync(path.join(__dirname, '../db/17_movie_user_timestamps.sql'), 'utf8').replaceAll('movies.', `${schema}.`);
    try {
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`CREATE TABLE ${schema}.movie (movie_id INT PRIMARY KEY); INSERT INTO ${schema}.movie VALUES (1)`);
        await client.query(initial);
        await client.query(migration);
        await client.query(timestampMigration);
        await client.query(timestampMigration);
        await client.query(`ALTER TABLE ${schema}.users ADD COLUMN password_hash VARCHAR(255)`);
        await client.query(`
            INSERT INTO ${schema}.users (user_username, user_name, user_email, password_hash) VALUES
                ('legacy', 'Legacy', 'legacy@example.com', NULL),
                ('CaseUser', 'First', 'first@example.com', 'hash-1'),
                ('caseuser', 'Duplicate username', 'second@example.com', 'hash-2'),
                ('EmailOne', 'First email', 'same@example.com', 'hash-3'),
                ('EmailTwo', 'Duplicate email', 'SAME@example.com', 'hash-4');
            INSERT INTO ${schema}.movie_user (user_id, movie_id, rating, opinion, created_at, updated_at)
            VALUES (1, 1, 4, 'Legacy', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z');
            UPDATE ${schema}.movie_user SET rating = 5 WHERE user_id = 1 AND movie_id = 1
        `);
        const timestamped = await client.query(`SELECT created_at, updated_at FROM ${schema}.movie_user WHERE user_id = 1 AND movie_id = 1`);
        assert.ok(timestamped.rows[0].updated_at > timestamped.rows[0].created_at);
        await client.query(`UPDATE ${schema}.movie_user SET rating = 5 WHERE user_id = 1 AND movie_id = 1`);
        const unchanged = await client.query(`SELECT created_at, updated_at FROM ${schema}.movie_user WHERE user_id = 1 AND movie_id = 1`);
        assert.equal(unchanged.rows[0].created_at.getTime(), timestamped.rows[0].created_at.getTime());
        assert.equal(unchanged.rows[0].updated_at.getTime(), timestamped.rows[0].updated_at.getTime());
        await client.query(authMigration);
        await client.query(authMigration);
        const users = await client.query(`SELECT user_username, user_email, password_hash FROM ${schema}.users ORDER BY user_id`);
        assert.deepEqual(users.rows, [
            { user_username: 'CaseUser', user_email: 'first@example.com', password_hash: 'hash-1' },
            { user_username: 'EmailOne', user_email: 'same@example.com', password_hash: 'hash-3' },
        ]);
        assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${schema}.movie_user`)).rows[0].count, 0);
        assert.equal((await client.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'password_hash'`, [schema])).rows[0].is_nullable, 'NO');
        assert.equal((await client.query(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'movie_user' AND column_name IN ('created_at', 'updated_at')`, [schema])).rows[0].count, 2);
        await client.query(migration);
    } finally {
        await client.query('ROLLBACK');
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        client.release();
    }
});

test('favorite, watched and want-to-watch buttons work independently of the review', async () => {
    await db.query('DELETE FROM movie_user WHERE user_id = $1 AND movie_id = 238', [userId]);
    const toggle = (value) => post({ toggle: value }, 'estado');
    const state = (is_favorite, watch_status, rating, opinion) => [{ is_favorite, watch_status, rating, opinion }];

    assert.equal((await toggle('favorite')).status, 302);
    assert.deepEqual(await saved(), state(true, null, null, null), 'favorita sin reseña');

    assert.equal((await post({ rating: '4', opinion: 'Buena' }, 'calificar')).status, 302);
    assert.deepEqual(await saved(), state(true, null, 4, 'Buena'), 'la reseña no toca la favorita');

    await toggle('watched');
    assert.deepEqual(await saved(), state(true, 'watched', 4, 'Buena'), 'marcar vista no toca la reseña');
    const watched = await (await fetch(`${baseUrl}/pelicula/238`, { headers: { cookie } })).text();
    assert.match(watched, /action-watched" type="submit" aria-pressed="true" aria-label="Quitar de vistas"><span aria-hidden="true">✓<\/span>Vista/);
    await toggle('want_to_watch');
    assert.deepEqual(await saved(), state(true, 'want_to_watch', 4, 'Buena'), '"Quiero ver" reemplaza a "Vista"');
    await toggle('want_to_watch');
    const withoutWantToWatch = await (await fetch(`${baseUrl}/pelicula/238`, { headers: { cookie } })).text();
    assert.match(withoutWantToWatch, /action-watched" type="submit" aria-pressed="false" aria-label="Marcar como vista"><span aria-hidden="true">\+<\/span>Marcar como vista/);
    assert.match(withoutWantToWatch, /aria-pressed="false" aria-label="Agregar a Quiero ver"><span aria-hidden="true">\+<\/span>Agregar a Quiero ver/);
    await toggle('favorite');
    assert.deepEqual(await saved(), state(false, null, 4, 'Buena'), 'apagar los botones conserva la reseña');

    await post({ rating: '', opinion: '' }, 'calificar');
    assert.deepEqual(await saved(), [], 'sin reseña ni estados, la relación se borra');

    await toggle('watched');
    await toggle('watched');
    assert.deepEqual(await saved(), [], 'apagar el único estado también la borra');

    assert.equal((await toggle('otra-cosa')).status, 400);
    const anonymous = await fetch(`${baseUrl}/pelicula/238/estado`, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams({ toggle: 'favorite' }),
    });
    assert.equal(anonymous.headers.get('location'), '/login');
});

test('movie page shows other users reviews and the community average', async () => {
    const movieId = (await db.query(`SELECT movie_id FROM movie
        WHERE movie_id NOT IN (SELECT movie_id FROM movie_user) ORDER BY movie_id LIMIT 1`)).rows[0].movie_id;
    const other = (await db.query('SELECT user_username FROM users WHERE user_id = $1', [otherUserId])).rows[0];
    const communityOf = (html) => html.slice(html.indexOf('id="community-heading"'));

    try {
        // Una favorita sin puntuación ni opinión no es una reseña.
        await db.query('INSERT INTO movie_user (user_id, movie_id, is_favorite) VALUES ($1, $2, TRUE)', [otherUserId, movieId]);
        let html = await (await fetch(`${baseUrl}/pelicula/${movieId}`, { headers: { cookie } })).text();
        assert.match(communityOf(html), /Todavía nadie reseñó esta película/);

        await db.query("UPDATE movie_user SET rating = 5, opinion = '<b>Obra</b> maestra' WHERE user_id = $1 AND movie_id = $2", [otherUserId, movieId]);
        assert.equal((await post({ rating: '3', opinion: 'Mi opinión' }, 'calificar', String(movieId))).status, 302);

        html = communityOf(await (await fetch(`${baseUrl}/pelicula/${movieId}`, { headers: { cookie } })).text());
        assert.match(html, /Reseñas de la comunidad <span class="movie-count">2<\/span>/);
        assert.match(html, /<strong>4<\/strong> \/ 5 · 2 puntuaciones/);
        assert.match(html, new RegExp(`href="/usuarios/${otherUserId}"[^>]*>.*${other.user_username}`));
        assert.match(html, /&lt;b&gt;Obra&lt;\/b&gt; maestra/, 'la opinión se muestra escapada');
        assert.match(html, /review-card-mine[\s\S]*Tu reseña[\s\S]*Mi opinión/, 'la propia reseña aparece marcada');
        assert.ok(html.indexOf('Mi opinión') < html.indexOf('Obra'), 'la propia reseña va primero');

        const anonymous = communityOf(await (await fetch(`${baseUrl}/pelicula/${movieId}`)).text());
        assert.match(anonymous, /Obra/);
        assert.match(anonymous, /Mi opinión/, 'sin sesión se ven todas las reseñas');
    } finally {
        await db.query('DELETE FROM movie_user WHERE movie_id = $1 AND user_id = ANY($2::int[])', [movieId, [userId, otherUserId]]);
    }
});
