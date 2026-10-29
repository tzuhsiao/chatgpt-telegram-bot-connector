import { allowlist, groupConfig, observedGroups, requireChat } from './access.ts';
import { DAY } from './constants.ts';
import { digest } from './crypto.ts';
import { first, requireDatabase, rows } from './db.ts';
import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { checkGroup, groupCurrent } from './groups.ts';
import { normalizedMentions } from './mentions.ts';
import { botId } from './telegram.ts';
import { requestedThread, threadScope } from './threads.ts';
import type { UntypedJson } from './untyped.ts';
import { groupId, objectArgs, senderUsername } from './validate.ts';

// Owner-only read paths. Status reports configuration booleans, IDs, group
// access state and delivery counts without secrets, callback paths or message
// text. History returns retained connector data for one authorized chat/topic
// within the current group epoch; it is not arbitrary Telegram history.

export async function connectorStatus(env: Env, runtime: Runtime) {
  const db = requireDatabase(env),
    now = runtime.now();
  const configured = {
    owner: !!env.OWNER_USER_ID,
    bot: !!env.TELEGRAM_BOT_TOKEN,
    webhook_secret: !!env.TELEGRAM_WEBHOOK_SECRET,
    allowed_users: !!env.TELEGRAM_ALLOWED_USER_IDS,
    allowed_chats: !!env.TELEGRAM_ALLOWED_CHAT_IDS,
    callback_origins: !!env.MCP_CALLBACK_ORIGINS,
    site_origin: !!env.SITE_ORIGIN,
  };
  const active: UntypedJson = await first(
    db,
    'SELECT COUNT(*) AS n FROM subscriptions WHERE owner_id=? AND enabled=1 AND expires_at>?',
    env.OWNER_USER_ID,
    now,
  );
  const pending: UntypedJson = await first(
    db,
    "SELECT COUNT(*) AS n FROM inbox WHERE state='pending' AND received_at>=?",
    now - 7 * DAY,
  );
  const exhausted: UntypedJson = await first(
    db,
    "SELECT COUNT(*) AS n FROM inbox WHERE state='pending' AND attempts>=8 AND received_at>=?",
    now - 7 * DAY,
  );
  const failed: UntypedJson = await first(
    db,
    "SELECT COUNT(*) AS n FROM inbox WHERE state='failed' AND received_at>=?",
    now - 7 * DAY,
  );
  const uncertain: UntypedJson = await first(
    db,
    "SELECT COUNT(*) AS n FROM outgoing WHERE (state='uncertain' OR (state='sending' AND updated_at<?)) AND created_at>=?",
    now - 30000,
    now - 30 * DAY,
  );
  const uncertainReactions: UntypedJson = await first(
    db,
    "SELECT COUNT(*) AS n FROM reaction_operations WHERE (state='uncertain' OR (state='applying' AND updated_at<?)) AND created_at>=?",
    now - 30000,
    now - 30 * DAY,
  );
  const requested = await first(
    db,
    'SELECT value FROM connector_meta WHERE key=?',
    'requested_callback_origin',
  );
  const groups = [];
  const groupObservation = observedGroups(env);
  let configuredBot = null;
  try {
    configuredBot = botId(env);
  } catch {
    /* Presence is not proof of valid bot configuration. */
  }
  for (const [chat, humans] of groupObservation.groups) {
    if (!configuredBot) {
      groups.push({
        chat_id: chat,
        configured: true,
        state: 'paused',
        revision: 0,
        verified_at: null,
        last_error: 'bot_configuration_required',
      });
      continue;
    }
    const bot = configuredBot,
      hash = await digest(JSON.stringify([env.OWNER_USER_ID, bot, chat, humans]));
    const state = await first(
      db,
      'SELECT * FROM group_access WHERE bot_id=? AND chat_id=?',
      bot,
      chat,
    );
    const matches = state?.config_hash === hash;
    groups.push({
      chat_id: chat,
      configured: true,
      state: matches ? state.state : 'paused',
      is_forum: matches ? state.is_forum === 1 : null,
      revision: state?.revision ?? 0,
      verified_at: matches ? state.verified_at : null,
      last_error: matches ? state.last_error : state ? 'approval_changed' : 'verification_required',
    });
  }
  if (configuredBot) {
    for (const stored of await rows(
      db,
      'SELECT * FROM group_access WHERE bot_id=?',
      configuredBot,
    )) {
      if (!groupObservation.groups.has(stored.chat_id as string))
        groups.push({
          chat_id: stored.chat_id,
          configured: false,
          state: 'paused',
          revision: stored.revision,
          verified_at: null,
          last_error: groupObservation.error ?? 'approval_removed',
        });
    }
  }
  return {
    configured,
    allowed_chat_ids: [...allowlist(env.TELEGRAM_ALLOWED_CHAT_IDS)],
    groups,
    group_configuration_error: groupObservation.error,
    active_subscriptions: active.n,
    pending_deliveries: pending.n,
    retry_exhausted_deliveries: exhausted.n,
    failed_deliveries: failed.n,
    uncertain_sends: uncertain.n,
    uncertain_reactions: uncertainReactions.n,
    requested_callback_origin: requested?.value ?? null,
  };
}

// `args` are MCP tool arguments, shape-checked by objectArgs on the first line.
export async function recentMessages(args: UntypedJson, env: Env, runtime: Runtime) {
  objectArgs(args, ['chat_id', 'limit', 'message_thread_id', 'include_outgoing'], ['chat_id']);
  const chat = requireChat(args.chat_id, env),
    limit = args.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new AppError('Limit must be between 1 and 20.');
  if (args.include_outgoing !== undefined && typeof args.include_outgoing !== 'boolean')
    throw new AppError('include_outgoing must be boolean.');
  if (!groupId(chat) && !allowlist(env.TELEGRAM_ALLOWED_USER_IDS).has(chat))
    throw new AppError('Sender access has been revoked.', 403, -32001);
  const group = groupId(chat) ? await checkGroup(chat, env, runtime) : null;
  const thread = requestedThread(args, group, !groupId(chat)),
    db = requireDatabase(env),
    bot = botId(env),
    cutoff = runtime.now() - 7 * DAY,
    revision = group?.revision ?? null;
  const scope = threadScope(thread, !groupId(chat));
  // checkGroup above already required an approved group's sender pair to exist.
  const senders = (group ? groupConfig(env).get(chat) : [chat, null]) as (string | null)[];
  let messages: UntypedJson[];
  if (args.include_outgoing) {
    messages = await rows(
      db,
      `SELECT event_id,update_id,chat_id,sender_id,sender_username,message_id,message_thread_id,text,media_json,occurred_at,state,last_error,role,mentions_json FROM (
      SELECT event_id,update_id,chat_id,sender_id,sender_username,message_id,message_thread_id,text,media_json,occurred_at,state,last_error,'user' AS role,NULL AS mentions_json FROM inbox
      WHERE chat_id=? AND bot_id=? AND received_at>=? AND (? IS NULL OR group_revision=?) AND ${scope.column} IS ? AND sender_id IN (?,?)
      UNION ALL SELECT NULL,NULL,chat_id,bot_id,NULL,message_id,message_thread_id,text,NULL,occurred_at,'sent',NULL,'bot',mentions_json FROM sent_messages
      WHERE chat_id=? AND bot_id=? AND sent_at>=? AND (? IS NULL OR group_revision=?) AND ${scope.column} IS ?)
      ORDER BY message_id DESC LIMIT ?`,
      chat,
      bot,
      cutoff,
      revision,
      revision,
      scope.value,
      senders[0],
      senders[1],
      chat,
      bot,
      cutoff,
      revision,
      revision,
      scope.value,
      limit,
    );
  } else {
    messages = await rows(
      db,
      `SELECT event_id,update_id,chat_id,sender_id,sender_username,message_id,text,media_json,occurred_at,state,last_error,message_thread_id FROM inbox WHERE chat_id=? AND bot_id=? AND received_at>=? AND (? IS NULL OR group_revision=?) AND ${scope.column} IS ? AND sender_id IN (?,?) ORDER BY received_at DESC,update_id DESC LIMIT ?`,
      chat,
      bot,
      cutoff,
      revision,
      revision,
      scope.value,
      senders[0],
      senders[1],
      limit,
    );
    for (const message of messages)
      if (message.message_thread_id === null) delete message.message_thread_id;
  }
  for (const message of messages) {
    if (typeof message.mentions_json === 'string' && typeof message.text === 'string') {
      try {
        const stored: unknown = JSON.parse(message.mentions_json);
        const mentions = normalizedMentions(stored, message.text);
        if (mentions.length) message.mentions = mentions;
      } catch {
        // Damaged display metadata grants nothing and must not hide other history.
      }
    }
    delete message.mentions_json;
    const username = senderUsername(message.sender_username);
    if (username !== null) message.sender_username = username;
    else delete message.sender_username;
    if (message.media_json) message.media = JSON.parse(message.media_json);
    delete message.media_json;
  }
  if (group) await groupCurrent(group, env);
  return { messages };
}
