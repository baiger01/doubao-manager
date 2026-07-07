# Loose Coupling Architecture Design

## Goal

Refactor the current Electron + Node + React application toward a loosely coupled architecture without changing user-facing behavior in one large rewrite.

The main objective is to remove the current hot-path coupling that makes the app feel less smooth after recent changes:

- Frontend state updates currently broadcast through one large React context.
- Backend generation routes directly coordinate jobs, generation calls, downloads, persistence, and websocket events.
- External API, license heartbeat, token verification, and proxy handling have security/performance-sensitive work that should stay behind explicit service/presenter boundaries.
- Backend HTTP proxy, external Chrome proxy, and Electron webview proxy use different runtime stacks but currently share unclear configuration semantics.

The refactor should be incremental, testable, and reversible by phase.

> Updated on 2026-07-05 after a focused code review and several remediation rounds. This document reflects current repository direction rather than the initial pre-remediation snapshot. For the grounded audit and fix status, see `docs/codebase-review-2026-07-05.md`.

## Current State Summary

Several high-risk correctness issues have already been reduced:

- `/ext` generation persistence now threads `conversationId`
- frontend unknown-job fallback no longer treats arbitrary jobs as belonging to the current conversation
- single-account deletion now removes persisted profile data
- import failure now attempts rollback cleanup
- `JobManager` now has bounded queue admission (`maxQueueSize`)
- visible conversation results are being re-centered around derived runtime state rather than ad hoc UI mutation
- frontend conversation/generation orchestration now lives in `web/src/domains/conversation-generation-domain.js`, with `store.jsx` composing that domain into the app-wide provider
- frontend Claude text-chat state now lives in `web/src/domains/claude-chat-domain.js`
- frontend license state and bulk account login/import state now live in `web/src/domains/license-domain.js` and `web/src/domains/account-bulk-domain.js`
- account deletion now preserves platform-level conversation history while detaching deleted account ownership
- conversation APIs are platform-scoped internally; `accountId` remains a compatibility input only
- `/api/generate` and `/ext` share `services/generation-job-submitter.js` for job submission/quota/persistence wiring
- image API config and API token/MCP presentation have focused helper services

This means the refactor can now focus more on **state decomposition and semantic cleanup**, not only urgent correctness hazards.

## Recommended Approach

Use a boundary-first incremental refactor.

Do not do a full rewrite. Do not only patch individual symptoms. First introduce stable service boundaries around the highest-risk paths, keep public APIs compatible, then split large internals only after the boundaries are covered by regression tests.

This approach is recommended because the workspace already has many active changes and the current behavior spans API routes, Electron, browser automation, generated media, license state, and React UI state. A full rewrite would create too much regression risk, while small isolated patches would leave the same coupling in place.

## Current Coupling Problems

### Backend HTTP and Generation

`server.js` directly constructs most managers and passes them into multiple route trees. The route layer knows too much about business workflows.

`routes/generate.js` and `routes/ext.js` now share `services/generation-job-submitter.js` for the common async job submission/quota/persistence path. Route handlers are thinner than before, though job DTO shape and deeper generation parsing/transport are still future seams.

`services/job-manager.js` still mixes:

- job storage
- execution
- broadcasting
- TTL cleanup
- queueing policy
- public listing shape

Bounded queue admission now exists, but job lifecycle and DTO exposure are still not cleanly separated.

`services/media-downloader.js` still depends on `generationService.httpRequest()`, so media download remains coupled to generation transport concerns.

`services/generation-service.js` remains the largest backend coupling point, but prompt construction has moved to `services/generation/prompt-builder.js`.

### Frontend State and Rendering

`web/src/store.jsx` remains the highest frontend integration hotspot, but conversation/generation orchestration has now been separated into `web/src/domains/conversation-generation-domain.js`.

The store no longer owns the full conversation/generation flow directly. It still composes and exposes too many domains through one provider value:

- platform and mode
- accounts and login state
- conversation CRUD wiring
- generation parameters and reference image state
- reference images
- pending jobs
- visible result batches
- dialogs and overlays
- settings state

The recent fixes improved correctness and extracted the most coupled generation flow, Claude text chat, license state, and bulk account import/login state. The app still needs post-extraction state separation to reduce context churn and remaining cross-domain coupling.

### External API, Token, and Job Visibility

`/ext` now has better conversation ownership handling and shares async job submission with `/api/generate`, but the API surface still deserves a more explicit contract around:

- job DTO shape
- queue policy
- compatibility semantics

Auth-before-body-parser behavior remains good, and API token/MCP presentation now lives in `services/api-access-presenter.js`. The route family still carries more lifecycle knowledge than ideal.

### Conversation Semantics

The codebase is now more clearly aligned around **platform-first conversations**.

The public compatibility layer still accepts `accountId` in some signatures, but the implementation decision is now explicit: conversation scope is platform-only. The web client no longer sends `accountId` for conversation list/create, and `activeByAccount` is only a legacy persisted shape that is cleared on init/mutations.

This is no longer an open semantic fork; the remaining work is naming/comment cleanup and eventual retirement of legacy fields when migration coverage is sufficient.

### Account Lifecycle

Account deletion and import behavior are safer than before, and deletion/history semantics are now explicit for account removal.

The chosen account-deletion policy is:

- preserve platform-level generated history
- detach the deleted account from conversations and compatibility active mappings
- clear stale single-account service conversation cursors
- never cascade-delete generated history merely because an account is removed

Remaining lifecycle work is now focused on keeping bulk deletion, import rollback, and legacy compatibility migration aligned with that policy.

## Code Review Addendum (2026-07-05)

The focused review and remediation rounds sharpened priorities further.

### Already reduced

1. result ownership drift in `/ext`
2. fallback cross-conversation UI mutation from unknown jobs
3. local profile residue on single-account delete
4. half-created account residue on import failure
5. unbounded queue growth in `JobManager`
6. direct ownership of conversation/generation orchestration inside `web/src/store.jsx`
7. direct ownership of Claude text-chat state inside `web/src/store.jsx`
8. undefined account deletion/history semantics
9. previously unresolved platform-vs-account conversation semantics
10. brittle source-text UI assertions around account/settings/video contracts
11. previously duplicated async generation job submission across `/api/generate` and `/ext`
12. previously route-local settings image API/token presentation logic

### Still worth prioritizing

1. further frontend provider/subscription narrowing
2. remaining account/session and shell/settings domain extraction
3. generation parser/transport/platform adapter seams inside `GenerationService`
4. cleaner public job DTO boundaries

## Refactor Principles

1. **Fix ownership before abstraction.**
   - This principle still stands and has already paid off in the first remediation rounds.

2. **Treat visible UI state as derived state when possible.**
   - Canonical history and transient pending state should not be permanently mixed in one mutable bucket.

3. **Prefer explicit lifecycle semantics.**
   - Import, delete, activate, persist, and replay should each have one clearly owned path.

4. **Treat tests as architecture.**
   - Tests that prove the wrong thing slow down refactoring.

5. **Bound overload behavior deliberately.**
   - This is now partially done; later phases should preserve and refine it.

## Updated Phase Order

### Phase 0: Correctness Guard Rails

Status: **partially completed**

Completed or substantially improved:

- websocket/result ownership tightened
- `/ext` persistence ownership improved
- single-account profile cleanup added
- import rollback cleanup added
- queue admission bounds added

Still open inside this phase:

- continued regression coverage for bulk account deletion, import rollback, and legacy account compatibility fields

### Phase 1: Frontend State Separation

Status: **substantially completed for the first split; still worth continuing**

Already completed:

- `web/src/domains/conversation-generation-domain.js` owns conversation loading, result loading, history pagination, websocket job events, and generation submit/retry/edit orchestration
- `web/src/domains/claude-chat-domain.js` owns Claude text-chat config/loading/send/stop/clear state
- `web/src/store.jsx` wires those domains into app state instead of directly owning the full flow
- `web/src/domains/license-domain.js` owns license status/gate actions
- `web/src/domains/account-bulk-domain.js` owns bulk auto-login and backup import state/actions
- focused selector hooks now exist for high-churn UI surfaces: `useCanvasState`, `useInputPodState`, and `useNavRailState`

Goals:

- continue splitting `web/src/store.jsx` into smaller domains or selector-oriented subcontexts
- reduce broad context churn
- keep pending jobs and visible history state derived through explicit helpers/domain boundaries
- reduce render coupling in components like `Canvas`

Suggested target split:

- conversation/generation domain (already started)
- Claude chat domain (completed)
- shell/ui store
- account/session store
- notification/toast store

Success criteria:

- unrelated UI no longer rerenders because of timer/progress changes
- result rendering becomes fully selector/derived-state driven
- store actions become easier to reason about and test

### Phase 2: Conversation Semantic Cleanup

Status: **completed for internal semantics; compatibility cleanup remains**

Current result:

- internal scope is platform-only
- `accountId` compatibility inputs are ignored for conversation scope
- the web client no longer sends `accountId` for conversation list/create
- legacy `activeByAccount` state is cleared and kept only as a migration/file-shape compatibility field

Remaining cleanup:

- update older comments/names where they still imply account-scoped conversations
- eventually retire legacy fields after migration coverage proves it is safe

### Phase 3: Account Lifecycle Policy

Status: **partially completed**

Goals:

- keep the account deletion/history policy explicit in services and tests
- apply the same semantics to bulk deletion, import rollback, and legacy compatibility cleanup

Chosen policy:

- preserve history but detach account ownership
- preserve platform-level history
- do not cascade-delete generated history because an account was removed

Success criteria:

- deletion behavior is intentional and documented
- no orphaned data semantics remain accidental

### Phase 4: Generation Orchestration Boundary

Status: **partially completed**

Completed:

- `services/generation-job-submitter.js` centralizes job creation, immediate response, quota broadcast, and result-persistence callback wiring for `/api/generate` and `/ext`
- `services/generation/prompt-builder.js` extracts prompt/ratio/movement/reference rewrite helpers from `GenerationService`

Remaining goals:

- separate internal job state from public DTOs more clearly
- continue extracting parser/transport/platform-adapter seams from the large generation service

### Phase 5: Result Recorder Boundary

Status: **still recommended**

Goals:

- isolate media download and persistence
- keep ownership metadata explicit through the recording path

### Phase 6: Config and Proxy Policy Isolation

Status: **partially completed**

Completed:

- image API defaults/migration/normalization/masking/mutation live in `services/settings-image-api-config.js`
- proxy routes now receive canonical `accountManager.config` instead of reaching through `generationService.config`
- `ProxyPolicy` remains the shared proxy intent boundary

Remaining goals:

- introduce a broader `ConfigService` if config mutation keeps expanding
- keep proxy policy shared by intent but not by runtime implementation

### Phase 7: License and Token Internals

Status: **partially completed**

Completed:

- frontend license state/actions live in `web/src/domains/license-domain.js`
- API access DTO and MCP snippet presentation live in `services/api-access-presenter.js`
- existing `services/api-token-manager.js` remains the token persistence/verification boundary

Remaining goals:

- keep external APIs stable while simplifying internals
- preserve lightweight request-path verification behavior
- tighten auth semantics where compatibility allows

### Phase 8: Platform Adapter Split

Status: **later refactor**

Only after state semantics and orchestration boundaries are stable.

## Non-Goals

This design still does not require:

- rewriting the whole app
- changing public `/api` or `/ext` paths in one step
- replacing all styling or visual behavior
- removing every compatibility field immediately if it does not block correctness

## Verification Strategy

Use tests and build checks at every phase.

Minimum commands after relevant changes:

```powershell
npm test
npm run build:web
```

### Current required validation emphasis

1. conversation/job ownership after view switches
2. `/ext` persistence ownership behavior
3. single-account deletion cleanup
4. import rollback cleanup
5. bounded queue behavior under overload
6. derived-results rendering correctness

### Continuing validation emphasis

1. store decomposition should not regress conversation switching
2. conversation semantic cleanup should not break API compatibility accidentally
3. account lifecycle policy should be encoded in tests, not comments alone

## Open Decisions

The main semantic decision is now closed: conversation scope is platform-only internally, while `accountId` remains accepted as a compatibility input. Remaining decisions are implementation pacing decisions:

- when to fully retire legacy conversation file fields after migration coverage
- how aggressively to replace remaining static contract/CSS checks with browser-rendered tests
- how far to split `GenerationService` before introducing platform adapters

## Implementation Planning Notes

Recommended next implementation batch:

1. keep narrowing the broad provider composition, especially account/session and shell/settings state
2. reduce remaining `Canvas`/result rendering subscription breadth
3. continue replacing remaining static contract/CSS checks with browser-rendered behavior tests where useful
4. continue compatibility cleanup around old conversation/account naming

Recommended batch after that:

5. introduce cleaner public job DTO boundaries
6. split generation result parser/transport/platform-adapter seams further
7. introduce a broader `ConfigService` only if config mutation keeps growing
8. continue compatibility cleanup around legacy persisted conversation fields
