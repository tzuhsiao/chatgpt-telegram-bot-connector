import { observedGroups, securityConfigured, senderAllowed } from './access.ts';
import { equalSecret } from './crypto.ts';
import { first, requireDatabase, run } from './db.ts';
import { deliverEvent } from './delivery.ts';
import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import {
  checkGroup,
  groupCurrent,
  membershipUpdate,
  pauseForUpdate,
  syncGroupApprovals,
} from './groups.ts';
import { json, readJson } from './http.ts';
import { normalizedUpdate } from './intake.ts';
import { prefetchMedia } from './media.ts';
import { cleanup } from './retention.ts';
import { botId, webhookSecret } from './telegram.ts';
import { incomingThread } from './threads.ts';
import type { UntypedJson } from './untyped.ts';
import { groupId } from './validate.ts';

// Telegram webhook ingress. Authenticates the secret header in constant time,
// requires complete security configuration, persists accepted messages before
// delivery, and never lets background media prefetch affect the receipt.

export async function telegramWebhook(
  request: Request,
  env: Env,
  runtime: Runtime,
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<Response> {
  try {
    const expected = webhookSecret(env);
    if (!(await equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), expected)))
      throw new AppError('Invalid webhook authentication.', 401, -32001);
    if (!securityConfigured(env))
      throw new AppError('Connector security configuration is incomplete.', 503, -32002);
    botId(env);
    const payload: UntypedJson = await readJson(request);
    if (!payload || !Number.isSafeInteger(payload.update_id) || payload.update_id < 0)
      throw new AppError('Invalid Telegram update.');
    await cleanup(env, runtime.now());
    await syncGroupApprovals(env);
    if (await membershipUpdate(payload, env, runtime)) return json({ ok: true });
    const groupChat = String(payload.message?.chat?.id);
    const configuredGroups = observedGroups(env).groups;
    if (
      configuredGroups.has(groupChat) &&
      (await first(
        requireDatabase(env),
        'SELECT update_id FROM group_updates WHERE bot_id=? AND update_id=?',
        botId(env),
        payload.update_id,
      ))
    )
      return json({ ok: true, ignored: true });
    if (
      configuredGroups.has(groupChat) &&
      payload.message &&
      (payload.message.sender_chat ||
        payload.message.from?.is_bot !== false ||
        !senderAllowed(groupChat, String(payload.message.from?.id), env))
    ) {
      return json({ ok: true, ignored: true });
    }
    const message = normalizedUpdate(payload, env, runtime.now());
    if (!message) return json({ ok: true, ignored: true });
    let group = null;
    if (groupId(message.chat_id)) {
      try {
        group = await checkGroup(message.chat_id, env, runtime);
      } catch (error) {
        if (error instanceof AppError && error.code === -32016) {
          await run(
            requireDatabase(env),
            'INSERT INTO group_updates(bot_id,update_id,chat_id,received_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
            botId(env),
            payload.update_id,
            groupChat,
            runtime.now(),
          );
          return json({ ok: true, ignored: true, group_paused: true });
        }
        throw error;
      }
    }
    if (
      group &&
      ((group.is_forum === 1 && payload.message.chat?.is_forum !== true) ||
        (!group.is_forum &&
          (payload.message.chat?.is_forum || payload.message.is_topic_message === true)))
    ) {
      await pauseForUpdate(groupChat, payload.update_id, 'group_mode_changed', env, runtime);
      return json({ ok: true, ignored: true });
    }
    const thread = incomingThread(payload.message, group?.is_forum === 1);
    const eventId = `tg_${message.bot_id}_${message.update_id}`;
    if (group) await groupCurrent(group, env);
    await run(
      // cleanup() above already required the database binding.
      env.DB as D1Database,
      `INSERT INTO inbox(event_id,bot_id,update_id,chat_id,sender_id,message_id,text,occurred_at,received_at,group_revision,message_thread_id,media_json,reaction_album)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_id,update_id) DO NOTHING`,
      eventId,
      message.bot_id,
      message.update_id,
      message.chat_id,
      message.sender_id,
      message.message_id,
      message.text,
      message.occurred_at,
      message.received_at,
      group?.revision ?? null,
      thread,
      message.media_json,
      message.reaction_album,
    );
    const result = await deliverEvent(eventId, env, runtime, false, group);
    // Receipt is already attempted. Never await downloads or let failures affect intake.
    try {
      if (typeof ctx?.waitUntil === 'function')
        ctx.waitUntil(prefetchMedia(eventId, env, runtime, group).catch(() => {}));
    } catch {} // Scheduling is also best effort.
    if (result.state === 'pending' && result.reason !== 'retry_limit')
      return json({ ok: false, retry: true }, 503, { 'retry-after': '5' });
    return json({ ok: true });
  } catch (error) {
    return json(
      { error: error instanceof AppError ? error.message : 'Request could not be processed.' },
      error instanceof AppError ? error.status : 503,
    );
  }
}
