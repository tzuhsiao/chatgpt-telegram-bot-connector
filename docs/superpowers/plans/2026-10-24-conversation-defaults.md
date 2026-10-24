# Discretionary conversation defaults

Implement the owner's requested conversation-policy correction inline. The
connector delivers notifications and exposes authorized tools; conversational
judgment belongs to the Dot. README and Worker runtime remain unchanged.

## Decisions and constraints

- Normal sends omit optional `reply_to_message_id`. Existing transport already
  supports this; retain quoted legacy frozen requests during migration.
- Text replies, optional emoji-only text acknowledgments, and silence are choices.
  No reaction tool is added or claimed. Other reaction tools require actual
  availability and their own authorization.
- Consider every validated event, preserving unresolved substantive requests.
  Combine only already-arrived messages; no timers, polling or collection waits.
- Reserve coverage in available authoritative private task state, serialize
  overlapping planning, and freeze the included message IDs, anchor, disposition,
  parts, arguments and keys before sending. The anchor is the smallest actual
  included message ID. Use `tg-chat:v3:<chat_id>:<anchor>:<kind>:<part>`, with `reply`
  or `ack` kind so a confirmed receipt acknowledgment cannot consume the later
  substantive-answer key. Ack alone does not resolve a substantive request.
- Do not regroup already reserved/covered messages or use another anchor/kind to
  evade uncertain/failed operations. If coverage history cannot be established,
  stop for reconciliation rather than inventing a fresh plan. No durable queue or
  shared ledger runtime is introduced; document host limits honestly.
- Retain actual-event, recipient, activation, bounded-context, secret and error
  safeguards. New key semantics require a cutover, never replay of old requests.
- No live task/Site/plugin/settings/subscription/message actions.

## Work and verification

1. Update `prompts/private-chat.md`, `docs/normal-chat.md`, AGENTS and related setup/
   operations guidance consistently. Keep setup welcome consent separate.
2. Run existing transport tests (including exact unquoted payload and idempotency),
   build, artifact validation, local links and whitespace checks. Do not add tests
   that merely match prompt wording or pretend to prove hosted model behavior.
3. Have existing WSL Claude Code review the final diff and independently walk
   synthetic reply/ack/silence/grouping/overlap/uncertainty cases. Address findings
   and re-review changed areas. Publish a draft PR and merge only after review
   and final CI; verify remote main and post-merge checks.
