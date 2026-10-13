---
name: pre-push-code-review
description: Perform a read-only review of local Git changes before pushing. Use when the user asks to review current work, check readiness, or find bugs and risks before a push.
---

# Pre-Push Code Review

Review the current local changes without modifying the working tree.

## Workflow

1. Inspect the active branch, status, staged and unstaged diffs, and relevant untracked files.
2. Determine the appropriate base branch and read surrounding code needed to understand behavior.
3. Check correctness, regressions, validation, error handling, security, secret exposure, database behavior, performance, and meaningful missing tests.
4. For MovieWeb, pay particular attention to Express routes, EJS escaping and links, PostgreSQL query parameters and result size, environment configuration, and consistency with the current assignment. Review MongoDB only when the change actually touches it.
5. Run available non-destructive checks such as `npm test`. Never alter files merely to make the review pass.
6. Report actionable findings first, ordered by severity, with file and line references. Then list verification performed and a short final recommendation.

## Decision

- `BLOCKED`: at least one critical or high-severity issue, or an important verification command fails.
- `CHANGES RECOMMENDED`: only medium or low findings remain.
- `READY`: no meaningful findings and relevant verification passes.

## Rules

- Do not edit, stage, commit, push, reset, stash, or clean files.
- Prefer a few evidence-backed findings over speculative or stylistic comments.
- State clearly when a relevant check could not be run.
- Check for credentials, `.env` files, tokens, and private keys without printing their values.
