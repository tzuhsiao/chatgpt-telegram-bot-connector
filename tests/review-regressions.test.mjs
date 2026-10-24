import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../worker/index.js';
import {NOW,SECRET2,environment,rpc,subscription,telegramRequest,call,challengeResponse,verifySignature} from './helpers.mjs';

test('automatic retry exhaustion preserves an event for explicit owner recovery',async t=>{
  const env=environment();t.after(()=>env.DB.close());let now=NOW;const eventIds=[];
  const worker=createWorker({now:()=>now,fetch:async(url,init)=>{
    const body=JSON.parse(init.body);
    if(body.type==='verification') return challengeResponse(init);
    eventIds.push(body.eventId);
    return new Response(null,{status:eventIds.length<=8?503:204});
  }});
  await worker.fetch(rpc('events/subscribe',subscription()),env);
  for(let i=0;i<8;i++) {
    assert.equal((await worker.fetch(telegramRequest(),env)).status,i===7?200:503);
    now+=600000;
  }
  const exhausted=await env.DB.prepare('SELECT * FROM inbox').first();
  assert.equal(exhausted.state,'pending');assert.equal(exhausted.last_error,'retry_limit');
  assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.retry_exhausted_deliveries,1);
  assert.equal((await worker.fetch(telegramRequest(),env)).status,200);
  assert.equal(eventIds.length,8);
  const recovered=await call(worker,env,'retry_pending_events',{chat_id:'10001'});
  assert.equal(recovered.body.result.structuredContent.delivered,1);
  assert.equal(eventIds.length,9);assert.equal(new Set(eventIds).size,1);
});

for(const status of [401,403,410]) test(`stale callback ${status} cannot disable a newly verified subscription`,async t=>{
  const env=environment();t.after(()=>env.DB.close());const started=Promise.withResolvers(),oldResponse=Promise.withResolvers();let deliveries=0;
  t.after(()=>oldResponse.resolve(new Response(null,{status})));
  const worker=createWorker({now:()=>NOW,fetch:async(url,init)=>{
    if(JSON.parse(init.body).type==='verification') return challengeResponse(init);
    deliveries++;
    if(deliveries===1) {started.resolve();return oldResponse.promise;}
    assert.equal(verifySignature(init,SECRET2),true);
    return new Response(null,{status:204});
  }});
  await worker.fetch(rpc('events/subscribe',subscription()),env);
  const firstDelivery=worker.fetch(telegramRequest(),env);
  await started.promise;
  const renewed=subscription();renewed.delivery.secret=SECRET2;
  assert.ok((await(await worker.fetch(rpc('events/subscribe',renewed),env)).json()).result?.id);
  oldResponse.resolve(new Response(null,{status}));
  assert.equal((await firstDelivery).status,503);
  assert.equal((await env.DB.prepare('SELECT enabled FROM subscriptions').first()).enabled,1);
  assert.equal((await env.DB.prepare('SELECT state FROM inbox').first()).state,'pending');
  assert.equal((await call(worker,env,'retry_pending_events',{})).body.result.structuredContent.delivered,1);
});

test('malformed or contradictory Telegram envelopes remain uncertain and are not replayed',async t=>{
  for(const [status,body] of [[200,{}],[200,null],[200,{ok:false}],[500,{ok:true,result:{message_id:88,chat:{id:10001}}}],[200,{ok:false,error_code:400}],[503,{ok:false,error_code:503}]]) {
    await t.test(JSON.stringify([status,body]),async t=>{
      const env=environment();t.after(()=>env.DB.close());let sends=0;
      const worker=createWorker({now:()=>NOW,fetch:async()=>{sends++;return Response.json(body,{status});}});
      for(let i=0;i<2;i++) {
        const result=await call(worker,env,'send_message',{chat_id:'10001',text:'Synthetic reply',idempotency_key:'ambiguous-envelope'});
        assert.equal(result.body.result.structuredContent.state,'uncertain');
      }
      assert.equal(sends,1);
    });
  }
});

test('read-only tools hide expired inbox content without deleting stored records',async t=>{
  const env=environment();t.after(()=>env.DB.close());let now=NOW;
  const worker=createWorker({now:()=>now,fetch:async(url,init)=>JSON.parse(init.body).type==='verification'?challengeResponse(init):new Response(null,{status:204})});
  await worker.fetch(rpc('events/subscribe',subscription()),env);
  await worker.fetch(telegramRequest(),env);
  now+=8*86400000;
  const messages=await call(worker,env,'get_recent_messages',{chat_id:'10001'});
  assert.deepEqual(messages.body.result.structuredContent.messages,[]);
  await call(worker,env,'get_connector_status');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n,1);
  await call(worker,env,'retry_pending_events',{});
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n,0);
});

test('cached renewals do not indefinitely extend the challenge verification cache',async t=>{
  const env=environment();t.after(()=>env.DB.close());let now=NOW,verifications=0;
  const worker=createWorker({now:()=>now,fetch:async(url,init)=>{verifications++;return challengeResponse(init);}});
  for(let i=0;i<7;i++) {await worker.fetch(rpc('events/subscribe',subscription()),env);now+=60000;}
  assert.equal(verifications,2);
});

test('an in-flight renewal cannot reactivate a subscription after unsubscribe',async t=>{
  const env=environment();t.after(()=>env.DB.close());let verifying=0;
  const started=Promise.withResolvers(),release=Promise.withResolvers();
  t.after(()=>release.resolve());
  const worker=createWorker({now:()=>NOW,fetch:async(url,init)=>{
    verifying++;
    if(verifying===2) {started.resolve();await release.promise;}
    return challengeResponse(init);
  }});
  await worker.fetch(rpc('events/subscribe',subscription()),env);
  const rotated=subscription();rotated.delivery.secret=SECRET2;
  const renewal=worker.fetch(rpc('events/subscribe',rotated),env);
  await started.promise;
  await worker.fetch(rpc('events/unsubscribe',subscription()),env);
  release.resolve();
  assert.ok((await(await renewal).json()).error);
  assert.equal((await env.DB.prepare('SELECT enabled FROM subscriptions').first()).enabled,0);
  assert.ok((await(await worker.fetch(rpc('events/subscribe',rotated),env)).json()).result?.id);
  assert.equal((await env.DB.prepare('SELECT enabled FROM subscriptions').first()).enabled,1);
});
