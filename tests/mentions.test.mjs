import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createWorker } from '../worker/index.js';
import { NOW, TestDatabase, environment, rpc, call, update, telegramRequest } from './helpers.mjs';

const GROUP = '-1001234567890';
const OTHER = '-1009876543210';
const DAY = 86400000;
const data = (result) => result.body.result?.structuredContent;
const mention = (user_id = '20002', offset = 0, length = 3) => ({ user_id, offset, length });
const args = (overrides = {}) => ({
  chat_id: GROUP,
  message_thread_id: 70,
  text: 'Two',
  mentions: [mention()],
  idempotency_key: 'synthetic-mention',
  ...overrides,
});

async function fixture(t, { forum = true } = {}) {
  const env = environment();
  t.after(() => env.DB.close());
  env.TELEGRAM_ALLOWED_GROUPS = JSON.stringify({
    [GROUP]: ['10001', '20002'],
    [OTHER]: ['10001', '20002'],
  });
  const state = { time: NOW, sends: [], failure: null, hook: null, wrongThread: false };
  const worker = createWorker({
    now: () => state.time,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      const method = new URL(url).pathname.split('/').at(-1);
      if (state.hook) await state.hook(method, body);
      let result;
      if (method === 'getChat')
        result = { id: Number(body.chat_id), type: 'supergroup', is_forum: forum };
      else if (method === 'getChatMember') {
        assert.equal(body.user_id, 123456, 'Only bot-self access may be inspected');
        result = { user: { id: 123456, is_bot: true }, status: 'administrator' };
      } else if (method === 'sendMessage') {
        state.sends.push(body);
        if (state.failure === 'network') throw new Error('Synthetic uncertain send');
        if (state.failure === 'rejected')
          return Response.json(
            { ok: false, error_code: 400, description: 'Synthetic rejection' },
            { status: 400 },
          );
        result = {
          message_id: 500 + state.sends.length,
          date: NOW / 1000,
          chat: { id: Number(body.chat_id) },
          text: body.text,
          ...(body.message_thread_id
            ? {
                message_thread_id: state.wrongThread ? 99 : body.message_thread_id,
                is_topic_message: true,
              }
            : {}),
        };
      } else throw new Error(`Unexpected method ${method}`);
      return Response.json({ ok: true, result });
    },
  });
  for (const chat_id of [GROUP, OTHER])
    assert.equal(data(await call(worker, env, 'verify_group_access', { chat_id })).state, 'active');
  let id = 100;
  async function receive({
    chat = GROUP,
    sender = '20002',
    thread = forum ? 70 : undefined,
    extra = {},
  } = {}) {
    const event = update(++id);
    event.message.chat = {
      id: Number(chat),
      type: chat.startsWith('-') ? 'supergroup' : 'private',
      ...(chat.startsWith('-') && forum ? { is_forum: true } : {}),
    };
    event.message.from.id = Number(sender);
    if (thread !== undefined)
      Object.assign(event.message, { message_thread_id: thread, is_topic_message: thread !== 1 });
    Object.assign(event.message, extra);
    await worker.fetch(telegramRequest(event), env);
  }
  return { env, worker, state, receive };
}

test('authorized username-free mentions use UTF-16 inline entities and retain literal labels', async (t) => {
  const { env, worker, state, receive } = await fixture(t);
  await receive();
  await receive({ sender: '10001' });
  const text = '\u{1f600} Two <a href="tg://user?id=999">One</a> *literal*';
  const mentions = [mention('20002', 3, 3), mention('10001', 7, 34)];
  const result = await call(
    worker,
    env,
    'send_message',
    args({ text, mentions: [...mentions].reverse() }),
  );
  assert.equal(data(result)?.state, 'sent');
  assert.deepEqual(data(result).mentions, mentions);
  assert.deepEqual(state.sends, [
    {
      chat_id: GROUP,
      message_thread_id: 70,
      text,
      link_preview_options: { is_disabled: true },
      entities: [
        { type: 'text_link', offset: 3, length: 3, url: 'tg://user?id=20002' },
        { type: 'text_link', offset: 7, length: 34, url: 'tg://user?id=10001' },
      ],
    },
  ]);
  const stored = await env.DB.prepare('SELECT mentions_json FROM outgoing').first();
  assert.deepEqual(JSON.parse(stored.mentions_json), mentions);
  const history = data(
    await call(worker, env, 'get_recent_messages', {
      chat_id: GROUP,
      message_thread_id: 70,
      include_outgoing: true,
    }),
  );
  assert.deepEqual(history.messages.find((m) => m.role === 'bot').mentions, mentions);
  assert.equal(history.messages.find((m) => m.role === 'bot').text, text);
  const hidden = data(
    await call(worker, env, 'get_recent_messages', {
      chat_id: GROUP,
      message_thread_id: 71,
      include_outgoing: true,
    }),
  );
  assert.deepEqual(hidden.messages, []);
});

test('mention validation rejects malformed IDs, shapes, overlaps and UTF-16 splits before sends', async (t) => {
  const { env, worker, state, receive } = await fixture(t);
  await receive();
  const invalid = [
    null,
    {},
    'Two',
    Array(21).fill(mention()),
    [null],
    ...['0', '-1', '020002', '9007199254740992', 20002, '20002&x=1', '@Two'].map((id) => [
      mention(id),
    ]),
    [mention('20002', -1)],
    [mention('20002', 0.5)],
    [mention('20002', 0, 0)],
    [mention('20002', 0, 99)],
    [mention('20002', 1, 1)],
    [mention('20002', 0, 1)],
    [mention('20002', 3, 1), mention('20002', 3, 2)],
    [{ ...mention(), url: 'https://injection.example' }],
    [{ user_id: '20002', offset: 3 }],
    [mention('20002', Number.MAX_SAFE_INTEGER, 2)],
    [mention('20002', 3, -1)],
  ];
  for (const mentions of invalid) {
    const result = await call(
      worker,
      env,
      'send_message',
      args({ text: '\u{1f600}Two', mentions }),
    );
    assert.ok(result.body.error, JSON.stringify(mentions));
  }
  assert.equal(state.sends.length, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM outgoing').first()).n, 0);
  for (const text of ['\ud800Two', '\udc00Two', '   ']) {
    assert.ok(
      (await call(worker, env, 'send_message', args({ text, mentions: [mention('20002', 0, 1)] })))
        .body.error,
    );
  }
});

test('unknown, forwarded and cross-chat/topic targets cannot supply mention provenance', async (t) => {
  const { env, worker, state, receive } = await fixture(t);
  await receive({ chat: OTHER });
  await receive({ thread: 71 });
  await receive({
    sender: '10001',
    extra: {
      forward_origin: {
        type: 'user',
        sender_user: { id: 20002, is_bot: false, first_name: 'Two' },
      },
      text: '20002 @Two',
    },
  });
  for (const user_id of ['20002', '30003', '123456']) {
    const result = await call(worker, env, 'send_message', args({ mentions: [mention(user_id)] }));
    assert.equal(result.body.error?.code, -32001);
  }
  assert.equal(state.sends.length, 0);
  await receive();
  assert.equal(data(await call(worker, env, 'send_message', args()))?.state, 'sent');
});

test('mentions require current retained provenance, approvals and bot identity', async (t) => {
  for (const mutation of ['expired', 'epoch', 'bot', 'revoked', 'sender']) {
    await t.test(mutation, async (t) => {
      const { env, worker, state, receive } = await fixture(t);
      await receive();
      if (mutation === 'expired')
        await env.DB.prepare('UPDATE inbox SET received_at=?')
          .bind(NOW - 7 * DAY - 1)
          .run();
      if (mutation === 'epoch')
        await env.DB.prepare('UPDATE inbox SET group_revision=group_revision-1').run();
      if (mutation === 'bot') await env.DB.prepare("UPDATE inbox SET bot_id='654321'").run();
      if (mutation === 'revoked')
        await env.DB.prepare("UPDATE inbox SET last_error='group_access_revoked'").run();
      if (mutation === 'sender')
        env.TELEGRAM_ALLOWED_GROUPS = JSON.stringify({ [GROUP]: ['10001', '30003'] });
      const result = await call(worker, env, 'send_message', args());
      assert.ok(result.body.error?.code === -32001 || data(result)?.state === 'failed');
      assert.equal(state.sends.length, 0);
    });
  }
});

test('normalized mentions freeze target, range, text, routing and reply across success reuse', async (t) => {
  const { env, worker, state, receive } = await fixture(t);
  await receive();
  await receive({ sender: '10001' });
  const original = args({ text: 'Two One', mentions: [mention(), mention('10001', 4, 3)] });
  assert.equal(data(await call(worker, env, 'send_message', original))?.state, 'sent');
  const replay = await call(worker, env, 'send_message', {
    ...original,
    mentions: [...original.mentions].reverse(),
  });
  assert.equal(data(replay).reused, true);
  for (const change of [
    { mentions: [mention('10001'), mention('10001', 4, 3)] },
    { mentions: [mention('20002', 1, 2), mention('10001', 4, 3)] },
    { text: 'Two Two' },
    { message_thread_id: 71 },
    { reply_to_message_id: 500 },
    { mentions: [] },
    { chat_id: OTHER },
  ]) {
    assert.equal(
      (await call(worker, env, 'send_message', { ...original, ...change })).body.error?.code,
      -32004,
    );
  }
  assert.equal(state.sends.length, 1);
});

test(
  'concurrent mention sends reserve once and stale sending records stay uncertain',
  { timeout: 5000 },
  async (t) => {
    const { env, worker, state, receive } = await fixture(t);
    await receive();
    let entered, release;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    state.hook = async (method) => {
      if (method === 'sendMessage') {
        entered();
        await gate;
      }
    };
    const pending = call(worker, env, 'send_message', args());
    await started;
    const duplicates = await Promise.all(
      Array.from({ length: 5 }, () => call(worker, env, 'send_message', args())),
    );
    assert.ok(duplicates.every((r) => data(r).state === 'sending' && data(r).reused));
    state.time += 31000;
    assert.equal(data(await call(worker, env, 'send_message', args())).state, 'uncertain');
    release();
    assert.equal(data(await pending).state, 'uncertain');
    assert.equal(state.sends.length, 1);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM sent_messages').first()).n, 0);
  },
);

test('provenance loss or group revocation after reservation prevents mention dispatch', async (t) => {
  for (const revoke of ['target', 'group']) {
    await t.test(revoke, async (t) => {
      const { env, worker, state, receive } = await fixture(t);
      await receive();
      const prepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql) => {
        const statement = prepare(sql);
        if (!sql.startsWith('INSERT INTO outgoing')) return statement;
        return {
          ...statement,
          bind(...values) {
            const bound = statement.bind(...values);
            return {
              ...bound,
              async run() {
                const result = await bound.run();
                if (revoke === 'target') await prepare('DELETE FROM inbox').run();
                else
                  await prepare("UPDATE group_access SET state='paused',revision=revision+1").run();
                return result;
              },
            };
          },
        };
      };
      const result = await call(worker, env, 'send_message', args());
      const error = revoke === 'target' ? 'mention_access_changed' : 'group_access_blocked';
      assert.equal(result.body.error, undefined);
      assert.equal(result.body.result.isError, true);
      assert.deepEqual(
        { ...data(result), diagnostics: undefined },
        {
          state: 'failed',
          message_id: null,
          reused: false,
          requires_review: true,
          error,
          mentions: [mention()],
          diagnostics: undefined,
        },
      );
      assert.equal(data(result).diagnostics.operation_state, 'failed');
      assert.equal(data(result).diagnostics.category, 'permission');
      assert.deepEqual(data(result).diagnostics.retry, {
        safe: false,
        action: 'reconcile_privately',
      });
      const stored = await prepare('SELECT * FROM outgoing').first();
      assert.equal(stored.state, 'failed');
      assert.equal(stored.error_code, error);
      const replay = data(await call(worker, env, 'send_message', args()));
      assert.equal(replay.state, 'failed');
      assert.equal(replay.error, error);
      assert.equal(replay.reused, true);
      assert.equal(replay.diagnostics.operation_state, 'failed');
      assert.equal(
        (await call(worker, env, 'send_message', args({ mentions: [] }))).body.error?.code,
        -32004,
      );
      assert.deepEqual(JSON.parse(stored.mentions_json), [mention()]);
      assert.equal(state.sends.length, 0);
    });
  }
});

test('malformed stored mentions are omitted without aborting or fabricating history metadata', async (t) => {
  const { env, worker, state, receive } = await fixture(t);
  await receive();
  assert.equal(data(await call(worker, env, 'send_message', args())).state, 'sent');
  assert.equal(
    data(await call(worker, env, 'send_message', args({ idempotency_key: 'healthy-history-row' })))
      .state,
    'sent',
  );
  for (const damaged of [
    '{',
    'null',
    '{}',
    '"untrusted"',
    JSON.stringify([mention('20002', 0, 99)]),
    JSON.stringify([mention(), mention('20002&other=1', 0, 1)]),
    JSON.stringify([mention(), mention('10001', 1, 1)]),
  ]) {
    await env.DB.prepare('UPDATE sent_messages SET mentions_json=? WHERE message_id=501')
      .bind(damaged)
      .run();
    const result = await call(worker, env, 'get_recent_messages', {
      chat_id: GROUP,
      message_thread_id: 70,
      include_outgoing: true,
    });
    assert.equal(result.body.error, undefined, damaged);
    const history = data(result).messages;
    assert.equal(history.length, 3);
    const corrupt = history.find((message) => message.message_id === 501);
    assert.equal(corrupt.text, 'Two');
    assert.equal(Object.hasOwn(corrupt, 'mentions'), false);
    assert.deepEqual(history.find((message) => message.message_id === 502).mentions, [mention()]);
    assert.equal(
      history.some((message) => Object.hasOwn(message, 'mentions_json')),
      false,
    );
    assert.equal(
      (await env.DB.prepare('SELECT mentions_json FROM sent_messages WHERE message_id=501').first())
        .mentions_json,
      damaged,
    );
  }
  assert.equal(state.sends.length, 2);
});

test('uncertain, rejected and mismatched-topic mention sends never fallback or resend', async (t) => {
  for (const failure of ['network', 'rejected', 'topic']) {
    await t.test(failure, async (t) => {
      const { env, worker, state, receive } = await fixture(t);
      await receive();
      state.failure = failure;
      state.wrongThread = failure === 'topic';
      const first = data(await call(worker, env, 'send_message', args()));
      assert.equal(first.state, failure === 'rejected' ? 'failed' : 'uncertain');
      assert.deepEqual(first.mentions, [mention()]);
      const replay = data(await call(worker, env, 'send_message', args()));
      assert.equal(replay.state, first.state);
      assert.equal(replay.reused, true);
      assert.equal(
        (await call(worker, env, 'send_message', args({ mentions: [] }))).body.error?.code,
        -32004,
      );
      assert.equal(state.sends.length, 1);
      assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM sent_messages').first()).n, 0);
    });
  }
});

test('private named topics, General equivalence and nonforum groups retain mention routing', async (t) => {
  const { env, worker, state, receive } = await fixture(t, { forum: false });
  await receive({ thread: undefined });
  assert.equal(
    data(await call(worker, env, 'send_message', args({ message_thread_id: undefined })))?.state,
    'sent',
  );
  await receive({ chat: '10001', sender: '10001', thread: 70 });
  assert.ok(
    (
      await call(
        worker,
        env,
        'send_message',
        args({
          chat_id: '10001',
          message_thread_id: 71,
          mentions: [mention('10001')],
          idempotency_key: 'private-wrong',
        }),
      )
    ).body.error,
  );
  assert.equal(
    data(
      await call(
        worker,
        env,
        'send_message',
        args({ chat_id: '10001', mentions: [mention('10001')], idempotency_key: 'private-named' }),
      ),
    )?.state,
    'sent',
  );
  await receive({ chat: '10001', sender: '10001', thread: 1 });
  assert.equal(
    data(
      await call(
        worker,
        env,
        'send_message',
        args({
          chat_id: '10001',
          message_thread_id: undefined,
          mentions: [mention('10001')],
          idempotency_key: 'private-general',
        }),
      ),
    )?.state,
    'sent',
  );
  assert.equal(state.sends[1].message_thread_id, 70);
  assert.equal(state.sends[2].message_thread_id, undefined);
});

test('migration preserves legacy plain-text keys, results and history with no mentions', async (t) => {
  const db = new TestDatabase(9);
  t.after(() => db.close());
  const env = environment(db);
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  await db
    .prepare(
      'INSERT INTO outgoing(operation_key,request_hash,chat_id,state,message_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .bind(
      hash(['owner-test', '123456', 'legacy']),
      hash(['10001', 'Literal <b>Two</b>', null]),
      '10001',
      'sent',
      800,
      NOW,
      NOW,
    )
    .run();
  await db
    .prepare(
      'INSERT INTO sent_messages(operation_key,bot_id,chat_id,message_id,text,occurred_at,sent_at) VALUES (?,?,?,?,?,?,?)',
    )
    .bind(
      'legacy-record',
      '123456',
      '10001',
      800,
      'Literal <b>Two</b>',
      new Date(NOW).toISOString(),
      NOW,
    )
    .run();
  db.sqlite.exec(
    readFileSync(new URL('../drizzle/0009_outbound_mentions.sql', import.meta.url), 'utf8'),
  );
  const worker = createWorker({
    now: () => NOW,
    fetch: async () => {
      throw new Error('No network for replay');
    },
  });
  const replay = data(
    await call(worker, env, 'send_message', {
      chat_id: '10001',
      text: 'Literal <b>Two</b>',
      idempotency_key: 'legacy',
    }),
  );
  assert.deepEqual(replay, {
    state: 'sent',
    message_id: 800,
    reused: true,
    requires_review: false,
  });
  assert.deepEqual(
    data(
      await call(worker, env, 'send_message', {
        chat_id: '10001',
        text: 'Literal <b>Two</b>',
        mentions: [],
        idempotency_key: 'legacy',
      }),
    ),
    replay,
  );
  const history = data(
    await call(worker, env, 'get_recent_messages', { chat_id: '10001', include_outgoing: true }),
  );
  assert.equal(history.messages[0].text, 'Literal <b>Two</b>');
  assert.equal(Object.hasOwn(history.messages[0], 'mentions'), false);
});

test('send discovery exposes a bounded explicit mention schema', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const result = await (await createWorker().fetch(rpc('tools/list'), env)).json();
  const tool = result.result.tools.find((tool) => tool.name === 'send_message');
  assert.equal(tool.inputSchema.properties.mentions.maxItems, 20);
  assert.deepEqual(tool.inputSchema.properties.mentions.items.required, [
    'user_id',
    'offset',
    'length',
  ]);
  assert.equal(tool.inputSchema.properties.mentions.items.additionalProperties, false);
  assert.match(tool.description, /UTF-16/);
});
