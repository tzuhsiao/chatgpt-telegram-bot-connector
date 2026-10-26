import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../worker/index.js';
import {NOW,SECRET,SECRET2,environment,rpc,subscription,verifySignature,challengeResponse} from './helpers.mjs';

test('subscription verifies its signed callback before persisting',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const calls=[];
  const worker=createWorker({now:()=>NOW,fetch:async(url,init)=>{calls.push([url,init]);assert.equal(verifySignature(init),true);assert.equal(init.redirect,'manual');return challengeResponse(init);}});
  const response=await worker.fetch(rpc('events/subscribe',subscription()),env);
  const data=await response.json();
  assert.equal(response.status,200);assert.ok(data.result?.id);
  assert.equal(data.result.refreshBefore,'2026-10-24T12:00:00.000Z');
  assert.equal(calls.length,1);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions').first()).n,1);
});

test('failed challenge cannot activate a subscription or expose the callback path',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const worker=createWorker({now:()=>NOW,fetch:async()=>Response.json({challenge:'wrong'})});
  const data=await(await worker.fetch(rpc('events/subscribe',subscription()),env)).json();
  assert.equal(data.error.code,-32015);assert.equal(data.error.data.reason,'challenge_failed');
  assert.doesNotMatch(JSON.stringify(data),/opaque-test-path/);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions').first()).n,0);
});

test('callback allowlist blocks SSRF, lookalikes and redirects without following them',async t=>{
  const env=environment();t.after(()=>env.DB.close());let fetches=0;
  const worker=createWorker({now:()=>NOW,fetch:async()=>{fetches++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}});}});
  for(const url of ['http://callbacks.example.com/events','https://127.0.0.1/','https://[::1]/','https://callbacks.example.com.evil.test/','https://user:pass@callbacks.example.com/','https://callbacks.example.com:444/','https://callbacks.example.com/#fragment']) {
    const params=subscription();params.delivery.url=url;
    assert.ok((await(await worker.fetch(rpc('events/subscribe',params),env)).json()).error);
  }
  assert.equal(fetches,0);
  const body=await(await worker.fetch(rpc('events/subscribe',subscription()),env)).json();
  assert.equal(body.error.code,-32015);assert.equal(fetches,1);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions').first()).n,0);
});

test('renewal keeps identity, rotates secrets and unsubscribe is idempotent',async t=>{
  const env=environment();t.after(()=>env.DB.close());let now=NOW;let fetches=0;
  const worker=createWorker({now:()=>now,fetch:async(url,init)=>{fetches++;return challengeResponse(init);}});
  const first=await(await worker.fetch(rpc('events/subscribe',subscription()),env)).json();
  const repeat=await(await worker.fetch(rpc('events/subscribe',subscription()),env)).json();
  assert.equal(repeat.result.id,first.result.id);assert.equal(fetches,1);
  now+=60000;
  const params=subscription({ttlMs:120000});params.delivery.secret=SECRET2;
  const renew=await(await worker.fetch(rpc('events/subscribe',params),env)).json();
  assert.equal(renew.result.id,first.result.id);assert.equal(renew.result.refreshBefore,new Date(NOW+180000).toISOString());
  const row=await env.DB.prepare('SELECT * FROM subscriptions').first();
  assert.equal(row.secret,SECRET2);assert.equal(row.previous_secret,SECRET);assert.ok(row.rotation_until>now);
  const unsubscribe=subscription();delete unsubscribe.delivery.secret;
  for(let i=0;i<2;i++) assert.deepEqual((await(await worker.fetch(rpc('events/unsubscribe',unsubscribe),env)).json()).result,{});
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE enabled=1').first()).n,0);
});

test('a different callback cannot silently replace an active chat subscriber',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const worker=createWorker({now:()=>NOW,fetch:async(url,init)=>challengeResponse(init)});
  await worker.fetch(rpc('events/subscribe',subscription()),env);
  const next=subscription();next.delivery.url='https://callbacks.example.com/events/second';
  assert.ok((await(await worker.fetch(rpc('events/subscribe',next),env)).json()).error);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE enabled=1').first()).n,1);
});

test('unauthorized event filters and invalid signing keys fail before outbound requests',async t=>{
  const env=environment();t.after(()=>env.DB.close());let fetches=0;
  const worker=createWorker({fetch:async()=>{fetches++;throw new Error('unexpected outbound call');}});
  for(const params of [subscription({arguments:{chat_id:'999'}}),subscription({arguments:{chat_id:'10001',extra:true}}),subscription({name:'unknown'}),subscription({delivery:{mode:'webhook',url:'https://callbacks.example.com/',secret:'whsec_YQ=='}})]) {
    assert.ok((await(await worker.fetch(rpc('events/subscribe',params),env)).json()).error);
  }
  assert.equal(fetches,0);
});

test('event diagnostics count unexpected top-level keys without logging their names or values',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  env.MCP_DIAGNOSTICS='1';
  env.TELEGRAM_ALLOWED_CHAT_IDS='';
  const entries=[];
  t.mock.method(console,'info',(...args)=>entries.push(args.join(' ')));
  const params=subscription({cursor:null,extra_wire_field:'private-value-canary'});
  const response=await createWorker().fetch(rpc('events/subscribe',params),env);
  assert.equal(response.status,400);
  const records=entries.filter(entry=>entry.startsWith('mcp_event_diagnostic '))
    .map(entry=>JSON.parse(entry.slice('mcp_event_diagnostic '.length)));
  assert.equal(records.length,2);
  for(const record of records) {
    assert.equal(record.unexpectedTopLevelCount,1);
    assert.equal(record.hasSigningSecret,true);
  }
  const output=entries.join('\n');
  for(const value of ['private-value-canary',SECRET,'opaque-test-path','https://callbacks.example.com','10001']) {
    assert.equal(output.includes(value),false);
  }
});

test('event subscribe accepts optional opaque MCP metadata without logging it',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  env.MCP_DIAGNOSTICS='1';
  const entries=[];
  t.mock.method(console,'info',(...args)=>entries.push(args.join(' ')));
  const worker=createWorker({now:()=>NOW,fetch:async(url,init)=>challengeResponse(init)});
  const params=subscription({cursor:null,_meta:{trace:'private-meta-canary',authorized:true}});
  const response=await worker.fetch(rpc('events/subscribe',params),env);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.ok(body.result?.id);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE enabled=1').first()).n,1);
  const records=entries.filter(entry=>entry.startsWith('mcp_event_diagnostic '))
    .map(entry=>JSON.parse(entry.slice('mcp_event_diagnostic '.length)));
  assert.deepEqual(records.map(record=>record.unexpectedTopLevelCount),[0]);
  assert.equal(entries.join('\n').includes('private-meta-canary'),false);
});

test('event unsubscribe accepts optional opaque MCP metadata',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const worker=createWorker({now:()=>NOW,fetch:async(url,init)=>challengeResponse(init)});
  assert.equal((await worker.fetch(rpc('events/subscribe',subscription()),env)).status,200);
  const params=subscription({_meta:{trace:'ignored-unsubscribe-metadata'}});
  delete params.delivery.secret;
  const response=await worker.fetch(rpc('events/unsubscribe',params),env);
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).result,{});
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE enabled=1').first()).n,0);
});

test('event metadata cannot bypass chat allowlist and must be an object',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  env.TELEGRAM_ALLOWED_CHAT_IDS='';
  let fetches=0;
  const worker=createWorker({fetch:async()=>{fetches++;throw new Error('unexpected outbound call');}});
  const denied=await worker.fetch(rpc('events/subscribe',subscription({_meta:{authorized:true,chat_id:'10001'}})),env);
  assert.equal(denied.status,403);
  assert.equal((await denied.json()).error.message,'Chat is not allowed.');
  for(const method of ['events/subscribe','events/unsubscribe']) {
    for(const _meta of [null,[],42,'invalid',false]) {
      const response=await worker.fetch(rpc(method,subscription({_meta})),env);
      assert.equal(response.status,400);
      assert.equal((await response.json()).error.message,'Invalid arguments.');
    }
  }
  assert.equal(fetches,0);
});
