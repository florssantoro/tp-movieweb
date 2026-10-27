# Descubrimiento de películas

La portada muestra tendencias semanales de TMDB con hasta seis tráileres,
géneros y las películas mejor puntuadas del catálogo local (al menos 200 votos).
No incluye una sección de cartelera.

`/explorar` filtra por género y pagina el catálogo. `/que-ver` prioriza géneros
de favoritas o películas puntuadas con 4–5, excluye vistas y permite elegir
género o duración de hasta 100 minutos. Para visitantes ofrece títulos bien
puntuados. `/mi-lista` requiere sesión y usa exclusivamente su usuario.

El feed de tendencias se comparte durante 30 minutos entre visitantes, agrupa
pedidos concurrentes y conserva el último resultado si TMDB falla. Sin un
resultado anterior, la portada muestra un aviso y mantiene el catálogo local.

La ficha puede mostrar películas que todavía no están en PostgreSQL. Abrirla
no escribe datos. Al guardar una interacción autenticada se valida la película
en TMDB y se inserta su ID, título y fecha de estreno en `movie`, respetando la
clave foránea existente de `movie_user`. El resto de la ficha se consulta en
TMDB; no se importan créditos ni relaciones del catálogo automáticamente.

El carrusel avanza cada ocho segundos y ofrece controles manuales y pausa.
Detiene la rotación al recibir foco, interacción táctil o reproducción; la
suspende cuando la pestaña está oculta o el puntero está encima. Con movimiento
reducido no rota automáticamente. Los videos sólo se cargan al abrir el diálogo;
Escape o Cerrar detienen el video y devuelven el foco al enlace original.
Sin JavaScript se conservan el desplazamiento horizontal y los enlaces a YouTube.
