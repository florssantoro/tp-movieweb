# Bases de Datos 2026

## Trabajo Práctico: MovieWeb

### Objetivos
El objetivo principal de este trabajo práctico es adquirir experiencia en el desarrollo de una aplicación web que interactúa con una base de datos `PostgreSQL`. La aplicación se llama **MovieWeb** y tiene como objetivo permitir a los usuarios buscar películas, actores y directores, explorar la información detallada de películas, y buscar películas relacionadas a través de palabras clave.
También se pretende conocer el uso básico de bases de datos NoSQL, como MongoDB.

---

### Instalación de software
Para realizar el TP se deberá instalar el siguiente software:

1.  **Node.js y npm (Node Package Manager):** para ejecutar la aplicación web en un servidor local.
2.  **PostgreSQL:** para gestionar la base de datos `movies` que contiene la información de películas, actores, directores, etc.
3.  **Un editor de código** (por ejemplo, `WebStorm`, `Visual Studio Code`, etc.) para escribir y editar código.
4.  **MongoDB**: base de datos NoSQL.

---

### Código provisto
Se proporciona código prefabricado que servirá como punto de partida para el desarrollo de la aplicación MovieWeb. Este código incluye la estructura básica de la aplicación `Node.js` con las rutas, vistas y archivos estáticos necesarios. También se proporciona la base de datos `movies`.

---

### Descripción de funcionalidades

1.  **Búsqueda de películas, actores y directores**
    *   Modificar la página principal para que el buscador no solo busque nombres de películas, sino también nombres de personas que sean actores o directores.
    *   Crear una página de resultados de búsqueda que liste los resultados separados en secciones: películas, actores y directores.

2.  **Páginas de personas (actores y directores)**
    *   Al hacer clic en una persona (actor o director) en la página de resultados de búsqueda, se debe mostrar la página de esa persona.
    *   En la página de la persona, listar las películas en las que esa persona ha participado como actor o director.

3.  **Información detallada de películas**
    *   Modificar la página de películas para que incluya todos los datos de la película, incluyendo género, país de producción, etc. Mostrar toda la información contenida en las tablas de la base de datos `movies`.

4.  **Búsqueda de películas por palabras clave**
    *   Incluir un buscador de palabras clave (keywords) que devuelva como resultado las películas relacionadas con la palabra de búsqueda.

5.  **Registro de actividad del usuario**
    * Registrar tres tipos de actividades del usuario usando MongoDB (ver punto 3 de las Instrucciones).

---

### Instrucciones
Se deben completar las siguientes tareas como parte de este TP:

#### 1. Configuración del entorno:
*   Instalar `Node.js`.
*   Instalar `PostgreSQL` y la base de datos `movies` (ver instrucciones en carpeta `db`).
*   Instalar `MongoDB`.
*   Descargar el código proporcionado y configurar el entorno de desarrollo.
*   Instalar dependencias y ejecutar la aplicación:

    ```bash
    # Instalar dependencias del proyecto
    npm install
    
    # Ejecutar la aplicación
    node app.js
    ```

#### 2. Desarrollo de funcionalidades:
*   Modificar el código existente para habilitar la búsqueda de películas, actores y directores en la página principal (`index.ejs` y `app.js`).
*   Modificar la página de resultados de búsqueda (`resultado.ejs`) para mostrar los resultados separados en secciones (películas, actores, directores).
*   Desarrollar la funcionalidad para mostrar la lista de películas en las que una persona (actor o director) ha participado al hacer clic en su nombre. Página de actor (`actor.ejs`) y director (`director.ejs`).
*   Mejorar la página de película (`pelicula.ejs`) para mostrar toda la información contenida en la base de datos `movies`.
*   Implementar un buscador de palabras clave que devuelva películas relacionadas. Crear las páginas del buscador y de resultados (`search_keyword.ejs` y `resultados_keyword.ejs`).
*   Crear las tablas y archivos necesarios para permitir la creación, modificación y borrado de usuarios (`user_id`, `user_username`, `user_name`, `user_email`) y las películas que les gustan (`movie_user`). Debe ser posible listar los usuarios, las películas asociadas a los usuarios, la puntuación que asignaron a una determinada película y la opinión sobre esa película.

---

### 3. Registro de actividad del usuario (Timeline con MongoDB)

#### Descripción:
Crear una página de perfil de usuario donde se muestre un "timeline" o feed de su actividad reciente en el sitio. Esta actividad puede ser de 3 diferentes tipos:
- *"calificó la película X con 4 estrellas"*
- *"añadió la película Y a su lista de favoritos"*
- *"escribió una reseña para la película Z"*

#### Usar MongoDB tiene algunas ventajas
**Diversidad de estructuras de datos:** cada tipo de evento de actividad tiene datos asociados diferentes. Una calificación tiene una puntuación, una reseña tiene texto, y un "favorito" es una acción simple.

**Esquema flexible:** cada evento puede ser un documento en una colección `user_activity` con una estructura que se adapte al tipo de evento. No hay columnas vacías ni `JOIN`s innecesarios.

**Consultas simples para feeds:** para obtener el timeline de un usuario basta con hacer un `find({ userId: "..." })` en la colección y ordenarlo por fecha, por ejemplo.

#### Ejemplo de documentos en MongoDB (Colección: `user_activity`)

```json
// Evento de calificación
{
  "_id": ObjectId("..."),
  "userId": "user_abc",
  "type": "RATED_MOVIE",
  "timestamp": ISODate("2023-10-27T12:00:00Z"),
  "details": {
    "movieId": 54321,
    "movieTitle": "El Origen",
    "rating": 5
  }
}

// Evento de reseña
{
  "_id": ObjectId("..."),
  "userId": "user_abc",
  "type": "WROTE_REVIEW",
  "timestamp": ISODate("2023-10-26T18:45:00Z"),
  "details": {
    "movieId": 67890,
    "movieTitle": "Parásitos",
    "reviewId": "review_1122" // ID que apunta a otra colección o sistema
  }
}

// Evento de añadido a favoritos
{
  "_id": ObjectId("..."),
  "userId": "user_abc",
  "type": "ADDED_TO_FAVORITES",
  "timestamp": ISODate("2023-10-25T09:30:00Z"),
  "details": {
    "movieId": 12345,
    "movieTitle": "El Señor de los Anillos: La Comunidad del Anillo"
  }
}
```

---

## Puesta en marcha

### 1. Dependencias
```bash
npm install
```

### 2. Variables de entorno
Copiar `.env.example` a `.env` y completar los valores. El archivo `.env` no se sube al repositorio.

| Variable | Para qué sirve |
|---|---|
| `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_DATABASE` | Conexión a PostgreSQL |
| `SESSION_SECRET` | Firma de las sesiones de login. Cualquier texto largo y aleatorio |
| `TMDB_API_KEY` | Opcional. Pósters, tráileres y sinopsis en español ([themoviedb.org](https://www.themoviedb.org) → Configuración → API) |
| `MONGO_URL`, `MONGO_DB` | Conexión a MongoDB para el timeline (ej. `mongodb://localhost:27017` y `movieweb`) |

### 3. PostgreSQL
Crear la base `movies` y, desde la carpeta `db`, ejecutar:
```bash
psql --single-transaction -d movies -U postgres -f 00_load_all.sql
```
`00_load_all.sql` carga las películas y también las tablas de usuarios (`13_users.sql`, `14_movie_interactions.sql` y `15_user_auth.sql`). Ver `db/README.md` para actualizar una base existente.

### 4. MongoDB
Alcanza con tener el servidor de MongoDB corriendo y las variables `MONGO_URL` y `MONGO_DB` en el `.env`. La base, la colección `user_activity` y su índice `{ userId: 1, timestamp: -1 }` se crean solos con el primer evento.

### 5. Ejecutar
```bash
npm start
```
La aplicación queda en http://localhost:3500.

```bash
npm test
```
Los tests usan la base PostgreSQL local, pero no el MongoDB real: lo reemplazan por uno falso.

### Timeline de actividad con MongoDB
- **PostgreSQL guarda el estado actual** de cada usuario con cada película (`movie_user`): si es favorita, la puntuación y la opinión.
- **MongoDB guarda el historial** en la colección `user_activity`: cada cambio es un documento nuevo.

Al guardar una interacción (`POST /pelicula/:id/interaccion`), la aplicación compara el estado anterior con el nuevo y registra solo lo que cambió:

| Cambio | `type` | `details` |
|---|---|---|
| La película pasa a ser favorita | `ADDED_TO_FAVORITES` | `movieId`, `movieTitle` |
| Cambia la puntuación | `RATED_MOVIE` | `movieId`, `movieTitle`, `rating` |
| Cambia la opinión | `WROTE_REVIEW` | `movieId`, `movieTitle`, `opinion` |

El perfil del usuario (`/perfil` y `/usuarios/:id`) muestra los últimos 20 eventos en la sección "Actividad reciente", con `find({ userId }).sort({ timestamp: -1 })`. El código está en `activity.js`.

Si MongoDB no está disponible, la aplicación sigue funcionando: las interacciones se guardan en PostgreSQL y el perfil muestra un aviso en lugar del timeline.
