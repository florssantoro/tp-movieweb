const { MongoClient } = require('mongodb');

// Los 3 tipos de actividad que pide la consigna.
const ACTIVITY_TYPES = ['RATED_MOVIE', 'ADDED_TO_FAVORITES', 'WROTE_REVIEW'];

let client = null;
let databasePromise = null;

// Se conecta una sola vez y reutiliza esa conexión en todos los pedidos.
// La comparten el timeline (user_activity) y las reseñas (reviews, en reviews.js).
function getDatabase() {
    if (!process.env.MONGO_URL) return Promise.resolve(null);

    if (!databasePromise) {
        const attempt = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 2000 });
        client = attempt;
        databasePromise = attempt.connect()
            .then(async () => {
                const database = attempt.db(process.env.MONGO_DB || 'movieweb');
                await database.collection('user_activity').createIndex({ userId: 1, timestamp: -1 });
                await database.collection('reviews').createIndex({ userId: 1, movieId: 1 }, { unique: true });
                await database.collection('reviews').createIndex({ updatedAt: -1 });
                return database;
            })
            .catch(async (err) => {
                // Si falla, se cierra este cliente y la próxima llamada vuelve a intentar conectarse.
                databasePromise = null;
                if (client === attempt) client = null;
                await attempt.close().catch(() => {});
                throw err;
            });
    }
    return databasePromise;
}

async function getCollection(name = 'user_activity') {
    const database = await getDatabase();
    return database ? database.collection(name) : null;
}

// Guarda un evento en el timeline del usuario.
async function logActivity(userId, type, details) {
    if (!ACTIVITY_TYPES.includes(type)) {
        throw new Error(`Tipo de actividad desconocido: ${type}`);
    }
    const collection = await getCollection();
    if (!collection) return;

    await collection.insertOne({
        userId,
        type,
        timestamp: new Date(),
        details,
    });
}

// Devuelve los últimos eventos del usuario, del más nuevo al más viejo.
async function getTimeline(userId, limit = 20) {
    const collection = await getCollection();
    if (!collection) return [];

    return collection
        .find({ userId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
}

// Elimina el historial cuando el usuario borra su cuenta.
async function deleteUserActivity(userId) {
    const collection = await getCollection();
    if (!collection) return;

    await collection.deleteMany({ userId });
}

// Cierra la conexión (para los tests o al apagar la app).
async function closeActivity() {
    if (client) await client.close();
    client = null;
    databasePromise = null;
}

module.exports = { ACTIVITY_TYPES, logActivity, getTimeline, deleteUserActivity, closeActivity, getCollection };
