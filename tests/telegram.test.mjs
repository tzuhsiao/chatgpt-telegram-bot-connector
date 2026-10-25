import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../worker/index.js';
import {NOW,environment,rpc,subscription,update,telegramRequest,verifySignature,challengeResponse,call} from './helpers.mjs';

async function setup(t,delivery) {
  const env=environment();t.after(()=>env.DB.close());let time=NOW;
  const worker=createWorker({now:()=>time,fetch:async(url,init)=>{
    if(JSON.parse(init.body).type==='verification') return challengeResponse(init);
    return delivery(url,init);
  }});
  const result=await(await worker.fetch(rpc('events/subscribe',subscription()),env)).json();assert.ok(result.result?.id);
  return {env,worker,advance:milliseconds=>{time+=milliseconds;}};
}

test('webhook requires a valid independent secret before persistence',async t=>{
  let fetches=0;const {env,worker}=await setup(t,async()=>{fetches++;return new Response(null,{status:204});});
  for(const secret of ['', 'incorrect']) assert.equal((await worker.fetch(telegramRequest(update(),secret),env)).status,401);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n,0);assert.equal(fetches,0);
});

test('non-allowlisted humans, groups, bot senders and unsupported updates are ignored',async t=>{
  let fetches=0;const {env,worker}=await setup(t,async()=>{fetches++;return new Response(null,{status:204});});
  const outsider=update();outsider.message.from.id=20002;
  const group=update();group.message.chat.type='group';group.message.chat.id=-42;
  const bot=update();bot.message.from.is_bot=true;
  for(const item of [outsider,group,bot,{update_id:42,edited_message:update().message}]) assert.equal((await worker.fetch(telegramRequest(item),env)).status,200);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n,0);assert.equal(fetches,0);
});

test('valid message becomes one signed event and successful duplicate is acknowledged',async t=>{
  const events=[];const {env,worker}=await setup(t,async(url,init)=>{assert.equal(verifySignature(init),true);assert.equal(init.redirect,'manual');events.push(JSON.parse(init.body));return new Response(null,{status:204});});
  for(let i=0;i<2;i++) assert.equal((await worker.fetch(telegramRequest(),env)).status,200);
  assert.equal(events.length,1);
  assert.deepEqual(events[0],{eventId:'tg_123456_42',name:'telegram.message.received',timestamp:'2026-10-23T12:00:00.000Z',data:{update_id:42,chat_id:'10001',sender_id:'10001',message_id:52,text:'Hello from a synthetic test',sent_at:'2026-10-23T12:00:00.000Z'},cursor:null});
  assert.equal((await env.DB.prepare('SELECT state FROM inbox').first()).state,'delivered');
});

test('pending duplicate after transient failure retries with stable identity and fresh signature',async t=>{
  const attempts=[];const {env,worker,advance}=await setup(t,async(url,init)=>{attempts.push(init);return new Response(null,{status:attempts.length===1?503:204});});
  assert.equal((await worker.fetch(telegramRequest(),env)).status,503);
  advance(10000);
  assert.equal((await worker.fetch(telegramRequest(),env)).status,200);
  assert.equal(attempts.length,2);assert.equal(attempts[0].body,attempts[1].body);
  assert.notEqual(new Headers(attempts[0].headers).get('webhook-timestamp'),new Headers(attempts[1].headers).get('webhook-timestamp'));
});

test('concurrent duplicates use one database admission and one active delivery lease',{timeout:5000},async t=>{
  let deliveries=0;let release;let completed=0;
  const gate=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  const {env,worker}=await setup(t,async()=>{deliveries++;await gate;return new Response(null,{status:204});});
  // Every competitor must reach the occupied lease before the callback completes.
  const requests=Array.from({length:10},()=>worker.fetch(telegramRequest(),env).then(response=>{if(++completed===9)release();return response;}));
  const responses=await Promise.all(requests);
  assert.equal(deliveries,1);assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n,1);
  for(const response of responses) {
    assert.ok([200,503].includes(response.status));
    assert.deepEqual(await response.json(),response.status===200?{ok:true}:{ok:false,retry:true});
    if(response.status===503) assert.equal(response.headers.get('retry-after'),'5');
  }
  assert.equal(responses.filter(response=>response.status===200).length,1);
  assert.equal(responses.filter(response=>response.status===503).length,9);
  assert.deepEqual(await env.DB.prepare('SELECT state,attempts FROM inbox').first(),{state:'delivered',attempts:1});
});

test('a fresh Worker resumes pending state from D1 instead of an in-memory map',async t=>{
  const {env,worker,advance}=await setup(t,async()=>{throw new TypeError('Network failure containing private callback URL');});
  const first=await worker.fetch(telegramRequest(),env);assert.equal(first.status,503);assert.doesNotMatch(await first.text(),/private callback/);
  advance(10000);let events=0;
  const restarted=createWorker({now:()=>NOW+10000,fetch:async()=>{events++;return new Response(null,{status:204});}});
  assert.equal((await restarted.fetch(telegramRequest(),env)).status,200);assert.equal(events,1);
});

test('terminal callback response is retained for diagnosis and is not retried',async t=>{
  let deliveries=0;const {env,worker}=await setup(t,async()=>{deliveries++;return new Response(null,{status:410});});
  for(let i=0;i<2;i++) assert.equal((await worker.fetch(telegramRequest(),env)).status,200);
  assert.equal(deliveries,1);assert.equal((await env.DB.prepare('SELECT state FROM inbox').first()).state,'failed');
  assert.equal((await env.DB.prepare('SELECT enabled FROM subscriptions').first()).enabled,0);
});

test('expired or unsubscribed destinations do not receive messages',async t=>{
  let deliveries=0;const {env,worker,advance}=await setup(t,async()=>{deliveries++;return new Response(null,{status:204});});
  advance(86400001);
  assert.equal((await worker.fetch(telegramRequest(),env)).status,503);assert.equal(deliveries,0);
});

test('oversized webhook body is rejected before it reaches storage',async t=>{
  const {env,worker}=await setup(t,async()=>new Response(null,{status:204}));
  assert.equal((await worker.fetch(telegramRequest(update(42,'x'.repeat(70000))),env)).status,413);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n,0);
});

test('manual owner recovery retries pending events without an incoming webhook',async t=>{
  let deliveries=0;const {env,worker,advance}=await setup(t,async()=>{deliveries++;return new Response(null,{status:deliveries===1?503:204});});
  assert.equal((await worker.fetch(telegramRequest(),env)).status,503);advance(10000);
  const response=await call(worker,env,'retry_pending_events',{chat_id:'10001',limit:5});
  assert.equal(response.body.result.structuredContent.delivered,1);
  assert.equal((await env.DB.prepare('SELECT state FROM inbox').first()).state,'delivered');
});
