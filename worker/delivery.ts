import { requireChat, senderAllowed } from './access.ts';
import { sendCallback } from './callback.ts';
import { DAY, EVENT } from './constants.ts';
import { first, requireDatabase, rows, run } from './db.ts';
import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { checkGroup, groupCurrent } from './groups.ts';
import type { GroupSnapshot } from './groups.ts';
import { botId } from './telegram.ts';
import { validThread } from './threads.ts';
import type { UntypedJson } from './untyped.ts';
import { groupId, objectArgs, senderUsername } from './validate.ts';

// Event delivery: inbox rows are persisted first, then claimed with a lease and
// a subscription revision, signed and POSTed. Up to eight automatic attempts;
// after that only explicit owner recovery (retryPending) retries. An event
// bound to one subscription never migrates to another, and a stale response
// cannot disable a renewed subscription.

export async function deliverEvent(
  eventId: string,
  env: Env,
  runtime: Runtime,
  manual = false,
  ingressGroup: UntypedJson = null,
): Promise<{ state: string; reason?: string }> {
  const db = requireDatabase(env),
    now = runtime.now();
  const record: UntypedJson = await first(db, 'SELECT * FROM inbox WHERE event_id=?', eventId);
  if (!record) return { state: 'missing' };
  if (record.state !== 'pending') return { state: record.state };
  const receivedAt: unknown = record.received_at;
  if (
    typeof receivedAt !== 'number' ||
    !Number.isSafeInteger(receivedAt) ||
    receivedAt < now - 7 * DAY
  ) {
    await run(
      db,
      "UPDATE inbox SET state='failed',last_error='expired' WHERE event_id=? AND state='pending'",
      eventId,
    );
    return { state: 'failed' };
  }
  if (record.attempts >= 8 && !manual) return { state: 'pending', reason: 'retry_limit' };
  if (record.bot_id !== botId(env) || !senderAllowed(record.chat_id, record.sender_id, env)) {
    await run(
      db,
      "UPDATE inbox SET state='failed',last_error='access_revoked' WHERE event_id=? AND state='pending'",
      eventId,
    );
    return { state: 'failed' };
  }
  let group = null;
  if (groupId(record.chat_id)) {
    try {
      group =
        ingressGroup?.chat_id === record.chat_id
          ? ingressGroup
          : await checkGroup(record.chat_id, env, runtime);
      await groupCurrent(group, env);
      if (record.group_revision !== group.revision) throw new Error('Stale group epoch.');
      if (
        group.is_forum === 1
          ? !validThread(record.message_thread_id)
          : record.message_thread_id !== null
      )
        throw new Error('Invalid retained topic context.');
    } catch {
      await run(
        db,
        "UPDATE inbox SET state='failed',last_error='group_access_revoked' WHERE event_id=? AND state='pending'",
        eventId,
      );
      return { state: 'failed' };
    }
  }
  const subscription: UntypedJson = await first(
    db,
    'SELECT * FROM subscriptions WHERE chat_id=? AND owner_id=? AND enabled=1 AND expires_at>?',
    record.chat_id,
    env.OWNER_USER_ID,
    now,
  );
  if (!subscription) return { state: 'pending', reason: 'no_subscription' };
  const subscriptionId: unknown = subscription.id,
    revision: unknown = subscription.revision;
  if (
    typeof subscriptionId !== 'string' ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw new AppError('Stored subscription is invalid.', 503, -32603);
  // An already-bound event must never migrate to a different subscribed conversation.
  if (record.subscription_id && record.subscription_id !== subscription.id) {
    await run(
      db,
      "UPDATE inbox SET state='failed',last_error='subscription_changed' WHERE event_id=? AND state='pending'",
      eventId,
    );
    return { state: 'failed' };
  }
  const lease = crypto.randomUUID();
  const claimed: UntypedJson = await first(
    db,
    `UPDATE inbox SET lease_token=?,lease_until=?,subscription_id=?,attempts=attempts+1
    WHERE event_id=? AND state='pending' AND lease_until<=? AND next_attempt_at<=? AND (attempts<8 OR ?=1)
    AND EXISTS (SELECT 1 FROM subscriptions WHERE id=? AND revision=? AND enabled=1 AND expires_at>?)
    RETURNING *`,
    lease,
    now + 30000,
    subscription.id,
    eventId,
    now,
    now,
    manual ? 1 : 0,
    subscription.id,
    subscription.revision,
    now,
  );
  if (!claimed) return { state: 'pending', reason: 'retry_later' };
  const username = senderUsername(record.sender_username);
  const payload = {
    eventId: record.event_id,
    name: EVENT,
    timestamp: record.occurred_at,
    data: {
      update_id: record.update_id,
      chat_id: record.chat_id,
      sender_id: record.sender_id,
      ...(username !== null ? { sender_username: username } : {}),
      message_id: record.message_id,
      ...(record.message_thread_id != null ? { message_thread_id: record.message_thread_id } : {}),
      text: record.text,
      ...(record.media_json ? { media: JSON.parse(record.media_json) } : {}),
      sent_at: record.occurred_at,
    },
    cursor: null,
  };
  let status = null,
    errorCode = null;
  const dispatchStopped = new Error('Delivery authorization changed before dispatch.');
  try {
    const response = await sendCallback(subscription, payload, env, runtime, async () => {
      if (group) await groupCurrent(group, env);
      if (!senderAllowed(record.chat_id, record.sender_id, env)) throw dispatchStopped;
      // sendCallback invokes this after every signing await, immediately before
      // fetch. A claim result held across cancellation/renewal is not authority
      // to dispatch: recheck the exact live lease and signed subscription.
      const authorized = await first(
        db,
        `SELECT i.lease_until,i.received_at,s.expires_at
          FROM inbox i JOIN subscriptions s ON s.id=i.subscription_id
          WHERE i.event_id=? AND i.state='pending' AND i.lease_token=?
          AND i.bot_id=? AND i.chat_id=s.chat_id
          AND s.id=? AND s.revision=? AND s.owner_id=? AND s.enabled=1`,
        eventId,
        lease,
        botId(env),
        subscriptionId,
        revision,
        env.OWNER_USER_ID,
      );
      // Read the clock after D1 resolves too: the claim or guard read itself
      // may have been delayed across lease, subscription or receipt expiry.
      const dispatchNow = runtime.now();
      if (
        !authorized ||
        typeof authorized.lease_until !== 'number' ||
        !Number.isSafeInteger(authorized.lease_until) ||
        authorized.lease_until <= dispatchNow ||
        typeof authorized.expires_at !== 'number' ||
        !Number.isSafeInteger(authorized.expires_at) ||
        authorized.expires_at <= dispatchNow ||
        typeof authorized.received_at !== 'number' ||
        !Number.isSafeInteger(authorized.received_at) ||
        authorized.received_at < dispatchNow - 7 * DAY
      )
        throw dispatchStopped;
    });
    status = response.status;
    await response.body?.cancel();
    if (response.ok) {
      await run(
        db,
        "UPDATE inbox SET state='delivered',delivered_at=?,last_status=?,last_error=NULL,lease_token=NULL,lease_until=0 WHERE event_id=? AND lease_token=?",
        runtime.now(),
        status,
        eventId,
        lease,
      );
      return { state: 'delivered' };
    }
    errorCode = status >= 300 && status < 400 ? 'redirect' : 'callback_http_error';
  } catch (error) {
    if (error === dispatchStopped) {
      const cutoff = runtime.now() - 7 * DAY;
      // Release only our still-pending lease. Cancellation and a competing claim
      // own their state; neither can be revived or unlocked by this stale worker.
      await run(
        db,
        `UPDATE inbox SET
        state=CASE WHEN received_at<? THEN 'failed' ELSE state END,
        last_error=CASE WHEN received_at<? THEN 'expired' ELSE 'pre_dispatch_changed' END,
        lease_token=NULL,lease_until=0
        WHERE event_id=? AND state='pending' AND lease_token=?`,
        cutoff,
        cutoff,
        eventId,
        lease,
      );
      const current = await first(db, 'SELECT state FROM inbox WHERE event_id=?', eventId);
      return {
        state: typeof current?.state === 'string' ? current.state : 'missing',
        reason: 'pre_dispatch_changed',
      };
    }
    errorCode = error instanceof AppError ? 'callback_configuration' : 'callback_network_error';
  }
  const terminal = status !== null && status < 500 && status !== 429 && status !== 408;
  const exhausted = claimed.attempts >= 8;
  const next = runtime.now() + Math.min(300000, 1000 * 2 ** Math.min(claimed.attempts, 8));
  const saved = await run(
    db,
    `UPDATE inbox SET state=?,next_attempt_at=?,last_status=?,last_error=?,lease_token=NULL,lease_until=0
    WHERE event_id=? AND lease_token=? AND EXISTS (SELECT 1 FROM subscriptions WHERE id=? AND revision=?)`,
    terminal ? 'failed' : 'pending',
    next,
    status,
    !terminal && exhausted ? 'retry_limit' : errorCode,
    eventId,
    lease,
    subscription.id,
    subscription.revision,
  );
  if (!saved.meta?.changes) {
    // A response signed with an older subscription revision cannot reject the new revision.
    await run(
      db,
      "UPDATE inbox SET state='pending',next_attempt_at=0,last_status=?,last_error='subscription_revision_changed',lease_token=NULL,lease_until=0 WHERE event_id=? AND lease_token=?",
      status,
      eventId,
      lease,
    );
    return { state: 'pending', reason: 'subscription_revision_changed' };
  }
  if (status === 410 || status === 401 || status === 403)
    await run(
      db,
      'UPDATE subscriptions SET enabled=0,revision=revision+1 WHERE id=? AND revision=?',
      subscription.id,
      subscription.revision,
    );
  return {
    state: terminal ? 'failed' : 'pending',
    reason: !terminal && exhausted ? 'retry_limit' : errorCode,
  };
}

// Only explicit unsubscribe starts a generation; callback rejection is distinct.
export const cancellationKey = (chat: string): string => 'subscription_cancelled:' + chat;

// Best-effort automatic recovery, not manual recovery: never reset backoff or
// override the eight-attempt budget. The existing claim and epoch guards decide
// each dispatch again. A later renewal or explicit recovery handles leftovers.
export async function drainPending(
  chat: string,
  env: Env,
  runtime: Runtime,
  group: GroupSnapshot | null = null,
): Promise<void> {
  requireChat(chat, env);
  const now = runtime.now();
  const pending = await rows(
    requireDatabase(env),
    `SELECT event_id FROM inbox
    WHERE state='pending' AND bot_id=? AND chat_id=? AND received_at>=?
    AND attempts<8 AND lease_until<=? AND next_attempt_at<=?
    ORDER BY received_at,update_id LIMIT 10`,
    botId(env),
    chat,
    now - 7 * DAY,
    now,
    now,
  );
  for (const event of pending) {
    if (runtime.now() >= now + 16000) break;
    if (typeof event.event_id !== 'string') throw new Error('Invalid retained event identity.');
    await deliverEvent(event.event_id, env, runtime, false, group);
  }
}

// `args` are MCP tool arguments, shape-checked by objectArgs on the first line.
export async function retryPending(args: UntypedJson, env: Env, runtime: Runtime) {
  objectArgs(args, ['chat_id', 'limit']);
  const limit = args.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new AppError('Limit must be between 1 and 10.');
  if (args.chat_id !== undefined) requireChat(args.chat_id, env);
  const db = requireDatabase(env);
  const pending: UntypedJson[] = await rows(
    db,
    "SELECT event_id,chat_id FROM inbox WHERE state='pending' AND bot_id=? AND (? IS NULL OR chat_id=?) ORDER BY received_at LIMIT ?",
    botId(env),
    args.chat_id ?? null,
    args.chat_id ?? null,
    limit,
  );
  const result: Record<string, number> = {
    examined: pending.length,
    delivered: 0,
    pending: 0,
    failed: 0,
  };
  const verifiedGroups = new Map<unknown, UntypedJson>();
  for (const event of pending) {
    if (groupId(event.chat_id) && !verifiedGroups.has(event.chat_id)) {
      try {
        verifiedGroups.set(event.chat_id, await checkGroup(event.chat_id, env, runtime));
      } catch {
        verifiedGroups.set(event.chat_id, null);
      }
    }
    await run(db, 'UPDATE inbox SET next_attempt_at=0 WHERE event_id=?', event.event_id);
    const outcome = await deliverEvent(
      event.event_id,
      env,
      runtime,
      true,
      verifiedGroups.get(event.chat_id),
    );
    // The `in` check guarantees the counter exists.
    if (outcome.state in result) result[outcome.state]!++;
  }
  return result;
}
