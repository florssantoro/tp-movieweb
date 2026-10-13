# Review Output and Decision Rules

## Severity

- **Critical**: credential exposure, exploitable security issue, destructive data behavior, or a change that makes the application fundamentally unsafe or unusable.
- **High**: a reproducible functional failure in a normal flow, major regression, serious data-integrity issue, or important error path that breaks the feature.
- **Medium**: meaningful edge-case bug, fragile behavior, missing important regression coverage, maintainability risk, or non-critical performance problem worth fixing before merge.
- **Low**: small cleanup or consistency improvement with limited impact. Do not report pure formatting preferences.

Do not inflate severity. Explain the realistic trigger and impact for every finding.

## Decision

- `BLOCKED`: one or more Critical or High findings, or a required verification command fails for a reason caused by the change.
- `CHANGES RECOMMENDED`: only Medium or Low findings remain.
- `READY`: no meaningful findings and relevant verification passes.

An unavailable check is not automatically blocking. State the resulting uncertainty and decide based on how central that check is to the change.

## Required Report Structure

Start with findings. Omit empty severity sections.

```markdown
## Pre-Push Review

**Status:** READY | CHANGES RECOMMENDED | BLOCKED
**Scope:** <base and reviewed local/branch changes>
**Findings:** <count>

### High

- `path/file.js:42` — **Concise finding title**
  Explain the exact problem, the input or state that triggers it, its impact, and the smallest practical recommendation.

### Medium

- ...

### Low

- ...

### Verification

- `npm test` — passed (N tests)
- `<other command>` — passed/failed/not run, with reason

### Residual Risk

State any important behavior not exercised, such as unavailable local PostgreSQL data or an external API path tested only with mocks. Omit when none remains.

### Recommendation

READY TO PUSH | CHANGES RECOMMENDED BEFORE PUSH | DO NOT PUSH YET
```

When there are no findings, say `No actionable findings.` immediately after the status instead of manufacturing praise or low-value issues.

## Evidence Rules

- Use repository-relative file paths and tight, current line references.
- Verify line numbers after the final diff inspection.
- Explain cause and impact, not only the symptom.
- Recommend a direction, not a full implementation, unless the user separately asks for fixes.
- Do not repeat the same root cause as multiple findings.
- Keep positive observations brief and secondary; the purpose is risk detection.
