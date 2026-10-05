# tp-movieweb

### Plan de Acción Semanal: TP MovieWeb

#### Semana 1: Del 28/09 al 05/10 — Configuración y Entorno Base

* **Objetivo:** Dejar operativo el repositorio compartido y la estructura inicial del proyecto.
* **Tareas:**
* Definir el repositorio en GitHub/GitLab y asegurar que todo el grupo clone y haga funcionar el código base (scaffolding).


* Configurar las variables de entorno (`.env`) con las conexiones locales de PostgreSQL (`movies`), MongoDB y la clave de la API de TMDB.


* Diseñar el diagrama entidad-relación (DER) para las tablas de usuarios (`users`), interacciones (`user_movies`) y validaciones iniciales de PostgreSQL.





#### Semana 2: Del 06/10 al 12/10 — Módulo Relacional (PostgreSQL) & Búsquedas

* **Objetivo:** Implementar la lógica relacional principal y los buscadores.
* **Tareas:**
* Crear los scripts SQL de inicialización, creación y borrado de tablas adicionales para facilitar la corrección.


* Desarrollar la **búsqueda general** simultánea de películas, actores y directores (`index.ejs` y `resultado.ejs`).


* Armar las páginas de perfil de personas (`actor.ejs` / `director.ejs`) y la vista detallada de cada película enriquecida con datos de la base de datos.





#### Semana 3: Del 13/10 al 19/10 — Integración con TMDB y Búsqueda por Keywords

* **Objetivo:** Enriquecer visualmente el sitio web y sumar filtros avanzados.
* **Tareas:**
* Conectar la API de **TMDB** para traer pósters, sinopsis, tráilers y enlaces multimedia a la vista de detalle de la película (`pelicula.ejs`).


* Implementar la búsqueda específica por palabras clave (`search_keyword.ejs` y `resultados_keyword.ejs`).


* Armar el módulo de gestión de usuarios (CRUD básico de perfiles en SQL) y la asociación de películas como "favoritas" o "vistas".





#### Semana 4: Del 20/10 al 26/10 — Módulo NoSQL (MongoDB) & Automatización

* **Objetivo:** Integrar la base de datos no relacional para actividades y reseñas.
* **Tareas:**
* Configurar Mongoose/MongoDB en el proyecto para registrar eventos en la colección `user_activity` (calificaciones, favoritos y reseñas con esquemas flexibles).


* Crear el **timeline o feed de actividad reciente** en el perfil de usuario.


* Implementar la gestión avanzada de reseñas (búsqueda, actualización y borrado) usando MongoDB.


* Programar el script automatizado de configuración del entorno (`npm run dev:setup`) exigido por la cátedra.





#### Semana 5: Del 27/10 al 03/11 — Pulido Final, Pruebas y README

* **Objetivo:** Asegurar que todo funcione sin baches y empaquetar la entrega.
* **Tareas:**
* Hacer pruebas de punta a punta (end-to-end) para corroborar que no queden rutas rotas ni errores de conexión.
* Redactar el archivo **`README.md`** completo en la raíz con los integrantes, instrucciones de clonado, dependencias (`npm install`), configuración de `.env` y comandos de inicio (`npm start`).


* Generar el archivo comprimido final formato `GrupoX-MovieWeb.zip`.


* Preparar y ensayar la presentación en vivo para la defensa del 05/11 (repartiendo los roles de qué va a explicar cada uno sobre diseño de bases de datos y desafíos superados).