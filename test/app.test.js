const { after, afterEach, before, test } = require('node:test');
const assert = require('node:assert/strict');

// Los tests no usan el MongoDB real: sin MONGO_URL, activity.js no se conecta.
process.env.MONGO_URL = '';
const { app, db } = require('../app');

let baseUrl;
let server;
const initialsForTest = (name) => String(name).trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();

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
    delete app.locals.loadTmdbPersonPhoto;
    delete app.locals.loadRatingUsers;
    delete app.locals.deleteUserActivity;
});

test('static assets are served but EJS templates are not', async () => {
    for (const asset of ['/styles.css', '/discovery.css', '/discovery-ui.js', '/tmdb-logo.svg']) {
        assert.equal((await fetch(`${baseUrl}${asset}`)).status, 200, asset);
    }
    for (const template of ['/pelicula.ejs', '/partials/header.ejs']) {
        assert.equal((await fetch(`${baseUrl}${template}`)).status, 404, template);
    }
});

test('person pages reject IDs outside the integer range', async () => {
    for (const route of ['actor', 'director']) {
        for (const id of ['99999999999', '1e3', '0', 'abc']) {
            assert.equal((await fetch(`${baseUrl}/${route}/${id}`)).status, 400, `${route}/${id}`);
        }
    }
});

test('empty search shows guidance without result sections', async () => {
    const response = await fetch(`${baseUrl}/buscar?q=%20%20`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Ingresá una película, persona o tema/);
    assert.doesNotMatch(body, /id="movies-heading"/);
});

test('SQL wildcard characters are searched as literal text', async () => {
    for (const query of ['%', '_']) {
        const response = await fetch(`${baseUrl}/buscar?q=${encodeURIComponent(query)}`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.ok(body.length < 20_000, `La búsqueda ${query} devolvió demasiados datos.`);
    }
});

test('unified search lists movies related by keyword without duplicating direct title matches', async () => {
    const keyword = await db.query(`
        SELECT keyword.keyword_name, movie.movie_id
        FROM keyword
        INNER JOIN movie_keywords ON movie_keywords.keyword_id = keyword.keyword_id
        INNER JOIN movie ON movie.movie_id = movie_keywords.movie_id
        WHERE movie.title NOT ILIKE '%' || keyword.keyword_name || '%'
        ORDER BY movie.vote_count DESC NULLS LAST, movie.vote_average DESC NULLS LAST
        LIMIT 1
    `);
    assert.ok(keyword.rows.length > 0, 'La base debe contener al menos una película con palabra clave.');
    const { keyword_name: keywordName, movie_id: movieId } = keyword.rows[0];

    const response = await fetch(`${baseUrl}/buscar?q=${encodeURIComponent(keywordName)}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Películas relacionadas/);
    assert.match(body, /class="tile tile-related"/);
    assert.match(body, /aria-label="Tema relacionado:/);
    assert.match(body, new RegExp(`src="/poster/${movieId}"`));
    assert.equal((body.match(new RegExp(`href="/pelicula/${movieId}"`, 'g')) || []).length, 1);

    const filtered = await fetch(`${baseUrl}/buscar?tipo=keyword&q=${encodeURIComponent(keywordName)}`);
    const filteredBody = await filtered.text();
    assert.equal(filtered.status, 200);
    assert.match(filteredBody, /id="keyword-movies-heading"/);
    assert.doesNotMatch(filteredBody, /id="movies-heading"|id="actors-heading"|id="directors-heading"/);
});

test('unified search recognizes genres and close Spanish terms', async () => {
    for (const query of ['drama', 'dramático']) {
        const response = await fetch(`${baseUrl}/buscar?q=${encodeURIComponent(query)}`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /Películas de Drama/);
        assert.match(body, /class="tile tile-related"/);
        assert.match(body, /aria-label="Género: Drama"/);
        assert.match(body, /href="\/explorar\?genero=18"/);
    }
});

test('search category selector limits results to the selected source', async () => {
    const actor = await fetch(`${baseUrl}/buscar?tipo=actor&q=${encodeURIComponent('Morgan Freeman')}`);
    const actorBody = await actor.text();
    assert.equal(actor.status, 200);
    assert.match(actorBody, /id="actors-heading"/);
    assert.match(actorBody, /<option value="actor" selected>Actores<\/option>/);
    assert.doesNotMatch(actorBody, /id="directors-heading"|id="movies-heading"/);

    const genre = await fetch(`${baseUrl}/buscar?tipo=genre&q=drama`);
    const genreBody = await genre.text();
    assert.equal(genre.status, 200);
    assert.match(genreBody, /Películas de Drama/);
    assert.doesNotMatch(genreBody, /id="keyword-movies-heading"/);

    assert.equal((await fetch(`${baseUrl}/buscar?tipo=desconocido&q=drama`)).status, 400);
});

test('legacy keyword routes redirect to the unified search', async () => {
    const form = await fetch(`${baseUrl}/keyword`, { redirect: 'manual' });
    assert.equal(form.status, 302);
    assert.equal(form.headers.get('location'), '/buscar?tipo=keyword');

    const results = await fetch(`${baseUrl}/keyword/resultados?q=${encodeURIComponent('space travel')}`, { redirect: 'manual' });
    assert.equal(results.status, 302);
    assert.equal(results.headers.get('location'), '/buscar?tipo=keyword&q=space%20travel');
});

test('unified keyword search uses the search_keyword and resultados_keyword views', async () => {
    const start = await (await fetch(`${baseUrl}/buscar?tipo=keyword`)).text();
    assert.match(start, /id="keyword-start-heading">Buscá películas por tema/);
    assert.match(start, /href="\/buscar\?tipo=keyword&amp;q=/, 'sugiere palabras clave populares');

    const keyword = (await db.query(`SELECT k.keyword_name, COUNT(*)::int AS movies FROM keyword k
        JOIN movie_keywords mk ON mk.keyword_id = k.keyword_id GROUP BY k.keyword_name ORDER BY COUNT(*) DESC LIMIT 1`)).rows[0];
    const results = await (await fetch(`${baseUrl}/buscar?tipo=keyword&q=${encodeURIComponent(keyword.keyword_name)}`)).text();
    assert.match(results, /id="keyword-movies-heading"/);
    const shown = (results.match(/class="tile tile-related"/g) || []).length;
    assert.ok(shown > 12 || shown === keyword.movies, 'buscando solo por palabra clave se muestran más de 12 películas');
});

test('unified search handles unmatched and wildcard queries', async () => {
    const unmatched = await fetch(`${baseUrl}/buscar?q=zzzz-no-existe-zzzz`);
    assert.equal(unmatched.status, 200);
    assert.match(await unmatched.text(), /No encontramos coincidencias/);

    const wildcard = await fetch(`${baseUrl}/buscar?q=${encodeURIComponent('%')}`);
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
    assert.match(body, new RegExp(`src="/persona/${actor.rows[0].person_id}/foto"`));
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
    assert.match(body, new RegExp(`src="/persona/${director.rows[0].person_id}/foto"`));
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
    assert.match(body, /name="q" value="Star Wars"/);
    assert.match(body, /Resultados para &#34;Star Wars&#34;/);
    assert.match(body, /src="\/poster\/11"/);
});

test('person search results request TMDB photos while keeping initials as fallback', async () => {
    const person = await db.query(`
        SELECT person.person_id, person.person_name
        FROM person
        INNER JOIN movie_cast ON movie_cast.person_id = person.person_id
        ORDER BY person.person_id
        LIMIT 1
    `);
    const { person_id: personId, person_name: personName } = person.rows[0];
    const response = await fetch(`${baseUrl}/buscar?q=${encodeURIComponent(personName)}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, new RegExp(`src="/persona/${personId}/foto"`));
    assert.match(body, /class="avatar-photo"/);
    assert.match(body, new RegExp(initialsForTest(personName)));
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

test('person photo route redirects to TMDB and handles missing or invalid photos', async () => {
    app.locals.loadTmdbPersonPhoto = async (personId) => (personId === 192 ? 'https://image.tmdb.org/t/p/w185/profile.jpg' : null);

    const found = await fetch(`${baseUrl}/persona/192/foto`, { redirect: 'manual' });
    assert.equal(found.status, 302);
    assert.equal(found.headers.get('location'), 'https://image.tmdb.org/t/p/w185/profile.jpg');

    assert.equal((await fetch(`${baseUrl}/persona/193/foto`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/persona/abc/foto`)).status, 400);
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
    let deletedActivityUserId;

    try {
        for (const route of ['/login', '/registro']) {
            const authPage = await fetch(`${baseUrl}${route}`);
            assert.equal(authPage.status, 200);
            assert.match(authPage.headers.get('cache-control') || '', /no-store/);
        }

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

        for (const route of ['/login', '/registro']) {
            const authenticatedAuthPage = await fetch(`${baseUrl}${route}`, { redirect: 'manual', headers: { cookie } });
            assert.equal(authenticatedAuthPage.status, 302);
            assert.equal(authenticatedAuthPage.headers.get('location'), '/perfil');
            assert.match(authenticatedAuthPage.headers.get('cache-control') || '', /no-store/);
        }

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

        app.locals.deleteUserActivity = async (deletedUserId) => {
            deletedActivityUserId = deletedUserId;
            throw new Error('MongoDB caído');
        };

        const originalWarn = console.warn;
        console.warn = () => {};
        let deleted;
        try {
            deleted = await fetch(`${baseUrl}/perfil/eliminar`, {
                method: 'POST', redirect: 'manual', headers: { cookie: loginCookie }, body: new URLSearchParams({ password: newPassword }),
            });
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(deleted.status, 302);
        assert.equal(deletedActivityUserId, userId);
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

test('search suggestions autocomplete movies, people, genres and keywords while typing', async () => {
    const suggest = async (query) => {
        const response = await fetch(`${baseUrl}/buscar/sugerencias?${new URLSearchParams(query)}`);
        return { status: response.status, body: await response.json() };
    };

    const all = await suggest({ q: 'acc' });
    assert.equal(all.status, 200);
    assert.ok(all.body.suggestions.length > 0 && all.body.suggestions.length <= 11);
    assert.deepEqual(all.body.suggestions[0], { type: 'genre', label: 'Acción', detail: 'Género', url: '/explorar?genero=28' });
    for (const suggestion of all.body.suggestions) {
        assert.ok(['genre', 'movie', 'actor', 'director', 'keyword'].includes(suggestion.type));
        assert.match(suggestion.url, /^\/(pelicula|actor|director|explorar|buscar)[/?]/);
        assert.ok(suggestion.label && suggestion.detail);
    }

    const movies = await suggest({ q: 'star', tipo: 'movie' });
    assert.ok(movies.body.suggestions.length > 0 && movies.body.suggestions.length <= 8);
    assert.ok(movies.body.suggestions.every((suggestion) => suggestion.type === 'movie'));
    assert.match(movies.body.suggestions[0].label, /^star/i, 'primero lo que empieza con el texto');

    const keywords = await suggest({ q: 'prison', tipo: 'keyword' });
    assert.equal(keywords.body.suggestions[0].url, '/buscar?tipo=keyword&q=prison');

    assert.deepEqual((await suggest({ q: 'a' })).body, { suggestions: [] });
    assert.deepEqual((await suggest({ q: '%%' })).body, { suggestions: [] });
    assert.equal((await suggest({ q: 'acc', tipo: 'invalido' })).status, 400);
});

test('pages load the search autocomplete script', async () => {
    const body = await (await fetch(`${baseUrl}/explorar`)).text();
    assert.match(body, /<script src="\/search-suggest\.js" defer><\/script>/);
});

test('a TMDB-only movie shows its full credits and links only people that have a page', async () => {
    const [actor, director] = await Promise.all([
        db.query('SELECT p.person_id, p.person_name FROM movie_cast mc JOIN person p ON p.person_id = mc.person_id LIMIT 1'),
        db.query("SELECT p.person_id, p.person_name FROM movie_crew mc JOIN person p ON p.person_id = mc.person_id WHERE mc.job = 'Director' LIMIT 1"),
    ]);
    const known = actor.rows[0];
    const knownDirector = director.rows[0];
    const remoteId = 2100000077;
    assert.equal((await db.query('SELECT 1 FROM movie WHERE movie_id = $1', [remoteId])).rowCount, 0);

    app.locals.loadTmdbMovie = async (movieId) => (movieId !== remoteId ? null : {
        movie: { movie_id: remoteId, title: 'Remota de prueba', release_date: '2026-01-01', runtime: 99 },
        genres: [{ genre_name: 'Drama' }],
        cast: [
            { person_id: known.person_id, person_name: known.person_name, character_name: 'Protagonista', cast_order: 0 },
            { person_id: 2100000099, person_name: 'Actriz Sin Ficha', character_name: 'Secundaria', cast_order: 1 },
        ],
        crew: [
            { person_id: knownDirector.person_id, person_name: knownDirector.person_name, job: 'Director', department_name: 'Directing' },
            { person_id: 2100000098, person_name: 'Directora Sin Ficha', job: 'Director', department_name: 'Directing' },
            { person_id: 2100000097, person_name: 'Fotógrafo Remoto', job: 'Director of Photography', department_name: 'Camera' },
        ],
        countries: [{ country_name: 'Argentina', country_iso_code: 'AR' }],
        languages: [{ language_name: 'Español', language_code: 'es', language_role: 'Original' }],
        companies: [{ company_name: 'Productora Remota' }],
        keywords: [{ keyword_name: 'remote keyword' }],
        overview: null, posterUrl: null, trailerUrl: null, trailerEmbedUrl: null,
    });

    const response = await fetch(`${baseUrl}/pelicula/${remoteId}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.doesNotMatch(body, /Sin datos de elenco/);
    assert.match(body, new RegExp(`href="/actor/${known.person_id}"`));
    assert.match(body, new RegExp(`href="/director/${knownDirector.person_id}"`));
    assert.match(body, /<span>Actriz Sin Ficha<\/span>/);
    assert.match(body, /<span>Directora Sin Ficha<\/span>/);
    assert.doesNotMatch(body, /href="\/(actor|director)\/21000000(99|98)"/);
    for (const value of ['Protagonista', 'Fotógrafo Remoto', 'Argentina', 'Español (Original)', 'Productora Remota', 'remote keyword']) {
        assert.ok(body.includes(value), `falta "${value}" en la ficha`);
    }
});
