import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker/index.js';
import {
  NOW,
  environment,
  rpc,
  subscription,
  challengeResponse,
  update,
  telegramRequest,
  call,
} from './helpers.mjs';

const sendArgs = { chat_id: '10001', text: 'A synthetic reply', idempotency_key: 'reply-42' };

test('sending is fixed-destination, plain text and idempotent after success', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const requests = [];
  const worker = createWorker({
    now: () => NOW,
    fetch: async (url, init) => {
      requests.push([url, init]);
      return Response.json({
        ok: true,
        result: {
          message_id: 88,
          date: 1,
          chat: { id: 10001, type: 'private' },
          text: 'A synthetic reply',
        },
      });
    },
  });
  for (let i = 0; i < 2; i++) {
    const result = await call(worker, env, 'send_message', sendArgs);
    assert.equal(result.body.result.structuredContent.message_id, 88);
    assert.equal(result.body.result.structuredContent.state, 'sent');
  }
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0][0]).origin, 'https://api.telegram.org');
  assert.equal(requests[0][1].redirect, 'manual');
  assert.deepEqual(JSON.parse(requests[0][1].body), {
    chat_id: '10001',
    text: 'A synthetic reply',
    link_preview_options: { is_disabled: true },
  });
});

test('outgoing requests reject unapproved destinations, invalid text and operation conflicts', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  let requests = 0;
  const worker = createWorker({
    now: () => NOW,
    fetch: async () => {
      requests++;
      return Response.json({
        ok: true,
        result: { message_id: 88, chat: { id: 10001, type: 'private' }, date: 1 },
      });
    },
  });
  for (const args of [
    { ...sendArgs, chat_id: '999' },
    { ...sendArgs, text: '' },
    { ...sendArgs, text: 'a'.repeat(4097) },
    { ...sendArgs, idempotency_key: '' },
    { ...sendArgs, url: 'https://evil.test' },
    { ...sendArgs, reply_to_message_id: -1 },
  ]) {
    const result = await call(worker, env, 'send_message', args);
    assert.ok(result.body.error);
  }
  assert.equal(requests, 0);
  await call(worker, env, 'send_message', sendArgs);
  assert.equal(
    (await call(worker, env, 'send_message', { ...sendArgs, text: 'Different' })).body.error.code,
    -32004,
  );
  assert.equal(requests, 1);
});

test(
  'concurrent identical sends initiate only one Telegram operation',
  { timeout: 5000 },
  async (t) => {
    const env = environment();
    t.after(() => env.DB.close());
    let requests = 0;
    let release;
    let completed = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const worker = createWorker({
      now: () => NOW,
      fetch: async () => {
        requests++;
        await gate;
        return Response.json({
          ok: true,
          result: { message_id: 88, chat: { id: 10001, type: 'private' }, date: 1 },
        });
      },
    });
    // Hold the admitted send until every competing call has returned its reuse result.
    const calls = Array.from({ length: 10 }, () =>
      call(worker, env, 'send_message', sendArgs).then((result) => {
        if (++completed === 9) release();
        return result;
      }),
    );
    const results = await Promise.all(calls);
    assert.equal(requests, 1);
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.equal(result.body.error, undefined);
      const data = result.body.result.structuredContent;
      assert.ok(['sending', 'sent'].includes(data.state));
      assert.equal(data.reused, data.state === 'sending');
      assert.equal(data.requires_review, data.state === 'sending');
      assert.equal(result.body.result.isError, data.state === 'sending');
    }
    assert.equal(
      results.filter((result) => result.body.result.structuredContent.state === 'sent').length,
      1,
    );
    assert.equal(
      results.filter((result) => result.body.result.structuredContent.state === 'sending').length,
      9,
    );
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM outgoing').first()).n, 1);
  },
);

test('ambiguous network failure is uncertain and never automatically resent', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  let requests = 0;
  const worker = createWorker({
    now: () => NOW,
    fetch: async () => {
      requests++;
      throw new TypeError('Synthetic failure containing a secret token');
    },
  });
  for (let i = 0; i < 2; i++) {
    const result = await call(worker, env, 'send_message', sendArgs);
    assert.equal(result.body.result.structuredContent.state, 'uncertain');
    assert.equal(result.body.result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /secret token/);
  }
  assert.equal(requests, 1);
});

test('Telegram rejection is recorded without reflecting untrusted error descriptions', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  let requests = 0;
  const worker = createWorker({
    now: () => NOW,
    fetch: async () => {
      requests++;
      return Response.json(
        { ok: false, error_code: 400, description: 'PRIVATE_ERROR_DATA' },
        { status: 400 },
      );
    },
  });
  const result = await call(worker, env, 'send_message', sendArgs);
  assert.equal(result.body.result.structuredContent.state, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR_DATA/);
  await call(worker, env, 'send_message', sendArgs);
  assert.equal(requests, 1);
});

test('webhook setup refuses to replace another nonempty destination', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const methods = [];
  const worker = createWorker({
    now: () => NOW,
    fetch: async (url) => {
      const method = new URL(url).pathname.split('/').at(-1);
      methods.push(method);
      return Response.json({
        ok: true,
        result:
          method === 'getMe'
            ? { id: 123456, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' }
            : {
                url: 'https://existing.example/private-path',
                pending_update_count: 0,
                has_custom_certificate: false,
              },
      });
    },
  });
  const result = await call(worker, env, 'configure_telegram_webhook', {});
  assert.ok(result.body.error);
  assert.equal(methods.includes('setWebhook'), false);
  assert.doesNotMatch(JSON.stringify(result), /private-path/);
});

test('webhook setup uses configured URL and secret without dropping pending updates', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  let setBody;
  const worker = createWorker({
    now: () => NOW,
    fetch: async (url, init) => {
      const method = new URL(url).pathname.split('/').at(-1);
      if (method === 'getMe')
        return Response.json({
          ok: true,
          result: { id: 123456, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' },
        });
      if (method === 'getWebhookInfo')
        return Response.json({
          ok: true,
          result: { url: '', pending_update_count: 0, has_custom_certificate: false },
        });
      setBody = JSON.parse(init.body);
      return Response.json({ ok: true, result: true });
    },
  });
  const result = await call(worker, env, 'configure_telegram_webhook', {});
  assert.equal(result.body.result.structuredContent.configured, true);
  assert.deepEqual(setBody, {
    url: 'https://connector.example/telegram/webhook',
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    max_connections: 1,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
});

test('status and stored-message reads are owner-only and status is redacted', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const worker = createWorker({
    now: () => NOW,
    fetch: async (url, init) =>
      JSON.parse(init.body).type === 'verification'
        ? challengeResponse(init)
        : new Response(null, { status: 204 }),
  });
  await worker.fetch(rpc('events/subscribe', subscription()), env);
  await worker.fetch(telegramRequest(update()), env);
  const status = await call(worker, env, 'get_connector_status');
  assert.equal(status.body.result.structuredContent.active_subscriptions, 1);
  assert.doesNotMatch(
    JSON.stringify(status),
    /synthetic-token|synthetic_webhook|whsec_|opaque-test-path|Hello from/,
  );
  const messages = await call(worker, env, 'get_recent_messages', { chat_id: '10001', limit: 10 });
  assert.equal(
    messages.body.result.structuredContent.messages[0].text,
    'Hello from a synthetic test',
  );
  assert.equal(
    (
      await worker.fetch(
        rpc(
          'tools/call',
          { name: 'get_recent_messages', arguments: { chat_id: '10001' } },
          'other',
        ),
        env,
      )
    ).status,
    403,
  );
});

test('activity cleanup deletes expired content while retaining recent records', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  let now = NOW;
  const worker = createWorker({
    now: () => now,
    fetch: async (url, init) =>
      JSON.parse(init.body).type === 'verification'
        ? challengeResponse(init)
        : new Response(null, { status: 204 }),
  });
  await worker.fetch(rpc('events/subscribe', subscription()), env);
  await worker.fetch(telegramRequest(), env);
  now += 8 * 86400000;
  const result = await call(worker, env, 'get_recent_messages', { chat_id: '10001', limit: 10 });
  assert.deepEqual(result.body.result.structuredContent.messages, []);
});

test('public landing page contains no operational configuration and APIs enforce owner access', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const worker = createWorker();
  const response = await worker.fetch(new Request('https://connector.example/'), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Telegram Bot Connector<\/title>/);
  assert.doesNotMatch(html, /ChatGPT Telegram Bot Connector/);
  assert.equal(
    (await worker.fetch(new Request('https://connector.example/api/status'), env)).status,
    401,
  );
});
