# Implementation Plan

- [ ] 1. Write bug condition exploration tests
  - **Property 1: Bug Condition** - Data Persists Across Restart
  - **CRITICAL**: These tests MUST FAIL on unfixed code — failure confirms each bug exists
  - **DO NOT attempt to fix the tests or the code when they fail**
  - **NOTE**: These tests encode the expected behavior — they will validate the fix when they pass after implementation
  - **GOAL**: Surface counterexamples that demonstrate each of the four bugs
  - **Scoped PBT Approach**: Each sub-test targets the concrete failing case for its bug
  - Write the following four test cases (one per bug):
    - **Test 1.A — DB exit save**: Initialize DB via `getDB()`, write a row (sets `_dirty=true`), call `saveToDisk()` to flush and reset `_dirty=false`, write another row, then invoke the `process.on('exit')` handler directly — assert the second row IS present in the exported file. Expected: FAILS because `_dirty` is false and the exit handler skips the write.
    - **Test 1.B — Session SIGTERM**: Call `sessionStore.save(1, [{role:'user',content:'test'}])`, wait 500ms (less than write-behind delay), invoke the `process.on('SIGTERM')` handler directly — assert the session IS in SQLite. Expected: FAILS because no SIGTERM handler exists.
    - **Test 1.C — Extraction timeout**: Mock `createChatCompletion` to return a promise that never resolves, call `memoryStore.extractAndStoreAsync("test", "test")` with a 16s test timeout — assert it resolves within 16s. Expected: FAILS because there is no timeout guard (hangs for 90s).
    - **Test 1.D — Memory recency fallback**: Call `memoryStore.store("Marcelo prefiere TypeScript", "semantic")`, then call `buildSystemPrompt("hola")` — assert the returned string contains "TypeScript". Expected: FAILS because LIKE search on "hola" returns 0 results and there is no recency fallback.
  - Run all four tests on UNFIXED code
  - **EXPECTED OUTCOME**: All four tests FAIL (this is correct — it proves each bug exists)
  - Document the exact counterexamples found for each test
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Hot Path Unaffected
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for non-buggy inputs (normal operation paths)
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements
  - Property-based testing generates many test cases for stronger guarantees
  - Write the following preservation tests:
    - **Test 2.A — Normal session write-behind**: Observe that `sessionStore.save()` followed by a 6s wait results in the session being in SQLite. Write property test: for any session history, after 6s the data IS persisted. Verify PASSES on unfixed code.
    - **Test 2.B — Periodic DB save**: Observe that after `getDB()` init, writing data and waiting 11s results in the DB file being updated. Write property test: for any write, after 11s the file IS updated. Verify PASSES on unfixed code.
    - **Test 2.C — Memory search unchanged**: Observe that `memoryStore.search("TypeScript")` returns the stored "Marcelo prefiere TypeScript" fact. Write property test: for any non-trivial query that matches stored content, search returns ≥1 result. Verify PASSES on unfixed code.
    - **Test 2.D — Response path non-blocking**: Observe that `sessionStore.save()` returns synchronously (< 1ms). Write property test: for any history, save() completes in < 5ms. Verify PASSES on unfixed code.
  - Run all preservation tests on UNFIXED code
  - **EXPECTED OUTCOME**: All preservation tests PASS (confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [-] 3. Fix cross-session memory loss (4 bugs)

  - [x] 3.1 Fix Bug 1 — atlas_db.ts: unconditional exit save + SIGTERM handler
    - Move signal handler registration to module load time (outside `getDB()`) so they fire even if `getDB()` was never awaited
    - Add `saveToDiskForced()` function that saves regardless of `_dirty` flag — used only on exit paths
    - Change `process.on('exit', saveToDisk)` to `process.on('exit', saveToDiskForced)`
    - Add `process.on('SIGTERM', () => { saveToDiskForced(); process.exit(0); })`
    - Keep the existing `process.on('SIGINT', ...)` handler but point it to `saveToDiskForced`
    - Keep `saveToDisk()` (dirty-gated) for the periodic 10s interval — do NOT change that path
    - _Bug_Condition: isBugCondition(event) where event.type = 'process_exit' AND _dirty = false_
    - _Expected_Behavior: DB file contains all writes made before exit, regardless of _dirty state_
    - _Preservation: 10s periodic save interval unchanged; normal write path unchanged_
    - _Requirements: 2.1, 2.2, 3.1_

  - [x] 3.2 Fix Bug 2 — session_store.ts: aggressive flush on all termination signals
    - Reduce `WRITE_DELAY_MS` from `5_000` to `1_500`
    - Add `process.on('SIGTERM', () => { for (const [id] of cache) flush(id); process.exit(0); })`
    - Add `process.on('uncaughtException', (err) => { console.error('[SESSION] Flushing on crash:', err); for (const [id] of cache) flush(id); })` — do NOT call `process.exit` here, let the default handler propagate
    - Keep existing `SIGINT` and `exit` handlers unchanged
    - _Bug_Condition: isBugCondition(event) where event.type = 'process_killed' AND timeSinceLastWrite < 5000_
    - _Expected_Behavior: Session data is in SQLite before process exits on SIGTERM or crash_
    - _Preservation: Write-behind debounce still used for normal operation; save() still non-blocking_
    - _Requirements: 2.3, 3.2_

  - [x] 3.3 Fix Bug 3 — memory_store.ts: extraction timeout guard
    - Wrap the `createChatCompletion` call in `extractAndStoreAsync` with `Promise.race` against a 15-second timeout
    - If timeout fires, log `[MEMORY] extractAndStoreAsync timed out — skipping` and return
    - Reduce `max_tokens` from 400 to 200 (extraction prompt is simple, reduces API time)
    - Keep the outer `try/catch` and `.catch(() => {})` call site unchanged
    - _Bug_Condition: isBugCondition(event) where event.type = 'extraction_attempt' AND apiConnection.isSaturated()_
    - _Expected_Behavior: extractAndStoreAsync resolves within 16s regardless of API saturation_
    - _Preservation: When extraction succeeds, facts are stored identically to before_
    - _Requirements: 2.4, 3.4, 3.5_

  - [x] 3.4 Fix Bug 4 — telegram.ts: memory recency fallback in buildSystemPrompt
    - In `buildSystemPrompt`, after the existing `memoryStore.search(userMsg, 4)` call, check if fewer than 2 results were returned
    - If so, call `memoryStore.getRecent(7, 5)` and append results not already in the search results (deduplicate by `id`)
    - Limit the recency additions to 3 entries to stay within the `TOKEN_BUDGET.memoryContext` budget
    - Keep the existing `promptCache` caching logic — update the cache key to reflect that recency is now included (e.g., `mem_r_${userMsg.slice(0, 60)}`) to avoid stale cache entries from before the fix
    - _Bug_Condition: isBugCondition(event) where event.type = 'prompt_build' AND searchResults.length < 2_
    - _Expected_Behavior: System prompt contains recent memories even when query doesn't match stored facts_
    - _Preservation: For queries that return ≥2 search results, behavior is identical to before_
    - _Requirements: 2.5, 3.3_

  - [ ] 3.5 Verify bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - Data Persists Across Restart
    - **IMPORTANT**: Re-run the SAME four tests from task 1 — do NOT write new tests
    - The tests from task 1 encode the expected behavior for each bug
    - When all four pass, it confirms all four bugs are fixed
    - Run all four exploration tests (1.A, 1.B, 1.C, 1.D) from step 1
    - **EXPECTED OUTCOME**: All four tests PASS (confirms all bugs are fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ] 3.6 Verify preservation tests still pass
    - **Property 2: Preservation** - Hot Path Unaffected
    - **IMPORTANT**: Re-run the SAME four tests from task 2 — do NOT write new tests
    - Run preservation tests (2.A, 2.B, 2.C, 2.D) from step 2
    - **EXPECTED OUTCOME**: All preservation tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [ ] 4. Checkpoint — Ensure all tests pass
  - Run the full test suite
  - Verify all 8 tests (4 exploration + 4 preservation) pass
  - Do a manual smoke test: start the agent, send a message with a specific fact ("mi color favorito es el azul"), restart the process, send "qué sabés de mí?" — verify the fact appears in the response
  - Ask the user if any questions arise before closing the spec
