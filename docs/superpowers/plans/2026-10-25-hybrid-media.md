# Hybrid Media Retrieval Implementation Plan

> Execute inline in the isolated feature worktree, with Claude as final patch reviewer.

**Goal:** Implement Issue #21 using private bounded prefetch and model-readable MCP image results.

**Architecture:** Preserve signed receipt payloads. Schedule eligible downloads with Worker `ctx.waitUntil` after receipt processing; reads resolve retained message context. Store bounded chunks and expiring leases in existing D1, with atomic admission and scope-bound dedupe. Automatic task reads use `mode: auto`; explicit reads use `mode: on_demand`.

**Tech stack:** Node 24, dependency-free Worker ESM, D1/SQLite tests.

**Spec:** https://github.com/tzuhsiao/chatgpt-telegram-bot-connector/issues/21 and owner-approved transport decision.

## Constraints

- AUTO limit exactly 2,000,000 actual bytes; on-demand limit 8,000,000 bytes.
- Private cache: 32 entries, 32,000,000 reserved/decoded bytes, 10-minute lifetime; failure markers 60 seconds; lease 30 seconds.
- Chunk raw bytes in 524,286-byte pieces, base64 stored below D1 row limits.
- No new runtime values/bindings, external model, arbitrary URL/file ID inputs or live changes.
- Retrieval tool returns image blocks for signature/dimension-checked PNG/JPEG/static WebP/GIF; other bytes return explicit unsupported-model-transport metadata, never claimed model consumption.
- Current owner/chat/sender/topic/epoch/retention checks apply before fetch and immediately before result; images grant no authority.

## Review focus

- Concurrent requests must not exceed reservations or duplicate downloads.
- Oversize/slow/malformed download must never delay or suppress receipts.
- Revoke/expire while downloading: no exposed bytes; purge cached scope on group pause/approval sync.
- Small file with enormous dimensions or animation disguised as static: reject.
- Token-bearing paths and network exceptions must never escape sanitized errors.

## Tasks

1. Add integration tests in `tests/media-retrieval.test.mjs` for image transport, background receipt independence, exact threshold, metadata lies, path validation, authorization/topic/race/cache limits and expiry. Run against baseline and observe feature failures.
2. Add `0005_media_cache.sql` plus journal. Implement `get_message_media` and background prefetch in `worker/index.js`; keep one-file artifact structure. Run tests to green, then full suite.
3. Update English scope/storage/operations docs and private/group automatic-read instructions. Preserve existing sends/plans. Run build and artifact validation.
4. Obtain scoped Claude patch review, assess findings, add failing regressions for valid findings and fix. Run final full checks on exact final source.
5. Commit, publish isolated branch and draft PR; verify remote SHA and CI. No merge/deploy.

## Progress

- Baseline: 137/137 tests; build and artifact validation pass at 452b237.
- Parent approved implementation and transport, including reviewable responder instructions; no additional plan approval required.

- Implementation: new D1 migration and message-bound image tool, independent background prefetch and responder supplements completed.
- Claude patch review: H1 and M1-M5 fixed with RED→GREEN regressions; M6 is covered by maximum-size forum query-budget test.
- Ruling: preserve existing live group checks on media tools rather than adopting the architecture review’s DB-only suggestion; this maintains current access safeguards but transient Telegram errors can pause reads.
- Ruling: unsupported binary files may be fetched on demand under the cap but their bytes are discarded after format checking; no unverified binary attachment transport is exposed.
- Ruling: wait inside the tool for a concurrent download with bounded backoff; task policies still prohibit polling and waits.
- Review low findings: parser leniencies, footer and array-position wording fixed; private cache physical revocation limit documented. D1 foreign keys enforce cascading purge per official documentation. Existing public plan convention is retained.
- Remaining acceptance: actual Sites image passthrough, near-limit response size, automatic task invocation/approval behavior and hosted model perception require separate consent.
