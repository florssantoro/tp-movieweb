# Usuarios e interacciones (2.5)

Sobre la base de películas cargada, ejecutar en orden `13_users.sql`,
`14_movie_interactions.sql` y `15_user_auth.sql`. Para una instalación que ya
tiene usuarios y valoraciones, ejecutar las migraciones 14 y 15 antes de
iniciar la nueva versión. Los scripts pueden ejecutarse nuevamente sin borrar
datos. Usar la conexión PostgreSQL local, sin guardar credenciales en el
repositorio.

`movie_user` mantiene una relación por usuario y película. Favorita es
independiente del estado de visualización (`want_to_watch`, `watched` o NULL).
La puntuación y opinión son opcionales. Quitar la asociación elimina todos
estos datos de esa relación; no elimina el usuario ni la película.

La ficha usa el usuario autenticado de la sesión y precarga su relación. El
formulario completo usa `POST /pelicula/:id/interaccion`; `action=remove`
elimina la asociación.
Guardar todos los campos vacíos también la elimina.
`POST /pelicula/:id/calificar` sigue actualizando solamente puntuación y
opinión, conservando favorita y estado.

Los usuarios creados antes de `15_user_auth.sql` no tenían una contraseña
recuperable y eran datos de prueba, por lo que la migración los elimina junto
con sus interacciones. También resuelve duplicados por mayúsculas conservando
la cuenta más antigua. Las cuentas nuevas se crean desde `/registro`; las
contraseñas se guardan únicamente como hash.

Ejecutar `npm test` contra la base local de desarrollo, con las migraciones
aplicadas. Las pruebas crean usuarios temporales y un esquema de prueba
aislado, y los eliminan al finalizar; necesitan permisos para crear esquemas.
