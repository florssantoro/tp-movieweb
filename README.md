# MovieWeb

Trabajo práctico de **Bases de Datos y Recursos de Información 2026** (Universidad Austral).
Aplicación web para buscar y explorar películas, actores y directores, con usuarios, reseñas y un timeline de actividad.
Usa **PostgreSQL** (base relacional), **MongoDB** (base NoSQL) y la **API de TMDB**.

## Integrantes

- Milo Blanco
- Juan Manuel Gioino
- Flor Santoro
- Tomás Fernández Narice

---

## Instalación y ejecución

### Requisitos

- **Node.js 18 o superior** (probado con Node 24) y npm.
- **PostgreSQL** corriendo (probado con PostgreSQL 18).
- **MongoDB** corriendo (probado con MongoDB 9). Sin MongoDB la app funciona igual, pero sin timeline ni búsqueda de reseñas.
- Una clave de la **API de TMDB** (incluida en el `.env` de la entrega).

### 1. Clonar el repositorio (o descomprimir el .zip)

```bash
git clone https://github.com/florssantoro/tp-movieweb.git
cd tp-movieweb
```

### 2. Instalar las dependencias

```bash
npm install
```

### 3. Configurar el archivo `.env`

La entrega ya incluye un `.env` listo. Si hace falta crearlo, copiar el modelo `.env.example` a `.env` y completar los valores:

| Variable | Para qué sirve |
|---|---|
| `PORT` | Puerto de la app (por defecto `3500`) |
| `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_DATABASE` | Conexión a PostgreSQL. La base se llama `movies` |
| `TMDB_API_KEY` | Pósters, tráileres, fotos de actores y sinopsis en español |
| `SESSION_SECRET` | Firma de las sesiones de login (cualquier texto largo y aleatorio) |
| `MONGO_URL`, `MONGO_DB` | Conexión a MongoDB (ej. `mongodb://localhost:27017` y `movieweb`) |

> **Importante:** completar `DB_USER` y `DB_PASSWORD` con el usuario y la contraseña del PostgreSQL de la computadora donde se va a correr.

### 4. Configuración automática del entorno

```bash
npm run dev:setup
```

Este script (`scripts/dev-setup.js`):

1. Crea la base `movies` si no existe.
2. Carga las películas la primera vez (los scripts `db/01` a `db/12` que provee la cátedra, en el orden de `00_load_all.sql`). Tarda menos de un minuto.
3. Crea las tablas del grupo (`db/13` a `db/17`) y carga datos de prueba (`db/18_seed_demo.sql`).
4. Prepara MongoDB: crea los índices, copia las reseñas a la colección `reviews` y carga actividad de prueba.

Se puede correr las veces que haga falta: no borra ni duplica datos.

**Usuarios de prueba** (todos con la contraseña `movieweb123`): `demo_ana`, `demo_bruno`, `sofi.cine`, `nico_films`, `cami.martinez`, `juanpi.rojas`, `lu.fernandez` y `tomi.vera`. Tienen 48 películas guardadas y 41 reseñas, para ver la app con datos.

Otros comandos útiles para la corrección:

| Comando | Qué hace |
|---|---|
| `npm run dev:drop` | Borra solo lo que agregó el grupo: las tablas de usuarios (`db/99_drop_tables.sql`) y las colecciones de MongoDB. No toca las películas |
| `npm run dev:reset` | Borra todo y lo vuelve a cargar desde cero |

### 5. Iniciar la aplicación

```bash
npm start
```

Queda en **http://localhost:3500**.

### 6. Tests (opcional)

```bash
npm test
```

Usan la base PostgreSQL local (crean y borran sus propios datos de prueba) y un MongoDB falso, así que no necesitan MongoDB corriendo.

---

## Funcionalidades

| Consigna | Dónde se ve | Código |
|---|---|---|
| **2.1** Búsqueda de películas, actores y directores, en tres secciones | Buscador del header → `/buscar` (con autocompletado) | `app.js`, `views/resultado.ejs` |
| **2.2** Perfil de actor y director con sus películas y rol | `/persona/:id`: una sola página por persona, con sus películas como actor (personaje) y como director (rol), más biografía y carrera completa de TMDB. `/actor/:id` y `/director/:id` redirigen ahí | `views/persona.ejs`, `views/partials/person_tmdb.ejs` |
| **2.3** Ficha completa de la película + TMDB (póster, sinopsis, tráiler, enlaces) | `/pelicula/:id` | `views/pelicula.ejs`, `tmdb.js` |
| **2.4** Búsqueda por palabra clave | Buscador del header con **"Palabras clave"** → `/buscar?tipo=keyword` (integrada al buscador unificado; `/keyword` redirige ahí) | `views/search_keyword.ejs` (inicio de la búsqueda, con palabras populares) y `views/resultados_keyword.ejs` (resultados), incluidas en `views/resultado.ejs` |
| **2.5** Alta, baja y modificación de usuarios; favoritas, vistas, puntuación y opinión | `/registro`, `/login`, `/perfil`, `/perfil/editar`, botones de la ficha | `db/13`–`17`, `app.js` |
| **3.1** Timeline de actividad en MongoDB (3 tipos de evento) | Perfil del usuario, sección "Actividad reciente" | `activity.js` |
| **3.2** Reseñas en MongoDB: búsqueda, actualización y borrado | `/resenas` (menú "Reseñas") | `reviews.js`, `views/resenas.ejs` |

Extras: portada con tendencias de TMDB, Explorar por género, "¿Qué ver?" con sugerencias personalizadas, Mi lista, reseñas de la comunidad en cada película y fichas completas (vía TMDB) de películas que no están en la base.

---

## Diseño de las bases de datos

### PostgreSQL: tablas agregadas por el grupo

```
users      ( user_id PK, user_username UNIQUE, user_name, user_email UNIQUE, password_hash )
movie_user ( user_id FK → users, movie_id FK → movie, rating 1..5, opinion,
             is_favorite, watch_status ('want_to_watch' | 'watched'), created_at, updated_at,
             PK (user_id, movie_id) )
session    ( sesiones de login, la crea connect-pg-simple )
```

- `movie_user` resuelve la relación **N:M** entre usuarios y películas (es la tabla `user_movies` de la consigna). La **PK compuesta** hace que haya una sola relación por usuario y película.
- `ON DELETE CASCADE`: al borrar un usuario o una película se borran sus relaciones.
- `CHECK` en `rating` (1 a 5) y en `watch_status`; índices únicos sin distinguir mayúsculas en username y email.
- Un **trigger** actualiza `updated_at` cada vez que cambia la relación.
- Las contraseñas se guardan solo como **hash bcrypt**. Todas las consultas son **parametrizadas** (`$1`, `$2`…), sin riesgo de inyección SQL.

### MongoDB: colecciones

**`user_activity`**: el timeline. Un documento por evento, con un `details` distinto según el tipo:

```js
{ userId: 3, type: "RATED_MOVIE", timestamp: ISODate("..."),
  details: { movieId: 157336, movieTitle: "Interstellar", rating: 5 } }
{ userId: 3, type: "WROTE_REVIEW", timestamp: ISODate("..."),
  details: { movieId: 157336, movieTitle: "Interstellar", reviewId: "6730...", opinion: "..." } }
{ userId: 3, type: "ADDED_TO_FAVORITES", timestamp: ISODate("..."),
  details: { movieId: 238, movieTitle: "The Godfather" } }
```

Índice `{ userId: 1, timestamp: -1 }` para leer el timeline con `find({ userId }).sort({ timestamp: -1 })`.

**`reviews`**: las reseñas como documentos, para buscarlas, editarlas y borrarlas:

```js
{ userId: 3, username: "demo_ana", movieId: 157336, movieTitle: "Interstellar",
  rating: 5, text: "...", createdAt: ISODate("..."), updatedAt: ISODate("...") }
```

Índice único `{ userId: 1, movieId: 1 }` (una reseña por usuario y película) e índice `{ updatedAt: -1 }`.

### Cómo conviven las dos bases

- **PostgreSQL guarda el estado actual**: si la película es favorita, si está vista, la puntuación y la opinión breve (consigna 2.5).
- **MongoDB guarda el historial** (`user_activity`) y **las reseñas como documentos** (`reviews`, consigna 3.2).
- Cada vez que una reseña se crea, se edita o se borra, `app.js` actualiza las dos bases. El evento `WROTE_REVIEW` guarda el `reviewId` del documento de la reseña.
- Si MongoDB no responde, la app sigue funcionando con PostgreSQL y lo avisa en pantalla.

---

## Estructura del proyecto

```
app.js               Servidor Express: rutas y consultas a PostgreSQL
activity.js          Conexión a MongoDB y timeline (user_activity)
reviews.js           Reseñas en MongoDB (reviews)
tmdb.js              Cliente de la API de TMDB (con caché)
discovery.js         Portada, Explorar, ¿Qué ver? y Mi lista
scripts/dev-setup.js npm run dev:setup / dev:reset / dev:drop
db/                  Scripts SQL (00_load_all.sql carga todo; 99_drop_tables.sql borra lo agregado)
views/               Vistas EJS
public/              CSS, JavaScript del navegador e imágenes
test/                Tests (npm test)
docs/                Consigna original y notas
```
