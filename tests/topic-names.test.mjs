import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker/index.js';
import { NOW, environment, call, rpc, update, telegramRequest } from './helpers.mjs';

const target = { chat_id: '10001', message_thread_id: 70 };
const rename = {
  ...target,
  name: 'A meaningful topic title',
  expected_revision: 1,
  mode: 'automatic',
  idempotency_key: 'topic-name-1',
};
const data = (r) => {
  assert.ok(r.body.result, JSON.stringify(r.body.error));
  return r.body.result.structuredContent;
};
function message(id, field, value, thread = 70) {
  const u = update(id);
  u.message.message_thread_id = thread;
  u.message.is_topic_message = true;
  if (field) {
    delete u.message.text;
    u.message[field] = value;
  }
  return u;
}
async function fixture(t, implicit = true) {
  const env = environment();
  t.after(() => env.DB.close());
  const state = { edits: [], sends: [], mode: 'ok', now: NOW, hold: null };
  function worker() {
    return createWorker({
      now: () => state.now,
      fetch: async (url, init) => {
        const method = new URL(url).pathname.split('/').at(-1);
        const body = JSON.parse(init.body);
        if (method === 'editForumTopic') {
          state.edits.push(body);
          if (state.hold) await state.hold();
          if (state.mode === 'throw') throw new Error('Synthetic unknown outcome');
          if (state.mode === 'reject')
            return Response.json(
              { ok: false, error_code: 400, description: 'Synthetic rejection' },
              { status: 400 },
            );
          return Response.json({ ok: true, result: state.mode === 'malformed' ? {} : true });
        }
        assert.equal(method, 'sendMessage');
        state.sends.push(body);
        return Response.json({
          ok: true,
          result: {
            message_id: 500,
            chat: { id: 10001 },
            message_thread_id: body.message_thread_id,
          },
        });
      },
    });
  }
  const w = worker();
  const created = message(42, 'forum_topic_created', {
    name: 'Default topic',
    icon_color: 123,
    ...(implicit ? { is_name_implicit: true } : {}),
  });
  assert.equal((await w.fetch(telegramRequest(created), env)).status, 200);
  return { env, state, worker: w, restart: worker, created };
}
const info = (w, e, t = target) => call(w, e, 'get_private_topic', t).then(data);

test('implicit private topic metadata survives restart without becoming conversational intake', async (t) => {
  const { env, worker, restart, created } = await fixture(t);
  const first = await info(worker, env);
  assert.equal(first.provenance, 'implicit');
  assert.equal(first.automatic_eligible, true);
  assert.equal(first.revision, 1);
  assert.equal(first.name, 'Default topic');
  await worker.fetch(telegramRequest(created), env);
  assert.deepEqual(await info(restart(), env), first);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 0);
  await worker.fetch(telegramRequest(message(43)), env);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 1);
});

test('automatic naming edits the exact topic once, preserves icon and avoids title churn', async (t) => {
  const { env, worker, state, restart } = await fixture(t);
  assert.equal(data(await call(worker, env, 'rename_private_topic', rename)).state, 'applied');
  assert.deepEqual(state.edits, [{ chat_id: '10001', message_thread_id: 70, name: rename.name }]);
  assert.equal((await info(restart(), env)).provenance, 'dot');
  assert.equal((await info(worker, env)).automatic_eligible, false);
  assert.equal(data(await call(worker, env, 'rename_private_topic', rename)).reused, true);
  assert.ok(
    (
      await call(worker, env, 'rename_private_topic', {
        ...rename,
        expected_revision: 2,
        idempotency_key: 'churn',
        name: 'Another title',
      })
    ).body.error,
  );
  assert.equal(state.edits.length, 1);
});

test('manual and unknown provenance fail closed; explicit owner-directed renames use revision guards', async (t) => {
  const { env, worker, state, restart } = await fixture(t, false);
  assert.equal((await info(worker, env)).provenance, 'manual');
  assert.ok((await call(worker, env, 'rename_private_topic', rename)).body.error);
  await worker.fetch(telegramRequest(message(43, null, null, 80)), env);
  assert.equal(
    (await info(worker, env, { ...target, message_thread_id: 80 })).provenance,
    'unknown',
  );
  assert.ok(
    (
      await call(worker, env, 'rename_private_topic', {
        ...rename,
        message_thread_id: 80,
        expected_revision: 0,
      })
    ).body.error,
  );
  assert.equal(
    data(await call(worker, env, 'rename_private_topic', { ...rename, mode: 'manual' })).state,
    'applied',
  );
  assert.equal((await info(restart(), env)).provenance, 'manual');
  assert.equal(state.edits.length, 1);
  const same = {
    ...rename,
    mode: 'manual',
    name: rename.name,
    expected_revision: 2,
    idempotency_key: 'same-title',
  };
  assert.equal(data(await call(worker, env, 'rename_private_topic', same)).state, 'unchanged');
  assert.equal(state.edits.length, 1);
});

test('human rename wins over stale creation, identical names, icon updates and delayed API completion', async (t) => {
  const { env, worker, state, created, restart } = await fixture(t);
  let release, entered;
  const ready = new Promise((r) => (entered = r));
  state.hold = () => {
    entered();
    return new Promise((r) => (release = r));
  };
  const pending = call(worker, env, 'rename_private_topic', rename);
  await ready;
  await worker.fetch(
    telegramRequest(message(44, 'forum_topic_edited', { name: rename.name })),
    env,
  );
  release();
  assert.equal(data(await pending).superseded, true);
  await worker.fetch(telegramRequest(created), env);
  await worker.fetch(
    telegramRequest(message(43, 'forum_topic_created', { name: 'Old', is_name_implicit: true })),
    env,
  );
  await worker.fetch(
    telegramRequest(message(45, 'forum_topic_edited', { icon_custom_emoji_id: '' })),
    env,
  );
  const result = await info(restart(), env);
  assert.equal(result.provenance, 'manual');
  assert.equal(result.name, rename.name);
  assert.equal(result.revision, 2);
  assert.equal(result.automatic_eligible, false);
  assert.ok(
    (await call(worker, env, 'rename_private_topic', { ...rename, idempotency_key: 'stale' })).body
      .error,
  );
});

test('human rename before the dispatch claim cancels the reserved edit', async (t) => {
  const { env, worker, state } = await fixture(t);
  const prepare = env.DB.prepare.bind(env.DB);
  let intercepted = false;
  env.DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.includes("SET state='applying'")) return statement;
    return {
      bind(...args) {
        const bound = statement.bind(...args);
        return {
          ...bound,
          async run() {
            if (!intercepted) {
              intercepted = true;
              await worker.fetch(
                telegramRequest(message(44, 'forum_topic_edited', { name: 'Human choice' })),
                env,
              );
            }
            return bound.run();
          },
        };
      },
    };
  };
  const result = data(await call(worker, env, 'rename_private_topic', rename));
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'topic_changed');
  assert.equal(state.edits.length, 0);
  assert.equal((await info(worker, env)).name, 'Human choice');
});

test('provenance and uncertain target locks survive ordinary cleanup past thirty days', async (t) => {
  const { env, worker, state, restart } = await fixture(t);
  state.mode = 'throw';
  assert.equal(data(await call(worker, env, 'rename_private_topic', rename)).state, 'uncertain');
  await worker.fetch(
    telegramRequest(message(44, 'forum_topic_edited', { name: 'Manual after unknown' })),
    env,
  );
  state.now += 32 * 86400000;
  await call(worker, env, 'send_message', {
    ...target,
    text: 'Later reply',
    idempotency_key: 'later',
  });
  assert.equal((await info(restart(), env)).provenance, 'manual');
  assert.equal((await info(restart(), env)).operation_state, 'uncertain');
  assert.equal(data(await call(restart(), env, 'rename_private_topic', rename)).state, 'uncertain');
  assert.ok(
    (
      await call(worker, env, 'rename_private_topic', {
        ...rename,
        mode: 'manual',
        expected_revision: 2,
        idempotency_key: 'new-key',
      })
    ).body.error,
  );
  assert.equal(state.edits.length, 1);
});

test('concurrent keys serialize a topic and frozen arguments conflict across target/name/revision/mode', async (t) => {
  const { env, worker, state } = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      call(worker, env, 'rename_private_topic', {
        ...rename,
        idempotency_key: i % 2 ? 'other' : rename.idempotency_key,
      }),
    ),
  );
  assert.equal(state.edits.length, 1);
  assert.ok(results.some((r) => data(r)?.state === 'applied'));
  const winner = results.findIndex((r) => data(r)?.state === 'applied');
  const key = winner % 2 ? 'other' : rename.idempotency_key;
  env.TELEGRAM_ALLOWED_CHAT_IDS = '10001,20002';
  env.TELEGRAM_ALLOWED_USER_IDS = '10001,20002';
  for (const patch of [
    { name: 'Changed' },
    { message_thread_id: 80 },
    { chat_id: '20002' },
    { expected_revision: 2 },
    { mode: 'manual' },
  ]) {
    const r = await call(worker, env, 'rename_private_topic', {
      ...rename,
      idempotency_key: key,
      ...patch,
    });
    assert.equal(r.body.error?.code, -32004);
  }
  assert.equal(state.edits.length, 1);
});

test('rejected, uncertain and interrupted renames never retry or block ordinary replies', async (t) => {
  for (const mode of ['reject', 'throw', 'malformed', 'interrupted']) {
    const { env, worker, state, restart } = await fixture(t);
    state.mode = mode;
    if (mode === 'interrupted') {
      let entered;
      const ready = new Promise((r) => (entered = r));
      let release;
      state.hold = () => {
        entered();
        return new Promise((r) => (release = r));
      };
      const pending = call(worker, env, 'rename_private_topic', rename);
      await ready;
      state.now += 31000;
      assert.equal((await info(restart(), env)).operation_state, 'uncertain');
      assert.equal(
        data(await call(restart(), env, 'rename_private_topic', rename)).state,
        'uncertain',
      );
      release();
      assert.equal(data(await pending).state, 'uncertain');
    } else {
      const result = await call(worker, env, 'rename_private_topic', rename);
      assert.equal(data(result).state, mode === 'reject' ? 'failed' : 'uncertain');
      assert.equal(result.body.result.isError, true);
      assert.equal(data(result).diagnostics.retry.safe, false);
      assert.equal(data(result).diagnostics.operation_state, data(result).state);
    }
    assert.equal(data(await call(restart(), env, 'rename_private_topic', rename)).reused, true);
    if (mode !== 'reject')
      assert.ok(
        (await call(worker, env, 'rename_private_topic', { ...rename, idempotency_key: 'bypass' }))
          .body.error,
      );
    assert.equal(state.edits.length, 1);
    assert.equal(
      data(
        await call(worker, env, 'send_message', {
          ...target,
          text: 'Independent answer',
          idempotency_key: 'answer',
        }),
      ).state,
      'sent',
    );
    assert.equal(state.sends.length, 1);
  }
});

test('title validation counts Unicode code points with no soft-limit enforcement or truncation', async (t) => {
  const { env, worker, state } = await fixture(t);
  let revision = 1;
  for (const name of [
    '中'.repeat(128),
    '😀'.repeat(128),
    'e\u0301'.repeat(64),
    'Meaning can require a title longer than twenty four characters',
  ]) {
    const result = await call(worker, env, 'rename_private_topic', {
      ...rename,
      mode: 'manual',
      expected_revision: revision++,
      name,
      idempotency_key: 'unicode-' + revision,
    });
    assert.equal(data(result).state, 'applied');
    assert.equal(state.edits.at(-1).name, name);
  }
  for (const name of [
    '',
    '   ',
    '中'.repeat(129),
    '😀'.repeat(129),
    'e\u0301'.repeat(65),
    '\ud800',
    '\udc00',
    '\u200b',
  ])
    assert.ok(
      (
        await call(worker, env, 'rename_private_topic', {
          ...rename,
          name,
          expected_revision: revision,
          mode: 'manual',
          idempotency_key: 'invalid',
        })
      ).body.error,
    );
  assert.equal(state.edits.length, 4);
});

test('topic lifecycle and tools retain owner, webhook, sender, private-chat and exact-topic gates', async (t) => {
  const { env, worker, state } = await fixture(t);
  for (const caller of ['', 'outsider']) {
    for (const [name, args] of [
      ['get_private_topic', target],
      ['rename_private_topic', rename],
    ])
      assert.ok(
        (
          await (
            await worker.fetch(rpc('tools/call', { name, arguments: args }, caller), env)
          ).json()
        ).error,
      );
  }
  for (const message_thread_id of [undefined, 1, 0, -1, 1.5, '70', null])
    assert.ok(
      (await call(worker, env, 'rename_private_topic', { ...rename, message_thread_id })).body
        .error,
    );
  for (const mutation of [
    (m) => (m.from.id = 20002),
    (m) => (m.chat.id = 20002),
    (m) => (m.from.is_bot = true),
    (m) => (m.sender_chat = { id: 10001 }),
    (m) => (m.chat.type = 'supergroup'),
  ]) {
    const u = message(45, 'forum_topic_edited', { name: 'Unauthorized' });
    mutation(u.message);
    await worker.fetch(telegramRequest(u), env);
  }
  assert.equal(
    (
      await worker.fetch(
        telegramRequest(message(46, 'forum_topic_edited', { name: 'Bad secret' }), 'wrong'),
        env,
      )
    ).status,
    401,
  );
  assert.equal((await info(worker, env)).name, 'Default topic');
  assert.equal(
    (await info(worker, env, { ...target, message_thread_id: 80 })).provenance,
    'unknown',
  );
  env.TELEGRAM_ALLOWED_USER_IDS = '20002';
  assert.ok((await call(worker, env, 'get_private_topic', target)).body.error);
  assert.ok((await call(worker, env, 'rename_private_topic', rename)).body.error);
  assert.equal(state.edits.length, 0);
});
