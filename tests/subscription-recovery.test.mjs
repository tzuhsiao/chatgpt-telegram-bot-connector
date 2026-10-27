import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker/index.js';
import {
  NOW,
  environment,
  rpc,
  subscription,
  update,
  telegramRequest,
  challengeResponse,
  verifySignature,
  call,
} from './helpers.mjs';

const DAY = 86400000;
const GROUP = '-1001234567890';

async function waitFor(promise) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Recovery never started.')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function setup(t, { forum = false } = {}) {
  const env = environment();
  const background = [],
    events = [];
  const state = { now: NOW, status: 204, onEvent: null, challenge: true };
  const ctx = {
    waitUntil(promise) {
      background.push(promise);
    },
  };
  const worker = createWorker({
    now: () => state.now,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (new URL(url).hostname === 'api.telegram.org') {
        const method = new URL(url).pathname.split('/').at(-1);
        const result =
          method === 'getChat'
            ? { id: Number(GROUP), type: 'supergroup', is_forum: forum }
            : { user: { id: 123456, is_bot: true }, status: 'administrator' };
        return Response.json({ ok: true, result });
      }
      if (body.type === 'verification')
        return state.challenge ? challengeResponse(init) : Response.json({ challenge: 'wrong' });
      assert.ok(verifySignature(init));
      events.push(body);
      return state.onEvent ? state.onEvent(body) : new Response(null, { status: state.status });
    },
  });
  const flush = async () => {
    while (background.length) await Promise.all(background.splice(0));
  };
  t.after(async () => {
    await flush();
    env.DB.close();
  });
  const subscribe = async (params = subscription(), context = ctx) =>
    (await worker.fetch(rpc('events/subscribe', params), env, context)).json();
  const receive = (id, chat = '10001', thread) => {
    const value = update(id);
    value.message.date = Math.floor(state.now / 1000);
    if (chat === GROUP) {
      value.message.chat = { id: Number(GROUP), type: 'supergroup', is_forum: forum };
      if (thread !== undefined) {
        value.message.is_topic_message = true;
        value.message.message_thread_id = thread;
      }
    } else {
      value.message.chat.id = Number(chat);
      value.message.from.id = Number(chat);
    }
    return worker.fetch(telegramRequest(value), env);
  };
  return { env, worker, state, ctx, background, events, flush, subscribe, receive };
}

test('persisted no-subscription intake is acknowledged without a callback attempt', async (t) => {
  const s = setup(t);
  assert.equal((await s.receive(1)).status, 200);
  assert.equal((await s.receive(1)).status, 200);
  assert.deepEqual(
    await s.env.DB.prepare('SELECT state,attempts,subscription_id FROM inbox').first(),
    { state: 'pending', attempts: 0, subscription_id: null },
  );
  assert.equal(s.events.length, 0);
});

test('a chat without a subscription does not prevent another subscribed chat delivery', async (t) => {
  const s = setup(t);
  s.env.TELEGRAM_ALLOWED_CHAT_IDS = '10001,20002';
  s.env.TELEGRAM_ALLOWED_USER_IDS = '10001,20002';
  assert.ok((await s.subscribe(subscription({ arguments: { chat_id: '20002' } }))).result);
  await s.flush();
  assert.equal((await s.receive(1)).status, 200);
  assert.equal((await s.receive(2, '20002')).status, 200);
  assert.deepEqual(
    s.events.map((e) => e.data.chat_id),
    ['20002'],
  );
});

test('subscription creation and expired renewal recover retained events with stable IDs', async (t) => {
  const s = setup(t);
  await s.receive(1);
  assert.ok((await s.subscribe()).result);
  await s.flush();
  assert.deepEqual(
    s.events.map((e) => e.eventId),
    ['tg_123456_1'],
  );
  s.state.now += DAY + 1;
  assert.equal((await s.receive(2)).status, 200);
  assert.equal(s.events.length, 1);
  assert.ok((await s.subscribe()).result);
  await s.flush();
  assert.deepEqual(
    s.events.map((e) => e.eventId),
    ['tg_123456_1', 'tg_123456_2'],
  );
});

test('automatic recovery selects at most ten eligible events without resetting retry guards', async (t) => {
  const s = setup(t);
  for (let i = 1; i <= 16; i++) await s.receive(i);
  await s.env.DB.prepare('UPDATE inbox SET attempts=8 WHERE update_id=1').run();
  await s.env.DB.prepare('UPDATE inbox SET next_attempt_at=? WHERE update_id=2')
    .bind(NOW + 60000)
    .run();
  await s.env.DB.prepare('UPDATE inbox SET lease_until=? WHERE update_id=3')
    .bind(NOW + 30000)
    .run();
  await s.env.DB.prepare('UPDATE inbox SET received_at=? WHERE update_id=4')
    .bind(NOW - 7 * DAY - 1)
    .run();
  assert.ok((await s.subscribe()).result);
  await s.flush();
  assert.deepEqual(
    s.events.map((e) => e.data.update_id),
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
  assert.deepEqual(await s.env.DB.prepare('SELECT attempts FROM inbox WHERE update_id=1').first(), {
    attempts: 8,
  });
  assert.equal(
    (
      await s.env.DB.prepare(
        "SELECT COUNT(*) n FROM inbox WHERE update_id IN (15,16) AND state='pending'",
      ).first()
    ).n,
    2,
  );
});

test('subscription response completes while a recovery callback is still in flight', async (t) => {
  const s = setup(t);
  await s.receive(1);
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  s.state.onEvent = async () => {
    started.resolve();
    return release.promise;
  };
  try {
    assert.ok((await s.subscribe()).result);
    await waitFor(started.promise);
    assert.equal((await s.env.DB.prepare('SELECT state FROM inbox').first()).state, 'pending');
  } finally {
    release.resolve(new Response(null, { status: 204 }));
    await s.flush();
  }
});

test('concurrent renewal drains and duplicate webhooks share one active lease', async (t) => {
  const s = setup(t);
  await s.receive(1);
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  s.state.onEvent = async () => {
    started.resolve();
    return release.promise;
  };
  try {
    assert.ok((await s.subscribe()).result);
    await waitFor(started.promise);
    assert.ok((await s.subscribe()).result);
    assert.equal((await s.receive(1)).status, 503);
    assert.equal(s.events.length, 1);
  } finally {
    release.resolve(new Response(null, { status: 204 }));
    await s.flush();
  }
  assert.deepEqual(await s.env.DB.prepare('SELECT state,attempts FROM inbox').first(), {
    state: 'delivered',
    attempts: 1,
  });
});

test('background callback failure preserves backoff and cannot fail the subscription', async (t) => {
  const s = setup(t);
  await s.receive(1);
  s.state.status = 503;
  assert.ok((await s.subscribe()).result);
  await s.flush();
  assert.deepEqual(
    await s.env.DB.prepare('SELECT state,attempts,next_attempt_at FROM inbox').first(),
    { state: 'pending', attempts: 1, next_attempt_at: NOW + 2000 },
  );
  assert.ok((await s.subscribe()).result);
  await s.flush();
  assert.equal(s.events.length, 1);
  s.state.now += 2001;
  s.state.status = 204;
  await s.subscribe();
  await s.flush();
  assert.equal(s.events.length, 2);
});

test('recovery stops starting callbacks after its time budget', async (t) => {
  const s = setup(t);
  await s.receive(1);
  await s.receive(2);
  s.state.onEvent = async () => {
    s.state.now += 16000;
    return new Response(null, { status: 204 });
  };
  await s.subscribe();
  await s.flush();
  assert.deepEqual(
    s.events.map((e) => e.data.update_id),
    [1],
  );
  assert.equal(
    (await s.env.DB.prepare('SELECT state FROM inbox WHERE update_id=2').first()).state,
    'pending',
  );
});

test('events expiring during a recovery batch are not delivered', async (t) => {
  const s = setup(t);
  await s.receive(1);
  await s.receive(2);
  await s.env.DB.prepare('UPDATE inbox SET received_at=?')
    .bind(NOW - 7 * DAY + 1000)
    .run();
  s.state.onEvent = async () => {
    s.state.now += 2000;
    return new Response(null, { status: 204 });
  };
  await s.subscribe();
  await s.flush();
  assert.deepEqual(
    s.events.map((e) => e.data.update_id),
    [1],
  );
});

test('a replacement subscriber cannot take over an already bound event', async (t) => {
  const s = setup(t);
  await s.subscribe();
  await s.flush();
  s.state.status = 503;
  assert.equal((await s.receive(1)).status, 503);
  s.state.now += DAY + 1;
  await s.receive(2);
  s.state.status = 204;
  const next = subscription();
  next.delivery.url += '/replacement';
  assert.ok((await s.subscribe(next)).result);
  await s.flush();
  assert.deepEqual(
    s.events.map((e) => e.data.update_id),
    [1, 2],
  );
  assert.deepEqual(
    await s.env.DB.prepare('SELECT state,last_error FROM inbox WHERE update_id=1').first(),
    { state: 'failed', last_error: 'subscription_changed' },
  );
});

for (const replace of [false, true])
  test(
    'explicit cancellation ends old backlog and canceled-period replay: replacement=' + replace,
    async (t) => {
      const s = setup(t);
      await s.subscribe();
      await s.flush();
      s.state.status = 503;
      await s.receive(1);
      assert.deepEqual(
        (await (await s.worker.fetch(rpc('events/unsubscribe', subscription()), s.env)).json())
          .result,
        {},
      );
      assert.equal((await s.receive(2)).status, 200);
      const rows = (
        await s.env.DB.prepare('SELECT state,last_error FROM inbox ORDER BY update_id').all()
      ).results;
      assert.deepEqual(rows, [
        { state: 'failed', last_error: 'subscription_cancelled' },
        { state: 'failed', last_error: 'subscription_cancelled' },
      ]);
      s.state.status = 204;
      const next = subscription();
      if (replace) next.delivery.url += '/replacement';
      assert.ok((await s.subscribe(next)).result);
      await s.flush();
      assert.equal((await s.receive(2)).status, 200);
      await call(s.worker, s.env, 'retry_pending_events', {});
      assert.equal(s.events.length, 1);
      assert.equal((await s.receive(3)).status, 200);
      assert.deepEqual(
        s.events.map((e) => e.data.update_id),
        [1, 3],
      );
      assert.equal(
        (await call(s.worker, s.env, 'get_recent_messages', { chat_id: '10001' })).body.result
          .structuredContent.messages.length,
        3,
      );
    },
  );

test('unsubscribe of an unknown callback identity does not cancel the active subscriber', async (t) => {
  const s = setup(t);
  await s.subscribe();
  await s.flush();
  const other = subscription();
  other.delivery.url += '/other';
  await s.worker.fetch(rpc('events/unsubscribe', other), s.env);
  assert.equal((await s.receive(1)).status, 200);
  assert.equal(s.events.length, 1);
});

test('a canceled admission delayed across resubscription cannot become replayable', async (t) => {
  const s = setup(t);
  await s.subscribe();
  await s.flush();
  await s.worker.fetch(rpc('events/unsubscribe', subscription()), s.env);
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  const original = s.env.DB.prepare.bind(s.env.DB);
  t.mock.method(s.env.DB, 'prepare', (sql) => {
    const statement = original(sql);
    if (!sql.includes('INSERT INTO inbox')) return statement;
    return {
      bind(...args) {
        const bound = statement.bind(...args);
        return {
          ...bound,
          async run() {
            started.resolve();
            await release.promise;
            return bound.run();
          },
        };
      },
    };
  });
  const intake = s.receive(1);
  try {
    await waitFor(started.promise);
    s.state.now += 1000;
    assert.ok((await s.subscribe()).result);
  } finally {
    release.resolve();
    await intake;
    await s.flush();
  }
  assert.equal(s.events.length, 0);
  assert.equal((await s.env.DB.prepare('SELECT state FROM inbox').first()).state, 'failed');
});

test('failed subscription persistence never schedules recovery or reopens cancellation', async (t) => {
  const s = setup(t);
  await s.subscribe();
  await s.flush();
  await s.worker.fetch(rpc('events/unsubscribe', subscription()), s.env);
  const fault = t.mock.method(s.env.DB, 'batch', async () => {
    throw new Error('synthetic persistence failure');
  });
  assert.ok((await s.subscribe()).error);
  assert.equal(s.background.length, 0);
  assert.equal((await s.env.DB.prepare('SELECT enabled FROM subscriptions').first()).enabled, 0);
  fault.mock.restore();
  assert.equal((await s.receive(1)).status, 200);
  assert.equal((await s.env.DB.prepare('SELECT state FROM inbox').first()).state, 'failed');
});

test('admission during a delayed resume transaction stays canceled after commit', async (t) => {
  const s = setup(t);
  await s.subscribe();
  await s.flush();
  await s.worker.fetch(rpc('events/unsubscribe', subscription()), s.env);
  const resumeStarted = Promise.withResolvers(),
    resumeRelease = Promise.withResolvers();
  const admissionStarted = Promise.withResolvers(),
    admissionRelease = Promise.withResolvers();
  const batch = s.env.DB.batch.bind(s.env.DB),
    prepare = s.env.DB.prepare.bind(s.env.DB);
  t.mock.method(s.env.DB, 'batch', async (statements) => {
    if (statements.length !== 2) return batch(statements);
    resumeStarted.resolve();
    await resumeRelease.promise;
    return batch(statements);
  });
  t.mock.method(s.env.DB, 'prepare', (sql) => {
    const statement = prepare(sql);
    if (!sql.includes('INSERT INTO inbox')) return statement;
    return {
      bind(...args) {
        const bound = statement.bind(...args);
        return {
          ...bound,
          async run() {
            admissionStarted.resolve();
            await admissionRelease.promise;
            return bound.run();
          },
        };
      },
    };
  });
  const resume = s.subscribe();
  let intake;
  try {
    await waitFor(resumeStarted.promise);
    s.state.now += 1000;
    intake = s.receive(1);
    await waitFor(admissionStarted.promise);
    resumeRelease.resolve();
    assert.ok((await resume).result);
  } finally {
    resumeRelease.resolve();
    admissionRelease.resolve();
    await resume;
    await intake;
    await s.flush();
  }
  assert.equal(s.events.length, 0);
  assert.equal((await s.env.DB.prepare('SELECT state FROM inbox').first()).state, 'failed');
});

test('failed challenge and absent or rejected scheduling do not produce an untracked drain', async (t) => {
  const s = setup(t);
  await s.receive(1);
  s.state.challenge = false;
  assert.ok((await s.subscribe()).error);
  assert.equal(s.background.length, 0);
  s.state.challenge = true;
  assert.ok((await s.subscribe(subscription(), {})).result);
  assert.ok(
    (
      await s.subscribe(subscription(), {
        waitUntil() {
          throw new Error('synthetic scheduling failure');
        },
      })
    ).result,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.events.length, 0);
});

test('malformed retained subscription revision fails closed before renewal', async (t) => {
  const s = setup(t);
  await s.subscribe();
  await s.flush();
  await s.env.DB.prepare("UPDATE subscriptions SET revision='invalid'").run();
  const response = await s.worker.fetch(rpc('events/subscribe', subscription()), s.env, s.ctx);
  assert.equal(response.status, 503);
  assert.ok((await response.json()).error);
  assert.equal(s.background.length, 0);
});

test('authenticated invalid message content is ignored while envelope and storage errors remain failures', async (t) => {
  const s = setup(t);
  for (const item of [update(1, ''), update(2, 'x'.repeat(4097)), update(3)]) {
    if (item.update_id === 3) item.message.date += 301;
    const response = await s.worker.fetch(telegramRequest(item), s.env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ignored: true });
  }
  assert.equal((await s.env.DB.prepare('SELECT COUNT(*) n FROM inbox').first()).n, 0);
  assert.equal((await s.worker.fetch(telegramRequest({ update_id: -1 }), s.env)).status, 400);
  assert.equal((await s.worker.fetch(telegramRequest(update(), 'wrong'), s.env)).status, 401);
  const original = s.env.DB.prepare.bind(s.env.DB);
  t.mock.method(s.env.DB, 'prepare', (sql) => {
    if (sql.includes('INSERT INTO inbox')) throw new Error('synthetic write failure');
    return original(sql);
  });
  assert.equal((await s.receive(4)).status, 503);
  assert.equal(s.events.length, 0);
});

test('forum recovery preserves topics and rejects old epochs before callbacks', async (t) => {
  const s = setup(t, { forum: true });
  s.env.TELEGRAM_ALLOWED_GROUPS = JSON.stringify({ [GROUP]: ['10001', '20002'] });
  assert.equal(
    (await call(s.worker, s.env, 'verify_group_access', { chat_id: GROUP })).body.result
      .structuredContent.state,
    'active',
  );
  await s.receive(1, GROUP, 70);
  await s.receive(2, GROUP, 80);
  await s.env.DB.prepare(
    'UPDATE inbox SET group_revision=group_revision-1 WHERE update_id=1',
  ).run();
  assert.ok((await s.subscribe(subscription({ arguments: { chat_id: GROUP } }))).result);
  await s.flush();
  assert.deepEqual(
    s.events.map((e) => [e.data.update_id, e.data.message_thread_id]),
    [[2, 80]],
  );
  assert.equal(
    (await s.env.DB.prepare('SELECT state FROM inbox WHERE update_id=1').first()).state,
    'failed',
  );
});
