import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorker } from '../worker/index.js';
import { normalizedUpdate } from '../worker/intake.ts';
import {
  NOW,
  TestDatabase,
  environment,
  rpc,
  call,
  subscription,
  update,
  telegramRequest,
  challengeResponse,
  verifySignature,
} from './helpers.mjs';

const GROUP = '-1001234567890';
const data = (result) => result.body.result?.structuredContent;
function incoming(id, username, { group = false, thread } = {}) {
  const value = update(id);
  if (username !== undefined) value.message.from.username = username;
  if (group) {
    value.message.chat = { id: Number(GROUP), type: 'supergroup', is_forum: true };
    value.message.from.id = 20002;
  }
  if (thread !== undefined) {
    value.message.message_thread_id = thread;
    value.message.is_topic_message = thread !== 1;
  }
  return value;
}
async function fixture(t, { group = false, db = new TestDatabase() } = {}) {
  const env = environment(db);
  t.after(() => db.close());
  if (group) env.TELEGRAM_ALLOWED_GROUPS = JSON.stringify({ [GROUP]: ['10001', '20002'] });
  const state = { time: NOW, events: [], callbackStatus: 204 };
  const worker = createWorker({
    now: () => state.time,
    fetch: async (url, init) => {
      const args = JSON.parse(init.body);
      if (args.type === 'verification') return challengeResponse(init);
      if (args.name === 'telegram.message.received') {
        assert.equal(verifySignature(init), true);
        state.events.push(args);
        return new Response(null, { status: state.callbackStatus });
      }
      const method = new URL(url).pathname.split('/').at(-1);
      if (method === 'getChat')
        return Response.json({
          ok: true,
          result: { id: Number(GROUP), type: 'supergroup', is_forum: true },
        });
      if (method === 'getChatMember') {
        assert.equal(args.user_id, 123456);
        return Response.json({
          ok: true,
          result: { user: { id: 123456, is_bot: true }, status: 'administrator' },
        });
      }
      if (method === 'sendMessage')
        return Response.json({
          ok: true,
          result: {
            message_id: 500,
            chat: { id: Number(args.chat_id) },
            message_thread_id: args.message_thread_id,
            is_topic_message: true,
          },
        });
      throw new Error(`Unexpected method ${method}`);
    },
  });
  const chat = group ? GROUP : '10001';
  if (group)
    assert.equal(
      data(await call(worker, env, 'verify_group_access', { chat_id: chat })).state,
      'active',
    );
  assert.ok(
    (
      await (
        await worker.fetch(
          rpc('events/subscribe', subscription({ arguments: { chat_id: chat } })),
          env,
        )
      ).json()
    ).result.id,
  );
  return { env, worker, state, chat };
}

test('observed username round-trips in normalization, storage, signed retries, discovery and history', async (t) => {
  const { env, worker, state } = await fixture(t);
  const value = incoming(42, 'Synthetic_User', { thread: 70 });
  assert.equal(normalizedUpdate(value, env, NOW).sender_username, 'Synthetic_User');
  state.callbackStatus = 503;
  assert.equal((await worker.fetch(telegramRequest(value), env)).status, 503);
  value.message.from.username = 'Changed_Duplicate';
  state.callbackStatus = 204;
  await call(worker, env, 'retry_pending_events', { chat_id: '10001' });
  await Promise.all(Array.from({ length: 5 }, () => worker.fetch(telegramRequest(value), env)));
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events[0], state.events[1]);
  assert.equal(state.events[0].data.sender_username, 'Synthetic_User');
  assert.equal(state.events[0].data.sender_id, '10001');
  assert.equal(
    (await env.DB.prepare('SELECT sender_username FROM inbox').first()).sender_username,
    'Synthetic_User',
  );
  const history = data(
    await call(worker, env, 'get_recent_messages', { chat_id: '10001', message_thread_id: 70 }),
  ).messages;
  assert.equal(history[0].sender_username, 'Synthetic_User');
  const discovery = (await (await worker.fetch(rpc('events/list'), env)).json()).result;
  const schema = discovery.events[0].payloadSchema;
  assert.equal(schema.required.includes('sender_username'), false);
  assert.equal(schema.properties.sender_username.maxLength, 32);
  assert.match('Synthetic_User', new RegExp(schema.properties.sender_username.pattern));
});

test('username bounds and malformed values preserve the message while omitting unusable metadata', async (t) => {
  const { env, worker, state } = await fixture(t);
  const cases = [
    [undefined, undefined],
    [null, undefined],
    ['', undefined],
    [42, undefined],
    [{ username: 'Nested_User' }, undefined],
    [['Array_User'], undefined],
    ['@Synthetic_User', undefined],
    ['Synthetic User', undefined],
    ['Bad\nName', undefined],
    ['Bad\u0000Name', undefined],
    ['BadName\n', undefined],
    ['BadName\r\n', undefined],
    ['NonAscii_é', undefined],
    ['a'.repeat(33), undefined],
    ['a', 'a'],
    ['A_0', 'A_0'],
    ['A'.repeat(32), 'A'.repeat(32)],
  ];
  for (const [index, [username, expected]] of cases.entries()) {
    const value = incoming(100 + index, username);
    assert.equal((await worker.fetch(telegramRequest(value), env)).status, 200);
    const event = state.events.at(-1).data;
    assert.equal(event.sender_username, expected);
    assert.equal(Object.hasOwn(event, 'sender_username'), expected !== undefined);
    const row = await env.DB.prepare('SELECT sender_username FROM inbox WHERE update_id=?')
      .bind(100 + index)
      .first();
    assert.equal(row.sender_username, expected ?? null);
    const history = data(
      await call(worker, env, 'get_recent_messages', { chat_id: '10001', limit: 1 }),
    ).messages[0];
    assert.equal(history.sender_username, expected);
    assert.equal(Object.hasOwn(history, 'sender_username'), expected !== undefined);
  }
});

test('changed and removed usernames are per-message snapshots without profile backfill', async (t) => {
  const { env, worker, state } = await fixture(t);
  for (const [id, username] of [
    [42, 'Earlier_User'],
    [43, 'Later_User'],
    [44, undefined],
  ])
    await worker.fetch(telegramRequest(incoming(id, username)), env);
  assert.deepEqual(
    state.events.map((event) => event.data.sender_username),
    ['Earlier_User', 'Later_User', undefined],
  );
  assert.deepEqual(
    data(await call(worker, env, 'get_recent_messages', { chat_id: '10001' })).messages.map(
      (row) => row.sender_username,
    ),
    [undefined, 'Later_User', 'Earlier_User'],
  );
});

test('media receipts carry the same observed sender username without reading embedded profiles', async (t) => {
  const { env, worker, state } = await fixture(t);
  const value = incoming(42, 'Media_User');
  delete value.message.text;
  value.message.photo = [{ file_id: 'synthetic_photo', file_unique_id: 'synthetic_unique' }];
  value.message.caption = 'Synthetic media caption';
  await worker.fetch(telegramRequest(value), env);
  assert.equal(state.events[0].data.sender_username, 'Media_User');
  assert.equal(state.events[0].data.media.type, 'photo');
  const history = data(
    await call(worker, env, 'get_recent_messages', { chat_id: '10001' }),
  ).messages;
  assert.equal(history[0].sender_username, 'Media_User');
  assert.equal(history[0].media.type, 'photo');
});

test('only the actual authenticated top-level sender supplies username metadata', async (t) => {
  const { env, worker, state } = await fixture(t);
  for (const [id, username] of [
    [42, 'Actual_User'],
    [43, undefined],
  ]) {
    const value = incoming(id, username);
    value.message.chat.username = 'Chat_User';
    value.message.reply_to_message = { from: { id: 30003, username: 'Quoted_User' } };
    value.message.forward_origin = {
      type: 'user',
      sender_user: { id: 30003, username: 'Forward_User' },
    };
    value.message.forward_from = { id: 30003, username: 'Legacy_Forward' };
    value.message.entities = [
      { type: 'text_mention', offset: 0, length: 1, user: { id: 30003, username: 'Entity_User' } },
    ];
    await worker.fetch(telegramRequest(value), env);
  }
  assert.deepEqual(
    state.events.map((event) => event.data.sender_username),
    ['Actual_User', undefined],
  );
  assert.deepEqual(
    (await env.DB.prepare('SELECT sender_username FROM inbox ORDER BY update_id').all()).results,
    [{ sender_username: 'Actual_User' }, { sender_username: null }],
  );
});

test('username never authorizes outsiders, wrong chats, bot or anonymous senders, or invalid webhook secrets', async (t) => {
  const { env, worker, state } = await fixture(t, { group: true });
  const outsider = incoming(42, 'Allowed_Looking', { group: true, thread: 70 });
  outsider.message.from.id = 30003;
  const wrongChat = incoming(43, 'Allowed_Looking');
  wrongChat.message.chat.id = 20002;
  const bot = incoming(44, 'Allowed_Looking', { group: true, thread: 70 });
  bot.message.from.is_bot = true;
  const anonymous = incoming(45, 'Allowed_Looking', { group: true, thread: 70 });
  anonymous.message.sender_chat = { id: Number(GROUP), username: 'Anonymous_User' };
  for (const value of [outsider, wrongChat, bot, anonymous]) {
    assert.equal(normalizedUpdate(value, env, NOW), null);
    assert.equal((await worker.fetch(telegramRequest(value), env)).status, 200);
  }
  assert.equal(
    (await worker.fetch(telegramRequest(incoming(46, 'Secret_User'), 'wrong-secret'), env)).status,
    401,
  );
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 0);
  assert.deepEqual(state.events, []);
});

test('usernames obey owner, topic, group epoch and sender access boundaries in mixed history', async (t) => {
  const { env, worker, chat, state } = await fixture(t, { group: true });
  for (const [id, username, thread] of [
    [42, 'Topic_Seventy', 70],
    [43, 'Topic_Eighty', 80],
  ])
    await worker.fetch(telegramRequest(incoming(id, username, { group: true, thread })), env);
  assert.equal(
    data(
      await call(worker, env, 'send_message', {
        chat_id: chat,
        message_thread_id: 70,
        text: 'Synthetic answer',
        idempotency_key: 'username-history',
      }),
    ).state,
    'sent',
  );
  for (const include_outgoing of [false, true]) {
    const history = data(
      await call(worker, env, 'get_recent_messages', {
        chat_id: chat,
        message_thread_id: 70,
        include_outgoing,
      }),
    ).messages;
    assert.deepEqual(
      history.filter((row) => row.sender_username).map((row) => row.sender_username),
      ['Topic_Seventy'],
    );
    assert.equal(history.length, include_outgoing ? 2 : 1);
    if (include_outgoing)
      assert.equal(
        Object.hasOwn(
          history.find((row) => row.role === 'bot'),
          'sender_username',
        ),
        false,
      );
  }
  const denied = await worker.fetch(
    rpc(
      'tools/call',
      { name: 'get_recent_messages', arguments: { chat_id: chat, message_thread_id: 70 } },
      'other-owner',
    ),
    env,
  );
  assert.equal(denied.status, 403);
  assert.equal(
    data(await call(worker, env, 'get_recent_messages', { chat_id: '10001' })).messages.length,
    0,
  );
  state.callbackStatus = 503;
  await worker.fetch(telegramRequest(incoming(44, 'Old_Epoch', { group: true, thread: 70 })), env);
  await call(worker, env, 'pause_group_access', { chat_id: chat });
  await call(worker, env, 'verify_group_access', { chat_id: chat });
  state.callbackStatus = 204;
  const before = state.events.length;
  await call(worker, env, 'retry_pending_events', { chat_id: chat });
  assert.equal(state.events.length, before);
  assert.deepEqual(
    data(
      await call(worker, env, 'get_recent_messages', {
        chat_id: chat,
        message_thread_id: 70,
        include_outgoing: true,
      }),
    ).messages,
    [],
  );
  env.TELEGRAM_ALLOWED_GROUPS = JSON.stringify({ [GROUP]: ['10001', '30003'] });
  assert.ok(
    (await call(worker, env, 'get_recent_messages', { chat_id: chat, message_thread_id: 70 })).body
      .error,
  );
});

test('schema-only migration leaves legacy rows unknown and pending legacy events deliver without usernames', async (t) => {
  const db = new TestDatabase(8);
  db.sqlite
    .prepare(
      'INSERT INTO inbox(event_id,bot_id,update_id,chat_id,sender_id,message_id,text,occurred_at,received_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'tg_123456_42',
      '123456',
      42,
      '10001',
      '10001',
      52,
      'Synthetic legacy text',
      new Date(NOW).toISOString(),
      NOW,
    );
  db.sqlite.exec(
    readFileSync(new URL('../drizzle/0008_sender_username.sql', import.meta.url), 'utf8'),
  );
  assert.equal(
    (await db.prepare('SELECT sender_username FROM inbox').first()).sender_username,
    null,
  );
  const { env, worker, state } = await fixture(t, { db });
  await call(worker, env, 'retry_pending_events', { chat_id: '10001' });
  assert.equal(state.events.length, 1);
  assert.equal(Object.hasOwn(state.events[0].data, 'sender_username'), false);
  for (const include_outgoing of [false, true]) {
    const history = data(
      await call(worker, env, 'get_recent_messages', { chat_id: '10001', include_outgoing }),
    ).messages;
    assert.equal(history.length, 1);
    assert.equal(Object.hasOwn(history[0], 'sender_username'), false);
  }
});

test('stored malformed usernames are omitted from events and history rather than trusted', async (t) => {
  const { env, worker, state } = await fixture(t);
  state.callbackStatus = 503;
  await worker.fetch(telegramRequest(incoming(42, 'Original_User')), env);
  await env.DB.prepare('UPDATE inbox SET sender_username=?').bind('Injected\nValue').run();
  state.callbackStatus = 204;
  await call(worker, env, 'retry_pending_events', { chat_id: '10001' });
  assert.equal(Object.hasOwn(state.events.at(-1).data, 'sender_username'), false);
  for (const include_outgoing of [false, true])
    assert.equal(
      Object.hasOwn(
        data(await call(worker, env, 'get_recent_messages', { chat_id: '10001', include_outgoing }))
          .messages[0],
        'sender_username',
      ),
      false,
    );
});

test('username snapshots expire and are physically cleaned up with their inbox messages', async (t) => {
  const { env, worker, state } = await fixture(t);
  await worker.fetch(telegramRequest(incoming(42, 'Expired_User')), env);
  state.time += 7 * 86400000 + 1;
  assert.deepEqual(
    data(await call(worker, env, 'get_recent_messages', { chat_id: '10001' })).messages,
    [],
  );
  assert.equal(
    (await env.DB.prepare('SELECT sender_username FROM inbox').first()).sender_username,
    'Expired_User',
  );
  const fresh = incoming(43, 'Fresh_User');
  fresh.message.date = Math.floor(state.time / 1000);
  await worker.fetch(telegramRequest(fresh), env);
  assert.deepEqual((await env.DB.prepare('SELECT sender_username FROM inbox').all()).results, [
    { sender_username: 'Fresh_User' },
  ]);
});
