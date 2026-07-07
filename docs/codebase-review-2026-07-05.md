# Codebase Review Report

- Date: 2026-07-05
- Scope: backend routes/services, frontend state/UI architecture, test suite quality, performance hot spots, severe logic risks
- Review basis: static inspection + local `npm test` run + multi-agent parallel review + multiple implementation/verification rounds
- Validation status after remediation: `177/177` tests passing
- Conclusion summary: the project remains active and viable, and the highest-risk correctness issues have now been substantially remediated. Conversation semantics are now platform-first internally, the weakest UI tests have been moved toward exported contracts/behavior, several frontend state domains have been extracted, and backend job/config/token seams now have explicit helper services. The main remaining risk is broad top-level context composition and future maintainability of the still-large generation service.

---

## Executive Summary

This project is already beyond the "prototype with no tests" stage. It has meaningful backend/frontend separation, a non-trivial test suite, and packaging/runtime concerns already accounted for.

However, the current system originally had several serious structural weaknesses:

1. **Conversation/result ownership was not strict enough** across jobs, conversations, and accounts.
2. **Account lifecycle cleanup was incomplete**, especially for single-account deletion and import failure rollback.
3. **Frontend state was overly centralized**, creating both correctness risks and avoidable rendering cost.
4. **Job queueing had concurrency control but no admission control**, so overload behavior was weak.
5. **A noticeable part of the UI test suite validated source text instead of behavior**, which could hide real regressions.

The remediation rounds have now addressed the most immediate correctness risks and several architecture seams, but the codebase still benefits from continued decomposition of the broad frontend provider and the large generation transport/parser surface.

---

## What Has Been Fixed Since This Review Started

The following items have been remediated in code and verified by the current passing test suite.

### Fixed: `/ext` result persistence now carries conversation ownership

**Files**
- `routes/ext.js`
- `services/result-persistence-service.js`
- tests in `tests/result-persistence-routes.test.js`

**Status**
- `/ext` image/video/image-to-video flows now pass `conversationId` into result persistence.
- persistence rejects writes when an explicitly submitted conversation does not exist.
- tests cover the ownership path.

**Impact**
This materially reduces the risk of external API results silently landing in the wrong conversation.

---

### Fixed: unknown runtime jobs no longer default to the active conversation in the frontend

**Files**
- `web/src/store.jsx`
- `web/src/domains/conversation-generation-domain.js`
- `web/src/lib/conversation-results.js`
- tests in `tests/conversation-results-ui.test.js`

**Status**
- jobs without `conversationId` are no longer treated as matching arbitrary active conversations
- frontend event handling now requires stronger ownership checks before mutating visible UI state

**Impact**
This reduces the most dangerous form of cross-conversation result bleed.

---

### Fixed: single-account deletion now removes local persisted profile state

**Files**
- `routes/accounts.js`
- `routes/api.js`
- `services/conversation-manager.js`
- tests in `tests/accounts-routes.test.js`
- tests in `tests/conversation-manager.test.js`

**Status**
- single-account delete now removes the persisted profile directory before removing the account record
- account deletion now preserves platform-level conversation history while detaching the deleted account's compatibility ownership fields
- stale single-account service conversation cursors are cleared so deleted account metadata cannot be reused

**Impact**
This closes an important account-lifecycle cleanup hole, reduces leftover authenticated local state, and makes deletion/history semantics explicit without risking accidental generated-history loss.

---

### Fixed: import failure now attempts rollback of half-created account state

**Files**
- `services/account-importer.js`

**Status**
- import failure path now attempts to close browser state, remove partially created profile data, and remove the created account record

**Impact**
This reduces half-success account import residue.

---

### Fixed: job queue now has bounded admission control

**Files**
- `services/job-manager.js`
- tests in `tests/job-manager.test.js`

**Status**
- `JobManager` now supports `maxQueueSize`
- queue overflow rejects work with `queue_full`

**Impact**
The runtime now has a minimum viable backpressure policy instead of unbounded pending growth.

---

### Fixed: result rendering is moving toward derived UI instead of mixed source-of-truth mutation

**Files**
- `web/src/store.jsx`
- `web/src/domains/conversation-generation-domain.js`
- `web/src/lib/conversation-results.js`

**Status**
- visible result batches are now rebuilt more deliberately from history plus runtime pending state
- `job_done` no longer relies as heavily on direct UI-side result injection as the primary truth path

**Impact**
This is an architectural improvement that lowers future state inconsistency risk, though the store is still too large overall.

---

### Fixed: conversation/generation orchestration has been extracted from the frontend store

**Files**
- `web/src/domains/conversation-generation-domain.js`
- `web/src/domains/claude-chat-domain.js`
- `web/src/store.jsx`
- `web/src/components/Canvas.jsx`
- `web/src/components/InputPod.jsx`
- `web/src/components/NavRail.jsx`
- tests in `tests/conversation-results-ui.test.js`

**Status**
- conversation loading, result loading, history pagination, websocket job event handling, generation submit/retry/edit orchestration now live in `useConversationGenerationDomain`
- Claude text-chat config/loading/send/stop/clear state now lives in `useClaudeChatDomain`
- `store.jsx` composes this domain with the rest of app state instead of owning the full conversation/generation flow directly
- high-churn UI surfaces now have focused selector hooks: `useCanvasState`, `useInputPodState`, and `useNavRailState`

**Impact**
This meaningfully reduces the most concentrated frontend logic hotspot. The remaining frontend architecture risk is now less "all conversation/generation logic lives in the store" and more "the top-level context value is still broad and several unrelated domains still share one provider."

---

### Fixed: additional frontend state domains and UI contracts have been extracted

**Files**
- `web/src/domains/license-domain.js`
- `web/src/domains/account-bulk-domain.js`
- `web/src/lib/accounts-modal-contract.js`
- `web/src/lib/settings-ui-contract.js`
- tests in `tests/conversation-results-ui.test.js`, `tests/accounts-modal-ui.test.js`, `tests/proxy-ui.test.js`, and `tests/video-options.test.js`

**Status**
- license gate/status actions now live in `useLicenseDomain`
- bulk auto-login and account backup import state/actions now live in `useAccountBulkDomain`
- account-modal and settings-modal UI contracts are exported as small modules and tested directly
- video options tests now import exported options instead of grepping implementation text

**Impact**
This reduces `StoreContext` ownership and replaces several brittle source-text UI checks with stronger contract-level tests.

---

### Fixed: conversation APIs are now platform-scoped internally

**Files**
- `routes/conversations.js`
- `services/conversation-manager.js`
- `web/src/lib/api.js`
- tests in `tests/conversations-routes.test.js` and `tests/conversation-manager.test.js`

**Status**
- route/client signatures keep `accountId` compatibility, but web requests no longer send it
- conversation create/list/active paths ignore `accountId` and store new conversations with blank account ownership
- legacy `activeByAccount` shape is retained only for migration compatibility and is cleared on init/mutations
- deleted account detachment no longer risks deleting platform conversation history

**Impact**
The public compatibility surface remains stable while the internal mental model is now platform-first.

---

### Fixed: backend generation/job/result orchestration has a shared submission boundary

**Files**
- `services/generation-job-submitter.js`
- `services/generation/prompt-builder.js`
- `routes/generate.js`
- `routes/ext.js`
- `services/generation-service.js`
- tests in `tests/generation-job-submitter.test.js` and `tests/generation-service.test.js`

**Status**
- `/api/generate` and `/ext` now submit async jobs through `submitGenerationJob`
- quota broadcasting and result-persistence callback wiring are centralized
- prompt/ratio/movement/reference rewrite helpers are extracted from the large generation service into a focused pure module

**Impact**
This reduces duplicated route orchestration and creates a safer seam for future job DTO/result-recorder work.

---

### Fixed: settings image API config and token/MCP presentation boundaries are explicit

**Files**
- `services/settings-image-api-config.js`
- `services/api-access-presenter.js`
- `routes/settings.js`
- `routes/api.js`
- tests in `tests/settings-config-services.test.js`, `tests/settings-routes.test.js`, and `tests/api-status.test.js`

**Status**
- image API defaults, migration, normalization, masking, and mutation live outside `routes/settings.js`
- API token access DTOs and MCP snippets are built outside the route file
- proxy routes receive canonical `accountManager.config` instead of reaching through `generationService.config`

**Impact**
This narrows config/proxy/token responsibilities in the request layer without changing public routes.

---

## Verification Snapshot

### Current local test run

Command:

```powershell
npm test
```

Observed result:

- `177` tests
- `177` passed
- `0` failed

Interpretation:

- The latest remediation work is verified by the current test suite.
- Remaining concerns are now more about architecture concentration and long-term maintainability than immediate broken behavior.

---

## Remaining High-Value Risks

### 1. Frontend StoreContext/subscription surface is still broad, but less domain-heavy

**Files**
- `web/src/store.jsx`
- `web/src/domains/conversation-generation-domain.js`
- `web/src/domains/claude-chat-domain.js`
- `web/src/domains/license-domain.js`
- `web/src/domains/account-bulk-domain.js`

**Current status**
This remains the main frontend maintainability hotspot, but the most volatile flows are no longer directly owned by `store.jsx`.

Already extracted:

- conversation/generation orchestration
- Claude text chat
- license gate/status actions
- bulk auto-login and backup import state
- focused selector hooks for high-churn UI surfaces

The provider still composes and exposes many unrelated concerns:

- platform/mode
- account/session
- conversation CRUD wiring
- generation params and reference-image state
- dialogs/modals
- status/toast
- settings and shell UI

**Why it still matters**
- the provider value is still broad
- rerender surface can still be narrowed further
- account/session and shell/settings state are still mixed at the composition layer

**Recommended next move**
Continue extracting smaller domain hooks/providers or selector-oriented subcontexts, with account/session and shell/settings state as the next likely candidates.

---

### 2. Conversation semantics are now platform-first, with compatibility input still accepted

**Files**
- `services/conversation-manager.js`
- `routes/conversations.js`
- `web/src/lib/api.js`

**Current status**
The code direction has been chosen: **platform-only conversation scope**.

- `accountId` remains in some route/client signatures only for compatibility
- the web client no longer sends `accountId` for conversation list/create
- the backend ignores `accountId` for conversation scope
- new conversations store blank account ownership
- legacy `activeByAccount` persists only as a file-shape compatibility field and is cleared during init/mutations

**Why it still matters**
This is no longer an unresolved semantic fork, but old names/comments can still confuse future work.

**Recommended next move**
Gradually rename compatibility parameters/comments and retire legacy file fields only after migration coverage proves no user data will be stranded.

---

### 3. Account lifecycle policy is improved but still worth watching

**Files**
- `routes/accounts.js`
- `services/conversation-manager.js`

**Current status**
Profile cleanup and deletion/history semantics now exist:

- generated history is preserved
- deleted account ownership is detached from conversations
- account-scoped compatibility active mappings are cleared
- stale service conversation cursors are reset

**Why it still matters**
This is now lower risk than before, but account import, bulk deletion, and legacy compatibility data should keep regression coverage as the platform-first model is simplified further.

**Recommended next move**
Keep the current policy and extend coverage as compatibility fields are retired:

- preserve platform-level history
- detach account ownership
- never cascade-delete generated history from account deletion

---

### 4. UI test quality is improved, but some static contract checks remain

**Files**
- `tests/accounts-modal-ui.test.js`
- `tests/proxy-ui.test.js`
- `tests/video-options.test.js`

**Current status**
The most brittle checks in these files have been moved toward exported UI contract modules or imported option/config data. A few CSS/static layout checks remain where a full browser render test would be heavier than the current risk warrants.

**Why it matters**
Static contract checks are now less brittle than raw component-source greps, but they still provide weaker confidence than full runtime interaction/render tests.

**Recommended next move**
Gradually replace source-text assertions with:

- render tests
- interaction tests
- exported config/schema tests
- contract-level assertions

---

## Updated Priority Order

### Highest priority if implementation continues

1. continue frontend state separation after the new domain extractions
2. reduce remaining `Canvas`/result subscription breadth further
3. keep retiring old conversation compatibility names/comments where safe
4. continue shrinking the large generation service into parser/transport/platform-adapter seams

### Medium priority

5. introduce cleaner public DTO boundaries around jobs
6. continue moving routes toward thinner orchestration boundaries
7. isolate generation result parser/transport helpers further

### Lower priority but still worthwhile

8. cache SPA fallback HTML
9. further reduce synchronous hot-path work
10. tighten `/ext` auth surface if compatibility allows

---

## Relation to Architecture Document

This review now matches the current architecture document:

- `docs/superpowers/specs/2026-06-30-loose-coupling-architecture-design.md`

The architecture document should be treated as the forward plan.
This review should be treated as the grounded audit of:

- what was wrong
- what has been fixed
- what remains risky

---

## Final Assessment

The codebase is in a materially better state than when this audit started.

The most dangerous problems are no longer the same as they were initially:

### Reduced risk now
- `/ext` result ownership drift
- unknown job → active conversation fallback
- single-account profile residue
- half-created import state
- unbounded queue growth

### Remaining structural risk now
- broad frontend provider composition and remaining mixed UI/application state
- old compatibility names around conversation APIs despite platform-only internals
- remaining account/import compatibility edge cases
- still-large generation service internals

This means the project has successfully moved from:

> urgent correctness hazards

closer toward:

> maintainability and model-clarity work

That is a meaningful improvement.
