BEGIN;

-- Los datos provistos perdieron la barra de escapes JSON como \u00f1 y
-- quedaron guardados como u00f1. Esta función recupera esos caracteres sin
-- confundir palabras válidas que casualmente contienen "u" y letras hex.
CREATE OR REPLACE FUNCTION pg_temp.decode_unicode_escapes(
    input_text TEXT,
    decode_all BOOLEAN DEFAULT FALSE
) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
    decoded TEXT := input_text;
    matched TEXT[];
    escape_pattern TEXT := CASE
        WHEN decode_all THEN 'u([0-9A-Fa-f]{4})'
        ELSE 'u([0-9][0-9A-Fa-f]{3})'
    END;
BEGIN
    LOOP
        matched := regexp_match(decoded, escape_pattern);
        EXIT WHEN matched IS NULL;
        decoded := regexp_replace(
            decoded,
            escape_pattern,
            chr(('x' || matched[1])::bit(16)::int)
        );
    END LOOP;
    RETURN decoded;
END;
$$;

-- Los nombres de idiomas pueden estar compuestos completamente por escapes
-- (por ejemplo japonés, árabe o coreano), por eso se decodifican todos.
UPDATE movies.language
SET language_name = pg_temp.decode_unicode_escapes(language_name, TRUE)
WHERE language_name ~ 'u[0-9A-Fa-f]{4}';

-- En el resto de las tablas se decodifican los escapes inequívocos. También
-- se admiten alfabetos cuyos valores comienzan con dos o más escapes seguidos.
UPDATE movies.person
SET person_name = pg_temp.decode_unicode_escapes(
    person_name,
    person_name ~ '^(u[0-9A-Fa-f]{4}){2,}'
)
WHERE person_name ~ 'u[0-9][0-9A-Fa-f]{3}'
   OR person_name ~ '^(u[0-9A-Fa-f]{4}){2,}';

UPDATE movies.movie_cast
SET character_name = pg_temp.decode_unicode_escapes(
    character_name,
    character_name ~ '^(u[0-9A-Fa-f]{4}){2,}'
)
WHERE character_name ~ 'u[0-9][0-9A-Fa-f]{3}'
   OR character_name ~ '^(u[0-9A-Fa-f]{4}){2,}';

UPDATE movies.production_company
SET company_name = pg_temp.decode_unicode_escapes(company_name)
WHERE company_name ~ 'u[0-9][0-9A-Fa-f]{3}';

UPDATE movies.keyword
SET keyword_name = pg_temp.decode_unicode_escapes(
    keyword_name,
    keyword_name ~ '^(u[0-9A-Fa-f]{4}){2,}'
)
WHERE keyword_name ~ 'u[0-9][0-9A-Fa-f]{3}'
   OR keyword_name ~ '^(u[0-9A-Fa-f]{4}){2,}';

COMMIT;
