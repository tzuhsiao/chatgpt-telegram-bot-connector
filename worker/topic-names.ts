import { requireChat, senderAllowed } from './access.ts';
import { digest } from './crypto.ts';
import { first, requireDatabase, run } from './db.ts';
import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { authorizedMessage, inputRecord, serviceMessage } from './intake.ts';
import { botId, telegramApi } from './telegram.ts';
import { incomingThread, validThread } from './threads.ts';
import { numericId, objectArgs } from './validate.ts';

// TDLib clean_name -> strip_empty_characters -> utf8_truncate counts code
// points, not UTF-16 units, graphemes or UTF-8 bytes. Never truncate a title.
export function validTopicName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    !/[\ud800-\udfff]/u.test(name) &&
    [...name].length <= 128 &&
    /[^\s\u0000-\u001f\u007f\u180e\u200b-\u200f\u2028-\u202e\u2800\ufeff\ufffc\u{e0000}-\u{e007f}]/u.test(
      name,
    )
  );
}

function privateTarget(args: Record<string, unknown>, env: Env) {
  const chat = requireChat(args.chat_id, env);
  if (!numericId(chat) || !senderAllowed(chat, chat, env))
    throw new AppError('Approved private chat required.', 403, -32001);
  if (!validThread(args.message_thread_id) || args.message_thread_id === 1)
    throw new AppError('An explicit named private topic ID is required.');
  return { chat, thread: args.message_thread_id, bot: botId(env) };
}

// Authenticated Telegram service fields are observations, never conversation
// content. Bot echoes are ignored by authorizedMessage; every human name edit,
// even one matching a pending Dot title, takes manual precedence. message_id is
// used for lifecycle ordering because update_id can restart after inactivity.
export async function observePrivateTopic(raw: unknown, env: Env, runtime: Runtime) {
  const envelope = authorizedMessage(raw, env, runtime.now());
  if (!envelope || envelope.chatInfo.type !== 'private') return;
  const { message, chat } = envelope;
  const thread = incomingThread(message, false, true);
  if (thread === null || thread === 1) return;
  const created = inputRecord(message.forum_topic_created);
  const edited = inputRecord(message.forum_topic_edited);
  const name = created?.name ?? edited?.name;
  if (!created && !edited && serviceMessage(message)) return;
  const db = requireDatabase(env),
    bot = botId(env);
  if (!validTopicName(name)) {
    // Ordinary content establishes only the observed topic's existence. Unknown
    // or malformed lifecycle names never establish automatic naming permission.
    await run(
      db,
      `INSERT INTO private_topics(bot_id,chat_id,message_thread_id,provenance)
      VALUES (?,?,?,'unknown') ON CONFLICT DO NOTHING`,
      bot,
      chat,
      thread,
    );
    return;
  }
  const provenance = created?.is_name_implicit === true ? 'implicit' : 'manual';
  await db.batch([
    db
      .prepare(
        `INSERT INTO private_topics(bot_id,chat_id,message_thread_id,name,provenance,revision,last_message_id)
      VALUES (?,?,?,?,?,1,?) ON CONFLICT(bot_id,chat_id,message_thread_id) DO UPDATE SET
      name=excluded.name,provenance=excluded.provenance,revision=private_topics.revision+1,last_message_id=excluded.last_message_id
      WHERE excluded.last_message_id>private_topics.last_message_id
      AND (?=0 OR private_topics.provenance='unknown')`,
      )
      .bind(bot, chat, thread, name, provenance, message.message_id, created ? 1 : 0),
    db
      .prepare(
        `UPDATE topic_name_operations SET state='failed',error_code='topic_changed',updated_at=?
      WHERE bot_id=? AND chat_id=? AND message_thread_id=? AND state='reserved'
      AND NOT EXISTS (SELECT 1 FROM private_topics WHERE bot_id=? AND chat_id=? AND message_thread_id=? AND revision=topic_name_operations.revision)`,
      )
      .bind(runtime.now(), bot, chat, thread, bot, chat, thread),
  ]);
}

export async function getPrivateTopic(raw: unknown, env: Env, runtime: Runtime) {
  const args = objectArgs(raw, ['chat_id', 'message_thread_id'], ['chat_id', 'message_thread_id']);
  const { chat, thread, bot } = privateTarget(args, env),
    db = requireDatabase(env);
  const topic = await first(
    db,
    'SELECT * FROM private_topics WHERE bot_id=? AND chat_id=? AND message_thread_id=?',
    bot,
    chat,
    thread,
  );
  const busy = await first(
    db,
    `SELECT state,updated_at FROM topic_name_operations WHERE bot_id=? AND chat_id=? AND message_thread_id=? AND state IN ('reserved','applying','uncertain')`,
    bot,
    chat,
    thread,
  );
  const operationState =
    busy && (typeof busy.updated_at !== 'number' || busy.updated_at < runtime.now() - 30000)
      ? 'uncertain'
      : (busy?.state ?? null);
  return {
    chat_id: chat,
    message_thread_id: thread,
    observed: !!topic,
    name: topic?.name ?? null,
    provenance: topic?.provenance ?? 'unknown',
    revision: topic?.revision ?? 0,
    automatic_eligible: topic?.provenance === 'implicit' && !busy,
    operation_state: operationState,
  };
}

export async function renamePrivateTopic(raw: unknown, env: Env, runtime: Runtime) {
  const args = objectArgs(
    raw,
    ['chat_id', 'message_thread_id', 'name', 'mode', 'expected_revision', 'idempotency_key'],
    ['chat_id', 'message_thread_id', 'name', 'mode', 'expected_revision', 'idempotency_key'],
  );
  const { chat, thread, bot } = privateTarget(args, env),
    db = requireDatabase(env);
  if (!validTopicName(args.name))
    throw new AppError('Name must contain 1 to 128 Unicode code points and visible content.');
  if (args.mode !== 'automatic' && args.mode !== 'manual')
    throw new AppError('Invalid naming mode.');
  if (
    typeof args.expected_revision !== 'number' ||
    !Number.isSafeInteger(args.expected_revision) ||
    args.expected_revision < 0
  )
    throw new AppError('A nonnegative observed topic revision is required.');
  if (
    typeof args.idempotency_key !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotency_key)
  )
    throw new AppError('A stable ASCII idempotency key is required.');
  const name = args.name,
    mode = args.mode,
    revision = args.expected_revision;
  const key = await digest(
    JSON.stringify(['topic-name', env.OWNER_USER_ID, bot, args.idempotency_key]),
  );
  const hash = await digest(JSON.stringify([chat, thread, name, mode, revision]));
  const read = () => first(db, 'SELECT * FROM topic_name_operations WHERE operation_key=?', key);
  async function result(reused: boolean) {
    let op = await read();
    if (!op || op.request_hash !== hash)
      throw new AppError('Idempotency key conflicts with an earlier topic edit.', 200, -32004);
    if (
      ['reserved', 'applying'].includes(String(op.state)) &&
      typeof op.updated_at === 'number' &&
      op.updated_at < runtime.now() - 30000
    ) {
      await run(
        db,
        `UPDATE topic_name_operations SET state='uncertain',error_code='interrupted',updated_at=? WHERE operation_key=? AND state IN ('reserved','applying')`,
        runtime.now(),
        key,
      );
      op = await read();
      if (!op) throw new Error('Missing topic operation.');
    }
    return {
      state: op.state,
      reused,
      requires_review: !['applied', 'unchanged'].includes(String(op.state)),
      superseded: op.superseded === 1,
      ...(op.error_code ? { error: op.error_code } : {}),
    };
  }
  if (await read()) return result(true);
  const now = runtime.now();
  // Admission, revision eligibility and target locking are one SQL statement.
  const reserved = await run(
    db,
    `INSERT INTO topic_name_operations(operation_key,request_hash,bot_id,chat_id,message_thread_id,name,mode,revision,state,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,CASE WHEN name=? THEN 'unchanged' ELSE 'reserved' END,?,? FROM private_topics
    WHERE bot_id=? AND chat_id=? AND message_thread_id=? AND revision=? AND (?='manual' OR provenance='implicit')
    AND NOT EXISTS (SELECT 1 FROM topic_name_operations WHERE bot_id=? AND chat_id=? AND message_thread_id=? AND state IN ('reserved','applying','uncertain'))
    ON CONFLICT DO NOTHING`,
    key,
    hash,
    bot,
    chat,
    thread,
    name,
    mode,
    revision,
    name,
    now,
    now,
    bot,
    chat,
    thread,
    revision,
    mode,
    bot,
    chat,
    thread,
  );
  if (!reserved.meta?.changes) {
    if (await read()) return result(true);
    throw new AppError(
      'Topic is unknown, changed, protected, in progress or uncertain; read metadata and reconcile privately.',
      200,
      -32003,
    );
  }
  if ((await read())?.state === 'unchanged') return result(false);
  // Recheck the observed revision immediately before dispatch. No fallback or
  // retry exists. A human edit observed before this gate cancels the reservation.
  privateTarget(args, env);
  const claimed = await run(
    db,
    `UPDATE topic_name_operations SET state='applying',updated_at=? WHERE operation_key=? AND state='reserved'
    AND EXISTS (SELECT 1 FROM private_topics WHERE bot_id=? AND chat_id=? AND message_thread_id=? AND revision=? AND (?='manual' OR provenance='implicit'))`,
    runtime.now(),
    key,
    bot,
    chat,
    thread,
    revision,
    mode,
  );
  if (!claimed.meta?.changes) {
    await run(
      db,
      `UPDATE topic_name_operations SET state='failed',error_code='topic_changed',updated_at=? WHERE operation_key=? AND state='reserved'`,
      runtime.now(),
      key,
    );
    return result(false);
  }
  try {
    const response = await telegramApi(
      'editForumTopic',
      { chat_id: chat, message_thread_id: thread, name },
      env,
      runtime,
    );
    if (response !== true) throw new Error('Ambiguous topic edit response.');
    const provenance = mode === 'automatic' ? 'dot' : 'manual';
    await db.batch([
      db
        .prepare(
          `UPDATE private_topics SET name=?,provenance=?,revision=revision+1 WHERE bot_id=? AND chat_id=? AND message_thread_id=? AND revision=?
        AND EXISTS (SELECT 1 FROM topic_name_operations WHERE operation_key=? AND state='applying')`,
        )
        .bind(name, provenance, bot, chat, thread, revision, key),
      db
        .prepare(
          `UPDATE topic_name_operations SET state='applied',updated_at=?,superseded=CASE WHEN EXISTS
        (SELECT 1 FROM private_topics WHERE bot_id=? AND chat_id=? AND message_thread_id=? AND revision=? AND name=? AND provenance=?) THEN 0 ELSE 1 END
        WHERE operation_key=? AND state='applying'`,
        )
        .bind(runtime.now(), bot, chat, thread, revision + 1, name, provenance, key),
    ]);
  } catch (error) {
    const rejected = error instanceof AppError && !!error.telegramCode;
    await run(
      db,
      `UPDATE topic_name_operations SET state=?,error_code=?,updated_at=? WHERE operation_key=? AND state='applying'`,
      rejected ? 'failed' : 'uncertain',
      rejected ? `telegram_${error.telegramCode}` : 'network_or_response_unknown',
      runtime.now(),
      key,
    );
  }
  return result(false);
}
