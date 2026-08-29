# Bugfix Requirements Document

## Introduction

Atlas-Agent loses all memory between restarts. After a process restart, the agent has no recollection of previous conversations, stored facts, or session history — behaving as if it just started for the first time. This is caused by four compounding bugs across the persistence stack: the SQLite database is not reliably flushed to disk, session writes can be lost during abrupt shutdowns, background memory extraction silently times out, and the system prompt only queries memory by keyword (missing recently-stored facts that don't match the current query).

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `getSyncDB()` is called before `getDB()` has completed initialization THEN the system throws an error and all subsequent writes silently fail because `_syncDB` is null

1.2 WHEN `saveToDisk()` is called on process exit THEN the system skips the save if `_dirty` is `false`, even if the last write happened within the 10-second interval and the final in-memory state was never flushed to disk

1.3 WHEN the process is killed (crash, OOM, forced restart) within 5 seconds of the last message THEN the system loses the session because the write-behind timer has not fired and no flush occurs on unhandled termination

1.4 WHEN `extractAndStoreAsync` is called inside `setImmediate` immediately after the agent loop completes THEN the system silently drops the extracted facts because the GLM-5.1 API call times out (90s timeout, connection already saturated from the preceding agent loop request)

1.5 WHEN the agent starts after a restart and `buildSystemPrompt` runs `memoryStore.search(userMsg)` THEN the system returns 0 results if the DB was not saved properly (Bug 1.1/1.2), leaving the agent with no memory context even when facts were stored in the prior session

### Expected Behavior (Correct)

2.1 WHEN `getSyncDB()` is called at any point after `getDB()` has been awaited THEN the system SHALL return a valid `SyncDB` instance and all writes SHALL be reflected in `_dirty = true`

2.2 WHEN `saveToDisk()` is called on process exit THEN the system SHALL always flush the current in-memory DB state to disk regardless of the `_dirty` flag, ensuring the final state is never lost

2.3 WHEN the process receives SIGTERM, SIGINT, or an uncaught exception THEN the system SHALL synchronously flush all dirty session cache entries to SQLite and save the DB to disk before exiting

2.4 WHEN `extractAndStoreAsync` is called after the agent loop THEN the system SHALL use a separate, dedicated API client instance (or a short independent timeout) so that memory extraction does not compete with the main request connection and completes reliably

2.5 WHEN `buildSystemPrompt` runs on startup after a restart THEN the system SHALL inject both keyword-matched memories AND the most recently stored memories (by `created_at` DESC) so that facts from the previous session are always visible even if they don't match the current query

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the process runs normally without interruption THEN the system SHALL CONTINUE TO save the DB to disk every 10 seconds when dirty, preserving the existing periodic-save behavior

3.2 WHEN a session is active and messages are exchanged THEN the system SHALL CONTINUE TO use the write-behind 5-second debounce for session saves, preserving the non-blocking response path

3.3 WHEN `memoryStore.search()` is called with a relevant query THEN the system SHALL CONTINUE TO return keyword-matched and vector-matched results using the existing RRF fusion logic

3.4 WHEN `extractAndStoreAsync` completes successfully THEN the system SHALL CONTINUE TO store extracted facts in SQLite under the correct memory layer and source

3.5 WHEN the agent loop executes tool calls in parallel THEN the system SHALL CONTINUE TO use the shared `openaiClient` for all tool and LLM calls without interference from background memory extraction
