---
name: commit-local-changes
description: Review, verify, stage, and commit coherent local Git changes without pushing. Use when the user asks to commit the current work or create a local commit.
---

# Commit Local Changes

Create one clear local commit from the current repository changes.

## Workflow

1. Inspect the branch, `git status --short`, staged and unstaged diffs, and relevant untracked files. Do not switch branches.
2. Read the actual changes and separate unrelated work. Never discard, reset, stash, or overwrite user changes.
3. Check for `.env` files, tokens, passwords, private keys, generated output, and other files that should not be committed.
4. Stage only explicit paths that belong to the coherent change. Preserve unrelated work outside the commit.
5. Run the repository's relevant checks, including `npm test` for MovieWeb when available.
6. If any relevant check fails, stop without committing and report the failure. The original commit request is not authorization to ignore a failure. Continue only after a later user message explicitly accepts that exact failure.
7. Review the staged diff, then create an English Conventional Commit with a concise subject and useful body.
8. Report the commit hash, complete message, checks run, and final `git status --short`.

## Rules

- Do not push.
- Do not amend unless explicitly requested.
- Do not create an empty commit.
- Do not mix unrelated changes.
- Do not expose secret values in output.
- Do not leave intended commit changes staged without either committing them or clearly reporting why the commit stopped.
