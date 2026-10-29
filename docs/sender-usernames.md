# Observed sender usernames

An accepted incoming message may carry `sender_username` in its signed
`telegram.message.received` event and authorized `get_recent_messages` result.
It comes only from that message's actual top-level `message.from.username` after
the existing webhook, sender and chat checks. Quotes, forwards, mentions, chat
profiles and embedded users cannot supply it or grant access.

The connector accepts a nonempty ASCII string of at most 32 letters, digits or
underscores, without `@`, and preserves case. This is a bounded metadata check,
not Telegram account-registration validation; short collectible usernames are
not rejected by a five-character minimum. The Bot API defines
[User.username as optional](https://core.telegram.org/bots/api#user), and the
[Telegram FAQ](https://telegram.org/faq#q-what-can-i-use-as-my-username) describes
the character set and preserved capitalization. Missing, non-string, empty,
overlong or otherwise malformed values become SQL `NULL` and are omitted from
events/history without rejecting an otherwise accepted message. Stored values
are revalidated on both read paths.

This is a snapshot at the message's `sent_at` (event) or `occurred_at` (history).
A later rename/removal does not rewrite earlier snapshots; an absent field means
unavailable, not proof that the sender has no username now. Duplicate updates and
event retries keep the first admitted snapshot. Usernames are mutable, untrusted
display metadata, never verified current handles, stable identities or permission
evidence. Authorization continues to use numeric IDs with the existing exact
chat/topic and group-epoch checks. A historical literal `@handle` may now belong
to someone else; this field does not verify where a current mention would route.

Migration `0008_sender_username` adds one nullable inbox column using schema-only
SQL. Legacy rows remain unknown; no username is guessed, fetched, or copied from
another message or topic. Confirmed outgoing bot text has no observed human
username and omits the field in mixed history. No independent profile table or
lookup tool is added.

The snapshot expires with its inbox row seven days after `received_at`, under the
existing logical expiry and opportunistic physical cleanup rules. Disclose this
retained metadata before installation/upgrade consent through the
[setup skill](../.agents/skills/telegram-bot-connector-setup/SKILL.md); see
[privacy and retention](operations.md#retention-privacy-and-maintenance).

Upgrade completion also requires the supported discovery refresh and separately
consented username-bearing event/history verification in the
[setup skill](../.agents/skills/telegram-bot-connector-setup/SKILL.md#username-metadata-upgrades).
Host schema caching/enforcement is unverified; do not assume subscription recreation
is needed or sufficient to refresh discovery.

Username preservation does not itself authorize a mention. The separate
[explicit ID-mention contract](outbound-mentions.md) supports inline entities using
approved retained sender IDs, independently of observed usernames. No unrestricted
parse mode is exposed; tool/event names, routing and existing permissions remain.
