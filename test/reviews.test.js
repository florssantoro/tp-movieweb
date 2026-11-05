const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
// Los tests no usan el MongoDB real: sin MONGO_URL, activity.js y reviews.js no se conectan.
process.env.MONGO_URL = '';
const { app, db } = require('../app');
const realReviews = require('../reviews');

let server, baseUrl, ownerId, otherId, ownerCookie, otherCookie, movieId, movieTitle;
let loggedEvents = [];

// MongoDB falso: guarda las reseñas en memoria con las mismas funciones que reviews.js.
function createFakeReviewStore() {
    const docs = new Map();
    let counter = 0;
    const key = (userId, movieId) => `${userId}:${movieId}`;
    return {
        docs,
        async saveReview(review) {
            const existing = docs.get(key(review.userId, review.movieId));
            const doc = { ...existing, ...review, rating: review.rating ?? null, updatedAt: new Date(),
                _id: existing?._id || String(++counter).padStart(24, '0'), createdAt: existing?.createdAt || new Date() };
            docs.set(key(review.userId, review.movieId), doc);
            return doc._id;
        },
        async removeReview(userId, movieId) { docs.delete(key(userId, movieId)); },
        async removeUserReviews(userId) { for (const [k, d] of docs) if (d.userId === userId) docs.delete(k); },
        async renameUser(userId, username) { for (const d of docs.values()) if (d.userId === userId) d.username = username; },
        async findReview(id) { return [...docs.values()].find((d) => d._id === id) || null; },
        async searchReviews({ text = '', limit = 12, skip = 0 } = {}) {
            const needle = text.toLowerCase();
            const items = [...docs.values()]
                .filter((d) => !needle || [d.text, d.movieTitle, d.username].some((v) => String(v).toLowerCase().includes(needle)))
                .sort((a, b) => b.updatedAt - a.updatedAt);
            return { items: items.slice(skip, skip + limit), total: items.length };
        },
    };
}
let store;

async function createUser(suffix) {
    const name = `reviews-${suffix}-${Date.now()}`;
    const id = (await db.query(
        'INSERT INTO users (user_username, user_name, user_email, password_hash) VALUES ($1, $1, $2, $3) RETURNING user_id',
        [name, `${name}@example.com`, await bcrypt.hash('Password-123!', 4)]
    )).rows[0].user_id;
    const login = await fetch(`${baseUrl}/login`, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams({ identifier: name, password: 'Password-123!' }),
    });
    return { id, name, cookie: login.headers.get('set-cookie').split(';')[0] };
}

before(async () => {
    app.locals.loadTmdbMovie = async () => null;
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const owner = await createUser('owner');
    const other = await createUser('other');
    ({ id: ownerId, cookie: ownerCookie } = owner);
    ({ id: otherId, cookie: otherCookie } = other);
    const movie = (await db.query(`SELECT movie_id, title FROM movie
        WHERE movie_id NOT IN (SELECT movie_id FROM movie_user) ORDER BY movie_id LIMIT 1`)).rows[0];
    ({ movie_id: movieId, title: movieTitle } = movie);
});

afterEach(async () => {
    loggedEvents = [];
    delete app.locals.reviewStore;
    delete app.locals.logActivity;
    await db.query('DELETE FROM movie_user WHERE user_id = ANY($1::int[])', [[ownerId, otherId]]);
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.query('DELETE FROM users WHERE user_id = ANY($1::int[])', [[ownerId, otherId].filter(Boolean)]);
    await db.end();
});

const useFakes = () => {
    store = createFakeReviewStore();
    app.locals.reviewStore = store;
    app.locals.logActivity = async (userId, type, details) => { loggedEvents.push({ userId, type, details }); };
};
const review = (cookie, values) => fetch(`${baseUrl}/pelicula/${movieId}/calificar`, {
    method: 'POST', redirect: 'manual', headers: { cookie }, body: new URLSearchParams(values),
});
const row = async (userId) => (await db.query('SELECT rating, opinion, is_favorite FROM movie_user WHERE user_id = $1 AND movie_id = $2', [userId, movieId])).rows[0];
const ownerDoc = () => [...store.docs.values()].find((d) => d.userId === ownerId);

test('reviews module does nothing without MongoDB configured', async () => {
    assert.equal(await realReviews.saveReview({ userId: 1, movieId: 1, text: 'x' }), null);
    assert.equal(await realReviews.searchReviews({ text: 'x' }), null);
    assert.equal(await realReviews.findReview('0'.repeat(24)), null);
});

test('saving a review stores it in MongoDB and links it from the timeline event', async () => {
    useFakes();
    assert.equal((await review(ownerCookie, { rating: '4', opinion: 'Muy buena' })).status, 302);

    const doc = ownerDoc();
    assert.equal(doc.text, 'Muy buena');
    assert.equal(doc.rating, 4);
    assert.equal(doc.movieTitle, movieTitle);
    const event = loggedEvents.find((e) => e.type === 'WROTE_REVIEW');
    assert.equal(event.details.reviewId, doc._id, 'el evento guarda el id del documento, como el ejemplo de la consigna');

    assert.equal((await review(ownerCookie, { rating: '4', opinion: '' })).status, 302);
    assert.equal(ownerDoc(), undefined, 'sin opinión ya no hay reseña en MongoDB');
});

test('reviews page searches reviews and shows edit buttons only on your own', async () => {
    useFakes();
    await review(ownerCookie, { rating: '5', opinion: 'La música es increíble' });
    await review(otherCookie, { rating: '2', opinion: 'Se me hizo larga' });

    const all = await (await fetch(`${baseUrl}/resenas`, { headers: { cookie: ownerCookie } })).text();
    assert.match(all, /2 reseñas/);
    assert.equal((all.match(/\/editar">Editar</g) || []).length, 1, 'solo la propia se puede editar');

    const found = await (await fetch(`${baseUrl}/resenas?q=${encodeURIComponent('MÚSICA')}`)).text();
    assert.match(found, /1 reseña para &#34;MÚSICA&#34;/);
    assert.match(found, /La música es increíble/);
    assert.doesNotMatch(found, /Se me hizo larga/);
    assert.doesNotMatch(found, /\/editar">Editar</, 'sin sesión no hay botones de edición');
});

test('editing a review from the reviews page updates MongoDB and PostgreSQL', async () => {
    useFakes();
    await review(ownerCookie, { rating: '3', opinion: 'Primera versión' });
    const id = ownerDoc()._id;
    const edit = (cookie, values) => fetch(`${baseUrl}/resenas/${id}/editar`, {
        method: 'POST', redirect: 'manual', headers: { cookie }, body: new URLSearchParams(values),
    });

    assert.equal((await fetch(`${baseUrl}/resenas/${id}/editar`, { headers: { cookie: ownerCookie } })).status, 200);
    assert.equal((await edit(ownerCookie, { rating: '5', text: 'Versión corregida' })).headers.get('location'), '/resenas?listo=editada');
    assert.deepEqual(await row(ownerId), { rating: 5, opinion: 'Versión corregida', is_favorite: false });
    assert.equal(ownerDoc().text, 'Versión corregida');
    assert.equal(ownerDoc()._id, id, 'se actualiza el mismo documento');

    assert.equal((await edit(ownerCookie, { rating: '5', text: '' })).status, 400);
    assert.equal((await edit(ownerCookie, { rating: '9', text: 'Algo' })).status, 400);
    assert.equal((await edit(otherCookie, { rating: '1', text: 'No es mía' })).status, 403);
    assert.equal((await fetch(`${baseUrl}/resenas/${'f'.repeat(24)}/editar`, { headers: { cookie: ownerCookie } })).status, 404);
    assert.equal(ownerDoc().text, 'Versión corregida', 'los intentos inválidos no cambian nada');
});

test('deleting a review removes it from MongoDB and keeps the favorite in PostgreSQL', async () => {
    useFakes();
    await db.query('INSERT INTO movie_user (user_id, movie_id, is_favorite) VALUES ($1, $2, TRUE)', [ownerId, movieId]);
    await review(ownerCookie, { rating: '4', opinion: 'Para borrar' });
    const id = ownerDoc()._id;
    const remove = (cookie) => fetch(`${baseUrl}/resenas/${id}/eliminar`, { method: 'POST', redirect: 'manual', headers: { cookie } });

    assert.equal((await remove(otherCookie)).status, 403);
    assert.equal((await remove(ownerCookie)).headers.get('location'), '/resenas?listo=borrada');
    assert.equal(ownerDoc(), undefined);
    assert.deepEqual(await row(ownerId), { rating: null, opinion: null, is_favorite: true }, 'la favorita se conserva');
});

test('reviews page explains when MongoDB is unavailable', async () => {
    app.locals.reviewStore = { searchReviews: async () => null };
    const html = await (await fetch(`${baseUrl}/resenas`)).text();
    assert.match(html, /Las reseñas no están disponibles en este momento/);
});
