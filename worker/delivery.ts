import { requireChat, senderAllowed } from './access.ts';
import { sendCallback } from './callback.ts';
import { EVENT } from './constants.ts';
import { first, requireDatabase, rows, run } from './db.ts';
import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { checkGroup, groupCurrent } from './groups.ts';
import { botId } from './telegram.ts';
import { validThread } from './threads.ts';
import type { UntypedJson } from './untyped.ts';
import { groupId, objectArgs } from './validate.ts';

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
  const payload = {
    eventId: record.event_id,
    name: EVENT,
    timestamp: record.occurred_at,
    data: {
      update_id: record.update_id,
      chat_id: record.chat_id,
      sender_id: record.sender_id,
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
  try {
    const response = await sendCallback(
      subscription,
      payload,
      env,
      runtime,
      group ? () => groupCurrent(group, env) : null,
    );
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
