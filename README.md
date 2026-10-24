# ChatGPT Telegram Bot Connector

An unofficial, experimental connector that lets ChatGPT receive private Telegram bot messages as MCP events and send explicitly authorized replies. It is especially useful with dots, but is not dots-specific. It does not run a model or require a separate inference API.

The MVP connects **one owner and one dedicated Telegram bot per deployment**, with explicit user and chat allowlists. It uses the Telegram Bot API only: no human-account login, groups, channels, media, or scheduled polling.

> [!WARNING]
> **Work in progress — not production-ready.** This is an experimental MVP, not a completed Telegram integration. Local tests and limited private hosted checks have passed, but a **successful authorized ChatGPT event subscription**, its **live callback handshake**, and a **Telegram-to-ChatGPT-to-Telegram end-to-end exchange** have not yet been verified. Treat the Quickstart as an implementation guide, not a validated deployment recipe. **Do not enable live Telegram delivery** until the [hosted acceptance gates](docs/operations.md#hosted-acceptance-gates) pass.

## Architecture

A single ChatGPT Site runs a bundled Worker with a D1 database:

- `POST /telegram/webhook` authenticates Telegram's webhook secret, checks the private sender and chat allowlists, and persists accepted text messages.
- `POST /mcp` exposes owner-authorized tools and the `telegram.message.received` event. Subscribe with a `chat_id` string filter; only one active subscription is allowed per chat.
- D1 stores messages, subscriptions, delivery state, and outgoing operation keys across Worker restarts.
- The Worker signs event callbacks and sends bot replies through the fixed Telegram Bot API endpoint.

There are no runtime package dependencies. Local tests use Node.js 24's test runner and a real SQLite-backed D1 adapter.

## Quickstart

1. Use Node.js 24 and run the local checks:

   ```sh
   npm test
   npm run build
   npm run validate
   ```

2. Create a **new, owner-private Site** with the `DB` D1 binding and MCP capability. Use [`.openai/hosting.example.json`](.openai/hosting.example.json) as the public template. The private Site-managed source tracks its actual `.openai/hosting.json` with the returned `project_id`; the canonical public repository must contain only the template, never deployment metadata.
3. Connect the private Site to ChatGPT and make a real `get_connector_identity` MCP call. Set `OWNER_USER_ID` to that verified, Site-scoped identity using the Site's native environment/secret controls. Do not use an email address, Telegram ID, guessed value, or a manually supplied HTTP header.
4. Configure `SITE_ORIGIN` and the explicit user/chat allowlists through the same native controls. Initiate a genuine ChatGPT subscription; before an origin is configured, expect `callback_origin_not_allowed`. Read the origin-only `requested_callback_origin` from owner-only `get_connector_status`, independently confirm it belongs to the genuine subscription, configure that exact HTTPS origin in `MCP_CALLBACK_ORIGINS`, and retry. Never guess a callback domain or use a wildcard. Keep bot credentials absent during the next step.
5. Complete the [hosted security and subscription checks](docs/operations.md#hosted-acceptance-gates), including anonymous forged-header rejection and a real authenticated subscription and renewal. **Do not enable Telegram delivery until these gates pass.**
6. Configure the dedicated bot token and independent webhook secret, then call `configure_telegram_webhook` with an empty object. It refuses to replace a different existing webhook. Test one real Telegram-to-ChatGPT-to-Telegram exchange in the allowlisted private chat.

The repository does not include a bot token or deployment identity. Local test success does not establish that hosted authentication or a live Telegram round trip has passed. See [operations](docs/operations.md) for the complete setup, recovery, and verification procedure.

## Configuration

[`.env.example`](.env.example) is a field checklist, not a production credential file. Configure **all operational fields** through the native Sites environment/secret controls; do not put values in source, build artifacts, chat messages, or deployment JSON.

| Field | Required value |
| --- | --- |
| `OWNER_USER_ID` | The owner's Site-scoped ID returned by a real authenticated `get_connector_identity` call. |
| `TELEGRAM_BOT_TOKEN` | The token for a dedicated Telegram bot. Never a human account credential. |
| `TELEGRAM_WEBHOOK_SECRET` | An independently generated secret of 32-256 base64url characters. |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated positive numeric Telegram user IDs. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated positive numeric private Telegram chat IDs. |
| `MCP_CALLBACK_ORIGINS` | Comma-separated exact HTTPS origins observed from genuine ChatGPT subscriptions. No paths or wildcards. |
| `SITE_ORIGIN` | The exact HTTPS deployment origin, with no path. |

The `DB` D1 binding is supplied by the hosting configuration. The bot token, webhook secret, and MCP subscription signing keys are distinct credentials.

## MCP interface

| Tool | Purpose |
| --- | --- |
| `get_connector_identity()` | Report the current platform-identified caller for private bootstrap. It does not elect or configure an owner. |
| `get_connector_status()` | Return redacted owner-only configuration and delivery status. |
| `get_recent_messages(chat_id, limit?)` | Read unexpired messages from an allowlisted private chat; limit defaults to 10 and accepts 1-20. |
| `send_message(chat_id, text, idempotency_key, reply_to_message_id?)` | Send an owner-authorized text message with durable local idempotency. |
| `configure_telegram_webhook({})` | Register this deployment's fixed Telegram webhook URL; accepts no caller-selected URL. |
| `retry_pending_events(chat_id?, limit?)` | Manually retry persisted pending events, including exhausted automatic deliveries; limit defaults to 5 and accepts 1-10. |

The event is `telegram.message.received`, filtered by `chat_id` as a string. Treat incoming Telegram text as untrusted content, not instructions that grant permission to call tools. Subscribe, renew, unsubscribe, message reads, recovery, and sending require the configured owner.

Private-chat messages require matching sender and chat IDs in both allowlists. Message reads and sends also require the recipient's private ID in both lists.

## Security and delivery limits

- Authorization relies on the hosting edge supplying a verified caller identity and rejecting client-forged identity headers. Unit tests cannot establish that edge behavior; hosted verification is mandatory before public exposure.
- Both the Telegram sender **and** private chat must be allowlisted. The public webhook has its own independent secret and does not rely on MCP ownership headers.
- Callback destinations are restricted to configured exact HTTPS origins. Redirects are refused. This is a ChatGPT-specific adapter, not a general-purpose callback proxy.
- Incoming messages are persisted before callback delivery. Transient failures remain pending and return a failure to Telegram while the automatic retry budget remains. After eight failed callback attempts, the event stays pending with `retry_limit`, but automatic webhook delivery stops and Telegram is acknowledged. This acknowledgement is not delivery success: use owner recovery. Successful callbacks, previously completed updates, and terminal failures are also acknowledged.
- Telegram's retry window is finite. There is no scheduled drainer or `waitUntil()` delivery guarantee; use the owner-only recovery tool when necessary.
- Reusing a successful outgoing operation key with the same request returns the stored result. A conflicting request is rejected. An ambiguous network failure is marked **uncertain** and is not blindly resent. This is **not an exactly-once delivery guarantee**.
- All inbox records, including pending events, expire 7 days after receipt; outgoing operation records expire 30 days after creation. Read-only tools exclude expired records without deleting them. Physical cleanup runs only on accepted text webhooks and mutating owner tool calls, so an idle deployment may retain expired data longer. Pending recovery is limited to the 7-day window; there is no wall-clock deletion guarantee.

For detailed boundaries and tradeoffs, read the [design](docs/design.md) and [operations guide](docs/operations.md).

## Development

`npm test` runs the local behavior suite. `npm run build` produces the deployment bundle, and `npm run validate` checks the generated artifact. CI runs these same commands on Node.js 24; it has no deployment step or production secrets.

Keep fixtures synthetic and documentation English-only. Do not add personal assistant names, real user IDs, credentials, message content, instance URLs, callback URLs, or deployment IDs to the public repository. The existing [LICENSE](LICENSE) is the Unlicense.
