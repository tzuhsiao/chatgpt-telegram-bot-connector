# Bounded Subscription Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Fix #28 with persistence-backed ACK and bounded recovery on subscription success.
**Architecture:** Reuse deliverEvent for automatic attempts; schedule a bounded drain
through the request context. Store explicit cancellation in connector_meta and
admit canceled-period history as terminal, in atomic D1 operations.
**Tech Stack:** Node.js 24, TypeScript, SQLite-backed D1 tests; no new dependencies.
**Spec:** ../specs/2026-10-27-subscription-recovery-design.md

## Global Constraints

- No deployment, operational settings, credentials or live Telegram operations.
- At most ten eligible events; sixteen-second budget between callback attempts.
- Preserve eight attempts, backoff, leases, expiry, identity, epochs and topics.
- Public source and documentation stay English; public self-reference is Dot.

## Review Focus

- Cancellation racing with admission/renewal must not reactivate canceled backlog.
- Subscription persistence failure must never schedule delivery.
- A failed background callback must not make successful subscription look failed.
- Old callbacks must not disable renewed subscriptions or migrate bound events.
- No claim that Telegram retries cause permanent cross-chat deadlock or exactly-once delivery.

### Task 1: Persistence, recovery and cancellation

**Files:** worker/{ingress,intake,events,delivery,mcp,env}.ts, worker/index.js;
tests/subscription-recovery.test.mjs and the expired-subscription assertion in telegram.test.mjs.
**Interfaces:** Add drainPending(chat, env, runtime, group) and optional waitUntil
context propagation. Existing owner recovery remains manual and separate.

- [ ] Write behavioral regressions; run and observe missing-behavior failures.
- [ ] Implement the bounded recovery and atomic cancellation boundary.
- [ ] Run focused regressions and the complete suite; commit implementation/tests.

### Task 2: Explain, verify and review

**Files:** AGENTS.md, docs/design.md, docs/operations.md.
**Interfaces:** Documents describe Task 1's actual ACK/recovery and cancellation semantics.

- [ ] Explain latent finding, ingress versus callback, bounded recovery and limits.
- [ ] Link official Bot API documentation and tdlib discussions with qualified interpretation.
- [ ] Run formatting, typecheck, full tests, build and artifact validation.
- [ ] Obtain independent whole-branch review; address important findings with regressions.
- [ ] Create a draft PR with context, evidence, tests and remaining limits; never merge/deploy.
