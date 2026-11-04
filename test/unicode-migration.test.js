const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.MONGO_URL = '';
const { db } = require('../app');

after(async () => db.end());

test('Unicode repair migration decodes damaged data without changing valid names', async () => {
    const client = await db.connect();
    const schema = `unicode_test_${process.pid}`;
    const migration = fs.readFileSync(
        path.join(__dirname, '../db/16_decode_unicode_escapes.sql'),
        'utf8'
    ).replaceAll('movies.', `${schema}.`);

    try {
        await client.query(`
            CREATE SCHEMA ${schema};
            CREATE TABLE ${schema}.language (language_name TEXT);
            CREATE TABLE ${schema}.person (person_name TEXT);
            CREATE TABLE ${schema}.movie_cast (character_name TEXT);
            CREATE TABLE ${schema}.production_company (company_name TEXT);
            CREATE TABLE ${schema}.keyword (keyword_name TEXT);

            INSERT INTO ${schema}.language VALUES
                ('Espau00f1ol'), ('u65e5u672cu8a9e'), ('ud55cuad6d');
            INSERT INTO ${schema}.person VALUES
                ('Bju00f6rk'), ('Art Chudabala'), ('u5f20u7acb | Zhang Li');
            INSERT INTO ${schema}.movie_cast VALUES
                ('Evelyn Ou2019Connell'), ('uae40ud718 (Kim Hwi)');
            INSERT INTO ${schema}.production_company VALUES
                ('France 2 Cinu00e9ma'), ('Clubdeal');
            INSERT INTO ${schema}.keyword VALUES
                ('cu00f4te d''azur'), ('u7eddu5730u5976u9738');
        `);

        await client.query(migration);
        await client.query(migration);

        assert.deepEqual((await client.query(`SELECT language_name FROM ${schema}.language ORDER BY language_name COLLATE "C"`)).rows, [
            { language_name: 'Español' },
            { language_name: '日本語' },
            { language_name: '한국' },
        ]);
        assert.deepEqual((await client.query(`SELECT person_name FROM ${schema}.person ORDER BY person_name COLLATE "C"`)).rows, [
            { person_name: 'Art Chudabala' },
            { person_name: 'Björk' },
            { person_name: '张立 | Zhang Li' },
        ]);
        assert.deepEqual((await client.query(`SELECT character_name FROM ${schema}.movie_cast ORDER BY character_name COLLATE "C"`)).rows, [
            { character_name: 'Evelyn O’Connell' },
            { character_name: '김휘 (Kim Hwi)' },
        ]);
        assert.deepEqual((await client.query(`SELECT company_name FROM ${schema}.production_company ORDER BY company_name COLLATE "C"`)).rows, [
            { company_name: 'Clubdeal' },
            { company_name: 'France 2 Cinéma' },
        ]);
        assert.deepEqual((await client.query(`SELECT keyword_name FROM ${schema}.keyword ORDER BY keyword_name COLLATE "C"`)).rows, [
            { keyword_name: "côte d'azur" },
            { keyword_name: '绝地奶霸' },
        ]);
    } finally {
        await client.query('ROLLBACK');
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        client.release();
    }
});
