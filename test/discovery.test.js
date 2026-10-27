const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { app, db } = require('../app');
const { loadTrending } = require('../discovery');
let server, base, userId, cookie;
const remoteId = 2100000000;
let createdRemote = false;
before(async () => {
    app.locals.loadTrending = async () => [];
    app.locals.loadTmdbMovie = async (id) => id === remoteId ? {
        movie: { movie_id: id, title: 'Discovery fixture', release_date: '2025-01-01', runtime: 100 },
        overview: 'Una historia nueva', genres: [],
    } : null;
    const name = `discovery-${Date.now()}`;
    userId = (await db.query('INSERT INTO users (user_username,user_name,user_email,password_hash) VALUES ($1,$1,$2,$3) RETURNING user_id', [name, `${name}@example.com`, await bcrypt.hash('Test-Password-2026!',4)])).rows[0].user_id;
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/login`, { method:'POST', redirect:'manual', body:new URLSearchParams({identifier:name,password:'Test-Password-2026!'}) });
    cookie = response.headers.get('set-cookie').split(';')[0];
});
after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (userId) await db.query('DELETE FROM users WHERE user_id=$1',[userId]);
    if (createdRemote) await db.query('DELETE FROM movie WHERE movie_id=$1',[remoteId]);
    await db.end();
});
test('home degrades gracefully and genre filters stay paginated and validated', async () => {
    const home = await fetch(base);
    assert.equal(home.status,200);
    assert.match(await home.text(), /Las tendencias vuelven pronto/);
    const horror = await fetch(`${base}/explorar?genero=27`);
    assert.equal(horror.status,200);
    const html = await horror.text();
    const ids = [...html.matchAll(/class="discovery-card" href="\/pelicula\/(\d+)"/g)].map((m) => Number(m[1]));
    assert.equal(ids.length,24);
    const matched = await db.query('SELECT DISTINCT movie_id FROM movie_genres WHERE genre_id=27 AND movie_id=ANY($1::int[])',[ids]);
    assert.equal(matched.rowCount,24);
    for (const query of ['page=-1','genero=bad','orden=invalid']) assert.equal((await fetch(`${base}/explorar?${query}`)).status,400);
});
test('personal lists require login and suggestions exclude watched movies', async () => {
    assert.equal((await fetch(`${base}/mi-lista`,{redirect:'manual'})).headers.get('location'),'/login');
    await db.query("INSERT INTO movie_user (user_id,movie_id,watch_status,is_favorite) VALUES ($1,238,'watched',TRUE)",[userId]);
    const list = await (await fetch(`${base}/mi-lista?filtro=favorite`,{headers:{cookie}})).text();
    assert.match(list,/href="\/pelicula\/238"/);
    const picks = await (await fetch(`${base}/que-ver`,{headers:{cookie}})).text();
    assert.doesNotMatch(picks,/href="\/pelicula\/238"/);
    assert.equal((await fetch(`${base}/mi-lista?filtro=invalid`,{headers:{cookie}})).status,400);
});
test('a TMDB-only movie can be viewed without writes then saved in the authenticated list', async () => {
    assert.equal((await db.query('SELECT 1 FROM movie WHERE movie_id=$1',[remoteId])).rowCount,0);
    const detail = await fetch(`${base}/pelicula/${remoteId}`);
    assert.equal(detail.status,200);
    assert.match(await detail.text(),/Discovery fixture/);
    assert.equal((await db.query('SELECT 1 FROM movie WHERE movie_id=$1',[remoteId])).rowCount,0);
    createdRemote = true;
    const save = await fetch(`${base}/pelicula/${remoteId}/interaccion`,{method:'POST',redirect:'manual',headers:{cookie},body:new URLSearchParams({watch_status:'want_to_watch'})});
    assert.equal(save.status,302);
    const list = await (await fetch(`${base}/mi-lista`,{headers:{cookie}})).text();
    assert.match(list,/Discovery fixture/);
    const savedDetail = await (await fetch(`${base}/pelicula/${remoteId}`,{headers:{cookie}})).text();
    assert.match(savedDetail,/100 min/);
    assert.match(savedDetail,/value="want_to_watch" selected/);
});
test('trending handles unavailable API and rejects adult or invalid entries', async () => {
    assert.deepEqual(await loadTrending({apiKey:''}),[]);
    assert.deepEqual(await loadTrending({apiKey:'test',fetchImpl:async()=>{throw Error('offline');}}),[]);
    const movies = await loadTrending({apiKey:'test',fetchImpl:async()=>({ok:true,json:async()=>({results:[
        {id:1,title:'Movie',poster_path:'/poster.jpg'}, {id:2,title:'Adult',adult:true}, {id:-1,title:'Bad'}
    ]})}), detailLoader:async()=>null});
    assert.equal(movies.length,1);
    assert.equal(movies[0].movie_id,1);
});
