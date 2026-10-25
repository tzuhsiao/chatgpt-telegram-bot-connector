# Allowlisted private groups implementation plan

**Goal:** Support two separately approved humans and the dedicated bot in an
explicitly approved private group, preserving independent private chats.

**Architecture:** Keep positive private user/chat lists unchanged. Add optional
`TELEGRAM_ALLOWED_GROUPS`, a JSON object mapping each negative safe-integer group
ID to exactly two distinct positive human ID strings. Group-only approval never
grants private-chat access. D1 stores per-bot/group access epochs and membership
update deduplication. An owner-only `verify_group_access` tool enables or resumes
the approved group after checking Telegram's live roster. Every content operation
rechecks membership; changes or unknown state pause the group. Epochs prevent
replaying pending messages or exposing history from a previous approval period.
`pause_group_access` provides explicit revocation before configuration edits;
observed removals/changes also latch a pause. Unobserved settings that return to
identical values cannot be inferred without that explicit step. Same-request
ingress verification may be reused for immediate delivery with a final epoch guard;
later callbacks inspect again. Reserve outgoing sends only after membership
preflight and condition dispatch admission on the verified epoch.

**Scope:** No live operations, credentials, deployment, issue #15 or README edits.
Conversation decisions remain delegated to the dot. Existing identity, callback,
retention and uncertain-send safeguards remain mandatory. Dependency-free ESM,
Node 24 tests, additive D1 migration; no Telegram polling or automatic moderation.

## Alternatives and limits

Sender filtering alone cannot protect readers of bot replies. A member-count-only
check cannot establish identities. Use count plus individual membership checks for
both approved humans and the admin bot, private/non-forum chat metadata, and a
second count. Telegram does not provide an atomic roster-and-send transaction or
permanent invitation lock: administrators can change membership between checks,
and already visible content cannot be recalled. Document those limits and manual
invitation/admin controls. Membership events latch a pause, including departures;
an explicit owner-authorized recheck is required, never silent recovery.

## Tasks

- [ ] Add integration tests for negative-ID validation, separate participant
  approval, owner-only verification, private group metadata/roster failures,
  signed chat-scoped subscriptions/events, send/history isolation, durable pause
  and membership-update deduplication, verification races and send uncertainty.
  Run these tests first and confirm missing group behavior fails.
- [ ] Add migration `0002_group_access.sql` and append journal entry. Implement
  strict config parsing, live verification, access epochs and authenticated
  membership/service update handling in `worker/index.js`. Bind accepted group
  records to the current epoch, recheck at content boundaries, preserve existing
  private path and fixed Telegram destinations. Register membership update types
  only when groups are configured. Run all tests.
- [ ] Document owner/participant approval, Telegram permissions/privacy mode,
  exact group routing, history boundaries, manual invitation settings, pause and
  recovery in AGENTS.md, setup skill, operations guide and configuration example.
  Keep the short README unchanged and make no conversational rules mandatory.
- [ ] Run tests/build/artifact validation and diff checks. Obtain read-only WSL
  Claude Code review of the immutable final patch, fix actionable findings with
  regressions and re-review changed areas. Publish draft PR, verify final-head CI,
  mark ready and merge under standing authorization. Verify remote main and CI.

## Review focus

Fail closed for anonymous administrators/sender_chat, malformed or incomplete
Telegram responses, public/linked/forum groups, participant substitution, stale
updates, concurrent verification/membership changes, and paused pending delivery.
Reused/uncertain sends must never dispatch again. Removing a group or changing its
approved roster must revoke access; group approval cannot authorize private chat.
All Telegram network behavior is simulated in tests; live permission behavior and
the unavoidable membership/send race are not certified by local tests.
