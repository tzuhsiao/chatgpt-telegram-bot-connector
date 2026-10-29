import { allowlist, groupConfig, requireChat, senderAllowed } from './access.ts';
import { DAY } from './constants.ts';
import { digest } from './crypto.ts';
import { first, requireDatabase, run } from './db.ts';
import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { checkGroup, groupCurrent } from './groups.ts';
import { mentionEntities, normalizedMentions, requireMentionTargets } from './mentions.ts';
import { REACTION_EMOJI } from './schemas.ts';
import { botId, telegramApi } from './telegram.ts';
import { incomingThread, requestedThread, threadScope, validThread } from './threads.ts';
import type { UntypedJson } from './untyped.ts';
import { groupId, objectArgs } from './validate.ts';

// Outbound Telegram operations: authorized text sends and message reactions.
// Each has a durable operation key and request hash. A recorded success is
// replayed; conflicting arguments fail; an ambiguous outcome is recorded as
// 'uncertain' and is NEVER automatically resent, because Telegram offers no
// upstream idempotency key.

// `args` are MCP tool arguments, shape-checked by objectArgs on the first line.
export async function sendMessage(input: unknown, env: Env, runtime: Runtime) {
  const args = objectArgs(
    input,
    ['chat_id', 'text', 'idempotency_key', 'reply_to_message_id', 'message_thread_id', 'mentions'],
    ['chat_id', 'text', 'idempotency_key'],
  );
  const chat = requireChat(args.chat_id, env);
  if (!groupId(chat) && !allowlist(env.TELEGRAM_ALLOWED_USER_IDS).has(chat))
    throw new AppError('Recipient is not allowed.', 403, -32001);
  if (typeof args.text !== 'string' || !args.text.trim() || [...args.text].length > 4096)
    throw new AppError('Text must contain 1 to 4096 characters.');
  if (
    typeof args.idempotency_key !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotency_key)
  )
    throw new AppError('A stable ASCII idempotency key is required.');
  if (
    args.reply_to_message_id !== undefined &&
    (typeof args.reply_to_message_id !== 'number' ||
      !Number.isSafeInteger(args.reply_to_message_id) ||
      args.reply_to_message_id <= 0)
  )
    throw new AppError('Invalid reply message ID.');
  if (args.message_thread_id !== undefined && !validThread(args.message_thread_id))
    throw new AppError('A valid topic ID is required.');
  const db = requireDatabase(env);
  const mentions = normalizedMentions(args.mentions, args.text);
  const entities = mentionEntities(mentions);
  const mentionResult = mentions.length ? { mentions } : {};
  const mentionsJson = mentions.length ? JSON.stringify(mentions) : null;
  const operationKey = await digest(
    JSON.stringify([env.OWNER_USER_ID, botId(env), args.idempotency_key]),
  );
  const requestParts: unknown[] = [chat, args.text, args.reply_to_message_id ?? null];
  if (args.message_thread_id !== undefined) requestParts.push(args.message_thread_id);
  // Keep pre-upgrade plain-text hashes byte-for-byte, including omitted topics.
  if (mentions.length) requestParts.push({ mentions, entities });
  const requestHash = await digest(JSON.stringify(requestParts));
  async function reused(existing: Record<string, unknown> | null) {
    if (!existing)
      throw new AppError('Send operation is unavailable; reconcile privately.', 200, -32003);
    if (existing.request_hash !== requestHash)
      throw new AppError('Idempotency key conflicts with an earlier request.', 200, -32004);
    const now = runtime.now();
    if (
      existing.state === 'sending' &&
      typeof existing.updated_at === 'number' &&
      existing.updated_at < now - 30000
    ) {
      await run(
        db,
        "UPDATE outgoing SET state='uncertain',error_code='interrupted',updated_at=? WHERE operation_key=? AND state='sending'",
        now,
        operationKey,
      );
      existing.state = 'uncertain';
    }
    return {
      state: existing.state,
      message_id: existing.message_id ?? null,
      reused: true,
      requires_review: existing.state !== 'sent',
      ...mentionResult,
      ...(existing.error_code ? { error: existing.error_code } : {}),
    };
  }
  const existing = await first(db, 'SELECT * FROM outgoing WHERE operation_key=?', operationKey);
  if (existing) return reused(existing);
  if (groupId(chat) && args.message_thread_id === undefined) {
    const known = await first(
      db,
      'SELECT is_forum FROM group_access WHERE bot_id=? AND chat_id=?',
      botId(env),
      chat,
    );
    if (known?.is_forum === 1) requestedThread(args, known);
  }
  // Membership inspection is a preflight, not an in-flight Telegram send. Reserve
  // only afterward so its multi-call duration cannot age a send into uncertainty.
  let group = null,
    blocked = false;
  if (groupId(chat)) {
    try {
      group = await checkGroup(chat, env, runtime);
    } catch {
      blocked = true;
    }
  }
  const thread = blocked ? null : requestedThread(args, group, !groupId(chat));
  const scope = threadScope(thread, !groupId(chat));
  if (!blocked && mentions.length)
    await requireMentionTargets(mentions, chat, thread, group?.revision ?? null, env, runtime);
  if (!blocked && (group?.is_forum || !groupId(chat)) && args.reply_to_message_id !== undefined) {
    // checkGroup above already required this group to be approved.
    const senders = group ? (groupConfig(env).get(chat) as string[]) : [chat, null];
    const target = await first(
      db,
      `SELECT message_id FROM inbox WHERE bot_id=? AND chat_id=? AND message_id=? AND ${scope.column} IS ? AND group_revision IS ? AND received_at>=? AND sender_id IN (?,?)
      UNION ALL SELECT message_id FROM sent_messages WHERE bot_id=? AND chat_id=? AND message_id=? AND ${scope.column} IS ? AND group_revision IS ? AND sent_at>=? LIMIT 1`,
      botId(env),
      chat,
      args.reply_to_message_id,
      scope.value,
      group?.revision ?? null,
      runtime.now() - 7 * DAY,
      senders[0],
      senders[1],
      botId(env),
      chat,
      args.reply_to_message_id,
      scope.value,
      group?.revision ?? null,
      runtime.now() - 7 * DAY,
    );
    if (!target)
      throw new AppError(
        'Quoted target must be retained in this exact chat/topic and approval epoch.',
      );
  }
  const now = runtime.now();
  const inserted = await run(
    db,
    'INSERT INTO outgoing(operation_key,request_hash,chat_id,state,error_code,created_at,updated_at,mentions_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(operation_key) DO NOTHING',
    operationKey,
    requestHash,
    chat,
    blocked ? 'failed' : 'sending',
    blocked ? 'group_access_blocked' : null,
    now,
    now,
    mentionsJson,
  );
  if (!inserted.meta?.changes)
    return reused(await first(db, 'SELECT * FROM outgoing WHERE operation_key=?', operationKey));
  try {
    if (group) await groupCurrent(group, env);
  } catch {
    blocked = true;
  }
  if (blocked) {
    await run(
      db,
      "UPDATE outgoing SET state='failed',error_code='group_access_blocked',updated_at=? WHERE operation_key=? AND state='sending'",
      runtime.now(),
      operationKey,
    );
    return {
      state: 'failed',
      message_id: null,
      reused: false,
      requires_review: true,
      error: 'group_access_blocked',
      ...mentionResult,
    };
  }
  // Recheck provenance after reserving the operation, before dispatch. Losing a
  // target records failure under the frozen key; it never strips mentions/resends.
  if (mentions.length) {
    try {
      await requireMentionTargets(mentions, chat, thread, group?.revision ?? null, env, runtime);
    } catch {
      const saved = await run(
        db,
        "UPDATE outgoing SET state='failed',error_code='mention_access_changed',updated_at=? WHERE operation_key=? AND state='sending'",
        runtime.now(),
        operationKey,
      );
      if (!saved.meta?.changes)
        return reused(
          await first(db, 'SELECT * FROM outgoing WHERE operation_key=?', operationKey),
        );
      return {
        state: 'failed',
        message_id: null,
        reused: false,
        requires_review: true,
        error: 'mention_access_changed',
        ...mentionResult,
      };
    }
  }
  const claimed = await run(
    db,
    `UPDATE outgoing SET updated_at=? WHERE operation_key=? AND state='sending'
    AND (? IS NULL OR EXISTS (SELECT 1 FROM group_access WHERE bot_id=? AND chat_id=? AND state='active' AND config_hash=? AND revision=?))`,
    runtime.now(),
    operationKey,
    group?.bot_id ?? null,
    group?.bot_id ?? null,
    chat,
    group?.config_hash ?? null,
    group?.revision ?? null,
  );
  if (!claimed.meta?.changes) {
    await run(
      db,
      "UPDATE outgoing SET state='failed',error_code='group_access_blocked',updated_at=? WHERE operation_key=? AND state='sending'",
      runtime.now(),
      operationKey,
    );
    return reused(await first(db, 'SELECT * FROM outgoing WHERE operation_key=?', operationKey));
  }
  const body: Record<string, unknown> = {
    chat_id: chat,
    text: args.text,
    link_preview_options: { is_disabled: true },
  };
  if (mentions.length) body.entities = entities;
  if (thread !== null && (!group || thread !== 1)) body.message_thread_id = thread;
  if (args.reply_to_message_id !== undefined)
    body.reply_parameters = {
      message_id: args.reply_to_message_id,
      allow_sending_without_reply: false,
    };
  try {
    const response = await telegramApi('sendMessage', body, env, runtime);
    if (!response || typeof response !== 'object' || Array.isArray(response))
      throw new Error('Ambiguous API response.');
    const message = response as Record<string, unknown>;
    const responseChat = message.chat;
    if (
      typeof message.message_id !== 'number' ||
      !Number.isSafeInteger(message?.message_id) ||
      message.message_id <= 0 ||
      !responseChat ||
      typeof responseChat !== 'object' ||
      Array.isArray(responseChat) ||
      String((responseChat as Record<string, unknown>).id) !== chat
    )
      throw new Error('Ambiguous API response.');
    if (
      (group?.is_forum || !groupId(chat)) &&
      threadScope(incomingThread(message, group?.is_forum === 1, !groupId(chat)), !groupId(chat))
        .value !== scope.value
    )
      throw new Error('Ambiguous topic destination.');
    const sentAt = runtime.now();
    const saved = await db.batch([
      db
        .prepare(
          "UPDATE outgoing SET state='sent',message_id=?,updated_at=? WHERE operation_key=? AND state='sending'",
        )
        .bind(message.message_id, sentAt, operationKey),
      db
        .prepare(
          `INSERT INTO sent_messages(operation_key,bot_id,chat_id,message_id,message_thread_id,group_revision,text,occurred_at,sent_at,mentions_json)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM outgoing WHERE operation_key=? AND state='sent' AND message_id=?) ON CONFLICT DO NOTHING`,
        )
        .bind(
          operationKey,
          botId(env),
          chat,
          message.message_id,
          thread,
          group?.revision ?? null,
          args.text,
          new Date(sentAt).toISOString(),
          sentAt,
          mentionsJson,
          operationKey,
          message.message_id,
        ),
    ]);
    // D1 batch returns one result per statement.
    if (!saved[0]?.meta?.changes)
      return reused(await first(db, 'SELECT * FROM outgoing WHERE operation_key=?', operationKey));
    return {
      state: 'sent',
      message_id: message.message_id,
      reused: false,
      requires_review: false,
      ...mentionResult,
    };
  } catch (error: unknown) {
    // No automatic resend after an ambiguous result; Telegram has no matching idempotency key.
    const telegramCode = error instanceof AppError ? error.telegramCode : undefined;
    const state = telegramCode ? 'failed' : 'uncertain';
    const code = state === 'failed' ? `telegram_${telegramCode}` : 'network_or_response_unknown';
    const saved = await run(
      db,
      "UPDATE outgoing SET state=?,error_code=?,updated_at=? WHERE operation_key=? AND state='sending'",
      state,
      code,
      runtime.now(),
      operationKey,
    );
    if (!saved.meta?.changes)
      return reused(await first(db, 'SELECT * FROM outgoing WHERE operation_key=?', operationKey));
    return {
      state,
      message_id: null,
      reused: false,
      requires_review: true,
      error: code,
      ...mentionResult,
    };
  }
}

// Reaction receipts are independent of sends/history and substantive answer coverage.
// `args` are MCP tool arguments, shape-checked by objectArgs on the first line.
export async function setMessageReaction(args: UntypedJson, env: Env, runtime: Runtime) {
  objectArgs(
    args,
    ['chat_id', 'message_id', 'update_id', 'message_thread_id', 'reaction', 'idempotency_key'],
    ['chat_id', 'message_id', 'update_id', 'reaction', 'idempotency_key'],
  );
  const chat = requireChat(args.chat_id, env),
    db = requireDatabase(env),
    bot = botId(env);
  if (!validThread(args.message_id) || !Number.isSafeInteger(args.update_id) || args.update_id < 0)
    throw new AppError('Invalid retained message identity.');
  if (
    typeof args.reaction !== 'string' ||
    (args.reaction !== '' && !REACTION_EMOJI.includes(args.reaction))
  )
    throw new AppError('Use one supported Telegram emoji or an empty string to clear.');
  if (
    typeof args.idempotency_key !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotency_key)
  )
    throw new AppError('A stable ASCII idempotency key is required.');
  const group = groupId(chat) ? await checkGroup(chat, env, runtime) : null;
  const thread = requestedThread(args, group, !groupId(chat));
  const scope = threadScope(thread, !groupId(chat));
  const record: UntypedJson = await first(
    db,
    `SELECT * FROM inbox WHERE bot_id=? AND chat_id=? AND message_id=? AND update_id=? AND ${scope.column} IS ?`,
    bot,
    chat,
    args.message_id,
    args.update_id,
    scope.value,
  );
  async function authorizedTarget() {
    if (
      !record ||
      !senderAllowed(chat, record.sender_id, env) ||
      record.received_at < runtime.now() - 7 * DAY ||
      record.group_revision !== (group?.revision ?? null)
    )
      throw new AppError('Retained reaction target is unavailable.', 403, -32001);
    requireChat(chat, env);
    const current = await first(
      db,
      `SELECT event_id FROM inbox WHERE event_id=? AND bot_id=? AND chat_id=? AND message_id=? AND update_id=? AND sender_id=? AND message_thread_id IS ? AND group_revision IS ? AND received_at>=? AND media_json IS ? AND reaction_album=? AND (last_error IS NULL OR last_error NOT IN ('access_revoked','group_access_revoked'))`,
      record.event_id,
      bot,
      chat,
      args.message_id,
      args.update_id,
      record.sender_id,
      record.message_thread_id,
      record.group_revision,
      runtime.now() - 7 * DAY,
      record.media_json,
      record.reaction_album,
    );
    if (!current) throw new AppError('Retained reaction target is unavailable.', 403, -32001);
    // Telegram redirects album reactions, so exact-message authorization cannot hold.
    const legacyMedia = record.reaction_album === -1 && record.media_json !== null;
    if (
      record.reaction_album === 1 ||
      legacyMedia ||
      (record.media_json && JSON.parse(record.media_json)?.media_group_id)
    )
      throw new AppError(
        'Album or pre-upgrade media reaction targets are unsupported because exact targeting cannot be established.',
      );
    if (group) await groupCurrent(group, env);
  }
  await authorizedTarget();
  // A separate namespace/table preserves all existing send keys and hashes.
  const operationKey = await digest(
    JSON.stringify(['reaction', env.OWNER_USER_ID, bot, args.idempotency_key]),
  );
  const requestHash = await digest(
    JSON.stringify([
      chat,
      args.message_id,
      args.update_id,
      thread,
      args.reaction,
      group?.revision ?? null,
    ]),
  );
  async function reused(existing: UntypedJson) {
    if (existing.request_hash !== requestHash)
      throw new AppError('Idempotency key conflicts with an earlier reaction.', 200, -32004);
    if (existing.state === 'applying' && existing.updated_at < runtime.now() - 30000) {
      await run(
        db,
        "UPDATE reaction_operations SET state='uncertain',error_code='interrupted',updated_at=? WHERE operation_key=? AND state='applying'",
        runtime.now(),
        operationKey,
      );
      existing = await first(
        db,
        'SELECT * FROM reaction_operations WHERE operation_key=?',
        operationKey,
      );
    }
    return {
      state: existing.state,
      reused: true,
      requires_review: existing.state !== 'applied',
      ...(existing.error_code ? { error: existing.error_code } : {}),
    };
  }
  const existing = await first(
    db,
    'SELECT * FROM reaction_operations WHERE operation_key=?',
    operationKey,
  );
  if (existing) return reused(existing);
  const now = runtime.now();
  // Unique active-target index serializes different keys as well as duplicate calls.
  // Uncertainty keeps the target locked for its retained lifetime; no public unlock.
  const inserted = await run(
    db,
    `INSERT INTO reaction_operations(operation_key,request_hash,bot_id,chat_id,message_id,state,created_at,updated_at)
    VALUES (?,?,?,?,?,'applying',?,?) ON CONFLICT DO NOTHING`,
    operationKey,
    requestHash,
    bot,
    chat,
    args.message_id,
    now,
    now,
  );
  if (!inserted.meta?.changes) {
    const duplicate = await first(
      db,
      'SELECT * FROM reaction_operations WHERE operation_key=?',
      operationKey,
    );
    if (duplicate) return reused(duplicate);
    throw new AppError(
      'A reaction on this target is in progress or uncertain; do not change this target. Reconcile privately.',
      200,
      -32003,
    );
  }
  // Recheck retained authorization after reservation, before any external mutation.
  try {
    await authorizedTarget();
  } catch (error) {
    await run(
      db,
      "UPDATE reaction_operations SET state='failed',error_code='target_access_changed',updated_at=? WHERE operation_key=? AND state='applying'",
      runtime.now(),
      operationKey,
    );
    throw error;
  }
  try {
    const result = await telegramApi(
      'setMessageReaction',
      {
        chat_id: chat,
        message_id: args.message_id,
        reaction: args.reaction ? [{ type: 'emoji', emoji: args.reaction }] : [],
      },
      env,
      runtime,
    );
    if (result !== true) throw new Error('Ambiguous reaction response.');
    const saved = await run(
      db,
      "UPDATE reaction_operations SET state='applied',updated_at=? WHERE operation_key=? AND state='applying'",
      runtime.now(),
      operationKey,
    );
    if (!saved.meta?.changes)
      return reused(
        await first(db, 'SELECT * FROM reaction_operations WHERE operation_key=?', operationKey),
      );
    return { state: 'applied', reused: false, requires_review: false };
  } catch (error: UntypedJson) {
    const state = error instanceof AppError && error.telegramCode ? 'failed' : 'uncertain';
    const code =
      state === 'failed' ? `telegram_${error.telegramCode}` : 'network_or_response_unknown';
    const saved = await run(
      db,
      "UPDATE reaction_operations SET state=?,error_code=?,updated_at=? WHERE operation_key=? AND state='applying'",
      state,
      code,
      runtime.now(),
      operationKey,
    );
    if (!saved.meta?.changes)
      return reused(
        await first(db, 'SELECT * FROM reaction_operations WHERE operation_key=?', operationKey),
      );
    return { state, reused: false, requires_review: true, error: code };
  }
}
