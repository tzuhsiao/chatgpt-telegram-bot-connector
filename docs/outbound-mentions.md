# Explicit ID-based mentions

`send_message` accepts optional `mentions`, at most twenty objects containing
`user_id` (a positive safe-integer string), `offset` and `length`. Ranges index the
unchanged `text` in UTF-16 code units. They must be nonempty, contain non-whitespace
text, stay in bounds, not overlap and not split a surrogate pair. Mention-bearing
text must be well-formed Unicode. Array order is normalized by offset; adjacent
ranges and repeated references to the same approved user are allowed. An omitted
or empty array preserves the plain-text contract.

For example, with synthetic approved sender `20002` retained in group topic 70:

```json
{
  "chat_id": "-1001234567890",
  "message_thread_id": 70,
  "text": "😀 Two, please check this.",
  "mentions": [{ "user_id": "20002", "offset": 3, "length": 3 }],
  "idempotency_key": "synthetic-mention-1"
}
```

The emoji occupies two UTF-16 code units. The Worker generates a supported inline
user-link entity, `{ "type": "text_link", "offset": 3, "length": 3,
"url": "tg://user?id=20002" }`, in Telegram's `sendMessage.entities`. This is an
inline ID mention, not a bare URL in message text. No username, profile lookup,
markup parser or caller-supplied URL/entity type is used. Labels are literal text
slices: even HTML/Markdown-looking labels cannot create extra formatting or
change the target. See Telegram's [MessageEntity](https://core.telegram.org/bots/api#messageentity),
[sendMessage](https://core.telegram.org/bots/api#sendmessage) and
[inline user-link limitations](https://core.telegram.org/bots/api#formatting-options).

## Authorization and routing

An ID must belong to an explicitly approved actual human sender in the exact
destination chat. A current retained inbox receipt from that sender must exist in
the same topic and group approval epoch, under this bot, within seven days of
receipt, without an access-revocation marker. Configuration alone does not establish
provenance. Contact cards, forwards, quotes, display names, usernames and arbitrary
text cannot supply it. A target seen only in another topic/chat or an old epoch is
rejected; the connector does not search Telegram for arbitrary IDs or audit a roster.

Existing owner, destination, private-recipient and group-access checks still apply.
Forum groups require an explicit topic; private General omission/1 equivalence
remains unchanged. In a private chat the only eligible target is its approved
recipient. Group participation grants no private-chat access. Mention authorization
never authorizes a new send. Provenance is checked before reservation and again
before dispatch; group revision checks remain in the final dispatch claim. Database
checks and Telegram dispatch are not atomic, so a change after the final relevant
database snapshot can still race with the network request.

Telegram membership and privacy settings can limit mention behavior; retained
provenance does not prove current membership or arbitrary-ID reachability. An
accepted send is not proof of reading, successful attention or a guaranteed push
alert. No live message probe is required or authorized by source development.

## Frozen requests and retained results

The request hash includes normalized IDs/ranges, generated entity type/URL, text,
destination, exact supplied topic and optional quote target. Reordering an identical
mention array reuses the request. Changing a target, range, text, topic, destination
or quote with the same key conflicts. Omitted/empty mentions retain the exact old
plain-text hash, including replay of pre-upgrade stored operations.

Existing success reuse, concurrency, failed results and uncertainty locks apply.
Replay reports the recorded operation and does not revalidate or resend it. A
failed, sending or uncertain result must be reconciled privately; never silently
strip mentions, fall back to another topic or switch keys to resend. Loss of target
provenance after reservation records `mention_access_changed` under the frozen key.
The first response reports that recorded `failed` state and requires private
reconciliation; it is not reported as a request that never reserved a key.

Mention-bearing send results include the normalized `mentions`, describing what
was requested, including on failed/uncertain results; they do not certify Telegram's
rendering. Migration `0009_outbound_mentions` adds nullable `mentions_json` to
`outgoing` (thirty-day operation retention) and `sent_messages` (seven-day confirmed
history). Mixed `get_recent_messages(..., include_outgoing: true)` returns mentions
only for corresponding confirmed bot rows, under existing exact topic/current-epoch
access. Incoming rows and legacy/plain-text bot rows omit the field.
Damaged stored mention metadata is also omitted for that row without discarding its
text or other history rows; it is never repaired or partially accepted as valid mentions.
Metadata expires with its containing record under existing opportunistic cleanup,
without a separate profile store or indefinitely retained label. The label is
already part of text.

Deployment, additive migration application, discovery refresh and separately
authorized hosted acceptance remain operational steps under the
[setup skill](../.agents/skills/telegram-bot-connector-setup/SKILL.md). Local synthetic
tests do not establish live host schema refresh or Telegram rendering/notification
behavior; no subscription recreation is implied.
