#!/usr/bin/env node
// Configuración automática del entorno de MovieWeb.
//
//   npm run dev:setup   Crea la base "movies" si no existe, carga las películas (solo la primera vez),
//                       aplica las tablas del grupo (13 a 17), carga datos de prueba y prepara MongoDB.
//                       Se puede correr las veces que haga falta: no borra datos.
//   npm run dev:reset   Igual, pero vuelve a cargar todo desde cero (borra usuarios y reseñas).
//   npm run dev:drop    Borra solo lo que agregó el grupo: tablas de usuarios y colecciones de MongoDB.
//
// Usa las credenciales del archivo .env (DB_*, MONGO_URL, MONGO_DB).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { Client } = require('pg');
const { MongoClient } = require('mongodb');

const DB_DIR = path.join(ROOT, 'db');
const mode = process.argv[2] || 'setup';
const databaseName = process.env.DB_DATABASE || 'movies';

const pgConfig = (database) => ({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST, port: process.env.DB_PORT, database,
});
const step = (text) => console.log(`\n▶ ${text}`);
const done = (text) => console.log(`  ✔ ${text}`);

// El orden de carga sale de 00_load_all.sql (las líneas "\i archivo.sql"), así es siempre el mismo que con psql.
function loadOrder() {
    return fs.readFileSync(path.join(DB_DIR, '00_load_all.sql'), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.match(/^\\i\s+(\S+\.sql)\s*$/))
        .filter(Boolean)
        .map((match) => match[1]);
}

async function runFile(client, file) {
    const started = Date.now();
    await client.query(fs.readFileSync(path.join(DB_DIR, file), 'utf8'));
    done(`${file} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

async function ensureDatabase() {
    const admin = new Client(pgConfig('postgres'));
    await admin.connect();
    try {
        const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName])).rowCount > 0;
        if (!exists) await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
        done(exists ? `La base "${databaseName}" ya existe` : `Base "${databaseName}" creada`);
    } finally {
        await admin.end();
    }
}

async function withMongo(callback) {
    if (!process.env.MONGO_URL) {
        console.log('  ⚠ MONGO_URL no está en el .env: se saltea MongoDB.');
        return;
    }
    const mongo = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 3000 });
    try {
        await mongo.connect();
        await callback(mongo.db(process.env.MONGO_DB || 'movieweb'));
    } catch (err) {
        console.log(`  ⚠ No se pudo usar MongoDB (${err.message}). La app funciona igual, sin timeline ni búsqueda de reseñas.`);
    } finally {
        await mongo.close().catch(() => {});
    }
}

async function drop(client) {
    step('Borrando las tablas del grupo (PostgreSQL)');
    await runFile(client, '99_drop_tables.sql');
    step('Borrando las colecciones del grupo (MongoDB)');
    await withMongo(async (mongoDb) => {
        for (const name of ['user_activity', 'reviews']) {
            await mongoDb.collection(name).drop().catch(() => {});
            done(`Colección ${name} borrada`);
        }
    });
}

async function setup(client) {
    const order = loadOrder();
    const hasMovies = (await client.query(`SELECT to_regclass('movies.movie') IS NOT NULL AS ok`)).rows[0].ok
        && (await client.query('SELECT EXISTS (SELECT 1 FROM movies.movie) AS ok')).rows[0].ok;

    if (!hasMovies || mode === 'reset') {
        step('Cargando la base de películas (tarda un par de minutos)');
        for (const file of order) await runFile(client, file);
    } else {
        step('Las películas ya están cargadas: solo se aplican las tablas del grupo');
        for (const file of order.filter((name) => Number(name.slice(0, 2)) >= 13)) await runFile(client, file);
    }

    step('Datos de prueba');
    await runFile(client, '18_seed_demo.sql');

    step('MongoDB: índices, reseñas y actividad de prueba');
    await withMongo(async (mongoDb) => {
        const activity = mongoDb.collection('user_activity');
        const reviews = mongoDb.collection('reviews');
        await activity.createIndex({ userId: 1, timestamp: -1 });
        await reviews.createIndex({ userId: 1, movieId: 1 }, { unique: true });
        await reviews.createIndex({ updatedAt: -1 });
        done('Índices creados');

        // Copia a MongoDB las reseñas que hay en PostgreSQL (con opinión escrita).
        const rows = (await client.query(`SELECT mu.user_id, u.user_username, mu.movie_id, m.title, mu.rating, mu.opinion, mu.updated_at
            FROM movies.movie_user mu
            JOIN movies.users u ON u.user_id = mu.user_id
            JOIN movies.movie m ON m.movie_id = mu.movie_id
            WHERE mu.opinion IS NOT NULL`)).rows;
        for (const row of rows) {
            await reviews.updateOne(
                { userId: row.user_id, movieId: row.movie_id },
                { $set: { username: row.user_username, movieTitle: row.title, rating: row.rating, text: row.opinion, updatedAt: row.updated_at },
                    $setOnInsert: { createdAt: row.updated_at } },
                { upsert: true }
            );
        }
        const keep = rows.map((row) => ({ userId: row.user_id, movieId: row.movie_id }));
        const removed = (await reviews.deleteMany(keep.length ? { $nor: keep } : {})).deletedCount;
        done(`${rows.length} reseñas sincronizadas${removed ? ` (${removed} viejas borradas)` : ''}`);

        // Actividad de prueba para los usuarios de prueba (email @movieweb.test), solo si todavía no tienen.
        const demo = (await client.query(`SELECT u.user_id, mu.movie_id, m.title, mu.rating, mu.opinion, mu.is_favorite, mu.updated_at
            FROM movies.users u
            JOIN movies.movie_user mu ON mu.user_id = u.user_id
            JOIN movies.movie m ON m.movie_id = mu.movie_id
            WHERE u.user_email LIKE '%@movieweb.test'`)).rows;
        let inserted = 0;
        for (const row of demo) {
            if (await activity.countDocuments({ userId: row.user_id, 'details.movieId': row.movie_id })) continue;
            const base = { movieId: row.movie_id, movieTitle: row.title };
            const events = [];
            if (row.is_favorite) events.push({ type: 'ADDED_TO_FAVORITES', details: base });
            if (row.rating) events.push({ type: 'RATED_MOVIE', details: { ...base, rating: row.rating } });
            if (row.opinion) {
                const review = await reviews.findOne({ userId: row.user_id, movieId: row.movie_id });
                events.push({ type: 'WROTE_REVIEW', details: { ...base, reviewId: review ? String(review._id) : null, opinion: row.opinion } });
            }
            if (events.length) {
                await activity.insertMany(events.map((event, index) => ({
                    userId: row.user_id, ...event, timestamp: new Date(new Date(row.updated_at).getTime() + index),
                })));
                inserted += events.length;
            }
        }
        done(inserted ? `${inserted} eventos de prueba en el timeline` : 'La actividad de prueba ya estaba cargada');
    });

    const counts = (await client.query(`SELECT (SELECT COUNT(*) FROM movies.movie)::int AS movies,
        (SELECT COUNT(*) FROM movies.users)::int AS users, (SELECT COUNT(*) FROM movies.movie_user)::int AS interactions`)).rows[0];
    console.log(`\n✅ Listo: ${counts.movies} películas, ${counts.users} usuarios, ${counts.interactions} interacciones.`);
    console.log('   Usuarios de prueba: demo_ana, demo_bruno, sofi.cine, nico_films, cami.martinez, juanpi.rojas, lu.fernandez, tomi.vera');
    console.log('   Contraseña de todos: movieweb123');
    console.log('   Iniciá la app con: npm start');
}

async function main() {
    if (!['setup', 'reset', 'drop'].includes(mode)) throw new Error(`Modo desconocido: ${mode}`);
    if (!process.env.DB_USER || !process.env.DB_PASSWORD) {
        throw new Error('Faltan DB_USER y DB_PASSWORD en el archivo .env (copiá .env.example a .env y completalo).');
    }

    step(`PostgreSQL en ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
    await ensureDatabase();
    const client = new Client(pgConfig(databaseName));
    await client.connect();
    try {
        if (mode === 'drop' || mode === 'reset') await drop(client);
        if (mode !== 'drop') await setup(client);
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error(`\n✖ ${err.message}`);
    process.exitCode = 1;
});
