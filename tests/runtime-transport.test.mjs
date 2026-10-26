import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker/index.js';
import {
  NOW,
  environment,
  rpc,
  subscription,
  challengeResponse,
  verifySignature,
} from './helpers.mjs';

test('the default transport can verify a callback with a receiver-sensitive host fetch', async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  // workerd rejects a native fetch invoked with an unrelated receiver. Node's
  // ambient fetch tolerates that call, so model this host boundary explicitly.
  globalThis.fetch = async function (url, init) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    assert.equal(url, 'https://callbacks.example.com/events/opaque-test-path');
    assert.equal(init.redirect, 'manual');
    assert.equal(verifySignature(init), true);
    return challengeResponse(init);
  };
  const worker = createWorker({ now: () => NOW });
  const response = await worker.fetch(rpc('events/subscribe', subscription()), env);
  const body = await response.json();
  assert.equal(body.error, undefined);
  assert.ok(body.result?.id);
  assert.equal(
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE enabled=1').first()).n,
    1,
  );
});
