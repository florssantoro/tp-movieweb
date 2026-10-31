# MovieWeb Agent Guide

## Project Context

- The application uses Node.js, Express, EJS, PostgreSQL, and MongoDB.
- Run it with `npm start` and verify changes with `npm test`.
- MongoDB stores only the user activity timeline (`activity.js`, collection `user_activity`); PostgreSQL remains the source of truth for users and interactions.
- Keep credentials in the local `.env` file. Never commit secrets or API tokens.

## Shared Skills

- Use `$commit-local-changes` when the user asks to review, stage, and commit local work.
- Use `$pre-push-code-review` when the user asks for a read-only review before pushing.
- Never push unless the user explicitly asks for a push.
