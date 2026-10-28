import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker/index.js';
import { NOW, environment, call, rpc, update, telegramRequest, TestDatabase } from './helpers.mjs';
import { readFileSync } from 'node:fs';

const CHAT = '-1001234567890';
const base = {
  chat_id: '10001',
  message_id: 52,
  update_id: 42,
  reaction: '👀',
  idempotency_key: 'reaction-42-1',
};
const data = (result) => result.body.result?.structuredContent;
async function fixture(t, { group = false, forum = true } = {}) {
  const env = environment();
  t.after(() => env.DB.close());
  if (group) env.TELEGRAM_ALLOWED_GROUPS = JSON.stringify({ [CHAT]: ['10001', '20002'] });
  const state = { now: NOW, requests: [], mode: 'ok', gate: null, onCheck: null };
  const worker = createWorker({
    now: () => state.now,
    fetch: async (url, init) => {
      const method = new URL(url).pathname.split('/').at(-1),
        args = JSON.parse(init.body);
      if (method === 'getChat')
        return Response.json({
          ok: true,
          result: { id: Number(CHAT), type: 'supergroup', is_forum: forum },
        });
      if (method === 'getChatMember') {
        if (state.onCheck) await state.onCheck();
        return Response.json({
          ok: true,
          result: { user: { id: 123456, is_bot: true }, status: 'member' },
        });
      }
      state.requests.push({ method, args });
      if (state.gate) await state.gate;
      if (state.mode === 'throw') throw new Error('PRIVATE_UPSTREAM_DATA');
      if (state.mode === 'reject')
        return Response.json(
          { ok: false, error_code: 400, description: 'PRIVATE_UPSTREAM_DATA' },
          { status: 400 },
        );
      if (state.mode === 'redirect') return new Response(null, { status: 302 });
      if (state.mode === 'server')
        return Response.json(
          { ok: false, error_code: 500, description: 'PRIVATE_UPSTREAM_DATA' },
          { status: 500 },
        );
      if (state.mode === 'malformed')
        return Response.json({ ok: true, result: { message_id: 99 } });
      return Response.json({
        ok: true,
        result:
          method === 'sendMessage' ? { message_id: 99, chat: { id: Number(args.chat_id) } } : true,
      });
    },
  });
  if (group)
    assert.equal(
      data(await call(worker, env, 'verify_group_access', { chat_id: CHAT })).state,
      'active',
    );
  async function retain(id = 42, thread = 70, media = false) {
    const value = update(id);
    if (group) {
      value.message.chat = { id: Number(CHAT), type: 'supergroup', is_forum: forum };
      value.message.from.id = 20002;
      if (forum && thread !== 1) {
        value.message.is_topic_message = true;
        value.message.message_thread_id = thread;
      }
    }
    if (media) {
      delete value.message.text;
      value.message.photo = [{ file_id: 'synthetic', file_unique_id: 'synthetic_unique' }];
      value.message.media_group_id = 'synthetic_album';
    }
    await worker.fetch(telegramRequest(value), env);
  }
  await retain();
  const args = group
    ? { ...base, chat_id: CHAT, ...(forum ? { message_thread_id: 70 } : {}) }
    : base;
  return { env, worker, state, args, retain };
}

test('reaction add, update and clear are distinct durable operations; text send keys and coverage stay independent', async (t) => {
  const { env, worker, state, args } = await fixture(t);
  for (const [i, reaction] of ['👀', '👍', ''].entries()) {
    const request = { ...args, reaction, idempotency_key: 'reaction-' + i };
    for (let n = 0; n < 2; n++) {
      const result = await call(worker, env, 'set_message_reaction', request);
      assert.equal(data(result)?.state, 'applied');
      assert.equal(data(result).reused, n === 1);
      assert.equal(result.body.result.isError, false);
    }
  }
  assert.deepEqual(
    state.requests.map((r) => r.args),
    ['👀', '👍', ''].map((reaction) => ({
      chat_id: '10001',
      message_id: 52,
      reaction: reaction ? [{ type: 'emoji', emoji: reaction }] : [],
    })),
  );
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM outgoing').first()).n, 0);
  assert.equal(
    data(
      await call(worker, env, 'set_message_reaction', { ...args, idempotency_key: 'reaction-0' }),
    ).state,
    'applied',
  );
  assert.equal(state.requests.length, 3, 'Replaying an old success cannot replace the newer clear');
  const reply = {
    chat_id: '10001',
    text: 'The substantive answer',
    idempotency_key: args.idempotency_key,
  };
  assert.equal(data(await call(worker, env, 'send_message', reply)).state, 'sent');
  await call(worker, env, 'send_message', reply);
  assert.equal(state.requests.length, 4);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM sent_messages').first()).n, 1);
  assert.equal(
    (
      await call(worker, env, 'set_message_reaction', {
        ...args,
        reaction: '🔥',
        idempotency_key: 'reaction-0',
      })
    ).body.error.code,
    -32004,
  );
});

test('reaction rejects unsupported emoji, malformed arguments, nonowner and unretained exact identities', async (t) => {
  const { env, worker, state, args } = await fixture(t);
  for (const patch of [
    { reaction: '🙂' },
    { reaction: '👀👍' },
    { reaction: null },
    { reaction: [] },
    { reaction: { type: 'paid' } },
    { reaction: '❤️' },
    { chat_id: '999' },
    { message_id: 999 },
    { update_id: 43 },
    { message_id: 0 },
    { update_id: -1 },
    { message_thread_id: 80 },
    { idempotency_key: '' },
    { is_big: true },
  ]) {
    const result = await call(worker, env, 'set_message_reaction', { ...args, ...patch });
    assert.ok(result.body.error, JSON.stringify(patch));
    assert.equal(result.body.error.data.diagnostics.operation_state, 'not_started');
  }
  const response = await worker.fetch(
    rpc('tools/call', { name: 'set_message_reaction', arguments: args }, 'other'),
    env,
  );
  assert.equal(response.status, 403);
  assert.equal(state.requests.length, 0);
  await env.DB.prepare("UPDATE inbox SET sender_id='999'").run();
  assert.ok((await call(worker, env, 'set_message_reaction', args)).body.error);
});

test('retained album targets are rejected instead of accepting Telegram album redirection', async (t) => {
  const { env, worker, state, retain } = await fixture(t);
  await retain(43, 70, true);
  assert.ok(
    (await call(worker, env, 'set_message_reaction', { ...base, update_id: 43, message_id: 53 }))
      .body.error,
  );
  assert.equal(state.requests.length, 0);
});

test('malformed album IDs stay private and cannot bypass exact-target refusal', async (t) => {
  const { env, worker, state } = await fixture(t);
  for (const [id, media_group_id] of [
    [43, 'bad\n'],
    [44, {}],
    [45, 'x'.repeat(513)],
  ]) {
    const value = update(id);
    delete value.message.text;
    value.message.photo = [{ file_id: 'synthetic' }];
    value.message.media_group_id = media_group_id;
    await worker.fetch(telegramRequest(value), env);
    assert.equal(
      (await env.DB.prepare('SELECT reaction_album FROM inbox WHERE update_id=?').bind(id).first())
        .reaction_album,
      1,
    );
    assert.ok(
      (
        await call(worker, env, 'set_message_reaction', {
          ...base,
          message_id: id + 10,
          update_id: id,
        })
      ).body.error,
    );
  }
  assert.equal(state.requests.length, 0);
});

test('forum and General reactions require exact topic and current epoch; ordinary groups stay unthreaded', async (t) => {
  const { env, worker, state, args, retain } = await fixture(t, { group: true });
  await retain(43, 1);
  for (const patch of [
    { message_thread_id: undefined },
    { message_thread_id: 1 },
    { message_thread_id: 80 },
    { message_thread_id: 0 },
    { update_id: 43 },
  ])
    assert.ok((await call(worker, env, 'set_message_reaction', { ...args, ...patch })).body.error);
  assert.equal(data(await call(worker, env, 'set_message_reaction', args)).state, 'applied');
  const general = {
    ...args,
    message_id: 53,
    update_id: 43,
    message_thread_id: 1,
    idempotency_key: 'general',
  };
  assert.equal(data(await call(worker, env, 'set_message_reaction', general)).state, 'applied');
  assert.deepEqual(
    state.requests.map((r) => r.args.message_id),
    [52, 53],
  );
  assert.ok(state.requests.every((r) => !Object.hasOwn(r.args, 'message_thread_id')));
  await call(worker, env, 'pause_group_access', { chat_id: CHAT });
  assert.ok((await call(worker, env, 'set_message_reaction', args)).body.error);
  await call(worker, env, 'verify_group_access', { chat_id: CHAT });
  assert.ok(
    (await call(worker, env, 'set_message_reaction', { ...args, idempotency_key: 'new-epoch' }))
      .body.error,
  );
  const ordinary = await fixture(t, { group: true, forum: false });
  assert.equal(
    data(await call(ordinary.worker, ordinary.env, 'set_message_reaction', ordinary.args)).state,
    'applied',
  );
});

test('revocation or expiry rejects even a recorded success and final dispatch checks reject races', async (t) => {
  const { env, worker, state, args } = await fixture(t);
  await call(worker, env, 'set_message_reaction', args);
  env.TELEGRAM_ALLOWED_USER_IDS = '999';
  assert.ok((await call(worker, env, 'set_message_reaction', args)).body.error);
  env.TELEGRAM_ALLOWED_USER_IDS = '10001';
  state.now += 8 * 86400000;
  assert.ok((await call(worker, env, 'set_message_reaction', args)).body.error);
  assert.equal(state.requests.length, 1);
  const group = await fixture(t, { group: true });
  group.state.onCheck = async () => {
    await call(group.worker, group.env, 'pause_group_access', { chat_id: CHAT });
  };
  assert.ok((await call(group.worker, group.env, 'set_message_reaction', group.args)).body.error);
  assert.equal(group.state.requests.length, 0);
});

test('same-key and different-key concurrent operations cannot race on a reaction target', async (t) => {
  const { env, worker, state, args } = await fixture(t);
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  state.gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  // Resolve readiness from the held transport without timing assumptions.
  state.requests.push = (entry) => {
    Array.prototype.push.call(state.requests, entry);
    started();
  };
  const pending = call(worker, env, 'set_message_reaction', args);
  await ready;
  assert.equal(data(await call(worker, env, 'set_message_reaction', args)).state, 'applying');
  const busy = await call(worker, env, 'set_message_reaction', {
    ...args,
    reaction: '👍',
    idempotency_key: 'competing',
  });
  assert.equal(busy.body.error.code, -32003);
  assert.equal(busy.body.error.data.diagnostics.operation_state, 'not_started');
  release();
  assert.equal(data(await pending).state, 'applied');
  assert.equal(state.requests.length, 1);
});

for (const mode of ['throw', 'redirect', 'server', 'malformed', 'reject'])
  test('reaction ' + mode + ' is durable, redacted and never retried or replaced', async (t) => {
    const { env, worker, state, args } = await fixture(t);
    state.mode = mode;
    for (let i = 0; i < 2; i++) {
      const result = await call(worker, env, 'set_message_reaction', args);
      assert.equal(data(result).state, mode === 'reject' ? 'failed' : 'uncertain');
      assert.equal(result.body.result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UPSTREAM_DATA/);
      assert.equal(data(result).diagnostics.operation_state, data(result).state);
      assert.equal(data(result).diagnostics.retry.safe, false);
    }
    assert.equal(state.requests.length, 1);
    if (mode !== 'reject')
      assert.equal(
        (
          await call(worker, env, 'set_message_reaction', {
            ...args,
            reaction: '',
            idempotency_key: 'bypass',
          })
        ).body.error.code,
        -32003,
      );
  });

test('interrupted reaction becomes uncertain and cleanup expires operation metadata after thirty days', async (t) => {
  const { env, worker, state, args } = await fixture(t);
  await call(worker, env, 'set_message_reaction', args);
  await env.DB.prepare("UPDATE reaction_operations SET state='applying',updated_at=?")
    .bind(NOW - 31000)
    .run();
  assert.equal(data(await call(worker, env, 'get_connector_status')).uncertain_reactions, 1);
  assert.equal(data(await call(worker, env, 'set_message_reaction', args)).state, 'uncertain');
  assert.equal(state.requests.length, 1);
  assert.equal(data(await call(worker, env, 'get_connector_status')).uncertain_reactions, 1);
  state.now += 31 * 86400000;
  await call(worker, env, 'set_message_reaction', args);
  assert.equal(
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM reaction_operations').first()).n,
    0,
  );
});

test('uncertain reaction does not suppress a later substantive answer', async (t) => {
  const { env, worker, state, args } = await fixture(t);
  state.mode = 'throw';
  assert.equal(data(await call(worker, env, 'set_message_reaction', args)).state, 'uncertain');
  state.mode = 'ok';
  assert.equal(
    data(
      await call(worker, env, 'send_message', {
        chat_id: args.chat_id,
        text: 'An independently authorized answer',
        idempotency_key: 'tg-chat:v3:10001:52:reply:1',
      }),
    ).state,
    'sent',
  );
  assert.deepEqual(
    state.requests.map((r) => r.method),
    ['setMessageReaction', 'sendMessage'],
  );
});

test('exact chat and bot context cannot be substituted even when another destination is approved', async (t) => {
  const { env, worker, state, args } = await fixture(t);
  env.TELEGRAM_ALLOWED_CHAT_IDS = '10001,20002';
  env.TELEGRAM_ALLOWED_USER_IDS = '10001,20002';
  assert.ok(
    (await call(worker, env, 'set_message_reaction', { ...args, chat_id: '20002' })).body.error,
  );
  env.TELEGRAM_BOT_TOKEN = '654321:synthetic-other-bot';
  assert.ok((await call(worker, env, 'set_message_reaction', args)).body.error);
  assert.equal(state.requests.length, 0);
});

test('final retained-target check prevents dispatch after reservation races', async (t) => {
  const { env, worker, state, args } = await fixture(t),
    original = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const statement = original(sql);
    if (!sql.startsWith('INSERT INTO reaction_operations')) return statement;
    return {
      bind(...values) {
        const bound = statement.bind(...values);
        return {
          ...bound,
          async run() {
            const result = await bound.run();
            await original("UPDATE inbox SET last_error='access_revoked'").run();
            return result;
          },
        };
      },
    };
  };
  assert.ok((await call(worker, env, 'set_message_reaction', args)).body.error);
  assert.equal(state.requests.length, 0);
  assert.equal((await original('SELECT state FROM reaction_operations').first()).state, 'failed');
  await original('UPDATE inbox SET last_error=NULL').run();
  const replay = await call(worker, env, 'set_message_reaction', args);
  assert.equal(data(replay).state, 'failed');
  assert.equal(data(replay).error, 'target_access_changed');
  assert.equal(data(replay).diagnostics.category, 'permission');
  assert.equal(data(replay).diagnostics.reason, 'reaction_access_changed');
  assert.equal(state.requests.length, 0);
});

test('additive reaction migration preserves preexisting inbox and send idempotency records', (t) => {
  const db = new TestDatabase(6);
  t.after(() => db.close());
  db.sqlite.exec(
    "INSERT INTO outgoing VALUES ('synthetic-existing-key','synthetic-hash','10001','sent',99,NULL,1,1)",
  );
  db.sqlite.exec(
    "INSERT INTO inbox(event_id,bot_id,update_id,chat_id,sender_id,message_id,text,occurred_at,received_at) VALUES ('synthetic-event','123456',42,'10001','10001',52,'Synthetic text','2026-10-23T12:00:00Z',1)",
  );
  db.sqlite.exec(
    `INSERT INTO inbox(event_id,bot_id,update_id,chat_id,sender_id,message_id,text,occurred_at,received_at,media_json) VALUES ('legacy-media','123456',43,'10001','10001',53,'[Telegram photo message]','2026-10-23T12:00:00Z',1,'{"type":"photo"}')`,
  );
  const before = db.sqlite.prepare('SELECT * FROM outgoing').get();
  db.sqlite.exec(
    readFileSync(new URL('../drizzle/0006_message_reactions.sql', import.meta.url), 'utf8'),
  );
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM outgoing').get(), before);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reaction_operations').get().n, 0);
  assert.equal(
    db.sqlite.prepare("SELECT text FROM inbox WHERE event_id='synthetic-event'").get().text,
    'Synthetic text',
  );
  assert.equal(
    db.sqlite.prepare("SELECT reaction_album FROM inbox WHERE event_id='synthetic-event'").get()
      .reaction_album,
    -1,
  );
  assert.equal(
    db.sqlite
      .prepare("SELECT media_json,reaction_album FROM inbox WHERE event_id='legacy-media'")
      .get().reaction_album,
    -1,
  );
  assert.equal(
    db.sqlite.prepare("SELECT media_json FROM inbox WHERE event_id='legacy-media'").get()
      .media_json,
    '{"type":"photo"}',
  );
});
