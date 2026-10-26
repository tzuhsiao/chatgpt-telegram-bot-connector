# Operations

This guide covers the single-owner, dedicated-bot MVP. It uses ChatGPT Sites, a Worker, and D1. It does not require a human Telegram account session, external model API, scheduled polling, or a second relay service.

For agent-driven installation, start with [AGENTS.md](../AGENTS.md) and the
[setup skill](../.agents/skills/telegram-setup/SKILL.md). Install/reuse the Site and
its canonical plugin first, then guide the two intended owner inputs. Use
**Telegram Bot Connector** for the new Site title and **Telegram Bot** for the
canonical plugin display name. The Site hosts the bridge/storage; the plugin gives
the dot its tools. Use supported native naming controls and verify both results.
If separate naming is unsupported, report the actual names and exact observed
limitation. Preserve stable IDs and never silently rename an existing installation.
The bundled landing page uses the generic Site label on a future deployment;
updating its title/brand does not rename hosted Site/plugin metadata. Report any
pre-existing label difference; this documentation change does not deploy or rename it.

Before installing, explain that this is a small bridge running in the owner's
ChatGPT Sites account. Telegram sends it message notifications; it passes accepted
private text to the dot and exposes authorized reply tools. The owner's computer
need not stay on for the bridge. Connector records live in storage attached to
their Site, not on a separate server operated by this repository's author.
Explain the [actual retention](#retention-privacy-and-maintenance) and distinguish
it from Telegram and ChatGPT's own records before requesting setup consent.

Optional [approved private groups](group-chat.md) use the existing two approved
human sender IDs, independently of the audience. Keep group/sender mappings separate
from positive private-chat lists. Activation requires the additive migration,
approved native settings, bot-self update registration, owner-authorized
`verify_group_access` and one chat-scoped subscription. No roster/count or invitation
gate applies; rejected senders and other members' changes do not pause approved
activity. Users manage audience and reply visibility. Bot access/routing failures,
explicit pause and config revocation still halt unsafe operations. Administration
or Group Privacy Mode are Telegram delivery choices, not sender authorization.

## Setup capabilities and limits

| Step | Supported path and boundary |
| --- | --- |
| Site, D1 and plugin | Native Sites tooling can create a private Site, prepare storage and publish its canonical App/plugin. Follow current host skill/schema; reuse returned identities. A repository skill is not automatically bundled into that plugin. |
| Owner and callback configuration | Derive ownership from a real authenticated MCP call. Derive a callback candidate from a genuine subscription, then independently verify its origin before trusting it. The user need not invent either. |
| Runtime secrets | Native Sites controls store secrets. Plaintext tool arguments marked secret do not provide protected user entry. Use a protected handle/UI; otherwise the owner must enter the token directly in native Sites settings. |
| Independent webhook secret | Generate and assign without exposing it through a supported native path. If unavailable, the owner must generate and enter it securely; this is an extra manual host limitation. |
| Subscription and policy | Use the genuine event service and exactly one task. Preserve all triggers when updating. Callback acceptance does not prove the task ran or retained context. |
| Bot preflight and registration | `configure_telegram_webhook({})` combines bot identity/webhook checks and guarded registration. There is no separate read-only MCP bot inspection tool. A conflicting webhook is refused; an uncertain outcome needs secret-safe inspection before retrying. |
| Human interaction | Host sign-ins, installation/connection approval, dedicated-bot creation, protected secret entry, Telegram Start and a real message may require the owner. |

The [checkpoint helper](../scripts/plan-setup.mjs) is a local, enum-only decision
aid with no mutations, host inspection or persisted state. Its `verified` result
means supplied observations meet the checklist; it does not independently certify
a deployment. Missing capabilities must remain pending/blocked with an exact next
step. The skill does not promise an unattended two-input installation on every host.

## Owner-led clean-install test

The owner may choose to remove an old Site/plugin and test a fresh setup. This is
not authorization for an agent to delete them, change the live bot, or create a
replacement responder. Before deletion, securely preserve the dedicated bot token
in the owner's secret manager, private configuration and installation/task
references, and any required D1 backup under private access controls. Reconcile
pending deliveries and uncertain outgoing operations; a new database loses old
idempotency records, and a backup can contain message text and signing credentials.
Never copy backups, filled prompts or operational values into this repository.

Deleting a Site/plugin does not establish that an automation was disabled or that
Telegram's webhook was removed. Inventory stale task/connector references before
creating a replacement. Resolve each exact stale responder with owner approval.
For the same bot, the old webhook may block registration: use an explicitly approved
migration, or preferably select a new dedicated bot. Reuse requires the owner to
perform [`deleteWebhook`](https://core.telegram.org/bots/api#deletewebhook), preserving
pending updates, through a trusted secret-safe management path. The connector does
not expose deletion; without that path, use a new bot. Do not
force replacement or drop queued messages to make a test pass.

On the new Site, obtain its new Site-scoped owner identity, regenerate the independent
webhook secret securely, re-derive the genuine callback origin, and repeat hosted
acceptance while credentials are absent. Use a fresh normal-chat activation instant
so old queued Telegram messages cannot trigger backfilled replies. Never replay an
old or uncertain send under a new key merely because the database was replaced.
Then verify exactly one canonical plugin and enabled responder, one authenticated
subscription, Start/new text/follow-up behavior, and a read-only re-run of setup
that creates no extra resources, changes no secrets and sends no extra test message.

## Configuration boundaries

The public repository contains source, synthetic tests, and `.openai/hosting.example.json`. It must never contain real owner or Telegram IDs, personal assistant names, bot tokens, webhook secrets, callback URLs, subscription keys, message contents, instance URLs, or deployment IDs.

Keep the canonical public repository separate from the private Site-managed source. The public repository contains `.openai/hosting.example.json` and ignores `.openai/hosting.json`. The private Site-managed source correctly tracks its actual `.openai/hosting.json`, including the `project_id` returned when the new Site is created. That deployment manifest belongs only in the private source: do not copy it into the canonical public checkout or attach it to an issue. The template's D1 binding is named `DB` and its capability is `mcp`.

Use the **native Sites environment/secret controls** for every operational value:

| Field | Validation and source |
| --- | --- |
| `OWNER_USER_ID` | The exact Site-scoped caller ID from a genuine authenticated MCP identity call. Not a Telegram ID or email address. |
| `TELEGRAM_BOT_TOKEN` | Token for a dedicated bot controlled by the operator. |
| `TELEGRAM_WEBHOOK_SECRET` | A separate, cryptographically random secret of 32-256 base64url characters. |
| `TELEGRAM_ALLOWED_USER_IDS` | Explicit comma-separated positive numeric sender IDs. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Explicit comma-separated positive numeric private-chat IDs. |
| `MCP_CALLBACK_ORIGINS` | Exact HTTPS origins observed from genuine ChatGPT subscriptions. |
| `SITE_ORIGIN` | The exact HTTPS origin of this deployment, without a path, query, or fragment. |

Treat even non-token settings as private operational configuration. `.env.example` documents the fields but is not a file the Worker reads automatically. The D1 binding is hosting configuration, not a string-valued secret. MCP subscription signing keys are supplied through the authenticated subscription protocol and must not be reused as webhook or bot credentials.

For an accepted private message, the sender ID and chat ID must match and appear in their respective allowlists. Reading and sending also require the recipient's private ID in both `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_ALLOWED_CHAT_IDS`; listing a chat alone is not sufficient.

## Bootstrap a new deployment

1. Run `npm test`, `npm run build`, and `npm run validate` on Node.js 24. Review the bundle and the public working tree for accidental operational data before publication.
2. Create a new Site **owner-private**. Leave unrelated deployments unchanged. Configure its `DB` D1 binding and install the repository's schema using the supported hosting migration workflow.
3. In the private Site-managed source, retain and track the actual `.openai/hosting.json` with the returned `project_id` and the template's required bindings/capabilities. Deploy the validated bundle. Keep this manifest out of the canonical public repository. Do not put runtime secrets in the manifest or compile them into the Worker.
4. Connect ChatGPT to this private Site's MCP endpoint and invoke `get_connector_identity` through the real MCP connection. The identity tool reports the current caller; it never selects the first visitor as owner. An absent identity is not a usable bootstrap result.
5. Copy the verified Site-scoped caller ID into `OWNER_USER_ID` using native Sites environment/secret controls. Re-run `get_connector_identity` and the owner-only `get_connector_status` to confirm the configured owner is recognized.
6. Set the deployment origin and explicit private-chat allowlists through the same controls. Confirm the Telegram user and chat IDs using trusted account/bot setup information; a display name or username is not an authorization identifier.
7. Initiate a genuine authenticated ChatGPT event subscription. With no trusted callback origin configured, the expected result is `callback_origin_not_allowed`. The connector records only the syntactically safe requested origin before rejecting it. Read `requested_callback_origin` through owner-only `get_connector_status`; independently confirm it came from the genuine ChatGPT subscription, configure that exact HTTPS origin in `MCP_CALLBACK_ORIGINS`, and retry. Presence in status is not proof that an origin is trusted. Do not log or publish the full callback URL or signing key. If the origin cannot be verified safely, stop rather than broadening the allowlist.
8. Complete the hosted acceptance gates below before registering a Telegram webhook. The webhook remains disabled during these tests.
9. Create or select a dedicated Telegram bot, then enter its token and an independently generated webhook secret through the native controls. Do not paste either credential into chat, shell history, a public URL, or a source file.
10. Call `configure_telegram_webhook` with `{}`. This registers the fixed `/telegram/webhook` endpoint under `SITE_ORIGIN`; it is not an arbitrary Bot API or URL forwarding tool.
11. Follow the [one-time welcome procedure](#one-time-setup-welcome) when sending is supported and consented. Otherwise have the owner Start/message the bot. Separately confirm incoming event receipt, the stored message and an authorized reply; welcome success alone does not complete this check.

Registering a webhook changes the dedicated bot's Telegram delivery destination. The tool refuses a bot with a different existing webhook; it does not have an override argument. If moving a bot is intentional, explicitly remove the old integration through the bot's supported management workflow before configuring this connector. Otherwise use a new dedicated bot.

## Hosted acceptance gates

Local tests exercise Worker behavior, not the hosting edge's identity guarantees. Record each check separately; do not describe an untested or blocked check as passed.

### Identity and exposure

- A real authenticated owner call to `get_connector_identity` returns a nonempty Site-scoped caller ID.
- With `OWNER_USER_ID` configured, a real owner call to `get_connector_status` succeeds.
- Anonymous sensitive MCP calls fail. Public discovery and identity reporting, if available, must not expose owner settings, subscription data, messages, or credentials.
- Anonymous requests with a forged `oai-authenticated-user-id` matching the configured owner still fail for a sensitive tool and subscription mutation. Test at the actual public network edge, not by injecting headers directly into `worker.fetch`.
- Missing or wrong identity fails closed for owner operations. If a separate authorized test account is available, verify that it cannot act as the owner.

Owner-private access control may itself reject anonymous requests. That alone does **not** prove that the edge sanitizes forged headers once the webhook is publicly reachable. Keep Telegram credentials absent and the webhook unregistered while verifying the intended public access configuration. If verification needs a temporary visibility change, keep it limited to this new deployment, test the real edge immediately, and return to owner-private on any failure. Do not expose a populated production deployment to investigate this boundary.

If the edge accepts forged identity headers, or a real owner lacks a usable verified identity, stop. Do not add a fallback identity, trust an email string, bind the first caller, or weaken authentication to make the test pass.

### Event subscription lifecycle

- Create a real `telegram.message.received` subscription with a `chat_id` **string** filter for one allowlisted private chat.
- Confirm callback verification succeeds only for the configured exact HTTPS origin.
- Repeat subscription creation as the same subscriber to exercise idempotent setup. A different active subscription must not silently replace the current one for that chat.
- Renew the real subscription and confirm renewal still carries the authenticated owner identity. Exercise signing-key rotation if the client supports it.
- Unsubscribe and confirm delivery stops; recreate the subscription before the live message check.
- Confirm unauthenticated subscription creation, renewal, and deletion are rejected.

If background subscription or renewal requests do not carry usable verified identity, stop public rollout. Do not exempt event methods from ownership checks. Callback destinations may not use HTTP, credentials, fragments, IP literals, non-default ports, suffix matches, or wildcards. Redirects must not be followed during verification or delivery.

### Live bot round trip

After both preceding gates pass:

1. Configure the dedicated bot token, independent webhook secret, explicit sender IDs, and private chat IDs.
2. Register the webhook with `configure_telegram_webhook({})`.
3. Prefer the consented [one-time welcome](#one-time-setup-welcome), recording outbound acceptance separately. Ask the owner to reply to it; if unavailable, have the owner Start/message the bot.
4. Confirm the message is persisted and a signed MCP event reaches the active ChatGPT subscription.
5. Read the accepted message with `get_recent_messages` and reply using `send_message` with a new `idempotency_key`.
6. Repeat that exact send call with the same key and request. Confirm the recorded result is returned without initiating another bot send.
7. Send a second message and verify the intended conversation behavior. Check that disallowed senders/chats, unapproved groups, channels, and unsupported updates cannot trigger an event or reply.

Do not claim a live round trip passed solely because local tests passed or the Site deployed successfully. A dedicated bot token and an actual approved private chat are required; neither is included in this repository.

## One-time setup welcome

Offer this in setup consent: "After the connection checks pass, may I send one
brief welcome from your bot to your confirmed private Telegram chat?" Resolve the
exact recipient privately before treating consent as granted. Installation or
automatic-reply permission alone is not consent for this proactive message.

After owner identity, both matching allowlists, bot/webhook, hosted gates and the
single responder policy are verified, prefer one welcome **only** when supported:

1. Confirm this exact bot can contact that exact private chat, for example from the
   owner's confirmation that they already started/messaged it. Telegram
   [bots cannot initiate a conversation with a new user](https://core.telegram.org/bots#how-are-bots-different-from-users).
   A numeric ID, valid token or successful webhook registration does not establish
   chat reachability. If unknown, not started, blocked, unsupported or declined,
   skip the welcome and ask the owner to open the bot and press Start/send text.
   Choosing this fallback is terminal: persist `skipped` before prompting. Later
   confirmation that Start succeeded must not enable a delayed welcome alongside
   the normal responder's reply. Keep prior failed/uncertain dispatch evidence.
2. Inspect the durable private setup record for this Site/bot/chat. Use the fixed
   key `tg-setup:v1:welcome:<chat_id>` within this deployment's database; never add a
   timestamp, random suffix or new namespace on resume. The real ID belongs only in
   private configuration/tool arguments, not public examples.
3. Only a proven fresh installation with no prior dispatch **or fallback** may
   initialize that record as ready. An existing installation can reuse ready only
   from the original authoritative record, never by inferring it from absent logs.
   Freeze the full request (recipient, brief text, key, no reply
   target), and persist the intent before sending. Example text: "Your dot is
   connected. Reply here to check that your messages reach it." Localize once
   before freezing, not again on retries. Use a single setup writer or supported
   native reservation; if durable record storage/coordination is unavailable, use
   Start/message instead. This advisory helper does not supply that storage.
   A qualifying native private facility survives new sessions/agents, restarts
   and redeployments, supports authoritative read-before-write and a single writer
   or reservation, and retains terminal markers for the installation's lifetime.
   Chat history/model memory and the expiring `outgoing` table do not qualify.
4. Re-read the record, mark dispatch attempted/sending durably before the call,
   then invoke `send_message` once with the frozen request. Keep the operation key
   and frozen request as evidence during private reconciliation. If persisting the intent fails
   or its outcome is uncertain, do not send. An interrupted run with a sending
   record is uncertain even if it may have stopped before the network call.
5. On `sent` (including `reused: true`), retain a sent marker and Telegram message
   ID. Do not send another welcome on setup resume or after a lost acknowledgement.
   A sending/uncertain/conflicting outcome requires private reconciliation; do not
   automatically retry or change keys. A failed welcome falls back to Start/text;
   Start does not authorize retrying that failed welcome under a new key.

Never call `send_message` to look up an operation's status. It can perform a new
send when its row is absent (before an interrupted insert, after retention cleanup
or database replacement). There is no read-only MCP lookup by operation key.
Reconcile a sending/uncertain welcome through the owner checking the actual chat
and the native private record; incoming-message history is not outgoing evidence.
A same-key repeat is protected only while the matching Worker record is known to
remain; it is not a general status probe. If the outcome cannot be established,
keep it uncertain and stop instead of making another call.

Keep the setup record for the installation's lifetime in native private storage,
outside public source and diagnostics. Never reset an attempted/sent record to
ready. The Worker's outgoing operation records expire after thirty days: that
window alone cannot suppress a welcome forever. If the setup record is lost,
expired, unavailable or conflicts with retained operation state, skip sending
and reconcile privately/use Start/message. A new database is not proof of a new
send authorization; distinguish deliberate fresh installation from recovery.
When no durable facility exists to retain a skipped marker, keep welcome unsupported
on resume: absence of history cannot prove that no fallback was chosen. Do not
later initialize a ready record merely because storage/reachability became available.

Report **outbound welcome**, **incoming callback**, **model execution** and **full
conversation** separately. A `sent` result only shows Telegram accepted the
outbound request; it does not show the person read it or that incoming notifications
work. Have the owner reply to the welcome (or send new text for fallback), observe
the real incoming event and authorized answer, then verify a follow-up. Re-running
an already accepted setup is read-only and does not repeat welcome/test messages.

| Setup acceptance case | Expected result |
| --- | --- |
| Fresh, consented, reachable, durable ready record | One frozen welcome request with the stable key. Incoming verification remains pending. |
| Chat not started/reachability unknown, no send capability, no consent or no durable record facility | No probe-send; terminal skipped Start/message fallback, with no delayed welcome after Start. |
| Re-run, including after thirty-day operation expiry | Existing attempted/sent history prevents another welcome; lost history does not count as unsent. |
| Failed, in-flight or uncertain welcome | No new key or automatic resend. Reconcile uncertainty privately; use fallback for a definite failure. |
| Successful welcome without an incoming reply/event | Outbound accepted only; do not claim callbacks, inference or conversation passed. |

## Receiving and recovering events

For the hosted task's ordinary conversation policy, see [normal private conversation](normal-chat.md) and the [reusable task prompt](../prompts/private-chat.md). Task instructions determine which accepted messages receive replies; changing that policy does not require changing the generic Worker transport or registering another webhook. Preserve the original trigger and verify the actual reply behavior separately from callback acceptance.

The connector provides notifications and tools rather than mandatory one-to-one
conversation behavior. Default sends omit optional `reply_to_message_id`. The Dot
may answer, use a brief/emoji-only text acknowledgment, stay silent, or combine
several already-arrived messages into a coherent response, retaining unresolved
substantive requests. No reaction tool, polling loop or collection timer is added.
Combined plans require frozen actual coverage, a deterministic included-message
anchor and safe private coordination as described in the guide. Do not change an
existing plan's key, grouping or quote choice after dispatch or to escape an error.
Emoji text is not a Telegram reaction; any real reaction needs an actually available
and separately authorized tool. Policy changes do not expand transport authority.

Incoming accepted text and [media notifications](media-intake.md) are persisted before event delivery. Receipts store only type, caption and bounded allowlisted identifiers/metadata. [Hybrid retrieval](media-retrieval.md) additionally stores a bounded private byte cache with ten-minute logical expiry and activity-driven cleanup; arbitrary binary model consumption is unsupported. D1 uniqueness and atomic delivery leases coordinate concurrent requests; retries use a stable event ID.

The webhook acknowledges a successful callback, a previously completed delivery, or a terminal failure. A transient callback failure retains pending state and returns a failure to Telegram while the automatic attempt budget remains. A duplicate pending update is reconsidered for delivery according to its lease and backoff, rather than being mistaken for success merely because it was persisted.

After eight failed callback attempts, the record remains `pending` with `last_error` set to `retry_limit`. Automatic webhook requests stop further callback attempts and acknowledge Telegram. This acknowledgement deliberately stops the automatic retry loop; it does **not** mean the callback was delivered. The owner can explicitly recover the event with `retry_pending_events`, retaining its stable event ID.

Redirects and nonretryable callback client errors are terminal instead of recoverable pending state. An event already bound to one subscription identity cannot migrate to a different subscription; a replacement subscriber cannot take over that pending event. Subscription revision checks prevent a stale callback failure from disabling a renewed subscription.

Telegram's own retries are also finite. The MVP has no durable scheduled drainer and makes no eventual-delivery claim based on `waitUntil()`. If Telegram stops retrying, or automatic delivery is exhausted:

1. Invoke the owner-only `get_connector_status` and inspect pending/error status without exporting secrets or message contents.
2. Fix the cause: for example, restore a valid subscription, renew expired credentials, or correct the exact trusted callback origin. Do not loosen origin or identity checks as a recovery shortcut.
3. Call `retry_pending_events`, optionally scoped to an allowlisted `chat_id`. Its `limit` defaults to 5 and accepts 1-10 records. This is an explicit recovery action and can retry exhausted automatic deliveries.
4. Recheck status. Recover additional batches only after understanding continuing errors.

`get_connector_status` exposes configuration booleans, owner-only `allowed_chat_ids`, the origin-only `requested_callback_origin`, and counts for `active_subscriptions`, `pending_deliveries`, `retry_exhausted_deliveries`, `failed_deliveries`, and `uncertain_sends`. It must not disclose the bot token, webhook secret, full callback URLs, paths, queries, signing keys, or message text. Treat allowed chat IDs and the requested origin as private when sharing diagnostics. A recorded requested origin is a candidate for operator review, not an automatically approved destination.

The recovery tool retries unexpired stored pending deliveries, including those with `retry_limit`; it cannot recreate a message that was never accepted or replay a deliberately terminal update as if it were pending. Recovery is limited to seven days after the message was received. Expired pending records are removed by the recovery tool's cleanup before retry selection. The callback recipient should deduplicate stable event IDs, because an accepted callback whose acknowledgement is lost may be delivered again.

`get_recent_messages` accepts an optional `limit`, defaulting to 10 and bounded to 1-20, and returns only unexpired messages. Both it and `get_connector_status` are read-only: they logically exclude expired records without triggering cleanup.

## Sending and uncertain outcomes

`send_message` accepts `chat_id`, `text`, `idempotency_key`, and optional `reply_to_message_id`. It is owner-only and requires the recipient's private ID in both user and chat allowlists. It does not accept a bot token, URL, or arbitrary Telegram method as an argument.

Choose a stable key for each intended operation and preserve it across transport retries:

- The same key and same request after success return the stored result.
- The same key with different request content is a conflict, not a second send.
- Concurrent duplicate calls must not independently initiate duplicate Telegram requests.
- A network failure after dispatch may mean Telegram accepted the message but the Worker did not receive the result. This operation is **uncertain** and must not be automatically resent.

For an uncertain operation, inspect the destination chat privately and reconcile the outcome before deciding whether another send is needed. If a new send is explicitly authorized, use a new key and understand that it may duplicate a message Telegram already accepted. Never rotate keys automatically just to bypass an uncertain or conflicting result. Local durable idempotency is not upstream exactly-once delivery.

## Retention, privacy, and maintenance

Persisted data includes message text and identifiers, subscription state and signing credentials, delivery attempts/state, and outgoing operation records. Restrict database access and review retention before production use. Backups may retain the same sensitive data after the live records are removed.

These connector records are in D1 storage attached to the owner's Site. Bot and
webhook secrets stay in native Sites runtime configuration. Outgoing records store
request hashes, recipient/message IDs, states and error categories, not a complete
archive of reply text. Any private setup welcome journal is separate from this
thirty-day log and must retain its attempted/sent marker for the installation's
lifetime. Telegram and ChatGPT can retain their own service records separately;
these connector windows do not describe or erase those records.

New confirmed bot sends also retain their submitted text in a separate
`sent_messages` table for seven days from local confirmation. Optional
`include_outgoing: true` combines those records with accepted incoming messages,
including sender/role and topic context. The thirty-day operation table remains
metadata/hashes. No pre-upgrade, failed or uncertain reply text is reconstructed,
and no arbitrary Telegram history is fetched. See [group topics](group-topics.md)
for explicit topic selection, General behavior and incomplete-history limits.

All inbox records, including pending/failed events and media captions/metadata, expire seven days after `received_at`. Outgoing operation records/tombstones expire thirty days after `created_at`, not after their last retry or update. Status and history tools exclude expired records logically; they do not delete them for retention. Group history checks can still update access/pause state. Once an incoming record expires, neither history reads nor manual recovery can use it.

Group access approvals/epochs persist until changed; group update ID markers expire
after seven days with activity-driven cleanup. They contain identifiers and access
state, not message text. Old-epoch inbox text is excluded from group tools/delivery
but still expires under the inbox rules. A pause does not erase content already
forwarded to the host or visible in Telegram.

Physical cleanup runs opportunistically on authenticated valid-ID Telegram webhooks
and mutating owner calls to `send_message`, `configure_telegram_webhook`, or
`retry_pending_events`. It does not run on read-only tools, page/status requests,
identity checks or subscription operations. There is no scheduled cleanup; an idle
deployment may retain expired records longer. These windows do not promise physical
deletion at a particular time or purge every other category of operational state.

Deduplication and outgoing idempotency are limited by the corresponding stored records. After their removal, an old update or operation key may no longer be recognized. Do not casually delete them or reuse historical operation keys. Plan database maintenance while ingress and sending are stopped, preserve replay protection required by the chosen policy, and validate recovery before resuming. There is no database-reset tool in the MCP interface.

Operational logs and support reports should contain redacted error categories and synthetic examples, not bot tokens, webhook headers, full callback URLs, signing keys, personal IDs, or message text. Review generated artifacts and Git changes before every publication. Ignored files are not a substitute for checking what is staged.

To rotate the webhook secret, generate a new independent value, update the Site's secret control, and re-run `configure_telegram_webhook`; a mismatch during the change will reject deliveries. Rotate a compromised bot token using the bot's official management workflow, update the secret, and register the webhook again. Renew subscription signing keys through the authenticated event protocol. Recheck pending events after any credential rotation.

To stop delivery, unregister or disable the dedicated bot's webhook through its supported management workflow, unsubscribe the ChatGPT event subscription, and return the Site to owner-private. Handle pending records deliberately; changing visibility alone does not delete stored data or unsubscribe a bot.

## Development and CI

Use Node.js 24. No runtime package installation is needed for the dependency-free Worker and built-in test runner.

```sh
npm test
npm run build
npm run validate
```

The tests use a real SQLite-backed D1 adapter for persistence, uniqueness, and concurrency behavior. They cover authorization, validation, event lifecycle, signed callbacks, redirect refusal, pending recovery, and outgoing idempotency. Local fixtures are synthetic and are not evidence of a hosted integration result.

GitHub Actions runs only the three commands above on Node.js 24. It does not deploy, register webhooks, contact a real bot, or consume production secrets. Keep real deployment metadata in the private Site-managed source, never in the canonical public repository, and perform hosted acceptance checks against the new Site explicitly.
