const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
// Los tests no usan el MongoDB real: sin MONGO_URL, activity.js no se conecta.
process.env.MONGO_URL = '';
const { app, db } = require('../app');
const { logActivity, getTimeline } = require('../activity');

let server, baseUrl, userId, cookie;
let loggedEvents = [];

before(async () => {
    const suffix = `activity-${Date.now()}`;
    const result = await db.query(
        'INSERT INTO users (user_username, user_name, user_email, password_hash) VALUES ($1, $1, $2, $3) RETURNING user_id',
        [suffix, `${suffix}@example.com`, await bcrypt.hash('Password-123!', 4)]
    );
    userId = result.rows[0].user_id;
    app.locals.loadTmdbMovie = async () => null;
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/login`, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams({ identifier: suffix, password: 'Password-123!' }),
    });
    cookie = login.headers.get('set-cookie').split(';')[0];
});

afterEach(async () => {
    loggedEvents = [];
    delete app.locals.logActivity;
    delete app.locals.getTimeline;
    await db.query('DELETE FROM movie_user WHERE user_id = $1', [userId]);
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (userId) await db.query('DELETE FROM users WHERE user_id = $1', [userId]);
    await db.end();
});

// MongoDB falso: guarda los eventos en una lista en lugar de la colección user_activity.
const useFakeActivityLog = () => {
    app.locals.logActivity = async (eventUserId, type, details) => {
        loggedEvents.push({ userId: eventUserId, type, details });
    };
};

const post = (values, route = 'interaccion', movie = '11') => fetch(`${baseUrl}/pelicula/${movie}/${route}`, {
    method: 'POST', redirect: 'manual', headers: { cookie }, body: new URLSearchParams(values),
});

// Devuelve los tipos de evento registrados desde la última llamada.
const takeEventTypes = () => loggedEvents.splice(0).map((event) => event.type);

const withoutWarnings = async (callback) => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        return await callback();
    } finally {
        console.warn = originalWarn;
    }
};

test('activity module does nothing without MONGO_URL and rejects unknown event types', async () => {
    assert.equal(await logActivity(1, 'RATED_MOVIE', { movieId: 11, rating: 5 }), undefined);
    assert.deepEqual(await getTimeline(1), []);
    await assert.rejects(logActivity(1, 'RATED_MOVEI', {}), /Tipo de actividad desconocido/);
});

test('saving interactions records only what changed as activity events', async () => {
    useFakeActivityLog();

    assert.equal((await post({ is_favorite: 'on', rating: '4' })).status, 302);
    assert.deepEqual(takeEventTypes(), ['ADDED_TO_FAVORITES', 'RATED_MOVIE']);

    assert.equal((await post({ is_favorite: 'on', rating: '5' })).status, 302);
    assert.deepEqual(loggedEvents[0], {
        userId, type: 'RATED_MOVIE', details: { movieId: 11, movieTitle: 'Star Wars', rating: 5 },
    });
    assert.deepEqual(takeEventTypes(), ['RATED_MOVIE']);

    assert.equal((await post({ is_favorite: 'on', rating: '5', opinion: 'Un clásico' })).status, 302);
    assert.deepEqual(loggedEvents[0].details, { movieId: 11, movieTitle: 'Star Wars', opinion: 'Un clásico' });
    assert.deepEqual(takeEventTypes(), ['WROTE_REVIEW']);

    assert.equal((await post({ is_favorite: 'on', rating: '5', opinion: 'Un clásico' })).status, 302);
    assert.equal((await post({ rating: '5', opinion: 'Un clásico' })).status, 302);
    assert.equal((await post({ action: 'remove' })).status, 302);
    assert.deepEqual(takeEventTypes(), [], 'guardar sin cambios, quitar la favorita o eliminar no generan eventos');

    assert.equal((await post({ rating: '3' }, 'calificar')).status, 302);
    assert.deepEqual(takeEventTypes(), ['RATED_MOVIE']);
});

test('profile shows the activity timeline with one phrase per event type', async () => {
    app.locals.getTimeline = async (timelineUserId) => {
        assert.equal(timelineUserId, userId);
        return [
            { type: 'WROTE_REVIEW', timestamp: new Date('2026-10-31T15:00:00Z'), details: { movieId: 11, movieTitle: 'Star Wars', opinion: '<b>Un clásico</b>' } },
            { type: 'RATED_MOVIE', timestamp: new Date('2026-10-31T14:00:00Z'), details: { movieId: 11, movieTitle: 'Star Wars', rating: 4 } },
            { type: 'ADDED_TO_FAVORITES', timestamp: new Date('2026-10-30T12:00:00Z'), details: { movieId: 238, movieTitle: 'The Godfather' } },
        ];
    };

    const response = await fetch(`${baseUrl}/usuarios/${userId}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Actividad reciente/);
    assert.match(body, /escribió una reseña para la película <a href="\/pelicula\/11">Star Wars<\/a>/);
    assert.match(body, /calificó la película <a href="\/pelicula\/11">Star Wars<\/a>\s+con 4 estrellas/);
    assert.match(body, /añadió la película <a href="\/pelicula\/238">The Godfather<\/a> a su lista de favoritos/);
    assert.ok(body.indexOf('escribió una reseña') < body.indexOf('añadió la película'), 'el evento más nuevo va primero');
    assert.match(body, /&lt;b&gt;Un clásico&lt;\/b&gt;/);
    assert.match(body, /datetime="2026-10-31T14:00:00.000Z">31 oct 2026, 11:00/);
});

test('profile shows an empty timeline message when there is no activity', async () => {
    app.locals.getTimeline = async () => [];
    const body = await (await fetch(`${baseUrl}/perfil`, { headers: { cookie } })).text();
    assert.match(body, /Todavía no hay actividad/);
});

test('interactions and profiles keep working when MongoDB is unavailable', async () => {
    app.locals.logActivity = async () => { throw new Error('MongoDB caído'); };
    app.locals.getTimeline = async () => { throw new Error('MongoDB caído'); };

    await withoutWarnings(async () => {
        assert.equal((await post({ is_favorite: 'on', rating: '4' })).status, 302);
        const saved = await db.query('SELECT rating, is_favorite FROM movie_user WHERE user_id = $1 AND movie_id = 11', [userId]);
        assert.deepEqual(saved.rows, [{ rating: 4, is_favorite: true }]);

        const response = await fetch(`${baseUrl}/usuarios/${userId}`);
        const body = await response.text();
        assert.equal(response.status, 200);
        assert.match(body, /Star Wars/);
        assert.match(body, /La actividad no está disponible en este momento/);
    });
});
