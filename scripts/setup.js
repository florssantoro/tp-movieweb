require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const { MongoClient } = require('mongodb');

const database = process.env.PGDATABASE || 'movies';
const pgConfig = {
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432)
};

async function setupPostgres() {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error('PGDATABASE must be a simple PostgreSQL identifier.');
  }

  const admin = new Client({ ...pgConfig, database: 'postgres' });
  await admin.connect();
  try {
    const result = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!result.rowCount) {
      await admin.query(`CREATE DATABASE "${database}"`);
      console.log(`Created PostgreSQL database ${database}`);
    }
  } finally {
    await admin.end();
  }

  const client = new Client({ ...pgConfig, database });
  await client.connect();
  let hasSchema;
  let hasMovies;
  try {
    const result = await client.query("SELECT to_regnamespace('movies') IS NOT NULL AS has_schema, to_regclass('movies.movie') IS NOT NULL AS has_movies");
    ({ has_schema: hasSchema, has_movies: hasMovies } = result.rows[0]);
  } finally {
    await client.end();
  }

  if (hasMovies) {
    console.log('Movie tables already loaded; leaving existing data unchanged.');
    return;
  }
  if (hasSchema) {
    throw new Error('The movies schema already exists but the movie table is missing. Inspect it before loading the starter SQL.');
  }

  const macPsql = '/Library/PostgreSQL/17/bin/psql';
  const psql = process.env.PSQL_PATH || (fs.existsSync(macPsql) ? macPsql : 'psql');
  const result = spawnSync(psql, [
    '--single-transaction', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-h', pgConfig.host, '-p', String(pgConfig.port), '-U', pgConfig.user,
    '-d', database, '-f', '00_load_all.sql'
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PGPASSWORD: pgConfig.password },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Loading the starter SQL failed.');
  console.log('Movie tables loaded.');
}

async function checkMongo() {
  const client = new MongoClient(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/movieweb');
  try {
    await client.connect();
    await client.db('movieweb').command({ ping: 1 });
    console.log('MongoDB connection OK.');
  } finally {
    await client.close();
  }
}

async function main() {
  await setupPostgres();
  await checkMongo();
}

main().catch((error) => {
  console.error('Setup failed:', error.message);
  process.exitCode = 1;
});
