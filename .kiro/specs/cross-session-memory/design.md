# Cross-Session Memory Loss — Bugfix Design

## Overview

Atlas-Agent forgets everything between restarts due to four compounding bugs in the persistence stack. The fix targets each bug independently with minimal, surgical changes: (1) make `saveToDisk` unconditional on exit, (2) add SIGTERM/uncaughtException handlers and reduce the session write-behind delay, (3) decouple memory extraction from the main API connection using a timeout guard, and (4) augment the system prompt memory query with a recency fallback.

## Glossary

- **Bug_Condition (C)**: Any of the four conditions that cause data to be lost between process restarts
- **Property (P)**: After a restart, the agent SHALL have access to facts and session history stored in the previous session
- **Preservation**: All existing hot-path behaviors (response latency, tool execution, session debounce) must remain unchanged
- **`saveToDisk()`**: Function in `atlas_db.ts` that exports the sql.js in-memory DB to `data/atlas.db`
- **`_dirty`**: Boolean flag in `atlas_db.ts` that gates whether `saveToDisk()` actually writes
- **`SyncDB`**: Synchronous wrapper around the sql.js DB instance, created lazily after `getDB()` resolves
- **write-behind**: The 5-second debounce timer in `session_store.ts` that delays SQLite writes to avoid blocking the response path
- **`extractAndStoreAsync`**: Background function in `memory_store.ts` that calls the LLM to extract facts from a conversation snippet and stores them in SQLite

## Bug Details

### Bug Condition

The bug manifests when the process restarts and the persistence layer has not reliably written its in-memory state to disk. There are four distinct sub-conditions, any one of which is sufficient to cause memory loss.

**Formal Specification:**
```
FUNCTION isBugCondition(event)
  INPUT: event of type ProcessLifecycleEvent | WriteEvent | ExtractionEvent
  OUTPUT: boolean

  RETURN (
    // Bug 1: DB save skipped because _dirty is false at exit
    event.type = 'process_exit' AND _dirty = false AND _db.hasUnflushedWrites()
  ) OR (
    // Bug 2: Session lost because process killed before write-behind timer fires
    event.type = 'process_killed' AND sessionCache.hasDirtyEntries() AND timeSinceLastWrite < 5000
  ) OR (
    // Bug 3: Memory extraction times out silently
    event.type = 'extraction_attempt' AND apiConnection.isSaturated() AND extractionTimeout >= 90000
  ) OR (
    // Bug 4: Memory search returns empty on restart
    event.type = 'prompt_build' AND db.isEmpty() AND recentMemories.count > 0
  )
END FUNCTION
```

### Examples

- **Bug 1**: Agent stores 10 facts during a session. The 10s save timer fires at t=0s and t=10s. At t=14s the user sends a message, 3 more facts are stored. At t=15s the process is restarted. `saveToDisk()` is called on `exit` but `_dirty` was reset to `false` at t=10s — the last 3 facts are lost.
- **Bug 2**: User sends a message at t=0s. Session is updated in memory. At t=3s the process crashes. The write-behind timer was set for t=5s — the session is never written to SQLite.
- **Bug 3**: Agent finishes a 12-round tool loop at t=0s. `setImmediate` fires at t=~1ms and calls `extractAndStoreAsync`. The GLM API is still processing the previous connection's teardown. The extraction call times out after 90s with no error logged — facts are silently dropped.
- **Bug 4**: After a clean restart where Bug 1 was NOT triggered, the DB has facts. User says "hola". `memoryStore.search("hola", 4)` runs a LIKE query — no facts contain "hola" — returns 0 results. The agent has no memory context despite having stored facts.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- The 10-second periodic save interval must continue to work as-is for normal operation
- The 5-second write-behind debounce for sessions must remain (non-blocking response path)
- The `openaiClient` shared instance must continue to be used for all agent loop calls
- The `memoryStore.search()` RRF fusion logic must remain unchanged
- The `setImmediate` wrapper around post-processing must remain (non-blocking)

**Scope:**
All inputs that do NOT involve process termination or the first message after a restart should be completely unaffected by this fix. This includes:
- Normal message processing and tool execution
- Periodic DB saves during a running session
- Session reads (always from in-memory cache)
- Embedding queue processing

## Hypothesized Root Cause

### Bug 1 — `_dirty` flag cleared before final writes

`saveToDisk()` resets `_dirty = false` after each successful save. The `process.on('exit')` handler calls `saveToDisk()` which checks `_dirty` first. If the last periodic save happened at t=10s and new writes occurred at t=14s, `_dirty` is `true` — this case IS handled. However, if the periodic save fires at t=14.5s (resetting `_dirty = false`) and the process exits at t=14.6s with no new writes, the state IS saved. The real risk is the race between the 10s timer and the exit handler. The safest fix is to make the exit-path `saveToDisk()` unconditional (ignore `_dirty`).

Additionally, the `process.on('exit')` handler is registered inside `getDB()` — if `getDB()` is never awaited before exit (e.g., during a fast crash), the handler is never registered.

### Bug 2 — No flush on SIGTERM or uncaught exceptions

`session_store.ts` handles `SIGINT` but not `SIGTERM` (the default signal sent by process managers like PM2, Docker, systemd). Crashes (uncaught exceptions) are not handled at all. The write-behind delay of 5 seconds is also long relative to typical restart cycles.

### Bug 3 — Memory extraction competes with main API connection

`extractAndStoreAsync` uses `createChatCompletion` which calls the same `openaiClient` instance. The GLM-5.1 endpoint has a 90-second timeout. After a multi-round agent loop, the HTTP connection pool may be saturated or the server may be rate-limiting. The extraction call is fire-and-forget with `.catch(() => {})` — failures are invisible. The fix is to add an explicit short timeout (e.g., 15s) to the extraction call so it fails fast rather than hanging.

### Bug 4 — Memory injection is query-dependent only

`buildSystemPrompt` only injects memories that match the current user message via LIKE search. On the first message after a restart ("hola", "qué tal", etc.), the query is too generic to match stored facts. The fix is to also inject the N most recently stored memories as a fallback, ensuring continuity regardless of query content.

## Correctness Properties

Property 1: Bug Condition — Data Persists Across Restart

_For any_ process lifecycle event where data was written to the in-memory DB or session cache during a session, the fixed persistence layer SHALL ensure that data is readable from disk after a process restart, regardless of whether the process exited cleanly (SIGINT), was terminated (SIGTERM), or crashed (uncaught exception).

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

Property 2: Preservation — Hot Path Unaffected

_For any_ message processing event that does NOT involve process termination or the first post-restart prompt build, the fixed code SHALL produce the same observable behavior as the original code: same response latency profile, same session debounce timing, same memory search results for non-trivial queries, and same tool execution behavior.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

**File: `src/core/atlas_db.ts`**

**Function: `saveToDisk()` and `getDB()`**

**Specific Changes:**
1. **Unconditional exit save**: Change the `process.on('exit')` handler to call a variant of `saveToDisk()` that ignores `_dirty` — always export and write if `_db` exists.
2. **SIGTERM handler**: Register `process.on('SIGTERM', ...)` alongside the existing `SIGINT` handler in `getDB()`.
3. **Early handler registration**: Move signal handler registration to module load time (outside `getDB()`) so they fire even if `getDB()` was never awaited.

```typescript
// Unconditional save — used on exit paths
function saveToDiskForced(): void {
  if (!_db) return;
  try {
    const data: Uint8Array = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    _dirty = false;
  } catch (e) {
    console.error('[DB] Save error:', e);
  }
}

// Register at module load — not inside getDB()
process.on('exit', saveToDiskForced);
process.on('SIGINT', () => { saveToDiskForced(); process.exit(0); });
process.on('SIGTERM', () => { saveToDiskForced(); process.exit(0); });
```

---

**File: `src/core/session_store.ts`**

**Specific Changes:**
1. **Reduce write-behind delay**: Change `WRITE_DELAY_MS` from `5_000` to `1_500` — still non-blocking but much less exposure to data loss.
2. **Add SIGTERM handler**: Register `process.on('SIGTERM', ...)` to flush all dirty sessions.
3. **Add uncaughtException handler**: Register `process.on('uncaughtException', ...)` to flush before crash (best-effort).

```typescript
const WRITE_DELAY_MS = 1_500; // reduced from 5000

process.on('SIGTERM', () => { for (const [id] of cache) flush(id); process.exit(0); });
process.on('uncaughtException', (err) => {
  console.error('[SESSION] Uncaught exception, flushing sessions:', err);
  for (const [id] of cache) flush(id);
  // Do NOT call process.exit here — let the default handler do it
});
```

---

**File: `src/core/memory_store.ts`**

**Function: `extractAndStoreAsync`**

**Specific Changes:**
1. **Add extraction timeout**: Wrap the `createChatCompletion` call with a `Promise.race` against a 15-second timeout. If it times out, log a warning and return without storing.
2. **Use smaller model or lower max_tokens**: The extraction prompt is simple — reduce `max_tokens` from 400 to 200 and consider using a faster model if configured.

```typescript
async extractAndStoreAsync(conversationText: string, source: string): Promise<void> {
  const EXTRACTION_TIMEOUT_MS = 15_000;
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('extraction timeout')), EXTRACTION_TIMEOUT_MS)
    );
    const extractionPromise = createChatCompletion({ ... });
    const res = await Promise.race([extractionPromise, timeoutPromise]);
    // ... store facts
  } catch (e: any) {
    if (e.message === 'extraction timeout') {
      console.warn('[MEMORY] extractAndStoreAsync timed out — skipping');
    }
    // other errors: silent fail as before
  }
}
```

---

**File: `src/interfaces/telegram.ts`**

**Function: `buildSystemPrompt`**

**Specific Changes:**
1. **Add recency fallback**: After the LIKE search, if fewer than 2 results are returned, also query `memoryStore.getRecent(7, 5)` and append those to the memory context section.
2. **Deduplicate**: Filter out any recent entries whose IDs already appear in the search results.

```typescript
// After existing search:
const memories = memoryStore.search(userMsg, 4);
let allMemories = [...memories];

if (allMemories.length < 2) {
  const recent = memoryStore.getRecent(7, 5);
  const existingIds = new Set(allMemories.map(m => m.id));
  const newRecent = recent.filter(m => !existingIds.has(m.id));
  allMemories = [...allMemories, ...newRecent.slice(0, 3)];
}

if (allMemories.length > 0) {
  memoryContext = '\n## Memoria Relevante\n' +
    allMemories.map(m => `- [${m.layer}] ${m.content.slice(0, 150)}`).join('\n');
}
```

## Testing Strategy

### Validation Approach

The testing strategy follows the bug condition methodology: first write tests that demonstrate each bug on unfixed code (exploration), then write preservation tests that verify non-buggy paths are unaffected, then apply the fix and verify both sets pass.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate each of the four bugs BEFORE implementing the fix. Confirm or refute the root cause analysis.

**Test Plan**: Write unit tests that simulate the exact failure conditions for each bug. Run on UNFIXED code — all should FAIL.

**Test Cases**:
1. **DB Exit Save Test**: Write data to DB, call `saveToDisk()` to reset `_dirty`, write more data, then call the `exit` handler — verify the second batch IS in the file (will fail on unfixed code because `_dirty` is false)
2. **Session SIGTERM Test**: Write a session, wait < 1.5s, simulate SIGTERM — verify session IS in SQLite (will fail on unfixed code — no SIGTERM handler)
3. **Extraction Timeout Test**: Mock `createChatCompletion` to delay 20s, call `extractAndStoreAsync` — verify it returns within 16s without hanging (will fail on unfixed code — no timeout guard)
4. **Memory Recency Test**: Store 3 facts, call `buildSystemPrompt("hola")` — verify memory context is non-empty (will fail on unfixed code — LIKE search returns 0 for "hola")

**Expected Counterexamples**:
- DB exit handler skips write when `_dirty = false` even with unwritten state
- No SIGTERM handler registered — process exits without flushing sessions
- `extractAndStoreAsync` hangs for 90s before timing out
- `buildSystemPrompt` returns empty memory context for generic greetings

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed code produces the expected behavior.

**Pseudocode:**
```
FOR ALL event WHERE isBugCondition(event) DO
  result := fixedPersistenceLayer(event)
  ASSERT dataIsReadableAfterRestart(result)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed code produces the same result as the original.

**Pseudocode:**
```
FOR ALL event WHERE NOT isBugCondition(event) DO
  ASSERT originalBehavior(event) = fixedBehavior(event)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because the input space (message content, timing, tool combinations) is large and edge cases are hard to enumerate manually.

**Test Cases**:
1. **Normal Session Persistence**: Verify sessions written after 1.5s are still saved correctly (same as before, just faster)
2. **Periodic DB Save**: Verify the 10s interval save still fires and writes dirty data
3. **Memory Search Unchanged**: Verify `memoryStore.search("specific query")` still returns the same results as before for non-trivial queries
4. **Response Latency**: Verify that the reduced write-behind delay does not add measurable latency to the response path

### Unit Tests

- Test `saveToDiskForced()` saves even when `_dirty = false`
- Test SIGTERM handler flushes sessions to SQLite
- Test `extractAndStoreAsync` respects 15s timeout
- Test `buildSystemPrompt` includes recent memories when search returns < 2 results

### Property-Based Tests

- Generate random session histories and verify they survive simulated SIGTERM
- Generate random memory content and verify recency fallback returns them after restart
- Generate random conversation snippets and verify extraction either completes or times out within 16s

### Integration Tests

- Full restart simulation: write facts → kill process → restart → verify facts appear in system prompt
- Session continuity: send messages → restart → verify conversation history is restored
- Memory extraction under load: run agent loop → verify extraction completes or fails fast (not hangs)
