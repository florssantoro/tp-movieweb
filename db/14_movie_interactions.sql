BEGIN;

ALTER TABLE movies.movie_user
    ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS watch_status VARCHAR(20);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'movies.movie_user'::regclass
          AND conname = 'ck_mu_watch_status'
    ) THEN
        ALTER TABLE movies.movie_user ADD CONSTRAINT ck_mu_watch_status
            CHECK (watch_status IN ('want_to_watch', 'watched'));
    END IF;
END $$;

COMMIT;
