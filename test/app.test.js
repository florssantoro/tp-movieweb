const { after, afterEach, before, test } = require('node:test');
const assert = require('node:assert/strict');

// Los tests no usan el MongoDB real: sin MONGO_URL, activity.js no se conecta.
process.env.MONGO_URL = '';
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

afterEach(() => {
    delete app.locals.loadTmdbMovie;
    delete app.locals.loadTmdbPoster;
    delete app.locals.loadRatingUsers;
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

test('keyword search page links to keyword results', async () => {
    const response = await fetch(`${baseUrl}/keyword`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /action="\/keyword\/resultados"/);
});

test('keyword search lists related movies with matching keywords', async () => {
    const keyword = await db.query(`
        SELECT keyword.keyword_name, movie.movie_id
        FROM keyword
        INNER JOIN movie_keywords ON movie_keywords.keyword_id = keyword.keyword_id
        INNER JOIN movie ON movie.movie_id = movie_keywords.movie_id
        LIMIT 1
    `);
    assert.ok(keyword.rows.length > 0, 'La base debe contener al menos una película con palabra clave.');
    const { keyword_name: keywordName, movie_id: movieId } = keyword.rows[0];

    const response = await fetch(`${baseUrl}/keyword/resultados?q=${encodeURIComponent(keywordName)}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, new RegExp(`href="/pelicula/${movieId}"`));
    assert.match(body, /<strong>Palabras clave:<\/strong>/);
});

test('keyword search handles empty, unmatched and wildcard queries', async () => {
    const empty = await fetch(`${baseUrl}/keyword/resultados?q=%20`);
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), /Ingresá una palabra clave/);

    const unmatched = await fetch(`${baseUrl}/keyword/resultados?q=zzzz-no-existe-zzzz`);
    assert.equal(unmatched.status, 200);
    assert.match(await unmatched.text(), /No se encontraron películas/);

    const wildcard = await fetch(`${baseUrl}/keyword/resultados?q=${encodeURIComponent('%')}`);
    assert.equal(wildcard.status, 200);
    assert.doesNotMatch(await wildcard.text(), /href="\/pelicula\//);
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

test('movie detail renders PostgreSQL metadata and separate credits without duplicates', async () => {
    app.locals.loadTmdbMovie = async () => null;
    const movieId = 238;
    const [movie, genre, country, cast] = await Promise.all([
        db.query('SELECT title, overview FROM movie WHERE movie_id = $1', [movieId]),
        db.query('SELECT genre_name FROM movie_genres JOIN genre USING (genre_id) WHERE movie_id = $1 LIMIT 1', [movieId]),
        db.query('SELECT country_name FROM production_country JOIN country USING (country_id) WHERE movie_id = $1 LIMIT 1', [movieId]),
        db.query('SELECT person_id FROM movie_cast WHERE movie_id = $1 ORDER BY cast_order LIMIT 1', [movieId]),
    ]);
    assert.ok(movie.rows.length && genre.rows.length && country.rows.length && cast.rows.length);

    const response = await fetch(`${baseUrl}/pelicula/${movieId}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.ok(body.includes(movie.rows[0].title));
    assert.ok(body.includes(genre.rows[0].genre_name));
    assert.ok(body.includes(country.rows[0].country_name));
    assert.match(body, /Ficha técnica/);
    assert.match(body, /Presupuesto/);
    assert.match(body, /Palabras clave/);
    assert.match(body, /Equipo técnico/);
    assert.match(body, /Sin póster disponible/);
    assert.equal((body.match(new RegExp(`href="/actor/${cast.rows[0].person_id}"`, 'g')) || []).length, 1);
});

test('movie detail shows TMDB media and keeps PostgreSQL synopsis as an alternative', async () => {
    app.locals.loadTmdbMovie = async () => ({
        overview: 'Sinopsis en español de TMDB',
        posterUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg',
        trailerUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        trailerEmbedUrl: 'https://www.youtube-nocookie.com/embed/abcdefghijk',
        url: 'https://www.themoviedb.org/movie/238',
    });

    const response = await fetch(`${baseUrl}/pelicula/238`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Sinopsis en español de TMDB/);
    assert.match(body, /Leer sinopsis de la base de datos/);
    assert.match(body, /image\.tmdb\.org\/t\/p\/w500\/poster\.jpg/);
    assert.match(body, /youtube-nocookie\.com\/embed\/abcdefghijk/);
    assert.match(body, /Ficha en TMDB/);
    assert.doesNotMatch(body, /Sitio oficial|Sitio web \(TMDB\)|no está avalado ni certificado por TMDB/);
});

test('movie detail handles invalid and missing IDs', async () => {
    app.locals.loadTmdbMovie = async () => null;
    const invalid = await fetch(`${baseUrl}/pelicula/not-a-number`);
    const outOfRange = await fetch(`${baseUrl}/pelicula/2147483648`);
    const missing = await fetch(`${baseUrl}/pelicula/2147483647`);

    assert.equal(invalid.status, 400);
    assert.equal(outOfRange.status, 400);
    assert.equal(missing.status, 404);
});

test('search results load movie posters through the poster route', async () => {
    const response = await fetch(`${baseUrl}/buscar?q=${encodeURIComponent('Star Wars')}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /src="\/poster\/11"/);
});

test('poster route redirects to TMDB and handles missing or invalid posters', async () => {
    app.locals.loadTmdbPoster = async (movieId) => (movieId === 11 ? 'https://image.tmdb.org/t/p/w342/poster.jpg' : null);

    const found = await fetch(`${baseUrl}/poster/11`, { redirect: 'manual' });
    assert.equal(found.status, 302);
    assert.equal(found.headers.get('location'), 'https://image.tmdb.org/t/p/w342/poster.jpg');

    const missing = await fetch(`${baseUrl}/poster/12`, { redirect: 'manual' });
    assert.equal(missing.status, 404);

    const invalid = await fetch(`${baseUrl}/poster/abc`, { redirect: 'manual' });
    assert.equal(invalid.status, 400);
});

test('movie detail remains available when user tables are unavailable', async () => {
    app.locals.loadTmdbMovie = async () => null;
    app.locals.loadRatingUsers = async () => ({ available: false, users: [] });

    const response = await fetch(`${baseUrl}/pelicula/238`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Las interacciones no están disponibles/);
    assert.doesNotMatch(body, /action="\/pelicula\/238\/interaccion"/);
});

test('users can register, log in, edit their own profile and delete their account', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const username = `test-${suffix}`.slice(0, 50);
    const email = `${suffix}@example.com`;
    const password = 'Password-123!';
    let userId;

    try {
        const protectedProfile = await fetch(`${baseUrl}/perfil`, { redirect: 'manual' });
        assert.equal(protectedProfile.status, 302);
        assert.equal(protectedProfile.headers.get('location'), '/login');

        const created = await fetch(`${baseUrl}/registro`, {
            method: 'POST',
            redirect: 'manual',
            body: new URLSearchParams({ user_username: username, user_name: 'Usuario Test', user_email: email, password, password_confirmation: password }),
        });
        assert.equal(created.status, 302);
        assert.equal(created.headers.get('location'), '/perfil');
        const cookie = created.headers.get('set-cookie').split(';')[0];

        const duplicate = await fetch(`${baseUrl}/registro`, {
            method: 'POST',
            body: new URLSearchParams({ user_username: username.toUpperCase(), user_name: 'Duplicado', user_email: `other-${email}`, password, password_confirmation: password }),
        });
        assert.equal(duplicate.status, 400);
        assert.match(await duplicate.text(), /Ya existe un usuario/);

        const saved = await db.query('SELECT user_id FROM users WHERE user_username = $1', [username]);
        assert.equal(saved.rows.length, 1);
        userId = saved.rows[0].user_id;

        const profile = await fetch(`${baseUrl}/perfil`, { headers: { cookie } });
        assert.equal(profile.status, 200);
        assert.match(await profile.text(), /Usuario Test/);

        const edited = await fetch(`${baseUrl}/perfil/editar`, {
            method: 'POST',
            redirect: 'manual',
            headers: { cookie },
            body: new URLSearchParams({ user_username: username, user_name: 'Usuario Editado', user_email: email }),
        });
        assert.equal(edited.status, 200);

        const updated = await db.query('SELECT user_name FROM users WHERE user_id = $1', [userId]);
        assert.equal(updated.rows[0].user_name, 'Usuario Editado');

        const oldUserRoute = await fetch(`${baseUrl}/usuarios/1/editar`, { redirect: 'manual', headers: { cookie } });
        assert.equal(oldUserRoute.status, userId === 1 ? 302 : 403);

        const publicUsers = await fetch(`${baseUrl}/usuarios`);
        const publicBody = await publicUsers.text();
        assert.equal(publicUsers.status, 200);
        assert.ok(publicBody.includes(username));
        assert.doesNotMatch(publicBody, new RegExp(email));
        assert.doesNotMatch(publicBody, /Eliminar|Editar/);
        const publicProfile = await fetch(`${baseUrl}/usuarios/${userId}`);
        const publicProfileBody = await publicProfile.text();
        assert.equal(publicProfile.status, 200);
        assert.doesNotMatch(publicProfileBody, new RegExp(email));
        assert.doesNotMatch(publicProfileBody, /Editar perfil|Editar interacción/);

        const newPassword = 'Password-456!';
        const passwordChanged = await fetch(`${baseUrl}/perfil/password`, {
            method: 'POST', headers: { cookie }, body: new URLSearchParams({ current_password: password, new_password: newPassword, password_confirmation: newPassword }),
        });
        assert.equal(passwordChanged.status, 200);

        const loggedOut = await fetch(`${baseUrl}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie } });
        assert.equal(loggedOut.status, 302);
        const oldLogin = await fetch(`${baseUrl}/login`, {
            method: 'POST', body: new URLSearchParams({ identifier: email, password }),
        });
        assert.equal(oldLogin.status, 401);
        const login = await fetch(`${baseUrl}/login`, {
            method: 'POST', redirect: 'manual', body: new URLSearchParams({ identifier: email, password: newPassword }),
        });
        assert.equal(login.status, 302);
        const loginCookie = login.headers.get('set-cookie').split(';')[0];

        const deleted = await fetch(`${baseUrl}/perfil/eliminar`, {
            method: 'POST', redirect: 'manual', headers: { cookie: loginCookie }, body: new URLSearchParams({ password: newPassword }),
        });
        assert.equal(deleted.status, 302);
        const remaining = await db.query('SELECT 1 FROM users WHERE user_id = $1', [userId]);
        assert.equal(remaining.rows.length, 0);
        userId = undefined;
    } finally {
        if (userId) await db.query('DELETE FROM users WHERE user_id = $1', [userId]);
    }
});

test('registration rejects invalid account data', async () => {
    const response = await fetch(`${baseUrl}/registro`, {
        method: 'POST',
        body: new URLSearchParams({ user_username: 'a b', user_name: 'Nombre', user_email: 'no-es-email', password: 'short', password_confirmation: 'different' }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /username debe tener entre 3 y 50/);

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const truncated = '😀'.repeat(20);
    const longPassword = await fetch(`${baseUrl}/registro`, {
        method: 'POST',
        body: new URLSearchParams({ user_username: `emoji-${suffix}`.slice(0, 50), user_name: 'Emoji', user_email: `${suffix}@example.com`, password: truncated, password_confirmation: truncated }),
    });
    assert.equal(longPassword.status, 400);
    assert.match(await longPassword.text(), /contraseña es demasiado larga/);
});

test('sensitive account actions reject passwords that bcrypt would truncate', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const username = `limit-${suffix}`.slice(0, 50);
    const email = `${suffix}@example.com`;
    const password = 'A'.repeat(72);
    const truncatedVariant = `${password}B`;
    let userId;

    try {
        const created = await fetch(`${baseUrl}/registro`, {
            method: 'POST',
            redirect: 'manual',
            body: new URLSearchParams({
                user_username: username,
                user_name: 'Password Limit',
                user_email: email,
                password,
                password_confirmation: password,
            }),
        });
        assert.equal(created.status, 302);
        const cookie = created.headers.get('set-cookie').split(';')[0];
        userId = (await db.query('SELECT user_id FROM users WHERE user_username = $1', [username])).rows[0].user_id;

        const settings = await (await fetch(`${baseUrl}/perfil/editar`, { headers: { cookie } })).text();
        assert.match(settings, /name="user_username"[^>]*minlength="3"[^>]*maxlength="50"[^>]*pattern=/);
        assert.match(settings, /name="current_password"[^>]*maxlength="72"/);
        assert.match(settings, /id="delete_password"[^>]*maxlength="72"/);

        const changed = await fetch(`${baseUrl}/perfil/password`, {
            method: 'POST',
            headers: { cookie },
            body: new URLSearchParams({
                current_password: truncatedVariant,
                new_password: 'Replacement-Password-2026!',
                password_confirmation: 'Replacement-Password-2026!',
            }),
        });
        assert.equal(changed.status, 400);
        assert.match(await changed.text(), /contraseña actual es incorrecta/);

        const deleted = await fetch(`${baseUrl}/perfil/eliminar`, {
            method: 'POST',
            headers: { cookie },
            body: new URLSearchParams({ password: truncatedVariant }),
        });
        assert.equal(deleted.status, 400);
        assert.equal((await db.query('SELECT count(*)::int AS count FROM users WHERE user_id = $1', [userId])).rows[0].count, 1);
    } finally {
        if (userId) await db.query('DELETE FROM users WHERE user_id = $1', [userId]);
    }
});

test('auth forms expose the same basic limits enforced by the server', async () => {
    const registration = await (await fetch(`${baseUrl}/registro`)).text();
    assert.match(registration, /name="user_username"[^>]*minlength="3"[^>]*maxlength="50"[^>]*pattern=/);
    assert.match(registration, /name="password"[^>]*minlength="8"[^>]*maxlength="72"/);

    const login = await (await fetch(`${baseUrl}/login`)).text();
    assert.match(login, /name="identifier"[^>]*maxlength="255"/);
    assert.match(login, /name="password"[^>]*maxlength="72"/);
});

test('interaction routes require a logged-in user', async () => {
    const response = await fetch(`${baseUrl}/pelicula/238/calificar`, {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({ rating: '4', opinion: '' }),
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
});
