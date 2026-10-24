import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const rpc = (method, params = {}, id = 'owner-test') => new Request('https://connector.example/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(id ? { 'oai-authenticated-user-id': id } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});

test('public discovery reveals schemas but no runtime configuration', async () => {
  const response = await worker.fetch(rpc('server/discover', {}, null), { OWNER_USER_ID: 'secret-owner' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result.supportedVersions, ['2026-07-28']);
  assert.deepEqual(body.result.capabilities, { tools: {}, events: {} });
  assert.equal(JSON.stringify(body).includes('secret-owner'), false);
});

test('sensitive operations reject anonymous, non-owner and unconfigured callers', async () => {
  for (const [id, env] of [[null, {OWNER_USER_ID:'owner-test'}], ['other', {OWNER_USER_ID:'owner-test'}], ['owner-test', {}]]) {
    const response = await worker.fetch(rpc('tools/call', {name:'get_connector_status',arguments:{}}, id), env);
    assert.ok([401, 403, 503].includes(response.status));
    assert.ok((await response.json()).error);
  }
});

test('identity lookup returns only the authenticated caller identity', async () => {
  const response = await worker.fetch(rpc('tools/call', {name:'get_connector_identity',arguments:{}}), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result.structuredContent, {authenticated:true, caller_user_id:'owner-test', owner_configured:false, is_owner:false});
});

test('anonymous identity lookup does not invent an owner', async () => {
  const response = await worker.fetch(rpc('tools/call', {name:'get_connector_identity',arguments:{}}, null), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.structuredContent.caller_user_id, null);
});

test('malformed JSON is a protocol error without echoing input', async () => {
  const response = await worker.fetch(new Request('https://connector.example/mcp', {method:'POST',body:'invalid-private-content',headers:{'content-type':'application/json'}}), {});
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /-32700/);
  assert.doesNotMatch(body, /invalid-private-content/);
});

test('unknown routes and non-POST MCP requests are rejected', async () => {
  assert.equal((await worker.fetch(new Request('https://connector.example/not-found'), {})).status,404);
  assert.equal((await worker.fetch(new Request('https://connector.example/mcp'), {})).status,405);
});
