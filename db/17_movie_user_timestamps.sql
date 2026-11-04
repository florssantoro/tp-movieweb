BEGIN;

ALTER TABLE movies.movie_user
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION movies.set_movie_user_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.created_at = OLD.created_at;
    IF (NEW.rating, NEW.opinion, NEW.is_favorite, NEW.watch_status)
        IS DISTINCT FROM
       (OLD.rating, OLD.opinion, OLD.is_favorite, OLD.watch_status) THEN
        NEW.updated_at = CURRENT_TIMESTAMP;
    ELSE
        NEW.updated_at = OLD.updated_at;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_movie_user_updated_at ON movies.movie_user;
CREATE TRIGGER trg_movie_user_updated_at
    BEFORE UPDATE ON movies.movie_user
    FOR EACH ROW
    EXECUTE FUNCTION movies.set_movie_user_updated_at();

CREATE INDEX IF NOT EXISTS idx_movie_user_profile_recent
    ON movies.movie_user (user_id, updated_at DESC, movie_id);

CREATE INDEX IF NOT EXISTS idx_movie_user_profile_rating
    ON movies.movie_user (user_id, rating DESC, movie_id);

COMMIT;
