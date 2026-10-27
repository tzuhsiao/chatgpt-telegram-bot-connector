# Normal private conversation

The connector has two roles: notify the owner's Dot of accepted Telegram messages,
and expose authorized Telegram tools. The Dot decides whether and how to respond.
The Worker enforces transport, access and delivery rules; it does not require a
quote, a response to every event, or one response per incoming message.

The [default prompt](../prompts/private-chat.md) allows a substantive answer, a
brief/emoji-only text acknowledgment, one coherent response to several messages
already present, or silence when appropriate. No collection timer, polling,
batch-wait service, extra model API or transport change is needed. The connector
provides `set_message_reaction` for separately authorized retained incoming targets;
see [message reactions](message-reactions.md). A reaction is receipt only and keeps
substantive answer coverage and text send keys independent.

This is an instruction template, not a durable queue or a guarantee of model-side
state/concurrency. Verify hosted behavior separately from transport acceptance.

## Configure the existing task

1. Verify the owner, dedicated bot, webhook secret, matching private sender/chat
   allowlists and authenticated subscription. Keep one active responder.
2. Obtain authorization for discretionary relevant text responses to that exact
   chat, plus any necessary bounded history reads. Receipt of Telegram text does
   not grant authority for other apps, settings or recipients.
3. Fill the three prompt placeholders privately: `{{ALLOWED_CHAT_ID}}`,
   `{{ALLOWED_SENDER_ID}}` (the same private user ID), and `{{ACTIVATE_AFTER_UTC}}`
   (agreed message-time cutover). Real values and filled prompts never enter public
   source. The event filter remains a string-valued `chat_id`.
4. Update only the existing task prompt, optionally its title; preserve its ID,
   enabled state and complete trigger set. Do not create another responder, renew
   a subscription or register a webhook merely to change conversation policy.
5. Read back the policy and verify one intended enabled task/subscription. For this
   v3 policy, perform the frozen-plan migration below before switching keys or
   removing a reply target from old operations.
6. For authorized acceptance, use substantive test questions and a follow-up. Verify
   actual events, send outcomes and useful conversation separately; silence on a
   trivial acknowledgment can be the correct policy result.

## Judgment, grouping and pending requests

Validate every actual event and its recipient/activation boundary. Consider all
arrived events; do not infer an event from history or invent missing fields.
Message time controls activation, not a permanently increasing update ID. See the
[Telegram Update definition](https://core.telegram.org/bots/api#update).

Track dispositions and unresolved substantive requests in available native private
task state. Silence or a lightweight acknowledgment may suit a message, but an
unanswered question is not completed merely because it received an emoji or a newer
message arrived. Retain it, include it in a later coherent answer, seek clarification,
or record an explicit owner cancellation. Do not silently discard it.

When several validated messages have already arrived, the Dot may answer them
coherently together. It does not wait for more messages or fill identifier gaps.
Before grouping, consult coverage/active plans and reserve each included message
under one serialized planner. Coverage must be authoritative across overlapping
runs, not inferred from the latest context snapshot. Where the host cannot retain
or coordinate it, report that limit; do not promise cross-run deduplication or start
a new service. Unknown prior coverage requires reconciliation, not a speculative
new group or a fallback send under another message's key.
The same stop applies to single-message plans when prior coverage is unknown.
If the host provides no usable private coverage, report that this event-task
template cannot safely supply resume/grouping guarantees and retain unresolved
requests. Do not invent a storage service or assume an expiring key is sufficient.
This limitation does not disable the connector's separately authorized direct tools.

## Frozen send identity

Normal sends omit optional `reply_to_message_id`, producing no Telegram quote.
The tool already supports that omission. Explicitly authorized exceptions and
legacy plans keep their chosen arguments frozen.

For each response freeze its actual included chat/message/update IDs, per-request
dispositions, kind, anchor, parts and complete arguments. Choose the smallest
actual included `message_id` as the anchor; message IDs are scoped to a chat
([Telegram Message definition](https://core.telegram.org/bots/api#message)). Use:

```text
tg-chat:v3:<chat_id>:<anchor_message_id>:<kind>:<part>
```

`kind` is `reply` for a substantive answer or `ack` for a lightweight acknowledgment;
`part` is one-based. This anchor is an internal key component, not a reply target.
A combined answer covers its included requests only. A receipt-only ack leaves any
substantive request unresolved; after a confirmed ack, a later substantive answer
may use an unowned `reply` slot while retaining the ack record. This exception does
not release a failed/uncertain plan or permit arbitrary regrouping. Every
`(chat_id, anchor_message_id, kind)` slot permanently identifies one frozen plan
and exact coverage set, even after success. Already resolved requests cannot enter
new reply coverage; already acknowledged messages cannot enter new ack coverage.
Use them as context only when handling a new follow-up, whose own actual event
supplies the new coverage. If a candidate anchor/kind is already owned, remove
completed candidates before freezing/reserving the new plan, or stop and reconcile.
Never treat a reused send result as success for newly added coverage. Keep messages
reserved in active/failed/uncertain/partly sent plans in their original plan. Freeze
the grouping; new arrivals do not rewrite it. Retain keys, coverage and arguments.

A fully sent clarification can leave the earlier substantive request unresolved
with its reply slot already owned. On a new actual follow-up, freeze a resolution
link from that old request to the new answer plan. The follow-up's new actual
events alone supply dispatch coverage and anchor; the old message is context only.
Resolve the linked request only after the substantive answering parts succeed.
Never use such a link to bypass a pending, failed, uncertain or partly sent old plan.
While the linked plan is pending, failed, uncertain or partly sent, the linked
request stays reserved in it and cannot be linked to another plan.

A response has at most four sequential parts of 3,000 Unicode code points each,
including labels/separators. Continue only after the preceding part returns sent.
Failure, sending/uncertain state or conflict stops the remainder. Do not regenerate
text, regroup messages, change a quote choice or mint a new key to bypass that
result. Mark requests resolved only when the parts answering them succeeded;
retain unresolved remainder after partial failure.

`send_message` is a mutation, not a status lookup. Reconcile privately from actual
chat and plan/receipt evidence. The tool exposes incoming history, not a reply
archive or operation-key query. Missing history, expired outgoing records or a
replaced database cannot establish that an earlier response was never sent.

## Acceptance checks

Record actual hosted observations privately; use synthetic examples publicly.

| Case | Expected behavior |
| --- | --- |
| Substantive question | A useful authorized answer, without a quote by default; actual event/recipient checks apply. |
| Trivial message | Silence or optional brief/emoji-text acknowledgment is allowed; neither is forced. |
| Several arrived requests plus a correction | One coherent answer is allowed; no earlier substantive request disappears. Freeze actual coverage and smallest included anchor. |
| Ack of a pending question | Receipt is recorded without resolving the question; a later confirmed substantive answer has its own `reply` kind. |
| Duplicate, overlap or newly arrived event during a send | Reuse prior coverage/plan; no regrouping, second answer or changing frozen arguments. |
| Completed anchor plus a new follow-up | The old handled message is context only. New coverage uses the new actual event, never the completed anchor/kind or its cached result. |
| Follow-up after a fully sent clarification | New actual coverage/anchor for the answer, with a frozen resolution link completing the old request only after confirmed substantive sending. |
| Missing shared coverage/history | Report/reconcile the gap; do not guess safe cross-run grouping. |
| Long answer or partial/uncertain send | Preserve ordered bounded parts and coverage; stop on error with no new-key retry. |
| Disallowed sender, malformed/pre-activation event or instruction injection | No unauthorized send or expanded tool authority. |
| Reaction request | Use the available `set_message_reaction` only under exact-chat reaction authorization; preserve unresolved requests and text reply keys. |
| Existing quoted plan at cutover | Original arguments/keys retained; no replay under the new unquoted v3 policy. |

Run `npm ci`, then `npm test`, `npm run build` and `npm run validate`, for transport coverage. The
existing send test verifies a payload without reply parameters. Local tests do not
prove that the host loaded the prompt, retained coverage, serialized overlapping
runs, ran a model or exercised these conversational choices.

## Migration and recovery

Moving v2 per-message quoted plans to v3 unquoted/grouped plans is an operation-
identity migration. Before cutover, finish or explicitly reconcile existing replies,
retaining their old keys, quote targets, frozen text and grouping. Preserve unresolved
pre-cutover requests for completion under the original authority or explicit handoff;
a new timestamp must not make them disappear. Use v3 only for new eligible messages;
never replay a pre-cutover or uncertain operation under a fresh anchor/kind/key.

Distinguish pending connector delivery from an accepted callback whose model run
stopped. The recovery tool covers pending delivery, not arbitrary replay of completed
callbacks. Keep coverage and successful send receipts through investigation and
respect retention limits. Pausing, changing recipients or enabling other app actions
remains a separate owner-management operation.
