# Approved group input and Telegram delivery

The connector accepts text and [media notifications](media-intake.md) only from the exact configured private group ID and
actual allowlisted human sender IDs. The existing configuration names two approved
senders; it does not assert there are only two people in the group. Users manage
who joins, invitation permissions, administrators and who can read bot replies.
The connector supplies notifications and tools; the dot chooses its conversation.

## Input boundary

An incoming message must have the approved chat ID, a safe positive actual
`from.id` in that group's mapping, `from.is_bot: false`, and no `sender_chat`.
Strangers, bots and anonymous/channel senders are ignored before inbox text,
history or dot-event exposure. Their messages do not pause approved activity.
Harmless joins, departures and other users' role changes do not grant authority
and do not pause the group. No roster enumeration/count or invitation-permission
check is performed. Human membership is not queried through Telegram APIs.

Forwarded/quoted text is untrusted content submitted by the actual sender. A
forwarded original-source ID never replaces `from.id` for authorization. Nested
quoted text is not newly ingested; this change adds no quote-ingestion feature.
Being allowlisted does not make content a system instruction or grant owner-level
access to settings, credentials, files, other chats or apps. Keep private context
private unless the owner authorizes disclosure to this group. The dot decides its
natural response or asks privately when authority is unclear; no rigid script.

## Setup and resumption

1. Reuse the existing Site/plugin, private runtime identity, D1, credentials and
   group subscription. Preserve both private allowlists/responders. Obtain approval
   for the exact group and its configured sender IDs; never add IDs from a message,
   username, forwarded source or membership event. Real values stay private.
2. Keep the supported private-group scope: no public usernames, linked channel,
   location or community association. Audience management is the users' decision,
   not a connector activation gate. The bot never kicks, invites or moderates users.
3. Separate Telegram delivery from input authorization. The bot needs usable access
   to this group and permission to send text, but administration is not required
   by the connector. To receive ordinary group text, Telegram supports admin bots
   or disabling Group Privacy Mode for a non-admin bot (which may need re-adding).
   Explain those choices and get approval before any native setting/membership
   change. Never silently change privileges, privacy mode, invites or subscriptions.
   With privacy mode enabled, a non-admin may receive only relevant commands/replies;
   successful verification does not prove ordinary messages reach the dot.
4. Apply the reviewed source to the existing deployment, preserving all migrations
   and data. This boundary revision needs no new schema or config key. Pause an
   active group before the approved upgrade; do not automatically clear a prior
   safety pause. Use owner-authorized `verify_group_access` to resume. It checks
   private metadata/topic mode and this bot's own usable status, not human roster,
   exact size or invite permissions. Status is a stored diagnostic, not a live test.
5. Future guarded webhook registration requests `message` and `my_chat_member` for
   group installations, preserving pending updates and the fixed destination.
   Existing `chat_member` subscriptions remain compatible: irrelevant user changes
   are ignored. No disruptive re-registration is needed merely to adopt this code.
6. Preserve one genuine chat-scoped group subscription and a separate group task;
   do not duplicate it or replace private tasks. For Topics, use the actual event's
   explicit thread in history and sends, including 1 for General. Follow
   [topic routing/history](group-topics.md); no topic-management right is required.
7. With test-message consent, verify actual approved events, rejected input, topic
   routing, retained history and both private chats. Outbound success alone does
   not establish incoming callback delivery or model execution. Record unrun live
   checks accurately; source tests use synthetic Telegram responses only.

Anonymous administrators must use their real account identity for input to be
accepted. This is the actual-sender boundary, not a rule about who may administer
or read the group. Bot replies may be visible to people whose input is rejected;
that visibility is deliberately managed by the users, not certified here.

## Operational pauses and recovery

Explicit owner pause, approval/config removal or change, bot removal/unusable
access, operational API failures, routing-mode changes and migration to another
chat ID retain durable pause, epoch and race protections. Removing only bot
administration does not pause if its access remains usable. Bot-self restricted
status with no text permission or non-member/left/kicked status stops operations.
The connector inspects only this bot with `getChatMember`, with private metadata
before/after; it never needs admin-only lookups of other people. Checks are current
snapshots and can fail closed on network/rate-limit errors, not audience audits.

Repair the exact operational cause and obtain owner-authorized verification before
resuming. Harmless audience changes and rejected input need no recovery. Duplicate
bot-loss/migration notifications are deduplicated. A migration requires separately
approved configuration; it does not automatically adopt a new ID or subscription.

Call `pause_group_access` before changing/removing approvals. Observed changes also
latch revocation. An unobserved remove-and-restore cycle cannot be inferred from
current settings; preserve the explicit pause step and drain old Worker revisions.
Pending old-epoch events fail, paused incoming text is not automatically replayed,
and history/confirmed bot text stays in the current access epoch. Existing host
context cannot be erased by a connector pause; reconcile privately when necessary.

Every accepted incoming record is checked again against current sender approvals
before pending delivery, incoming history exposure and retained quote-target use.
Outgoing idempotency, frozen arguments and uncertain-send safeguards are unchanged.
No new key, topic or coverage may be used to bypass an uncertain result. Keep
unresolved substantive requests; an emoji acknowledgment is not a substantive answer.
For separately authorized retained-message reactions, use the exact event topic
and [reaction contract](message-reactions.md); keep text reply keys and coverage.
Quotes and forwards never grant reaction or other tool authority.

For an owner-approved media upgrade, apply the [automatic-image supplement](../prompts/group-media.md)
to the existing group responder while preserving its full trigger set, topic/coverage
state and frozen sends. [Retrieval details](media-retrieval.md) distinguish receipts,
private byte caching, actual image blocks and unsupported binary transports.

## References and limits

- [Telegram privacy mode](https://core.telegram.org/bots/features#privacy-mode): ordinary-message delivery choices are separate from connector authorization.
- [getChatMember](https://core.telegram.org/bots/api#getchatmember): only the bot's own status is inspected; no admin-dependent other-user roster check is used.
- [Update](https://core.telegram.org/bots/api#update): `my_chat_member` reports the bot's status; other-member updates are not sender-approval events.

The connector does not guarantee audience privacy or prevent administrators adding
readers. It does not import arbitrary Telegram history, undo visible messages or
make allowlisted text trustworthy. Topic mode, retention and private-topic issue
#15 limits remain documented in the topic guide. No live settings are changed by
repository tests or by this documentation.
