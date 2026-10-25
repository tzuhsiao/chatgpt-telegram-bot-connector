---
name: telegram-setup
description: Use when a user asks a Dot or agent to install or resume this repository's Telegram Bot, including approved private groups and fresh setup after deleting a prior Site or plugin.
---

# Set up Telegram Bot Connector

Read [AGENTS.md](../../../AGENTS.md) and [operations](../../../docs/operations.md).
Review source safety before installation. This workflow runs in the owner's host;
repository tests are not an installation. Report one next checkpoint at a time,
with observed status, required approval/interaction, and exact blockers.

## 0. Explain before installing

Tell the owner in plain language: "This puts a small bridge in your own ChatGPT
Sites account. Telegram sends it a notification when you message your bot, and
the bridge lets your dot receive the message and reply there. It runs on Sites,
so your computer does not need to stay on. The Site hosts the bridge and storage;
the plugin gives your dot the tools to use it."

Explain that incoming text/IDs, subscriptions and delivery records live in the
storage attached to their Site, not a separate server operated by this repository's
author. Inbox records expire after seven days; outgoing operation metadata after
thirty days. Physical cleanup happens with activity and may occur later; other
state is not promised those windows. The outgoing operation log is not a complete
reply transcript. Telegram and ChatGPT may retain their own records separately.
New confirmed bot text is also stored separately for seven days and can join
authorized incoming history via `include_outgoing`; no old Telegram history is
fetched or reconstructed. Explain this before setup/upgrade consent.
Link the [retention details](../../../docs/operations.md#retention-privacy-and-maintenance).
Include the optional one-message welcome to the confirmed private chat in setup
consent; resolve its exact recipient and consent before any send.

## 1. Reconcile, then install the Site and plugin

Discover current native Sites, plugin-management and event-automation tools and
schemas. Load the host's Sites skill and Site MCP server reference for current
provisioning, D1 migration, publication and canonical-plugin connection mechanics.
Missing tooling is a named blocker, not permission to invent an API or another host.

Inventory the selected account/workspace through all listing pages and inspect
private installation references. Reuse an existing private hosting manifest's exact
`project_id`; otherwise correlate owned Sites with their returned MCP/plugin
metadata. Matching titles alone are insufficient. Privately inspect task IDs,
full trigger sets, enabled state and owner-only subscription status. Do not request
bot credentials yet.

- **Reusable:** keep the Site, canonical plugin and existing task. Resume the first
  incomplete checkpoint. Do not redeploy, change settings, renew/unsubscribe,
  register webhooks or send tests merely because setup was invoked again.
- **Fresh:** only after a complete inventory proves no reusable match, create one
  owner-private Site titled **Telegram Bot Connector**, with `DB` D1 and `mcp`
  capability. Persist its returned ID atomically in the private Site source before
  further operations. Build, push, save and privately deploy through supported Sites
  tooling; install the repository migration journal through the supported D1 workflow.
  No operational values belong in public source or artifacts.
  After creation, refresh inventory to `reuse` by correlating the returned Site;
  retain `installation: fresh` only while it is the same proven empty onboarding.
- **Pending/uncertain create:** inspect actual operation/account state before any
  retry. Never create a second Site for a missing source credential; recover source
  access for the same project through its supported credential workflow.
- **Deleted/ambiguous references:** pause creation. Deleting a Site/plugin can leave
  an enabled task bound to its old connector and Telegram's old webhook. Ask which
  surviving installation to resume or obtain approval to reconcile the exact stale
  task. A deletion plan does not authorize this skill to delete/disable resources.
  Re-inventory after owner action; do not silently swap an old trigger's connector ID.

Sites publication provisions the canonical personal App/plugin. Retrieve it with
`get_site(include_mcp_connection: true)` using the actual tool schema. Reuse that
plugin; do not call `create_plugin` for it. Use **Telegram Bot** for its display
name, preserving stable IDs. The new Site title is **Telegram Bot Connector**.
Use native Site title controls and supported canonical-plugin display metadata/UI,
after inspecting current schemas. Do not assume changing one name changes the
other, or rename an internal package/connector ID to change a display label. If
the host cannot set separate names, report the specific verified limitation and
actual names; retain the canonical plugin. Do not silently rename existing setups.
Offer the returned plugin's install/connect UI. If
already installed but tools are absent, wait briefly, reconnect or request a new
chat; do not create a duplicate to refresh tools. Confirm a real read-only MCP call.

## 2. Establish ownership and guide the two user inputs

Call `get_connector_identity` through the genuine authenticated plugin. Derive
`OWNER_USER_ID` from the nonempty Site-scoped `caller_user_id`; never ask the owner
to invent it. A new Site has a new identity scope. Stop on an owner mismatch.
After approval, configure that ID and the returned Site origin through native
private runtime controls, preserve unrelated keys, apply the environment revision,
and confirm owner-only status.

Now guide the owner to obtain **their positive numeric Telegram user ID** from
trusted account/setup information and select/create a **dedicated bot** through
Telegram's official bot-management workflow. Sign-in, bot creation and Start/message
steps may need the user. A username or bot ID is not their human ID. Validate a
digit string representing a positive safe integer; this personal private-chat flow
uses the same confirmed value in both user and chat allowlists. Stop on conflicting
existing lists instead of silently adding recipients.

Explain the credential configuration and obtain approval **at this step**. Guide
bot-token entry directly into a protected native Sites secret field, never normal
chat, files, shell arguments or diagnostic output. A supported protected handle
may be assigned without revealing its value. The ordinary Sites tool's plaintext
`value` plus `is_secret: true` is secret storage, not protected user entry. Without
a protected channel, guide the owner to native Sites settings and wait; inspect
only redacted presence afterward. Do not ask for a pasted token to proceed.

Defer token assignment until the next phase's hosted gates pass. Reuse existing
credentials without reading them. Generate an independent webhook secret (32 random
bytes encoded base64url is suitable) through a supported secret-to-secret/native
path that does not print it. If unavailable, the owner must generate and enter it
through native secret controls: report this extra manual step rather than promising
a two-input unattended install. Never rotate secrets merely to resume. Keep bot,
webhook and subscription-signing credentials distinct.

## 3. Verify persistence, identity and one subscription

Set the matching private user/chat allowlists through native controls. Derive the
Site origin from its response. Keep tokens absent and ingress unregistered on a new
empty installation while running the [hosted gates](../../../docs/operations.md#hosted-acceptance-gates).

The steps below describe personal private chats. For an explicitly requested
two-human private group, also follow [group activation](../../../docs/group-chat.md).
Do not add negative IDs to either positive private list, grant private access from
group membership, or run the personal welcome in a group. Keep existing chats and
their complete task trigger sets intact.

Discover `telegram.message.received` with its string `chat_id` filter through the
genuine event service. Reuse the matching task. If the callback origin is missing,
make one approved genuine subscription attempt; expect `callback_origin_not_allowed`.
Task creation may still have a partial/uncertain outcome: inspect private task state
before retrying. Read owner-only `requested_callback_origin` and independently
correlate it with the authenticated host attempt. Presence in status is not trust.
Configure only the exact verified HTTPS origin. Never ask the owner to invent an
origin or paste full callbacks/signing keys; never use a wildcard. Stop if trusted
correlation is unavailable. Owner approval cannot substitute for that evidence.

Verify real ownership, owner-only operations, actual public-edge forged-header
rejection, D1 persistence, callback verification and authenticated renewal. Scope
create/repeat/renew/unsubscribe tests to a new empty installation; retain exactly one
final subscription. Any required visibility change needs approval for this deployment
only. For an existing live installation, use recorded acceptance plus read-only
checks; missing evidence is a verification gap, not permission for disruptive tests.
Do not exempt background event methods from owner checks to bypass host limitations.
If secrets were entered too early on a proven fresh deployment, ask for approval
to remove only those early secrets in native settings, apply the revision and
re-read redacted state before testing gates. Do not clear secrets on a live resume.

Look up tasks before every create/retry and preserve the complete trigger set on
updates. One subscription alone does not prove the correct single enabled task.
Stale/duplicate tasks, unknown operations or mismatched subscribers require
reconciliation before creating or activating another responder.

## 4. Connect the bot and verify conversation

After the gates pass, complete protected secret assignment and verify the applied
runtime revision. Obtain explicit approval to connect this bot to this Site.
Call `configure_telegram_webhook({})` once when registration is needed: it performs
`getMe`/`getWebhookInfo`, validates the bot, refuses a different webhook and registers
the fixed Site URL without dropping pending updates. Current MCP has no separate
read-only bot/webhook inspection tool; if independent inspection is unavailable,
this guarded call is the approved mutation, not a claimed read-only test.

On an old/different webhook, prefer a new dedicated bot. Reusing the same bot needs
an explicitly approved owner-performed
[`deleteWebhook`](https://core.telegram.org/bots/api#deletewebhook) operation through
a trusted secret-safe management path, preserving pending updates; the connector
does not expose this operation. If no such path is available, use a new bot.
Deleting the old Site does
not remove Telegram's webhook. On uncertain results, inspect actual bot state
through a supported secret-safe path before retrying; if unavailable, report the
blocker. Skip registration for an already verified same webhook. Do not rotate
secrets, poll `getUpdates`, expose tokens in Bot API URLs or send unsolicited tests.

Configure [normal private conversation](../../../docs/normal-chat.md) using
[the prompt](../../../prompts/private-chat.md) on the one existing task. Obtain
authorization for discretionary relevant responses to the exact chat and any bounded
history reads. The connector notifies and provides tools; it does not require a
reply to every event or one reply per message. Normal sends omit `reply_to_message_id`.
The Dot may answer several already-arrived messages coherently, acknowledge with
brief/emoji-only text, or stay silent while retaining unresolved substantive requests.
There is no reaction tool in this connector; do not claim text emoji are reactions.
Other reaction tools need actual availability and separate authorization.
Preserve its trigger, frozen per-plan/per-part operation keys, coverage and
uncertain-send handling. Use a fresh activation instant for a fresh installation;
do not backfill earlier messages. Reconcile legacy quoted/per-message plans under
their original arguments before a v3 cutover; do not regroup uncertain sends or
discard unresolved earlier requests. Follow the guide's deterministic included
anchor and authoritative private coverage checks, with no timer/polling/batch wait.
The template adds no shared-state service or durable model queue. Store the filled
prompt privately.

### Optional approved private group

Explain that shared text goes to the owner's dot and all group members may see
bot sends. Get separate approval for the exact negative group ID, each of its two
human IDs, deployment/configuration, history reads and intended sends. Keep actual
IDs private. This does not authorize altering existing private chats or invitations.
Confirm the two humans' agreement; a new sender cannot approve themselves through
a Telegram message.

Guide the owner to a private group with only those humans and this bot (Topics are supported):
no public username, linked channel, location or community; disable ordinary-member
invitations, review join approval/history visibility and revoke unnecessary invite
links. Require the bot to be an administrator, with no unnecessary ban/invite/delete
rights. Admin bots receive ordinary group messages even with privacy mode enabled;
do not change global privacy mode as a workaround. Administrators can add people
later: membership checks pause on detected changes, but cannot prevent all changes
or recall content already visible. Explain the snapshot/send race before consent.
Ask approved human admins to disable Remain Anonymous so posts carry their own IDs.

Use only the reviewed release and additive migration. Preserve existing D1, both
private lists, credentials and Site/plugin identities. Patch optional native
`TELEGRAM_ALLOWED_GROUPS` with the approved negative chat ID mapped to exactly two
distinct positive human ID strings; never copy it to public source or artifacts.
Apply the environment revision. With bot-connection approval, update the same
guarded webhook using `configure_telegram_webhook({})` so `chat_member` and
`my_chat_member` are requested alongside `message`. A matching URL alone does not
prove membership update types are active.

With explicit activation approval, call `verify_group_access` for that group. It
checks Telegram metadata, count and identities and enables access only if the bot
is an admin with both humans present and exactly three members. Stored status is
not a fresh membership check. Add/reuse exactly one genuine group-scoped event
subscription with a string chat filter and verified callback origin, preserving
all private triggers and avoiding duplicate responders. Adapt actual-event sender
validation to both approved humans and keep context/history in this group. Never
copy a private conversation or use its single-sender prompt unchanged. The dot
chooses conversational behavior; quoting or one reply per message is not required.

Use a separate group task. Identify the owner independently from the approved sender
set; participation/admin status grants no owner-level authority. Protect private
memory, files, other chats and connected-app context as well as private history.
Disclosure to the group or privileged external actions need the owner's applicable
authorization. The dot chooses a natural response or clarifies privately in ChatGPT.
Before changing/removing approvals, call `pause_group_access`; status stays read-only
and cannot detect a remove-and-restore cycle with no intervening requests. Drain
old Worker revisions before re-verification. Invalid optional group configuration
blocks groups and reports `invalid_group_config` without blocking valid private chats.

On membership/service changes, unapproved/anonymous senders or unverifiable API
checks, access pauses durably. Repair/review privately, obtain owner approval and
reverify; do not automatically resume because an outsider left. Old pending events
are failed, paused text is not backfilled, and history is limited to the new epoch.
Reconcile any old host task context and uncertain sends separately. Migration to
a new chat ID needs new approval. The connector never moderates members or changes
Telegram permissions. Real incoming/outgoing tests need separate consent; record
unrun live checks accurately. The enum-only setup planner covers personal setup,
not group readiness; never claim its `verified` state certifies group activation.

For Topics-enabled supergroups, follow [topic routing/history](../../../docs/group-topics.md).
Deploy migration 0003 with source, keep the group paused during upgrade, then get
owner-authorized verification and check `is_forum`. Do not attribute a generic
membership failure solely to Topics. Before enabling the existing group task,
preserve each actual event's thread ID in its context, bounded history reads and
frozen sends. Use explicit topic 1 for General; forum calls without a topic fail.
Keep plans/coverage per topic and never automatically combine different topics.
One chat subscription covers all topics; preserve private tasks and avoid duplicates.
No topic-management rights or private-topic BotFather setting are required here.
Private-topic issue #15 is not implemented.

Explain that history covers only accepted retained messages, with no Telegram
backfill. `include_outgoing: true` adds new confirmed bot text with sender/role;
failed/uncertain sends and pre-upgrade replies are not a transcript. New confirmed
outgoing text is retained separately for seven days, while operation hashes/metadata
remain thirty days. Physical cleanup can happen later with activity. Obtain the
applicable data-storage/upgrade consent and keep history scoped and authorized.

Prefer one consented welcome when supported. Follow
[the one-time welcome procedure](../../../docs/operations.md#one-time-setup-welcome):
verify the exact allowlisted private recipient, explicit one-message consent,
confirmed ability to reach that bot chat, and a durable private record containing
the frozen request and stable `tg-setup:v1:welcome:<chat_id>` key before dispatch.
The record must outlive the thirty-day outgoing-operation window. Missing or lost
history on resume is not evidence that the welcome was never sent. With no durable
record facility, skip it. The facility must survive sessions/agents, restarts and
redeployments, provide authoritative read-before-write plus one writer/reservation,
and retain terminal markers for the installation's lifetime. Chat/model memory or
the expiring outgoing table is insufficient. A ready record on an existing setup
must be the original durable record, never reconstructed from missing history.
Do not add a new bot API/probe or weaken allowlists.

If the owner has not opened this bot and started/messaged it, or reachability is
unknown, ask them to open it and press Start/send text instead of guessing that
the bot can initiate contact. If sending is unavailable or declined, use that same
fallback. A failed welcome is not automatically resent after Start. On sending,
uncertain or conflicting state, stop for private reconciliation; never change the
key or frozen arguments to bypass the result. Sent/completed setup does not welcome
again, including after operation-record expiry.

Make fallback final: persist `skipped` before asking the owner to Start/message.
The helper's `recordWelcomeAs: skipped` output is a requested transition, not proof
it was saved. After Start, keep skipped even when reachability becomes confirmed;
the ordinary responder may already answer Start. Preserve existing failed/uncertain
evidence. If durable storage is unavailable, keep welcome unsupported on resume;
missing history cannot prove that no earlier fallback or dispatch occurred.

Reconcile only through the owner's actual chat and private record. `send_message`
is a mutation, never a read-only status lookup: a missing/expired row or replaced
database may send again under the same key. No read-only MCP operation-key lookup
exists. If the outcome cannot be established, retain uncertain and stop.

Record welcome/outbound sending separately from incoming acceptance. Successful
send means Telegram accepted the outbound message; it proves neither receipt by
the person nor the incoming callback/model path. Ask the owner to reply to the
welcome (or send new text for fallback) and a follow-up, then verify actual events
and authorized replies. Report deployment, outbound result, callback acceptance,
model execution and the conversation loop separately; unobserved checks stay pending.

## Resume helper

From the repository root, use Node.js 24 with fresh **redacted enum observations**:

```sh
echo '{"inventory":"empty","operation":"idle","installation":"fresh","site":"missing"}' | node scripts/plan-setup.mjs
```

[The helper](../../../scripts/plan-setup.mjs) selects one checkpoint, stores nothing,
makes no network calls and grants no authority. Every omitted field is `unknown`,
never observed absence or a safe/idle outcome. Confirm operation outcomes explicitly.
`fresh` means a proven new empty installation; a previously used or uncertain
installation is `existing` and must not run disruptive lifecycle tests on resume.
Do not feed it runtime values or secret-bearing output. Keep private progress
references/checkpoint outcomes in native private state outside public source and
artifacts, without secrets. Re-read actual resources on resume; saved state is a hint.

| Observation | Allowed values |
| --- | --- |
| All fields | `unknown` is always allowed and is the default. |
| `inventory` | `unknown`, `empty`, `reuse`, `stale`, `ambiguous`; empty means complete Site/plugin/task inventory found no match. |
| `installation` | `fresh` for the same proven new empty onboarding, including partial resume; `existing` for previously used installations. Refresh `empty` inventory to `reuse` after Site creation. |
| `site`, `plugin` | Site: `missing`, `ready`; plugin: `missing`, `pending`, `ready` (real tools verified). |
| `owner` | `missing`, `verified` (identity obtained), `configured` (owner-only status succeeds), `mismatch`. |
| `telegramId`, `allowlists` | ID: `missing`, `valid`, `invalid`; lists: `missing`, `match`, `conflict`. |
| `callback`, `subscription` | Origin: `missing`, `candidate`, `trusted` (independently verified and configured), `unverifiable`; subscription: `missing`, `single`, `stale`, `conflict`. |
| `hostedGates` | `pending`, `passed`, `failed`; missing evidence on a live/credentialed installation yields a read-only `verification_gap`. |
| `botToken`, `webhookSecret` | Each independently: `missing`, `present` (redacted runtime presence). Partial credentials never count as complete. |
| `webhook`, `policy` | Webhook: `unknown`, `absent`, `ours`, `other`; policy: `missing`, `ready`, `conflict`. |
| `verification`, `operation`, `secretEntry` | Verification: `pending`, `passed` (observed round trip); operation: `idle`, `uncertain`; secret entry: `unavailable`, `native`. |
| `secretGeneration` | `native` for verified secret-safe generation/assignment; `manual` when the owner must generate and enter the webhook secret through native controls. |
| `welcomeRecord` | `ready` only for the original durable private record with no prior dispatch/fallback and frozen key/request; `sending`, `sent`, `failed`, `uncertain`, `unavailable`, `skipped` (terminal fallback, even after Start). Unknown history never proves unsent. |
| `welcomeConsent` | `granted` for one welcome to the exact confirmed private chat; `declined`; missing consent is `unknown`. |
| `welcomeReachability` | `confirmed` from trusted chat-start evidence; `needs_start`, `unavailable`; `unknown` never permits a probe-send. |

End with the verified checkpoint, completed observations, next exact action/target
and responsible actor, needed approval/interaction, and any action denied, pending
or uncertain. A successful local plan is not a completed installation.
