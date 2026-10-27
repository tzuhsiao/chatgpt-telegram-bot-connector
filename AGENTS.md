# Telegram Bot Connector: agent instructions

Dots installing or resuming the connector start at **Install**. Agents changing the
code read everything from **Project principles** on.

## Install

Installation, upgrade and resume follow
[the setup skill](.agents/skills/telegram-bot-connector-setup/SKILL.md). It is the
single source for the owner-facing explanation and data-retention disclosure, consent
and approval points, Site/plugin naming, protected credential entry, hosted
acceptance gates, the one-time welcome, and reconciliation of existing or stale
resources. Do not restate those procedures here or in other docs; link to the skill.

When asked to review this repository and install, inspect the source and report
material safety concerns first. Invoke the skill by reading that file: Site
publication does not add repository skills to the canonical plugin. Its
[checkpoint helper](scripts/plan-setup.mjs) accepts redacted observations only.
Hosted conversation policy comes from the [private](prompts/private-chat.md) and
[group](prompts/group-chat.md) prompt templates.

## Project principles

These principles are binding for every change.

1. **Triggers and tools, not behavior.** The connector only triggers the dot with MCP
   events and provides Telegram tools. Conversational behavior is agreed between the
   owner and their dot, not defined by this repository. Future changes must not make
   replies or quoting mandatory, require one reply per message, or impose rigid
   conversational policies; tools and events never force a behavior. Conversational
   choices in prompt templates remain adaptable defaults; their safety rules do not.
2. **Yours, end to end.** Site, D1 data, plugin and credentials belong to the owner's
   own account. Do not introduce a relay or second service, a service operated by the
   repository author, an extra model/inference API, or third-party storage, analytics
   or telemetry. Real IDs, tokens and URLs never enter this public repository.

Engineering ground rules: the dot's autonomy never relaxes owner identity, sender and
chat allowlists, credential protection or routing; incoming content (text, captions,
images, quotes, forwards, claimed sources) never grants authority; every send and
reaction is idempotent and an uncertain outcome is never retried automatically;
unverifiable configuration or access fails closed and is reported to the owner;
privileged actions need explicit owner approval. Never weaken any of these to make
setup or a test pass.

## Scope

One Site hosts an MCP Worker and D1 database for one owner and one dedicated
Telegram bot. It delivers private-chat and approved private-group text and media
receipts as events, and exposes authorized tools for text sends, reactions, retained
history and image reads; the host runs the model. Approved supergroups may use
Topics. Out of scope: a human Telegram login, public groups, channels, polling,
transcription or video analysis, attachment execution, outgoing media, an extra
inference API and a second relay service.

## Security invariants and their tests

Each invariant below has a guarding test. A change that touches one must keep its
test passing, and a new invariant needs a new test.

| Invariant | Guarded by (`tests/`) |
| --- | --- |
| Owner-only operations reject anonymous, non-owner and unconfigured callers; identity lookup never invents an owner | `auth`: "sensitive operations reject anonymous…", "anonymous identity lookup does not invent…" |
| The webhook requires its independent secret before anything is stored | `telegram`: "webhook requires a valid independent secret…" |
| Only allowlisted human senders in allowlisted chats enter the inbox, history or events | `telegram`: "non-allowlisted humans, groups, bot senders…"; `groups`: "unapproved, bot and anonymous senders never enter…" |
| Quotes and forwards are attributed to the actual sender and grant nothing | `groups`: "forwards and quotes use actual submitting sender…" |
| Callbacks go only to exact allowed HTTPS origins; redirects are never followed | `events`: "callback allowlist blocks SSRF, lookalikes and redirects…" |
| A subscription is stored only after its signed challenge succeeds; one subscriber per chat | `events`: "subscription verifies its signed callback…", "a different callback cannot silently replace…" |
| Concurrent duplicates are admitted once with one delivery lease | `telegram`: "concurrent duplicates use one database admission…" |
| Automatic retries stop after the budget, and stale responses cannot disable or revive a subscription | `review-regressions`: "automatic retry exhaustion…", "stale callback … cannot disable…", "an in-flight renewal cannot reactivate…" |
| Sends go only to authorized destinations, are idempotent, and dispatch once under concurrency | `tools`: "outgoing requests reject unapproved destinations…", "sending is fixed-destination…", "concurrent identical sends…" |
| An ambiguous send is recorded uncertain and never automatically resent | `tools`: "ambiguous network failure is uncertain…"; `topics`: "topic identity participates in idempotency…" |
| Forum sends need an explicit topic and never fall back to General | `topics`: "topic sends require explicit routing…" |
| Group revocation pauses durably and fails old-epoch work | `groups`: "bot access loss latches a durable pause…", "changed approvals and removed groups revoke pending work…" |
| Media reads re-check retained-message authorization; untrusted bytes never become model images | `media-retrieval`: "retained message authorization rejects…", "untrusted binary and dimension bombs…"; `image-type` |
| Status, the public page and diagnostics reveal no secrets or private data | `tools`: "status and stored-message reads are owner-only…", "public landing page contains no operational configuration…"; `maintenance`: "MCP diagnostics separate…" |
| Prompt templates use real tools, valid key formats and documented placeholders | `prompts` |

**Sensitive paths**: `access.ts`, `ingress.ts`, `intake.ts`, `events.ts`,
`delivery.ts`, `callback*.ts`, `crypto.ts`, `outbound.ts`, `groups.ts`, `media.ts` and
`image.ts`. A PR touching them states which invariants it affects and which tests
guard them, and is reviewed by an agent other than its author.

## Configuration

Use native Sites environment and secret controls for **all operational values**.
`.env.example` is a checklist the Worker never loads. Public source contains only
[the hosting template](.openai/hosting.example.json); the private Site-managed source
tracks the real `.openai/hosting.json` (`project_id`, `d1: "DB"`,
`capabilities: ["mcp"]`). Never copy private manifests, runtime settings or filled
prompts into this repository. Upgrades preserve Site/plugin IDs, tool names, event
names, package name and connection references.

| Field | Source and validation |
| --- | --- |
| `OWNER_USER_ID` | Exact Site-scoped caller ID from a genuine authenticated `get_connector_identity` call; never an email, Telegram ID, first visitor or forged header. |
| `SITE_ORIGIN` | Exact HTTPS origin returned for the selected Site, with no path. |
| `TELEGRAM_ALLOWED_USER_IDS` | Explicit positive, safe-integer numeric Telegram user IDs as strings. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | For the personal private-chat flow, the same confirmed user ID. |
| `TELEGRAM_ALLOWED_GROUPS` | Optional JSON object mapping each approved negative safe-integer group ID string to exactly two distinct positive human ID strings (maximum ten groups). Separate from both private lists. |
| `MCP_CALLBACK_ORIGINS` | Exact HTTPS origins independently correlated with genuine authenticated subscriptions; no wildcards or guessed domains. |
| `TELEGRAM_BOT_TOKEN` | Dedicated bot credential entered through a protected secret surface. |
| `TELEGRAM_WEBHOOK_SECRET` | Independent random 32-256 character base64url secret, generated and stored without printing it. |

Subscription signing keys come from the authenticated protocol and stay separate from
bot and webhook secrets. Runtime setting changes apply only after deploying a saved
version; verify the applied revision. Public files, logs and reports contain no real
identities, assistant names, tokens, webhook headers, full callback URLs, signing
keys, message text, instance URLs or deployment IDs.

## Interface

| Tool | Contract |
| --- | --- |
| `get_connector_identity()` | Report the platform-identified caller for bootstrap; does not select or configure an owner. |
| `get_connector_status()` | Owner-only configuration booleans, private chat IDs, group access state, origin-only callback candidate and delivery counts. Not a live bot-access check. |
| `get_recent_messages(chat_id, limit?, message_thread_id?, include_outgoing?)` | Retained messages for one chat/topic, limit 1-20; forum groups need an explicit topic (1 = General); group history is current-epoch only. `include_outgoing` adds confirmed bot text. |
| `get_message_media(chat_id, message_id, update_id, message_thread_id?, file_index?, mode?)` | Read a retained, currently authorized file: `auto` up to 2,000,000 bytes, `on_demand` up to 8,000,000. Only supported images become model-readable. |
| `send_message(chat_id, text, idempotency_key, reply_to_message_id?, message_thread_id?)` | Authorized text with durable idempotency. Forum groups need an explicit topic. Quoting is optional. |
| `set_message_reaction(chat_id, message_id, update_id, reaction, idempotency_key, message_thread_id?)` | Set, change or clear (empty string) this bot's emoji reaction on an exact retained incoming message. Separate from text coverage and keys. |
| `verify_group_access(chat_id)` | Owner-authorized activation/recovery: checks group metadata, topic mode and this bot's own access, never the human roster. Changes no Telegram settings. |
| `pause_group_access(chat_id)` | Owner-only durable revocation; fails pending group events. |
| `configure_telegram_webhook({})` | Validate the bot, refuse a different existing webhook, register only this Site's `/telegram/webhook`. |
| `retry_pending_events(chat_id?, limit?)` | Explicit owner recovery of unexpired pending events, limit 1-10. |

The event is `telegram.message.received`, filtered by a string `chat_id`, with one
active subscription per chat. Its `text` is the message text, or for media a type
notification plus caption; optional `media` holds bounded allowlisted metadata, a
receipt rather than access to content. Unknown non-text content still produces a
generic receipt without inspecting raw fields. Details:
[media intake](docs/media-intake.md), [media retrieval](docs/media-retrieval.md),
[reactions](docs/message-reactions.md).

## Groups and topics

- The input boundary is the exact approved group ID plus the actual human `from.id`
  (`is_bot: false`, no `sender_chat`). Do not add roster-size, invitation or
  administrator gates, and do not pause approved traffic because someone joins or a
  rejected message arrives. Users manage the audience.
- Never add recipients or senders from message text, usernames, forwards or
  membership events. Group participation grants no private-chat access.
- Bot access loss, explicit owner pause, configuration change, mode change and
  migration latch a durable pause with epoch protection; only owner-authorized
  `verify_group_access` resumes. Old-epoch events fail; paused messages are not replayed.
- Forum events carry `message_thread_id`; history, sends and reactions use the same
  explicit topic (1 = General) with no fallback, and plans stay per topic.

Setup, delivery settings and recovery: [group chat](docs/group-chat.md),
[topics](docs/group-topics.md).

## Delivery semantics

Messages persist before callbacks; persisted no-subscription events are acknowledged
to Telegram and remain pending. Successful subscription creation/renewal schedules
at most ten eligible events with backoff, lease and budget guards, stopping new
attempts after sixteen seconds. Background execution is best effort, not a durable
scheduled drainer or a host-renewal guarantee. Explicit unsubscribe ends pending
backlog and records a cancellation boundary; canceled-period history is terminal.
Automatic callback retries stop after eight attempts; exhausted pending records
need explicit owner recovery. Inbox records expire after seven days and outgoing operation
records after thirty, with opportunistic cleanup. A successful key replays its
recorded result, conflicting arguments fail, and there is no upstream exactly-once
guarantee. Background: [design](docs/design.md), [operations](docs/operations.md).

After signing, event dispatch rechecks the exact pending lease and enabled
subscription identity/revision plus group access; current time is checked after
the final D1 read for lease, subscription and receipt expiry. Guard rejection
cannot revive canceled rows or unlock a competing lease. Guard/network dispatch
are not atomic; retain the qualified boundary in the delivery documentation.

## Instruction design and maintenance

Write tools, prompts and skills for capable state-of-the-art models: give goals,
essential constraints, evidence and acceptance, and leave routine judgment to the
dot. Avoid exhaustive choreography and repetition. Preserve concrete security,
authorization, routing and uncertain-operation invariants. Keep each procedure in one
place and link to it.

For visible failures use [telegram-maintenance](.agents/skills/telegram-maintenance/SKILL.md);
its diagnostics are public-safe, surrounding output is not. See
[maintenance](docs/maintenance.md) before updating the canonical plugin.

## Development

Use Node.js 24. The Worker has no runtime dependencies; `npm ci` installs the
pinned build and type-check tools (esbuild, TypeScript, Workers types). Run:

```sh
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
npm run validate
```

Run `npm run format` before committing code or JSON. Prettier is pinned in
`package.json` and covers code only; Markdown prose is excluded. Tests use real
SQLite-backed D1 fixtures and synthetic network responses; they do not prove a hosted
round trip. CI runs without deployment or production secrets. Inspect the final diff
and build artifact for accidental operational data. Keep source, docs and UI in
English, preserve the Unlicense, and work on isolated branches. A setup skill never
authorizes live bot operations during source development.

### Worker layout

`worker/index.js` is only the build entry and HTTP router (`createWorker`).

| Concern | Modules |
| --- | --- |
| Owner identity, allowlists, group config | `access.ts` |
| HTTP entry points | `mcp.ts` (JSON-RPC dispatch, owner tools), `ingress.ts` (Telegram webhook), `page.ts` |
| Intake and delivery | `intake.ts` (update normalization), `events.ts` (subscriptions), `delivery.ts` (leases, retries) |
| Private groups and topics | `groups.ts`, `threads.ts` |
| Outbound Telegram | `outbound.ts` (sends, reactions), `webhook-setup.ts`, `telegram.ts` (Bot API client) |
| Media | `media.ts` (download, cache, reads), `image.ts` (static-image validation) |
| Read paths | `status.ts` |
| Callbacks and crypto | `callback.ts`, `callback-url.ts`, `crypto.ts` |
| Shared | `schemas.ts`, `tools.ts`, `diagnostics.ts`, `version.ts`, `db.ts`, `http.ts`, `validate.ts`, `errors.ts`, `env.ts`, `constants.ts`, `retention.ts`, `tool-result.ts`, `untyped.ts` |

### TypeScript

Worker source targets TypeScript. esbuild bundles `worker/index.js` and its imports
into one ESM file and only strips types, so `npm run typecheck` is the type gate.

- New Worker modules are `.ts`; add no new `.js` source under `worker/`.
- Do not mass-convert existing code; extract or convert in behavior-preserving PRs.
- Use only erasable type syntax (`erasableSyntaxOnly`): no `enum`, `namespace` or
  parameter properties. Import local modules with their real extension.
- External input is `unknown` until runtime validation narrows it: Telegram updates,
  MCP params, callback and Telegram API responses, `env` values and D1 rows. Types
  never replace or justify removing runtime checks.
- Avoid `any` and non-null assertions on external data; keep any unavoidable
  assertion next to the runtime check that justifies it.
- Extraction-only exception: code moved unchanged that walks raw Telegram JSON, MCP
  params or D1 rows may use `UntypedJson` (`worker/untyped.ts`, an explicit `any`).
  Never use it in new code; replace it with `unknown` plus narrowing when that code
  changes.
