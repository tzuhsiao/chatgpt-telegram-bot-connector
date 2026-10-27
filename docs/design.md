# MVP design

## Intent

Connect a dedicated Telegram bot to ChatGPT using MCP tools and webhook events. The connector is not a model runtime and does not call an inference API. It is especially useful with dots, but not specific to dots.

## Scope

- One owner and one dedicated bot per deployment.
- Allowlisted private conversations and private groups with exact actual-sender approvals; incoming text and [media notifications](media-intake.md), outgoing text. See [group support](group-chat.md) for input boundaries, bot access and epochs. Users manage the audience.
- One active event subscription per allowed chat, preventing accidental duplicate responders.
- Receive a Telegram message, persist it, deliver an MCP event, and expose an explicitly authorized reply tool.
- English-only source, documentation and UI. No real account IDs, personal assistant names, credentials, instance URLs or deployment IDs in this public repository.
- No human accounts, public groups, private-topic mode, automatic transcription/video analysis, attachment execution or outbound media, polling tasks, external hosting account or additional model API. Approved forum groups use [explicit topic routing](group-topics.md).

## Approach

The selected approach uses one ChatGPT Site with a Worker and D1. Its Telegram webhook is publicly reachable but independently authenticated; MCP operations require the configured, platform-verified owner's Site-scoped identity. A two-service relay or an external Worker would add another deployment and credential boundary and is deferred unless the single-Site identity experiment fails.

The canonical public repository contains only the hosting template. The private Site-managed source tracks its actual deployment manifest and project identity. Runtime operational configuration and secrets belong in native Sites environment/secret controls, not either repository's source or build output.

## Security boundaries

Start owner-private. Obtain the owner's identity through a real MCP call and configure it through Sites runtime settings. Do not bind the first visitor or treat absent identity as the owner. Before public use, verify that anonymous requests cannot forge the identity headers. Event subscription and renewal must carry the same usable identity.

Use independent bot, webhook and callback-signing secrets. Bot credentials and owner settings are runtime configuration only. Only exact configured trusted HTTPS callback origins are permitted; redirects are never followed. This is a ChatGPT-specific adapter, not a general callback proxy.

During bootstrap, an authenticated subscription with an unconfigured origin fails with `callback_origin_not_allowed`. Owner-only status exposes the requested origin without the callback path, query, or signing secret. The owner must confirm it belongs to a genuine ChatGPT subscription before adding that exact origin to trusted configuration. Keep Telegram credentials absent until the hosted identity and real subscription/renewal gates pass.

## Delivery semantics

D1 uniqueness and atomic leases protect concurrent incoming updates. A stable event ID survives retries and restarts. A persisted event with no active subscription is acknowledged to Telegram and stays pending without consuming an attempt. This ingress ACK means durable receipt, not ChatGPT callback acceptance or task execution. Authentication, envelope and storage failures retain their error responses; invalid message dates and text lengths are ignored after envelope validation without an inbox insert.

Successful subscription creation or renewal schedules best-effort recovery through the request's `waitUntil()` context. One invocation selects at most ten unexpired pending events for that chat, respecting leases, backoff and the eight-attempt automatic budget. It stops starting events after sixteen seconds; one in-flight callback can finish afterward. The subscription response does not await callbacks. Missing/rejected scheduling or interrupted background work leaves pending events for a later renewal or explicit owner recovery. There is no durable scheduled drainer and no automatic subscription renewal in this Worker.

Transient callback failures reached through Telegram ingress still return a non-2xx response while the automatic budget remains. After eight failed attempts, the record stays pending with `retry_limit`, but further automatic delivery stops and Telegram is acknowledged. Callback acceptance, previously completed deliveries and terminal failures are acknowledged too. Owner-only recovery can retry exhausted pending events with their stable IDs. Telegram retries are finite; neither persistence nor `waitUntil()` guarantees eventual delivery.

An event already bound to a subscription cannot migrate to a different subscription identity. Revision checks prevent stale callback failures from disabling renewed subscriptions.

Event callbacks also run a final authorization guard after signing and before network dispatch. It checks the exact pending lease, current enabled subscription identity/revision/owner and existing group guards, then reads the clock after D1 resolves to recheck lease, subscription and seven-day receipt expiry. A stale claim or delayed signature is not dispatch authority. A rejected guard releases only its own still-pending lease; it cannot revive canceled rows or unlock another claimant. The database guard and network dispatch are not atomic: revocation observed by this final guard prevents dispatch, while a cancellation after its database snapshot can still race with the request.

Explicit unsubscribe is a cancellation boundary, distinct from natural expiry or temporary callback failure: atomically disable the matched subscription, terminalize the chat's existing pending events, and start a new paused cancellation generation. Each valid admission reads that generation before group/network work. Its INSERT atomically fails delivery eligibility if it observed a pause or crossed a cancellation generation, even if resubscription has since succeeded. Successful subscription marks the same generation active in its persistence transaction. These records remain retained history with `subscription_cancelled`, not replayable pending events. The boundary is the first D1 admission snapshot, not the Telegram message date or HTTP arrival time; a request first admitted after resubscription is new. Already dispatched callbacks cannot be recalled. Legacy cancellations have no marker, so their historical intent cannot be reconstructed. Manual recovery does not revive these terminal records.

The motivation for #28 is a latent code-review finding, not an observed production outage. Non-2xx retry behavior and a single configured connection create avoidable retry pressure; permanent cross-chat deadlock has not been demonstrated. See the official sources and qualified discussion in [operations](operations.md#telegram-delivery-sources-and-context).

Outgoing messages use a durable operation key and request hash. Repeated successful calls return the same result. An ambiguous timeout is recorded and is not blindly retried: Telegram does not provide an upstream exactly-once guarantee.

All inbox records, including pending events and media metadata, expire seven days after receipt. Outgoing operation records expire thirty days after creation. Read-only tools exclude expired records without deleting them. Cleanup is opportunistic on authenticated webhooks and mutating send/configure/retry tool calls; there is no scheduled deletion guarantee. Recovery and replay protection are bounded by the corresponding retention windows.

## Acceptance

Local tests must exercise authorization, validation, deduplication, callback signing/verification, renewal and unsubscribe, pending recovery, redirect refusal and outgoing idempotency. Hosted verification must test anonymous/header-spoof rejection and real authenticated tools. The final Telegram-to-ChatGPT-to-Telegram exchange needs a dedicated bot token and an allowed chat, supplied through secure configuration.
