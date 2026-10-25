# Approved private groups

The connector can notify the dot about text in a separately approved private group
containing exactly two approved humans and its dedicated bot. Existing private
chats continue independently. It exposes Telegram tools; the dot chooses whether
to answer, acknowledge (including emoji-only text), combine already-arrived
messages or remain silent. No per-message reply or quote is required.

## Activation, with owner approval

1. Inventory the existing Site/plugin, private lists, tasks and complete trigger
   sets. Preserve private chats, credentials and subscriptions. Source development
   does not authorize deployment or group access. Obtain approval for deployment
   and for this exact group and **each** of its two human participants, including
   group history reads and intended sends. Obtain their informed agreement to
   forwarding accepted shared text to the owner's dot. Keep real IDs private.
2. The owner configures a private group/supergroup containing only those
   two humans and this bot. No public usernames, linked channel, location or
   community association are supported. Disable ordinary members' invitation
   permission, revoke unnecessary invite links, review join approval and visible
   history settings, and minimize administrators who can invite or change settings.
   Approved human admins must turn off **Remain Anonymous** so their messages
   carry their actual approved user IDs. The bot needs **administrator status**, which makes other-user `getChatMember`
   checks reliable and delivers `chat_member` updates. This connector does not need
   invite, ban, delete or topic-management rights; give it no unnecessary powers.
3. Admin bots receive ordinary group messages even with privacy mode enabled.
   Disabling privacy mode alone is insufficient for this implementation because
   membership checks require administration. Leave global privacy mode unchanged;
   verify the bot is an admin in the exact intended group. Anonymous admin posts
   (`sender_chat`) and bot senders are not accepted as approved human messages.
4. Deploy the reviewed artifact with its additive D1 migration, preserving existing
   D1 data and private-chat lists. In native private runtime settings, set optional
   `TELEGRAM_ALLOWED_GROUPS` to a JSON object: each negative safe-integer group ID
   string maps to an array of exactly two distinct positive human ID strings.
   Maximum ten groups. These participants need not be in the private-chat lists;
   group approval does not grant private-chat access. Never commit actual values.
   Apply the saved environment revision. No new Site/plugin/bot is needed.
5. After bot-connection approval, call `configure_telegram_webhook({})` to retain the
   same fixed webhook and request `message`, `chat_member`, `my_chat_member`, with
   pending updates preserved. Do not skip this update just because the URL already
   matches. It refuses a competing webhook and never changes Telegram membership.
6. Call owner-only `verify_group_access` for the approved group, with explicit
   activation approval. This checks private metadata, two counts of three members,
   the exact approved humans and the bot's administrator status. Initial state is
   paused; failed/unavailable checks stay paused. Owner-only status reports stored
   state but does not independently inspect live membership. Repeating a successful
   verification preserves the active history epoch.
7. Use the genuine event service's **string** `chat_id` filter for that group and
   the existing verified callback origin. Inspect before creating: keep exactly one
   active subscription/responder per chat. Add a distinct group-scoped trigger/task
   without replacing either private-chat trigger or creating duplicate responders.
   Use a **separate group task** with its own adapted group instructions, preserving
   both private tasks. Do not attach group events to an unchanged private prompt.
   The subscription performs a signed verification; that is not a Telegram test.
8. Adapt the task's actual-event checks to the exact group ID and its two approved
   sender IDs. Require complete real event data; history is context, not a
   fabricated trigger. Use a fresh activation timestamp. Keep task context and
   bounded `get_recent_messages` reads scoped to this group, plus explicit
   `message_thread_id` for forum groups. Do not
   automatically copy private context into the group. If a request would need
   private information or unclear authority, clarify privately in ChatGPT. This is
   an access/authority boundary, not a mandatory conversational script.
9. Only with separate test-message consent, verify a real incoming group event,
   chat-scoped history and an authorized send. A successful outbound send proves
   neither incoming callback delivery nor model execution. Check both existing
   private chats still work. Record automated, hosted and live checks separately.
   Do not run destructive membership tests on a live group without separate consent.

### Context and authority for the group task

Privately identify whether either approved human is the connector owner; if known,
record that owner's Telegram ID separately from the approved-sender set. Do not
infer ownership from being an admin, membership or message claims. Approval to
participate permits shared conversation, not owner-level control of apps, files,
credentials, recipients, settings or other external actions. Other participants'
requests do not grant the owner's authority. Apply the host's ordinary authorization
rules; the dot chooses how to respond naturally when authority is unclear.

Do not disclose owner-private memory, other chats, files, connected-app data or
management context to the shared group without explicit owner authorization for
that information and destination. Shared group history can provide normal context;
unclear private information needs clarification privately in ChatGPT. This does not
force a reply, refusal script or one-message policy. The dot may answer, acknowledge,
combine messages or stay silent using its judgment and existing authorization.

Validate every actual event's exact group ID, either approved sender ID, safe numeric
update/message IDs, text and UTC timestamp at/after activation. Keep bounded reads
and frozen plans in this group. An actual message anchor does not imply quoting.
Retain unresolved substantive requests and authoritative coverage; an emoji-only
text acknowledgment does not resolve a request. Use the frozen-plan safeguards in
[normal chat](normal-chat.md) with a group-specific task, rather than copying its
single-sender/private-context assumptions.

## Membership changes and recovery

Every group text admission, callback delivery, history read and fresh send checks
Telegram's current group metadata, member count and individual approved members.
The bot must remain an admin and the exact roster must contain three members.
Network errors, rate limits or malformed API responses fail closed and pause access.
Immediate callback delivery reuses its own ingress inspection and rechecks the D1
epoch immediately before forwarding. A bounded recovery invocation inspects each
group once and keeps per-event epoch guards; later invocations inspect again. There
is no cross-request membership cache. Each inspection makes seven bounded API calls,
so bursts/rate limits can still pause access. Avoid unnecessary tool calls; never
weaken checks or silently retry to recover availability.
Authenticated `chat_member`, `my_chat_member`, join/leave and migration service
updates also pause the group, including expected departures or role changes.
Repeated updates are deduplicated for seven days. Unapproved/anonymous senders
pause without admitting their text. Paused text updates get seven-day ID markers
without text, so retries do not silently backfill them after recovery.

The pause persists across Worker restarts. Repair the group manually, review any
possible exposure, obtain owner approval and call `verify_group_access` again.
No automatic re-enable, participant approval, kicking, subscription migration or
new-ID adoption occurs. An ID migration needs separately approved configuration.
Revocation/config changes prevent forwarding and sending. The owner can disable
the exact existing group subscription even after removing its config entry.

Before removing/replacing approvals, call owner-only `pause_group_access` while the
group still exists in the private record. It durably revokes access and fails pending
events without changing Telegram membership, subscriptions or private chats. Apply
the approved settings change afterward. Every authenticated webhook and owner content
operation also latches observed removals/config changes; status stays read-only.
Membership notifications for previously stored groups are still handled after removal.
Unobserved configuration changes that leave and return to identical values cannot
be inferred from current runtime settings: explicit pause before editing is required.
Drain old Worker revisions before verification; overlapping differing environments
fail closed rather than activating a roster checked under a different approval.

Pending old-epoch events are failed rather than replayed into a new membership
epoch. History after recovery excludes previous epochs; stored text still expires
after seven days with activity-driven physical cleanup. Existing callback/task
state may already contain older forwarded messages: the connector cannot erase
that host context. Reset/reconcile the group task privately after an incident,
without altering independent private tasks. Do not infer an old send was unsent.

Outgoing sends retain the existing stable idempotency protections. An access block
before dispatch returns definite `failed` / `group_access_blocked`; an ambiguous
Telegram dispatch remains `uncertain`. Inspect and reconcile frozen requests before
any newly authorized send. Never change keys, coverage or text to bypass a prior
result. Optional combined replies use an actual included deterministic anchor and
authoritative coverage as described in [normal chat](normal-chat.md); include this
group ID in all keys. Do not apply its single-sender prompt unchanged or transfer
plans between chats. Acknowledgments do not discard unresolved substantive requests.

## Limits and official Telegram references

These checks are snapshots. Telegram offers no atomic membership-check-and-send
transaction; administrators can add people between checks or before a membership
update arrives. A later member may see earlier messages through Telegram history
or copies. Pausing cannot retract content already sent or forwarded. Member
filtering is not a guarantee that only the approved people can ever read a reply.
The bot cannot permanently prevent administrators from adding users. Use trusted
administrators, private invitations and minimal rights, and accept this residual
limit before activation. No scheduled polling or automatic moderation is supplied.

- [Bot API: getChatMember](https://core.telegram.org/bots/api#getchatmember): other-user membership queries require bot administration for guaranteed operation.
- [Bot API: getChatMemberCount](https://core.telegram.org/bots/api#getchatmembercount) and [getChat](https://core.telegram.org/bots/api#getchat): roster count and current chat metadata, not an atomic roster snapshot.
- [Update](https://core.telegram.org/bots/api#update) and [setWebhook](https://core.telegram.org/bots/api#setwebhook): `chat_member` needs administration and an explicit update-type subscription.
- [Privacy mode](https://core.telegram.org/bots/features#privacy-mode): admins receive ordinary group messages; changing global privacy settings is unnecessary here.
- [ChatFullInfo](https://core.telegram.org/bots/api#chatfullinfo) and [ChatPermissions](https://core.telegram.org/bots/api#chatpermissions): public/linked chat metadata, invitations and visible history require deliberate review.

Forum supergroups use [explicit topic routing and retained history](group-topics.md).
Private-thread mode (issue #15), media and automatic moderation remain outside this
feature. Tests simulate Telegram responses with synthetic identifiers;
they do not certify real group settings, host identity or a live round trip.
