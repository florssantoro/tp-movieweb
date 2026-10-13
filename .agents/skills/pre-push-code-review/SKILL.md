---
name: pre-push-code-review
description: Perform a thorough, read-only review of MovieWeb's local Git changes before a commit, push, or pull request. Use when the user asks whether changes are ready, requests a pre-push review, or wants bugs and risks identified without modifying code.
---

# Pre-Push Code Review

Review MovieWeb changes as a skeptical but practical maintainer. Find concrete defects and meaningful risks without turning the review into a style rewrite.

This skill is read-only. Do not edit, stage, commit, push, reset, stash, clean, or otherwise change repository or remote state. A later request to fix findings is separate authorization.

## Required References

Before reviewing, read:

- [references/review-checklist.md](references/review-checklist.md) for the complete MovieWeb-specific review criteria.
- [references/output-format.md](references/output-format.md) for severity, decision rules, and the required report structure.

## Workflow

1. Establish the review scope.
   - Inspect the active branch and `git status --short`.
   - Determine the correct base branch, normally the remote default branch or the target branch of the current pull request.
   - Inspect committed branch changes, staged changes, unstaged changes, and relevant untracked files.
   - Include user changes already present in the working tree; never discard or alter them.

2. Understand intent before judging implementation.
   - Read the affected code and enough surrounding code to follow each changed path.
   - Consult `AGENTS.md`, relevant TP requirements, tests, configuration, and existing project patterns.
   - Search for callers, routes, templates, queries, and utilities affected by changed contracts.
   - Distinguish defects introduced by the change from unrelated pre-existing issues. Report a pre-existing issue only when the change exposes or materially worsens it.

3. Review using the complete checklist.
   - Prioritize correctness, security, data integrity, regressions, and failed user flows.
   - Apply only checklist sections relevant to the diff, but always perform Git hygiene, secret exposure, and verification checks.
   - Support every finding with a concrete file and line reference plus a realistic failure mode.
   - Do not report personal preferences, speculative risks, or generic advice without an actionable code-level cause.

4. Verify behavior without changing files.
   - Run the narrowest relevant commands already provided by the repository.
   - For ordinary MovieWeb changes, run `npm test` when dependencies and the configured local database are available.
   - Add syntax checks or focused tests when they materially validate the changed path.
   - Do not install dependencies, rewrite snapshots, seed or migrate data, start persistent services, or modify configuration merely to complete a review.
   - If a check cannot run, explain why and treat the resulting uncertainty according to its impact.

5. Report findings first using the required output format.
   - Order findings by severity, then by user impact.
   - Keep the summary brief and keep praise secondary to actionable findings.
   - If there are no findings, say so explicitly and identify any residual risk or unverified area.

## Review Standard

- Prefer a few high-confidence findings over a long list of weak observations.
- Trace both success and failure paths for changed Express routes, database queries, external API calls, and EJS rendering.
- Assume request input and third-party API responses are untrusted.
- Never print secret values found during inspection.
- Do not mark the change `READY` while a relevant required check is failing.
- Do not block a push for minor style preferences or unrelated legacy issues.
