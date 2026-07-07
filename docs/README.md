# Documentation Index

Last updated: 2026-07-05

This repository currently keeps its formal engineering documentation under `docs/`.

## Documents

### 1. Codebase review
- `docs/codebase-review-2026-07-05.md`

Purpose:
- current-state technical audit
- logic risks
- architecture risks
- performance issues
- test-quality issues
- prioritized remediation guidance

### 2. Architecture design
- `docs/superpowers/specs/2026-06-30-loose-coupling-architecture-design.md`

Purpose:
- target refactor direction
- boundary-first architecture evolution
- updated phase order after the July 5 review

## Current truth source

When documentation conflicts with older assumptions in code comments or tests, use this order:

1. current runtime behavior
2. current tests
3. `docs/codebase-review-2026-07-05.md`
4. `docs/superpowers/specs/2026-06-30-loose-coupling-architecture-design.md`
5. older inline comments that may predate recent changes

## Current architectural decisions

The following decisions are considered current unless a newer document supersedes them:

- conversation ownership is **platform-first**, not strictly account-scoped
- `accountId` in conversation-related APIs is retained only as a compatibility input; internal scope is platform-only and the web client no longer sends it
- generation result ownership should be driven by explicit `conversationId`
- `/ext` result persistence should follow the same ownership rules as `/api/generate`
- pending UI generation state is runtime-derived and should not become the canonical history source
- frontend conversation/generation orchestration lives in `web/src/domains/conversation-generation-domain.js`; `web/src/store.jsx` now composes broad app state and exposes selector/action hooks
- frontend Claude text-chat state lives in `web/src/domains/claude-chat-domain.js`
- frontend license state lives in `web/src/domains/license-domain.js`; bulk auto-login/import state lives in `web/src/domains/account-bulk-domain.js`
- account/settings UI contracts live in `web/src/lib/accounts-modal-contract.js` and `web/src/lib/settings-ui-contract.js` instead of brittle component-source assertions
- deleting accounts preserves platform-level conversation history and detaches account compatibility ownership instead of cascading history deletion
- queueing must be bounded; overload handling is part of correctness, not just performance
- generation route job submission is centralized in `services/generation-job-submitter.js`; prompt construction is centralized in `services/generation/prompt-builder.js`
- image API config mutation and API token/MCP presentation are centralized in `services/settings-image-api-config.js` and `services/api-access-presenter.js`

## Documentation maintenance rule

If implementation meaningfully changes any of the following, update docs in the same change set:

- conversation scope semantics
- account deletion/import lifecycle
- job queue policy
- result ownership model
- `/ext` API contract
- large frontend state boundaries
- conversation/generation domain boundaries
- settings/config/token presentation boundaries
- backend generation job orchestration boundaries

