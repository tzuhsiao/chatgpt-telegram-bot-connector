# MVP design

## Intent

Connect a dedicated Telegram bot to ChatGPT using MCP tools and webhook events. The connector is not a model runtime and does not call an inference API. It is especially useful with dots, but not specific to dots.

## Scope

- One owner and one dedicated bot per deployment.
- Allowlisted private conversations and separately approved two-human private groups; text messages only. See [group support](group-chat.md) for membership checks, access epochs and limits.
- One active event subscription per allowed chat, preventing accidental duplicate responders.
- Receive a Telegram message, persist it, deliver an MCP event, and expose an explicitly authorized reply tool.
- English-only source, documentation and UI. No real account IDs, personal assistant names, credentials, instance URLs or deployment IDs in this public repository.
- No human accounts, public groups, private-topic mode, media, polling tasks, external hosting account or additional model API. Approved forum groups use [explicit topic routing](group-topics.md).

## Approach

The selected approach uses one ChatGPT Site with a Worker and D1. Its Telegram webhook is publicly reachable but independently authenticated; MCP operations require the configured, platform-verified owner's Site-scoped identity. A two-service relay or an external Worker would add another deployment and credential boundary and is deferred unless the single-Site identity experiment fails.

The canonical public repository contains only the hosting template. The private Site-managed source tracks its actual deployment manifest and project identity. Runtime operational configuration and secrets belong in native Sites environment/secret controls, not either repository's source or build output.

## Security boundaries

Start owner-private. Obtain the owner's identity through a real MCP call and configure it through Sites runtime settings. Do not bind the first visitor or treat absent identity as the owner. Before public use, verify that anonymous requests cannot forge the identity headers. Event subscription and renewal must carry the same usable identity.

Use independent bot, webhook and callback-signing secrets. Bot credentials and owner settings are runtime configuration only. Only exact configured trusted HTTPS callback origins are permitted; redirects are never followed. This is a ChatGPT-specific adapter, not a general callback proxy.

During bootstrap, an authenticated subscription with an unconfigured origin fails with `callback_origin_not_allowed`. Owner-only status exposes the requested origin without the callback path, query, or signing secret. The owner must confirm it belongs to a genuine ChatGPT subscription before adding that exact origin to trusted configuration. Keep Telegram credentials absent until the hosted identity and real subscription/renewal gates pass.

## Delivery semantics

D1 uniqueness and atomic leases protect concurrent incoming updates. A stable event ID survives retries and restarts. Without a separate durable drainer, transient errors remain pending and return a non-2xx response while the automatic attempt budget remains. After eight failed attempts, the record stays pending with `retry_limit`, but further automatic webhook delivery stops and Telegram is acknowledged. This deliberate stop is not successful delivery: owner-only recovery can retry the pending event with its stable ID. Callback acceptance, previously completed deliveries, and terminal failures are also acknowledged. Telegram retries are finite; neither persistence nor `waitUntil()` guarantees eventual delivery.

An event already bound to a subscription cannot migrate to a different subscription identity. Revision checks prevent stale callback failures from disabling renewed subscriptions.

Outgoing messages use a durable operation key and request hash. Repeated successful calls return the same result. An ambiguous timeout is recorded and is not blindly retried: Telegram does not provide an upstream exactly-once guarantee.

All inbox records, including pending events, expire seven days after receipt. Outgoing operation records expire thirty days after creation. Read-only tools exclude expired records without deleting them. Cleanup is opportunistic on accepted text webhooks and mutating send/configure/retry tool calls; there is no scheduled deletion guarantee. Recovery and replay protection are bounded by the corresponding retention windows.

## Acceptance

Local tests must exercise authorization, validation, deduplication, callback signing/verification, renewal and unsubscribe, pending recovery, redirect refusal and outgoing idempotency. Hosted verification must test anonymous/header-spoof rejection and real authenticated tools. The final Telegram-to-ChatGPT-to-Telegram exchange needs a dedicated bot token and an allowed chat, supplied through secure configuration.
