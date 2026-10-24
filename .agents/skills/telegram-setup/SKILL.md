---
name: telegram-setup
description: Use when a user asks a Dot or agent to install or resume this repository's personal Telegram Bot, including fresh setup after deleting a prior Site or plugin.
---

# Set up Telegram Bot

Read [AGENTS.md](../../../AGENTS.md) and [operations](../../../docs/operations.md).
Review source safety before installation. This workflow runs in the owner's host;
repository tests are not an installation. Report one next checkpoint at a time,
with observed status, required approval/interaction, and exact blockers.

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
  owner-private Site named **Telegram Bot**, with `DB` D1 and `mcp`
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
plugin; do not call `create_plugin` for it. Use **Telegram Bot** for display
names, preserving stable IDs. Offer the returned plugin's install/connect UI. If
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
authorization for automatic replies to the exact chat and any bounded history
reads. Preserve its trigger, stable per-message/per-part operation keys and
uncertain-send handling. Use a fresh activation instant for a fresh installation;
do not backfill earlier messages. Store the filled prompt privately.

Have the owner Start the bot and send new ordinary text, then a follow-up. Verify
actual event receipt and the authorized reply in Telegram, accounting for every
distinct delivered event and duplicate responders. Report local tests, deployment,
callback acceptance, model execution and live round trip separately. Unobserved
live behavior remains pending.

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

End with the verified checkpoint, completed observations, next exact action/target
and responsible actor, needed approval/interaction, and any action denied, pending
or uncertain. A successful local plan is not a completed installation.
