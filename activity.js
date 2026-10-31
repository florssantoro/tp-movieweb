const { MongoClient } = require('mongodb');

// Los 3 tipos de actividad que pide la consigna.
const ACTIVITY_TYPES = ['RATED_MOVIE', 'ADDED_TO_FAVORITES', 'WROTE_REVIEW'];

let client = null;
let collectionPromise = null;

// Se conecta una sola vez y reutiliza esa conexión en todos los pedidos.
function getCollection() {
    if (!process.env.MONGO_URL) return Promise.resolve(null);

    if (!collectionPromise) {
        client = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 2000 });
        collectionPromise = client.connect()
            .then(async () => {
                const collection = client.db(process.env.MONGO_DB || 'movieweb').collection('user_activity');
                await collection.createIndex({ userId: 1, timestamp: -1 });
                return collection;
            })
            .catch((err) => {
                // Si falla, la próxima llamada vuelve a intentar conectarse.
                collectionPromise = null;
                throw err;
            });
    }
    return collectionPromise;
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

// Cierra la conexión (para los tests o al apagar la app).
async function closeActivity() {
    if (client) await client.close();
    client = null;
    collectionPromise = null;
}

module.exports = { ACTIVITY_TYPES, logActivity, getTimeline, closeActivity };