import { groupConfig, observedGroups, requireChat } from './access.ts';
import { digest } from './crypto.ts';
import { first, requireDatabase, rows, run } from './db.ts';
import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { botId, telegramApi } from './telegram.ts';
import type { UntypedJson } from './untyped.ts';
import { groupId, objectArgs } from './validate.ts';

// Private-group access state. Each approved group has a durable record keyed by
// (bot, chat) with a config hash, an epoch `revision` and `state`
// ('active' | 'paused'). Any approval change, bot access loss, mode change or
// migration pauses the group and fails its pending events; only owner-authorized
// verification reactivates it.

// D1 group_access row. Stored by this Worker; fields are compared, not trusted
// for authorization beyond what the queries already enforce.
export type GroupSnapshot = Record<string, unknown>;

export async function groupState(chat: string, env: Env): Promise<GroupSnapshot> {
  const humans = groupConfig(env).get(chat);
  if (!humans) throw new AppError('Group is not approved.', 403, -32001);
  const db = requireDatabase(env),
    bot = botId(env);
  const hash = await digest(JSON.stringify([env.OWNER_USER_ID, bot, chat, humans]));
  await run(
    db,
    `INSERT INTO group_access(bot_id,chat_id,config_hash,last_error) VALUES (?,?,?,'verification_required')
    ON CONFLICT(bot_id,chat_id) DO UPDATE SET config_hash=excluded.config_hash,state='paused',revision=group_access.revision+1,last_error='approval_changed'
    WHERE group_access.config_hash<>excluded.config_hash`,
    bot,
    chat,
    hash,
  );
  const state = await first(
    db,
    'SELECT * FROM group_access WHERE bot_id=? AND chat_id=?',
    bot,
    chat,
  );
  if (state?.config_hash !== hash)
    throw new AppError('Group configuration changed during verification.', 200, -32016);
  return state;
}

export async function syncGroupApprovals(env: Env): Promise<void> {
  const db = requireDatabase(env),
    bot = botId(env),
    { groups, error } = observedGroups(env);
  for (const state of await rows(db, 'SELECT * FROM group_access WHERE bot_id=?', bot)) {
    const humans = groups.get(state.chat_id as string);
    const hash = humans
      ? await digest(JSON.stringify([env.OWNER_USER_ID, bot, state.chat_id, humans]))
      : state.config_hash;
    const reason = humans
      ? 'approval_changed'
      : error
        ? 'invalid_group_config'
        : 'approval_removed';
    if ((humans && hash === state.config_hash) || (!humans && state.state === 'paused')) continue;
    await db.batch([
      db
        .prepare(
          "UPDATE group_access SET state='paused',revision=revision+1,config_hash=?,last_error=? WHERE bot_id=? AND chat_id=? AND revision=? AND config_hash=?",
        )
        .bind(hash, reason, bot, state.chat_id, state.revision, state.config_hash),
      db
        .prepare(
          "UPDATE inbox SET state='failed',last_error='group_access_revoked',lease_token=NULL,lease_until=0 WHERE bot_id=? AND chat_id=? AND state='pending' AND EXISTS (SELECT 1 FROM group_access WHERE bot_id=? AND chat_id=? AND state='paused')",
        )
        .bind(bot, state.chat_id, bot, state.chat_id),
      db
        .prepare(
          "DELETE FROM media_cache WHERE bot_id=? AND chat_id=? AND EXISTS (SELECT 1 FROM group_access WHERE bot_id=? AND chat_id=? AND state='paused')",
        )
        .bind(bot, state.chat_id, bot, state.chat_id),
    ]);
  }
}

export async function pauseGroup(chat: string, env: Env, reason: string): Promise<void> {
  const db = requireDatabase(env);
  await db.batch([
    db
      .prepare(
        "UPDATE group_access SET state='paused',revision=revision+1,last_error=? WHERE bot_id=? AND chat_id=?",
      )
      .bind(reason, botId(env), chat),
    db
      .prepare(
        "UPDATE inbox SET state='failed',last_error='group_access_revoked',lease_token=NULL,lease_until=0 WHERE bot_id=? AND chat_id=? AND state='pending'",
      )
      .bind(botId(env), chat),
    db.prepare('DELETE FROM media_cache WHERE bot_id=? AND chat_id=?').bind(botId(env), chat),
  ]);
}

// `args` are MCP tool arguments, shape-checked by objectArgs on the first line.
export async function pauseGroupAccess(args: Record<string, unknown>, env: Env) {
  objectArgs(args, ['chat_id'], ['chat_id']);
  if (
    !groupId(args.chat_id) ||
    !(await first(
      requireDatabase(env),
      'SELECT chat_id FROM group_access WHERE bot_id=? AND chat_id=?',
      botId(env),
      args.chat_id,
    ))
  )
    throw new AppError('A previously configured group is required.', 403, -32001);
  await pauseGroup(args.chat_id, env, 'owner_paused');
  return { chat_id: args.chat_id, state: 'paused' };
}

export async function groupCurrent(snapshot: GroupSnapshot, env: Env): Promise<void> {
  // A snapshot's chat_id came from groupState; an unknown ID simply fails approval there.
  const current = await groupState(snapshot.chat_id as string, env);
  if (
    current.state !== 'active' ||
    current.revision !== snapshot.revision ||
    current.config_hash !== snapshot.config_hash
  )
    throw new AppError(
      'Group access is paused. Owner-authorized verification is required.',
      200,
      -32016,
    );
}

export async function inspectGroup(chat: string, env: Env, runtime: Runtime): Promise<boolean> {
  const humans = groupConfig(env).get(chat),
    bot = botId(env);
  // Callers only inspect approved groups; an unapproved chat throws a TypeError here,
  // which callers treat as unverifiable access, exactly as before.
  if ((humans as string[]).includes(bot)) throw new Error('The bot is not an approved human.');
  const before = await inspectGroupMetadata(chat, env, runtime);
  // Query only this bot. Other members and invitation settings are audience
  // management, not the actual-sender authorization boundary.
  const self = await telegramApi(
    'getChatMember',
    { chat_id: chat, user_id: Number(bot) },
    env,
    runtime,
  );
  const after = await inspectGroupMetadata(chat, env, runtime);
  if (Boolean(before.is_forum) !== Boolean(after.is_forum))
    throw new AppError('Group mode changed.', 200, -32016, 'group_mode_changed');
  if (
    !usableBotMember(self, bot, before.permissions) ||
    !usableBotMember(self, bot, after.permissions)
  )
    throw new Error('Bot access is unusable.');
  return after.is_forum === true;
}

export function usableBotMember(
  member: UntypedJson,
  bot: string,
  permissions?: UntypedJson,
): boolean {
  if (
    !Number.isSafeInteger(member?.user?.id) ||
    String(member.user.id) !== bot ||
    member.user.is_bot !== true
  )
    return false;
  if (member.status === 'administrator') return true;
  if (permissions?.can_send_messages === false) return false;
  if (member.status === 'member') return true;
  return (
    member.status === 'restricted' && member.is_member === true && member.can_send_messages === true
  );
}

export async function inspectGroupMetadata(
  chat: string,
  env: Env,
  runtime: Runtime,
): Promise<UntypedJson> {
  const info: UntypedJson = await telegramApi('getChat', { chat_id: chat }, env, runtime);
  // Forum mode changes routing, not the approved membership boundary.
  if (
    !Number.isSafeInteger(info?.id) ||
    String(info.id) !== chat ||
    !['group', 'supergroup'].includes(info.type) ||
    info.username ||
    (info.active_usernames !== undefined &&
      (!Array.isArray(info.active_usernames) || info.active_usernames.length)) ||
    info.linked_chat_id !== undefined ||
    info.location !== undefined ||
    info.community !== undefined ||
    (info.is_forum !== undefined && typeof info.is_forum !== 'boolean') ||
    (info.is_forum && info.type !== 'supergroup') ||
    info.is_direct_messages
  )
    throw new Error('Group metadata is unsafe.');
  return info;
}

export async function checkGroup(chat: string, env: Env, runtime: Runtime): Promise<GroupSnapshot> {
  const snapshot = await groupState(chat, env);
  if (snapshot.state !== 'active')
    throw new AppError(
      'Group access is paused. Owner-authorized verification is required.',
      200,
      -32016,
    );
  let forum;
  try {
    forum = await inspectGroup(chat, env, runtime);
  } catch (error) {
    await pauseGroup(
      chat,
      env,
      error instanceof AppError && error.reason === 'group_mode_changed'
        ? 'group_mode_changed'
        : 'group_access_unverified',
    );
    throw new AppError(
      'Group operational access could not be verified; access is paused.',
      200,
      -32016,
    );
  }
  if (Number(forum) !== snapshot.is_forum) {
    await pauseGroup(chat, env, 'group_mode_changed');
    throw new AppError(
      'Group mode changed; owner-authorized verification is required.',
      200,
      -32016,
    );
  }
  await groupCurrent(snapshot, env);
  return snapshot;
}

// `args` are MCP tool arguments, shape-checked by objectArgs on the first line.
export async function verifyGroupAccess(args: Record<string, unknown>, env: Env, runtime: Runtime) {
  objectArgs(args, ['chat_id'], ['chat_id']);
  const chat = requireChat(args.chat_id, env);
  if (!groupId(chat)) throw new AppError('A configured group ID is required.');
  const snapshot = await groupState(chat, env);
  let forum;
  try {
    forum = await inspectGroup(chat, env, runtime);
  } catch (error) {
    await pauseGroup(
      chat,
      env,
      error instanceof AppError && error.reason === 'group_mode_changed'
        ? 'group_mode_changed'
        : 'group_access_unverified',
    );
    throw new AppError(
      'Group operational access could not be verified; access is paused.',
      200,
      -32016,
    );
  }
  const result = await run(
    // groupState above already required the database binding.
    env.DB as D1Database,
    `UPDATE group_access SET state='active',revision=revision+?,verified_at=?,last_error=NULL,is_forum=?
    WHERE bot_id=? AND chat_id=? AND config_hash=? AND revision=?`,
    snapshot.state === 'active' && snapshot.is_forum === Number(forum) ? 0 : 1,
    runtime.now(),
    Number(forum),
    snapshot.bot_id,
    chat,
    snapshot.config_hash,
    snapshot.revision,
  );
  if (!result.meta?.changes)
    throw new AppError(
      'Group access changed during verification. Inspect status before retrying.',
      200,
      -32016,
    );
  return { chat_id: chat, state: 'active', is_forum: forum };
}

export async function pauseForUpdate(
  chat: string,
  updateId: unknown,
  reason: string,
  env: Env,
  runtime: Runtime,
): Promise<void> {
  // Deduplication and the latch are one atomic batch; a crash cannot forget a pause.
  if (observedGroups(env).groups.has(chat)) await groupState(chat, env);
  const db = requireDatabase(env),
    bot = botId(env);
  const unique = 'NOT EXISTS (SELECT 1 FROM group_updates WHERE bot_id=? AND update_id=?)';
  await db.batch([
    db
      .prepare(
        `UPDATE group_access SET state='paused',revision=revision+1,last_error=? WHERE bot_id=? AND chat_id=? AND ${unique}`,
      )
      .bind(reason, bot, chat, bot, updateId),
    db
      .prepare(
        `UPDATE inbox SET state='failed',last_error='group_access_revoked',lease_token=NULL,lease_until=0 WHERE bot_id=? AND chat_id=? AND state='pending' AND ${unique}`,
      )
      .bind(bot, chat, bot, updateId),
    db
      .prepare(`DELETE FROM media_cache WHERE bot_id=? AND chat_id=? AND ${unique}`)
      .bind(bot, chat, bot, updateId),
    db
      .prepare(
        'INSERT INTO group_updates(bot_id,update_id,chat_id,received_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(bot, updateId, chat, runtime.now()),
  ]);
}

export async function membershipUpdate(
  update: UntypedJson,
  env: Env,
  runtime: Runtime,
): Promise<boolean> {
  const member = update.my_chat_member ?? update.chat_member;
  const message = update.message;
  const service =
    message &&
    ['new_chat_members', 'left_chat_member', 'migrate_to_chat_id', 'migrate_from_chat_id'].some(
      (key) => Object.hasOwn(message, key),
    );
  const chat = String((member?.chat ?? (service ? message.chat : null))?.id);
  if (
    !observedGroups(env).groups.has(chat) &&
    !(await first(
      requireDatabase(env),
      'SELECT chat_id FROM group_access WHERE bot_id=? AND chat_id=?',
      botId(env),
      chat,
    ))
  )
    return false;
  const migrated =
    service &&
    (message.migrate_to_chat_id !== undefined || message.migrate_from_chat_id !== undefined);
  if (migrated) await pauseForUpdate(chat, update.update_id, 'group_migrated', env, runtime);
  else if (update.my_chat_member && !usableBotMember(member.new_chat_member, botId(env))) {
    const identified =
      Number.isSafeInteger(member.new_chat_member?.user?.id) &&
      String(member.new_chat_member.user.id) === botId(env) &&
      member.new_chat_member.user.is_bot === true;
    await pauseForUpdate(
      chat,
      update.update_id,
      identified ? 'bot_access_lost' : 'bot_access_unverified',
      env,
      runtime,
    );
  } else if (
    member &&
    String(member.new_chat_member?.user?.id) === botId(env) &&
    !usableBotMember(member.new_chat_member, botId(env))
  ) {
    await pauseForUpdate(chat, update.update_id, 'bot_access_lost', env, runtime);
  } else if (service && String(message.left_chat_member?.id) === botId(env)) {
    await pauseForUpdate(chat, update.update_id, 'bot_access_lost', env, runtime);
  }
  // Joins, other users' role changes and usable bot role changes grant no input
  // authority and do not interrupt the approved senders.
  return true;
}
