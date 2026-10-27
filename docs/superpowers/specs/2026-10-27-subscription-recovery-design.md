# Bounded subscription recovery

Issue #28 is a latent source-review finding, not a measured production incident.
An accepted Telegram update is persisted before delivery. Missing subscriptions
currently produce 503 without consuming the callback retry budget.

## Approach

The selected scope acknowledges persisted no-subscription events and attempts a
bounded, chat-scoped drain after successful subscription creation or renewal.
ACK-only would require manual recovery; a durable scheduled drainer would be a
separate project. No deployment, operational settings or credentials change.

- Preserve authentication, envelope, storage failures, event IDs, leases, backoff,
  eight automatic attempts, seven-day expiry, subscriber identity and group epochs.
- Ignore invalid message dates/lengths after the authenticated envelope boundary.
- Schedule at most ten eligible events with the Worker's waitUntil context; stop
  starting events after a sixteen-second budget. Subscription responses do not
  await callback delivery. No context or scheduling failure leaves manual recovery.
- Explicit unsubscribe atomically sets a chat-scoped cancellation marker and
  terminalizes pending events. Admission while canceled stores history as failed,
  not replayable pending. The marker has a durable cancellation generation:
  admission snapshots it before group/network work, then INSERT atomically
  suppresses a paused snapshot or any generation crossed before persistence.
  Successful subscription activates the same generation atomically. The boundary
  is the first D1 admission snapshot, not wall time or a Telegram message date.
  This conservatively ends the old backlog, including pre-cancellation pending
  events. Already dispatched callbacks cannot be recalled. Legacy unsubscribes
  have no cancellation marker, so their historical intent cannot be reconstructed.
- The marker uses connector_meta; no migration or new infrastructure is needed.

These cancellation and time-budget choices are implementation decisions within
the requested simple scope. Expiry is recoverable; cancellation is an explicit
boundary. The connector does not create or automatically renew host subscriptions.
Callback acceptance is not proof of task execution or an exactly-once guarantee.

## Acceptance

Tests cover persistence-before-ACK, isolated chats, content versus envelope errors,
bounded eligible selection, overlapping renewals/webhooks, retry and expiry guards,
callback identity, group epochs/topics, cancellation and scheduling/storage failure.
Run the repository checks and obtain an independent review before a draft PR.
