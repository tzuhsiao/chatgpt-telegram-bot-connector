# Private topic titles

The Dot can name an approved private-chat topic through `rename_private_topic`,
backed by Telegram `editForumTopic`. The host's existing Dot chooses the title and
when enough context exists. The connector supplies metadata and the edit tool,
without an extra inference API, per-message requirement or cross-topic read.
General (omitted ID or 1) and group topic naming are outside this capability.

Discretionary automatic naming requires the owner's authorization for this exact
private chat. The adaptable [private prompt](../prompts/private-chat.md) contains
the policy. Source development does not update a task, change BotFather settings
or rename live topics. Topic mode remains an owner prerequisite.

## Metadata and edits

`get_private_topic(chat_id, message_thread_id)` reads local durable title metadata
for the exact approved private named topic: `observed`, `name`, `provenance`,
`revision`, `automatic_eligible` and a busy `operation_state` when present.
Unobserved topics report unknown provenance and revision 0; that does not permit
an edit. This read neither contacts Telegram nor reconstructs history.

Webhook observations use the same actual human sender and matching private chat
allowlists as ordinary intake. Top-level `forum_topic_created` with
`is_name_implicit: true` establishes implicit provenance. Explicit creation names
and human `forum_topic_edited.name` are manual. Ordinary messages establish only
topic existence with unknown provenance. Bot echoes, nested quote/forward fields
and icon-only changes cannot establish naming permission. Lifecycle messages do
not become conversational inbox rows or events. Chat service message IDs order
observations: duplicate/older creation cannot revert a manual title to implicit.
Missing lifecycle evidence fails closed, including topics created before upgrade.

`rename_private_topic` requires `chat_id`, explicit `message_thread_id` greater
than 1, `name`, `mode`, `expected_revision` from metadata and a stable ASCII
`idempotency_key`. `automatic` requires current implicit provenance. One confirmed
automatic edit records Dot provenance, suppressing later automatic churn. `manual`
requires an explicit owner-directed title change, including known topics with
unknown provenance; it records manual provenance. Incoming content grants no such
authority. Identical known names return `unchanged` without a Telegram call. Only
`name` is supplied to the API, preserving the topic icon.

A successful decision to keep identical wording still records mode-appropriate
provenance (manual or Dot) and advances the revision atomically with its operation
identity. Duplicates replay that decision without advancing the revision again.
Stale automatic requests cannot override it; automatic naming is complete.

Choose a concise meaningful title after substantive context. Chinese 8–12
characters and English about 20–24 characters are soft stylistic targets, never
validation rules. Meaning takes precedence; there is no mechanical truncation.

## API limit and Unicode

The [Bot API](https://core.telegram.org/bots/api#editforumtopic) documents 0–128
characters for an edit; empty/omitted names keep the title. An actual rename here
requires nonempty visible content and at most 128 Unicode code points, rejecting
unpaired UTF-16 surrogates. The supplied string is preserved; Telegram itself may
normalize whitespace and empty characters.

Counting was checked against official upstream source on 2026-10-28:
[the adapter](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp)
passes the name to TDLib;
[ForumTopicManager](https://github.com/tdlib/td/blob/master/td/telegram/ForumTopicManager.cpp)
uses `clean_name` with the
[128 limit](https://github.com/tdlib/td/blob/master/td/telegram/ForumTopicManager.h);
[`strip_empty_characters`](https://github.com/tdlib/td/blob/master/td/telegram/misc.cpp)
uses [`utf8_truncate`](https://github.com/tdlib/td/blob/master/tdutils/td/utils/utf8.h),
which counts UTF-8 character starts, equivalent to code points for valid input.
A supplementary-plane emoji counts once; `e` plus a combining acute counts twice.
Tests cover CJK, emoji and combining sequences at/over the limit. This is source
verification, not a live boundary experiment.

## Concurrency and manual precedence

Operations freeze target, title, mode and revision under a separate durable
key/hash namespace. Conflicting arguments fail. Atomic reservation checks revision
and provenance; a unique busy-topic index serializes different keys. A final
revision guard precedes dispatch. An observed human rename cancels undispatched
reservations. After dispatch, a call cannot be recalled: late confirmation does
not replace newer stored manual metadata, and reports `superseded: true`.
Telegram exposes no conditional edit or current-title lookup here. Unobserved
edits and the gap between the final database guard and network dispatch remain a
qualified race boundary, not an upstream exactly-once or manual-title guarantee.

States are `reserved`, `applying`, `applied`, `unchanged`, `failed`, `uncertain`.
Consistent Telegram client rejections are failed; network loss, redirects, server
errors and malformed responses are uncertain. After 30 seconds a still-reserved
operation is provably pre-dispatch: the next naming call atomically marks it failed
with `reservation_expired`, releasing its topic without retrying its old key.
State/timestamp guards prevent expiry from canceling a competing fresh applying
claim. Stale applying operations become uncertain and keep their target locked.
Metadata reads report these logical expiry states without changing storage.
Neither failure nor uncertainty
automatically retries. Never change keys/arguments to bypass them. Reconcile with
metadata reads and private evidence; the edit tool is not a status probe.
Uncertain targets stay locked even after human renames/restarts. Naming does not
consume reply coverage or gate ordinary authorized intake/replies.

## Persistence and validation

Schema-only migration `0007_private_topic_names` adds title state and operation
records. These persist for the installation's lifetime: title strings, topic IDs,
provenance/revision, frozen requested titles, hashes, states and timestamps.
They are outside seven-day inbox and thirty-day send/reaction cleanup: expiry must
not erase manual protection or unlock uncertain edits. Disclose this before an
upgrade. A separately authorized deletion/reset is not proof of non-execution.

`tests/topic-names.test.mjs` uses real SQLite-backed D1 and synthetic network
responses for authorization, exact routing, lifecycle ordering, Unicode,
concurrency, manual precedence, restart/cleanup and independent ordinary replies.
Hosted behavior and Telegram round trips need separately authorized acceptance.
