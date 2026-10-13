# MovieWeb Review Checklist

Use the sections relevant to the change. Do not mechanically report every possible concern; report only evidence-backed issues with a realistic impact.

## 1. Change Scope and Git Hygiene

- Compare against the correct base and inspect committed, staged, unstaged, and relevant untracked changes.
- Look for unrelated files, debug output, temporary code, commented-out implementations, generated files, large binaries, and accidental IDE state.
- Verify dependency and lockfile changes agree.
- Check that `.env`, tokens, passwords, private keys, database credentials, and TMDB credentials are not tracked or exposed in diffs, logs, tests, client-side code, or templates.
- Check that examples use placeholders rather than working credentials.
- Identify changes that should be split only when mixing them makes review, rollback, or ownership meaningfully harder.

## 2. Assignment and Behavioral Correctness

- Compare the implementation with the relevant TP requirement, not an assumed feature set.
- Trace the normal user flow from route input through data retrieval to the rendered EJS response.
- Check missing, empty, malformed, duplicate, very large, and unexpected input where realistic.
- Check no-result, partial-result, database-failure, and external-API-failure paths.
- Verify links between search results, movie pages, actor profiles, and director profiles target the correct IDs and routes.
- Verify displayed roles, character names, release years, and movie/person identities come from the intended source.
- Check sorting, filtering, limits, and deduplication for correctness and deterministic behavior.
- Look for unreachable branches, incorrect defaults, swallowed errors, missing returns after responses, and requests that can hang or send twice.
- Preserve compatibility with already completed TP functionality unless the current requirement intentionally changes it.

## 3. Express and Node.js

- Validate route parameters and query parameters on the server before using them.
- Use appropriate HTTP statuses for invalid input, missing resources, upstream failures, and internal errors.
- Ensure asynchronous work is awaited and rejected promises reach an error response.
- Check that server startup is guarded when the app is imported by tests.
- Verify the PostgreSQL pool and test servers are closed by tests and scripts that own them.
- Check middleware and static-file configuration for unintended exposure.
- Look for synchronous or repeated expensive work in request paths.
- Do not demand a new framework or abstraction when the existing Express structure is sufficient for the TP.

## 4. EJS, HTML, and Browser Behavior

- Use escaped EJS output (`<%=`) for untrusted database, request, and TMDB values. Treat unescaped output (`<%-`) as security-sensitive.
- Check generated `href`, image URLs, and attributes for injection, broken values, and missing fallbacks.
- Verify HTML is structurally complete and content does not disappear for empty or partial data.
- Check user-visible loading, empty, error, and unavailable-data states when the flow can produce them.
- Check forms for correct methods, names, required fields, and preservation of meaningful input.
- Verify interactive controls are keyboard-usable and images have useful alternative text when applicable.
- Check layout changes at narrow and wide viewports when CSS or page structure changes.
- Avoid flagging visual preferences unless they cause a concrete usability or assignment problem.

## 5. PostgreSQL and Data Access

- All user-controlled values must use parameterized queries; never interpolate them into SQL.
- When using `LIKE` or `ILIKE`, check whether `%`, `_`, and the escape character should be literal and are handled accordingly.
- Check joins for accidental Cartesian multiplication, duplicate credits, omitted rows, and incorrect join type.
- Check aggregation and deduplication preserve distinct roles or characters correctly.
- Check null values, blank strings, unknown dates, and missing foreign records.
- Require ordering and practical limits for potentially large result sets.
- Look for N+1 queries, repeated full-table scans, overly broad `SELECT *`, and payloads much larger than the page needs.
- Evaluate indexes only when the changed query and expected dataset make the impact credible.
- For schema or seed changes, check foreign keys, uniqueness, ordering, idempotence, compatibility with existing local data, and whether a failed load leaves partial state.
- Do not modify or reseed the user's database during a read-only review.

## 6. TMDB and Other External APIs

- Keep TMDB credentials server-side and load them from environment variables. Never expose bearer tokens or API keys in EJS, browser JavaScript, URLs committed to the repo, or logs.
- Verify the code uses the intended TMDB authentication method and does not mix the API key with the read-access token incorrectly.
- Validate IDs before making upstream requests.
- Handle non-2xx responses, network errors, timeouts, invalid JSON, missing fields, and rate limits without crashing the Express request.
- Check that an upstream failure produces a useful fallback or appropriate response and does not erase valid PostgreSQL content unnecessarily.
- Treat TMDB responses as optional and untrusted: check nullable fields, absent posters/backdrops, empty arrays, and unexpected values.
- Construct TMDB image URLs only when a path exists and use the intended image size.
- Avoid duplicate upstream requests for data already available during the same request.
- Check attribution or logo usage when the changed UI introduces TMDB-sourced content.
- Tests should mock external HTTP calls or isolate network behavior; routine tests should not consume real credentials or depend on live TMDB availability.

## 7. Security

- Look for SQL injection, XSS, HTML or attribute injection, command injection, path traversal, SSRF, unsafe redirects, and unsafe file handling where the changed code creates a credible path.
- Assume all request data and third-party API data are untrusted.
- Check that validation is enforced server-side, not only through HTML attributes.
- Do not expose stack traces, database errors, credentials, or full upstream responses to users.
- Check logs for tokens, passwords, authorization headers, sensitive URLs, or excessive personal data.
- Consider denial-of-service risks from unbounded queries, oversized responses, repeated external calls, and missing timeouts.
- Do not inflate theoretical concerns without a concrete entry point and impact.

## 8. Error Handling and Resilience

- Every expected failure should produce one response and leave resources in a valid state.
- Distinguish invalid input, not found, database failure, and external API failure where that distinction helps users or callers.
- Check fallback behavior when PostgreSQL succeeds but TMDB fails, and vice versa, according to the intended feature.
- Ensure error paths do not reference undefined variables or assume a response shape that only exists on success.
- Verify retries, if introduced, are bounded and safe.
- Check cleanup of servers, database pools, timers, and mocked state in tests.

## 9. Performance

- Flag performance only when likely or measurable for this project.
- Check unbounded result sets, broad selects, repeated joins, N+1 queries, duplicate API requests, and very large rendered HTML.
- Check loops over multiplied join results and repeated linear searches when dataset size makes them material.
- Avoid recommending caches, queues, pagination frameworks, or new dependencies without demonstrated need.

## 10. Maintainability and Reuse

- Follow existing CommonJS, Express, EJS, and PostgreSQL conventions unless there is a concrete reason to change them.
- Search before claiming logic is duplicated or a helper already exists.
- Identify duplicated validation, request construction, or formatting only when centralizing it would reduce real inconsistency or risk.
- Look for unclear responsibilities, misleading names, dead code, unused variables, and configuration that no longer matches runtime behavior.
- Prefer straightforward coursework-appropriate code over production-scale abstraction.
- Do not require TypeScript, React, NestJS, an ORM, or another stack unless the TP or repository explicitly adopts it.

## 11. Tests and Verification

- Important route behavior should have tests for success and meaningful failure paths.
- Bug fixes should include the smallest useful regression test.
- Search tests should cover empty input, no results, and special wildcard characters when relevant.
- Profile tests should cover valid people, roles or characters, invalid IDs, and missing records when relevant.
- TMDB tests should not call the live service and should cover success, missing optional data, and upstream failure when relevant.
- Check that tests assert user-visible behavior or contracts rather than only implementation details.
- Check for order dependence, shared mutable state, hard-coded IDs without a stable fixture assumption, and resources left open after the test run.
- Run `npm test` when possible. Also run focused syntax or test commands when they add confidence.
- State every check actually run and every relevant check that could not run.

## 12. Dependencies and Configuration

- Confirm a new dependency is necessary, used, compatible with the current Node.js version, and reflected in the lockfile.
- Prefer platform APIs or existing dependencies for small tasks when they are adequate.
- Check `.env.example` documents variable names with non-secret placeholders and stays consistent with runtime code.
- Check defaults do not silently point to the wrong database, schema, port, or external service.
- Verify scripts in `package.json` match documented commands and terminate correctly.
