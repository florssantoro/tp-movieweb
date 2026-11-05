const { ObjectId } = require('mongodb');
const { getCollection } = require('./activity');

// Reseñas de películas en MongoDB (colección "reviews"), punto 3.2 de la consigna.
// Cada documento es la reseña de un usuario para una película:
// { userId, username, movieId, movieTitle, rating, text, createdAt, updatedAt }
// PostgreSQL (movie_user) guarda la puntuación y la opinión breve del punto 2.5;
// app.js mantiene las dos bases sincronizadas cada vez que una reseña cambia.

const reviews = () => getCollection('reviews');
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isReviewId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);

// Crea o actualiza la reseña de un usuario para una película. Devuelve su id.
async function saveReview({ userId, username, movieId, movieTitle, rating, text }) {
    const collection = await reviews();
    if (!collection) return null;
    const now = new Date();
    const result = await collection.findOneAndUpdate(
        { userId, movieId },
        { $set: { username, movieTitle, rating: rating ?? null, text, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: 'after' }
    );
    return result?._id ? String(result._id) : null;
}

async function removeReview(userId, movieId) {
    const collection = await reviews();
    if (collection) await collection.deleteOne({ userId, movieId });
}

async function removeUserReviews(userId) {
    const collection = await reviews();
    if (collection) await collection.deleteMany({ userId });
}

async function renameUser(userId, username) {
    const collection = await reviews();
    if (collection) await collection.updateMany({ userId }, { $set: { username } });
}

async function findReview(id) {
    const collection = await reviews();
    if (!collection || !isReviewId(id)) return null;
    return collection.findOne({ _id: new ObjectId(id) });
}

// Busca por texto en la reseña, el título de la película o el usuario (sin importar mayúsculas).
async function searchReviews({ text = '', limit = 12, skip = 0 } = {}) {
    const collection = await reviews();
    if (!collection) return null;
    const filter = text
        ? { $or: ['text', 'movieTitle', 'username'].map((field) => ({ [field]: { $regex: escapeRegex(text), $options: 'i' } })) }
        : {};
    const [items, total] = await Promise.all([
        collection.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).toArray(),
        collection.countDocuments(filter),
    ]);
    return { items, total };
}

// Deja la colección igual a las opiniones guardadas en PostgreSQL (lo usa npm run dev:setup).
async function syncAllReviews(rows) {
    const collection = await reviews();
    if (!collection) return null;
    for (const row of rows) {
        await saveReview({ userId: row.user_id, username: row.user_username, movieId: row.movie_id,
            movieTitle: row.title, rating: row.rating, text: row.opinion });
    }
    const keep = rows.map((row) => ({ userId: row.user_id, movieId: row.movie_id }));
    const removed = await collection.deleteMany(keep.length ? { $nor: keep } : {});
    return { saved: rows.length, removed: removed.deletedCount };
}

module.exports = { saveReview, removeReview, removeUserReviews, renameUser, findReview, searchReviews, syncAllReviews, isReviewId };
