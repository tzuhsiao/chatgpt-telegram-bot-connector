# Group topics and retained conversation history

Approved private supergroups can keep Telegram Topics enabled. The exact group and
actual human sender allowlists apply independently of the audience. Bot-self access,
routing checks and explicit revocation remain; roster size, invitations and harmless
joins are not authorization gates. Topic routing does not approve new senders, grant
owner authority, or impose a conversational policy. The dot decides whether to
answer, acknowledge, combine already-arrived messages in a topic, or stay silent.

## Routing contract

- One existing chat-scoped subscription delivers all accepted topics. Forum events
  include integer `message_thread_id`; their `(chat_id, message_thread_id)` pair
  identifies context. Never infer topic IDs from titles or invent missing events.
- Named-topic messages require Telegram's actual positive safe-integer thread ID
  and `is_topic_message` flag. General is normalized to **1**. Telegram's General
  messages do not carry the named-topic flag; an ordinary General reply thread is
  still General, even if it has a different reply-thread ID.
- Forum `send_message` and `get_recent_messages` require an explicit integer
  `message_thread_id`, including **1 for General**. Omitting it fails before send
  rather than silently moving a named-topic reply into General. For General the
  connector omits the Bot API thread argument; named topics pass their ID.
- Non-forum private/group calls retain their old behavior and omit this argument.
  Ordinary non-forum reply threads do not become forum topics. Explicit private
  topic messages/sends are unsupported here; issue #15 remains separate.
- Normal sends omit `reply_to_message_id`, so topic routing does not require a
  quote. If a quote is explicitly selected in a forum, its target must be retained
  in this exact chat, topic and access epoch. Unknown or cross-topic targets fail.
- Telegram rejection of a closed/deleted/invalid topic never falls back to General.
  Ambiguous response routing remains uncertain and is never automatically retried.

Topic identity is part of the send request hash. Repeating the same key and exact
arguments reuses its result; changing the topic conflicts. Legacy unthreaded request
hashes remain compatible. Keep frozen plans, coverage and unresolved requests per
topic; do not automatically combine messages from different topics into a reply.
An optional topic plan namespace is
`tg-topic:v1:<chat_id>:<thread_id>:<actual_anchor_message_id>:<kind>:<part>`.
Use the actual deterministic included-message anchor and coverage safeguards from
[normal chat](normal-chat.md), with this topic as an additional routing boundary.
Cross-topic context may be consulted deliberately only with applicable authority;
it does not change the destination of the current frozen plan.

## What history contains

`get_recent_messages` defaults to retained **incoming** messages for compatibility.
For a coherent available topic view, request that exact topic with
`include_outgoing: true` and a bounded limit (default 10, maximum 20). It returns
newest message ID first, with `role: user` / `role: bot`, actual sender ID, chat/topic/message
IDs, text and timestamps. Incoming timestamps originate in accepted Telegram
updates; outgoing timestamps record local confirmation time.

This is only the connector's retained view. Bot API access does not fetch arbitrary
past chat/topic history. There is no import, backfill, reconstruction from hashes,
or claim of a complete Telegram transcript. The view excludes messages missed
before installation, ignored while paused, expired/deleted connector records, and
bot sends not confirmed by this connector. Failed, in-flight and uncertain sends
are not presented as confirmed replies. It cannot see manual bot sends elsewhere,
and it does not track later Telegram edits or deletions. Prior-upgrade outgoing
operation metadata cannot reconstruct old reply text.

New confirmed bot sends save their submitted plain text separately for **seven
days from confirmation**, across supported chats. Incoming text retains its existing
seven-day window. The outgoing idempotency table keeps metadata/hashes for thirty
days, without extending text retention. Logical expiry applies to reads; physical
cleanup is activity-driven and can occur later on idle Sites. Backups and Telegram/
ChatGPT may retain their own copies. Reused sends do not recreate expired text.
Group history, including bot replies, is limited to the current access epoch.

## Upgrade and activation

The parent/operator deploys reviewed source with additive migration
`0003_group_topics.sql`, preserving existing D1, private allowlists, credentials,
callbacks and subscriptions. If active, call `pause_group_access` before upgrading
this forum deployment; keep the currently paused group paused. Ordinary non-forum
groups remain compatible, but enabling/disabling Topics needs owner re-verification. After
approval, call `verify_group_access` and check its `is_forum` result, bot access
   and active status. A mode change after verification pauses access; owner recheck
starts a new epoch. A generic verification failure can have other bot-access/API/
metadata causes and is not proof that Topics was the sole problem.

Update the existing group task before activation: validate actual events and both
approved senders, require the event's topic ID, keep context/coverage per topic,
pass the same topic to history and sends, and preserve uncertain operations. Keep
both private tasks separate. No duplicate plugin, Site, bot or topic subscription
is needed. No additional topic-management rights, BotFather private-thread toggle,
or automatic topic creation/rename/delete is introduced.

With test-message consent, verify General and at least two named topics, isolated
incoming/confirmed-bot history, normal unquoted sends and both private chats.
Outbound success alone does not verify incoming callbacks or task execution.
Automated tests simulate APIs; real Telegram/hosting behavior remains a live check.

References: [Bot API Message](https://core.telegram.org/bots/api#message),
[sendMessage](https://core.telegram.org/bots/api#sendmessage),
[Telegram forum semantics](https://core.telegram.org/api/forum#interacting-within-topics),
and the [official Bot API implementation](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp)
for General versus named-topic serialization.
