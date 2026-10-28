import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker/index.js';
import { normalizedUpdate } from '../worker/intake.ts';
import {
  NOW,
  environment,
  call,
  rpc,
  subscription,
  challengeResponse,
  update,
  telegramRequest,
  verifySignature,
} from './helpers.mjs';

const CHAT = '10001';
const data = (result) => result.body.result?.structuredContent;
const send = {
  chat_id: CHAT,
  text: 'Synthetic topic answer',
  idempotency_key: 'private-topic',
  message_thread_id: 70,
};
function incoming(id, thread) {
  const value = update(id);
  if (thread !== undefined) {
    value.message.message_thread_id = thread;
    value.message.is_topic_message = true;
  }
  return value;
}
async function fixture(t) {
  const env = environment();
  t.after(() => env.DB.close());
  const state = {
    events: [],
    sends: [],
    reactions: [],
    mode: 'ok',
    callbackStatus: 204,
    nextId: 500,
  };
  const worker = createWorker({
    now: () => NOW,
    fetch: async (url, init) => {
      const args = JSON.parse(init.body);
      const method = new URL(url).pathname.split('/').at(-1);
      if (args.type === 'verification') return challengeResponse(init);
      if (args.name === 'telegram.message.received') {
        assert.equal(verifySignature(init), true);
        assert.equal(init.redirect, 'manual');
        state.events.push(args);
        return new Response(null, { status: state.callbackStatus });
      }
      if (method === 'setMessageReaction') {
        state.reactions.push(args);
        return Response.json({ ok: true, result: true });
      }
      assert.equal(method, 'sendMessage');
      state.sends.push(args);
      if (state.mode === 'throw') throw new Error('Synthetic ambiguity');
      if (state.mode === 'reject')
        return Response.json(
          { ok: false, error_code: 400, description: 'Synthetic topic rejection' },
          { status: 400 },
        );
      const thread = state.mode === 'wrong' ? 80 : args.message_thread_id;
      return Response.json({
        ok: true,
        result: {
          message_id: state.nextId++,
          chat: { id: Number(args.chat_id) },
          ...(thread !== undefined && thread !== 1 && state.mode !== 'missing'
            ? { message_thread_id: thread, is_topic_message: true }
            : {}),
        },
      });
    },
  });
  assert.ok(
    (await (await worker.fetch(rpc('events/subscribe', subscription()), env)).json()).result.id,
  );
  return { env, worker, state };
}

test('private topics survive normalization, storage, signed event retries and concurrent duplicates', async (t) => {
  const { env, worker, state } = await fixture(t);
  const value = incoming(42, 70);
  assert.equal(normalizedUpdate(value, env, NOW).message_thread_id, 70);
  state.callbackStatus = 503;
  await worker.fetch(telegramRequest(value), env);
  state.callbackStatus = 204;
  await call(worker, env, 'retry_pending_events', { chat_id: CHAT });
  await Promise.all(Array.from({ length: 5 }, () => worker.fetch(telegramRequest(value), env)));
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events[0], state.events[1]);
  assert.equal(state.events[0].data.message_thread_id, 70);
  await worker.fetch(telegramRequest(incoming(43, 80)), env);
  await worker.fetch(telegramRequest(incoming(44)), env);
  const noFlag = incoming(45, 1);
  delete noFlag.message.is_topic_message;
  await worker.fetch(telegramRequest(noFlag), env);
  assert.equal(state.events.at(-1).data.message_thread_id, 1);
  assert.equal(state.events[3].data.message_thread_id, undefined);
  assert.deepEqual(
    (await env.DB.prepare('SELECT message_thread_id FROM inbox ORDER BY update_id').all()).results,
    [
      { message_thread_id: 70 },
      { message_thread_id: 80 },
      { message_thread_id: null },
      { message_thread_id: 1 },
    ],
  );
});

test('private history isolates incoming and confirmed bot text by exact topic, including omitted fallback', async (t) => {
  const { env, worker } = await fixture(t);
  for (const [id, thread] of [
    [42, 70],
    [43, 80],
    [44, undefined],
    [45, 1],
  ]) {
    await worker.fetch(telegramRequest(incoming(id, thread)), env);
    const args = { ...send, idempotency_key: 'history-' + id };
    if (thread === undefined) delete args.message_thread_id;
    else args.message_thread_id = thread;
    assert.equal(data(await call(worker, env, 'send_message', args)).state, 'sent');
  }
  for (const thread of [70, 80, undefined, 1]) {
    const args = { chat_id: CHAT, ...(thread !== undefined ? { message_thread_id: thread } : {}) };
    for (const include_outgoing of [false, true]) {
      const messages = data(
        await call(worker, env, 'get_recent_messages', { ...args, include_outgoing }),
      ).messages;
      const general = thread === 1 || thread === undefined;
      assert.equal(messages.length, (include_outgoing ? 2 : 1) * (general ? 2 : 1));
      for (const message of messages) assert.equal(message.message_thread_id ?? 1, thread ?? 1);
      if (include_outgoing)
        assert.deepEqual(
          messages.map((m) => m.role),
          general ? ['bot', 'bot', 'user', 'user'] : ['bot', 'user'],
        );
    }
  }
});

test('private topic sends are unquoted, preserve ID 1, dispatch once and freeze topic identity', async (t) => {
  const { env, worker, state } = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => call(worker, env, 'send_message', send)),
  );
  assert.ok(results.every((r) => ['sent', 'sending'].includes(data(r).state)));
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].message_thread_id, 70);
  assert.equal(state.sends[0].reply_parameters, undefined);
  for (const patch of [
    { message_thread_id: 80 },
    { message_thread_id: undefined },
    { text: 'Changed' },
  ])
    assert.equal(
      (await call(worker, env, 'send_message', { ...send, ...patch })).body.error.code,
      -32004,
    );
  assert.equal(
    data(
      await call(worker, env, 'send_message', {
        ...send,
        idempotency_key: 'private-one',
        message_thread_id: 1,
      }),
    ).state,
    'sent',
  );
  assert.equal(state.sends[1].message_thread_id, 1);
});

test('private invalid, missing and unexpected send destinations never fall back or resend', async (t) => {
  const { env, worker, state } = await fixture(t);
  for (const mode of ['wrong', 'missing', 'throw', 'reject']) {
    state.mode = mode;
    const args = { ...send, idempotency_key: 'failure-' + mode };
    const result = data(await call(worker, env, 'send_message', args));
    assert.equal(result.state, mode === 'reject' ? 'failed' : 'uncertain');
    assert.equal(data(await call(worker, env, 'send_message', args)).reused, true);
    assert.equal(
      (await call(worker, env, 'send_message', { ...args, message_thread_id: 80 })).body.error.code,
      -32004,
    );
  }
  const unthreaded = { ...send, idempotency_key: 'unexpected-topic' };
  delete unthreaded.message_thread_id;
  state.mode = 'wrong';
  assert.equal(data(await call(worker, env, 'send_message', unthreaded)).state, 'uncertain');
  assert.equal(state.sends.length, 5);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM sent_messages').first()).n, 0);
});

test('private topic quote targets must be retained in the exact context, never cross topic or omitted', async (t) => {
  const { env, worker, state } = await fixture(t);
  for (const [id, thread] of [
    [42, 70],
    [43, 80],
    [44, undefined],
  ])
    await worker.fetch(telegramRequest(incoming(id, thread)), env);
  for (const patch of [
    { reply_to_message_id: 53 },
    { reply_to_message_id: 54 },
    { reply_to_message_id: 999 },
    { reply_to_message_id: 52, message_thread_id: undefined },
    { reply_to_message_id: 52, message_thread_id: 80 },
  ])
    assert.ok((await call(worker, env, 'send_message', { ...send, ...patch })).body.error);
  assert.equal(state.sends.length, 0);
  assert.equal(
    data(await call(worker, env, 'send_message', { ...send, reply_to_message_id: 52 })).state,
    'sent',
  );
  assert.deepEqual(state.sends[0].reply_parameters, {
    message_id: 52,
    allow_sending_without_reply: false,
  });
  assert.equal(
    data(
      await call(worker, env, 'send_message', {
        ...send,
        idempotency_key: 'quote-bot',
        reply_to_message_id: 500,
      }),
    ).state,
    'sent',
  );
  const plain = { ...send, idempotency_key: 'plain-quote', reply_to_message_id: 54 };
  delete plain.message_thread_id;
  assert.equal(data(await call(worker, env, 'send_message', plain)).state, 'sent');
});

test('private topics retain webhook, sender and owner gates; malformed topic context never enters storage', async (t) => {
  const { env, worker, state } = await fixture(t);
  assert.equal((await worker.fetch(telegramRequest(incoming(42, 70), 'wrong'), env)).status, 401);
  for (const mutate of [
    (m) => {
      m.from.id = 20002;
    },
    (m) => {
      m.from.is_bot = true;
    },
    (m) => {
      m.sender_chat = { id: 10001 };
    },
    (m) => {
      m.chat.id = 20002;
    },
  ]) {
    const value = incoming(42, 70);
    mutate(value.message);
    assert.equal((await worker.fetch(telegramRequest(value), env)).status, 200);
  }
  for (const thread of [0, -1, 1.5, '70', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await worker.fetch(telegramRequest(incoming(42, thread)), env)).status, 400);
    assert.ok(
      (await call(worker, env, 'send_message', { ...send, message_thread_id: thread })).body.error,
    );
    assert.ok(
      (await call(worker, env, 'get_recent_messages', { chat_id: CHAT, message_thread_id: thread }))
        .body.error,
    );
  }
  for (const patch of [
    { is_topic_message: true },
    { is_topic_message: 'true', message_thread_id: 70 },
  ]) {
    const value = incoming(42);
    Object.assign(value.message, patch);
    assert.equal((await worker.fetch(telegramRequest(value), env)).status, 400);
  }
  for (const caller of ['', 'outsider']) {
    const response = await worker.fetch(
      rpc('tools/call', { name: 'send_message', arguments: send }, caller),
      env,
    );
    assert.equal((await response.json()).error.code, -32001);
  }
  assert.equal(state.events.length, 0);
  assert.equal(state.sends.length, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 0);
});

test('private topic media and reactions require exact retained context and current sender approval', async (t) => {
  const { env, worker, state } = await fixture(t);
  const value = incoming(42, 70);
  delete value.message.text;
  value.message.document = { file_id: 'synthetic_document', file_unique_id: 'synthetic_unique' };
  await worker.fetch(telegramRequest(value), env);
  const target = { chat_id: CHAT, message_id: 52, update_id: 42 };
  const reaction = { ...target, reaction: '', idempotency_key: 'private-reaction' };
  for (const message_thread_id of [undefined, 80]) {
    assert.ok(
      (await call(worker, env, 'get_message_media', { ...target, message_thread_id })).body.error,
    );
    assert.ok(
      (await call(worker, env, 'set_message_reaction', { ...reaction, message_thread_id })).body
        .error,
    );
  }
  assert.equal(
    data(
      await call(worker, env, 'get_message_media', {
        ...target,
        message_thread_id: 70,
        mode: 'auto',
      }),
    ).state,
    'on_demand_required',
  );
  assert.equal(
    data(await call(worker, env, 'set_message_reaction', { ...reaction, message_thread_id: 70 }))
      .state,
    'applied',
  );
  assert.equal(state.reactions.length, 1);
  env.TELEGRAM_ALLOWED_USER_IDS = '20002';
  for (const [name, args] of [
    ['get_recent_messages', { chat_id: CHAT, message_thread_id: 70 }],
    ['get_message_media', { ...target, message_thread_id: 70 }],
    ['set_message_reaction', { ...reaction, message_thread_id: 70, idempotency_key: 'revoked' }],
    ['send_message', send],
  ])
    assert.ok((await call(worker, env, name, args)).body.error);
  assert.equal(state.reactions.length, 1);
});

test('private General reaction aliases share retained context but preserve frozen request arguments', async (t) => {
  const { env, worker, state } = await fixture(t);
  await worker.fetch(telegramRequest(incoming(42)), env);
  const args = {
    chat_id: CHAT,
    message_id: 52,
    update_id: 42,
    reaction: '',
    idempotency_key: 'general-reaction',
    message_thread_id: 1,
  };
  assert.equal(data(await call(worker, env, 'set_message_reaction', args)).state, 'applied');
  assert.equal(data(await call(worker, env, 'set_message_reaction', args)).reused, true);
  assert.equal(
    (await call(worker, env, 'set_message_reaction', { ...args, message_thread_id: undefined }))
      .body.error.code,
    -32004,
  );
  assert.equal(state.reactions.length, 1);
  const quote = { ...send, message_thread_id: 1, reply_to_message_id: 52 };
  assert.equal(data(await call(worker, env, 'send_message', quote)).state, 'sent');
  assert.equal(
    (await call(worker, env, 'send_message', { ...quote, message_thread_id: undefined })).body.error
      .code,
    -32004,
  );
});
