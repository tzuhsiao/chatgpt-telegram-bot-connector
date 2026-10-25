import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../worker/index.js';
import {NOW,environment,rpc,subscription,update,telegramRequest,challengeResponse,call,verifySignature,TestDatabase} from './helpers.mjs';
import {readFileSync} from 'node:fs';

const GROUP='-1001234567890';
const HUMANS=['10001','20002'];
function groupUpdate(id=71,sender=20002) {
  const event=update(id,'Shared group text');
  event.message.chat={id:Number(GROUP),type:'supergroup'};
  event.message.from.id=sender;
  return event;
}
function membership(id=80,user=123456,status='left') {
  return {update_id:id,chat_member:{chat:{id:Number(GROUP),type:'supergroup'},from:{id:10001,is_bot:false},date:NOW/1000,
    old_chat_member:{user:{id:user,is_bot:user===123456},status:status==='member'?'left':'member'},new_chat_member:{user:{id:user,is_bot:user===123456},status}}};
}
async function setup(t,{activate=true}={}) {
  const env=environment();t.after(()=>env.DB.close());
  env.TELEGRAM_ALLOWED_GROUPS=JSON.stringify({[GROUP]:HUMANS});
  const state={time:NOW,count:3,chat:{id:Number(GROUP),type:'supergroup',permissions:{can_invite_users:false}},
    members:new Map([[123456,{user:{id:123456,is_bot:true},status:'administrator'}],...HUMANS.map(id=>[Number(id),{user:{id:Number(id),is_bot:false},status:'member'}])]),
    events:[],sends:[],requests:[],fail:null,hook:null,callbackStatus:204};
  const worker=createWorker({now:()=>state.time,fetch:async(url,init)=>{
    const body=JSON.parse(init.body),method=new URL(url).pathname.split('/').at(-1);
    state.requests.push(method);
    if(state.hook) await state.hook(method,body);
    if(method==='events') {
      if(body.type==='verification') return challengeResponse(init);
      assert.ok(verifySignature(init));state.events.push(body);return new Response(null,{status:state.callbackStatus});
    }
    if(state.fail===method) throw new Error('synthetic unavailable');
    const result=method==='getChat'?state.chat:method==='getChatMemberCount'?state.count:method==='getChatMember'?state.members.get(body.user_id):
      method==='sendMessage'?(state.sends.push(body),{message_id:91,chat:{id:Number(body.chat_id)}}):
      method==='getMe'?{id:123456,is_bot:true}:method==='getWebhookInfo'?{url:''}:method==='setWebhook'?true:null;
    return Response.json({ok:true,result});
  }});
  if(activate) assert.equal((await call(worker,env,'verify_group_access',{chat_id:GROUP})).body.result?.structuredContent.state,'active');
  return {env,worker,state};
}
async function subscribe(worker,env,chat=GROUP) {
  return (await(await worker.fetch(rpc('events/subscribe',subscription({arguments:{chat_id:chat},delivery:{...subscription().delivery,url:'https://callbacks.example.com/events'}})),env)).json());
}
const send={chat_id:GROUP,text:'One coherent answer',idempotency_key:'group-answer-71'};

test('group activation is explicit and owner-only; invalid group config fails closed',async t=>{
  const {env,worker,state}=await setup(t,{activate:false});
  assert.ok((await subscribe(worker,env)).error);
  assert.ok((await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.error);
  const denied=await worker.fetch(rpc('tools/call',{name:'verify_group_access',arguments:{chat_id:GROUP}},'another-owner'),env);
  assert.equal(denied.status,403);assert.equal(state.requests.length,0);
  for(const value of ['bad','[]',JSON.stringify({'42':HUMANS}),JSON.stringify({[GROUP]:['10001']}),JSON.stringify({[GROUP]:['10001','10001']}),JSON.stringify({[GROUP]:['10001','9007199254740992']})]) {
    env.TELEGRAM_ALLOWED_GROUPS=value;
    assert.ok((await call(worker,env,'verify_group_access',{chat_id:GROUP})).body.error);
  }
  assert.equal(state.requests.length,0);
  env.TELEGRAM_ALLOWED_GROUPS=JSON.stringify({[GROUP]:HUMANS});
  for(const chat_id of ['0','-0','-01','-9007199254740992','-42',Number(GROUP)]) {
    assert.equal((await call(worker,env,'verify_group_access',{chat_id})).body.error.code,-32001);
  }
  const tools=(await(await worker.fetch(rpc('tools/list'),env)).json()).result.tools;
  assert.ok(tools.some(tool=>tool.name==='verify_group_access'));
});

test('group events, history and subscriptions remain chat-scoped without granting private access',async t=>{
  const {env,worker,state}=await setup(t);
  assert.ok((await subscribe(worker,env)).result?.id);
  assert.equal((await worker.fetch(telegramRequest(groupUpdate()),env)).status,200);
  assert.equal((await worker.fetch(telegramRequest(groupUpdate()),env)).status,200);
  assert.equal(state.events.length,1);
  assert.equal(state.events[0].data.chat_id,GROUP);assert.equal(state.events[0].data.sender_id,'20002');
  const history=(await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.result.structuredContent.messages;
  assert.equal(history.length,1);assert.equal(history[0].text,'Shared group text');
  assert.deepEqual((await call(worker,env,'get_recent_messages',{chat_id:'10001'})).body.result.structuredContent.messages,[]);
  assert.ok((await call(worker,env,'send_message',{...send,chat_id:'20002'})).body.error);
  assert.ok((await subscribe(worker,env,'-42')).error);
});

test('group sends omit quoting, preserve idempotency and never retry ambiguous dispatch',async t=>{
  const {env,worker,state}=await setup(t);
  assert.equal((await call(worker,env,'send_message',send)).body.result.structuredContent.state,'sent');
  await call(worker,env,'send_message',send);
  assert.equal(state.sends.length,1);assert.equal(state.sends[0].chat_id,GROUP);
  assert.equal(state.sends[0].reply_parameters,undefined);
  state.fail='sendMessage';
  const uncertain={...send,idempotency_key:'group-answer-72'};
  assert.equal((await call(worker,env,'send_message',uncertain)).body.result.structuredContent.state,'uncertain');
  const attempts=state.requests.filter(m=>m==='sendMessage').length;
  await call(worker,env,'send_message',uncertain);
  assert.equal(state.requests.filter(m=>m==='sendMessage').length,attempts);
});

test('bot access loss latches a durable pause, deduplicates, and discards pending old-epoch work',async t=>{
  const {env,worker,state}=await setup(t);await subscribe(worker,env);
  state.callbackStatus=503;
  assert.equal((await worker.fetch(telegramRequest(groupUpdate()),env)).status,503);
  await worker.fetch(telegramRequest(membership()),env);
  const first=await env.DB.prepare('SELECT revision FROM group_access').first();
  await worker.fetch(telegramRequest(membership()),env);
  assert.deepEqual(await env.DB.prepare('SELECT revision FROM group_access').first(),first);
  assert.ok((await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.error);
  const blocked=await call(worker,env,'send_message',send);assert.equal(blocked.body.result.structuredContent.state,'failed');
  assert.equal(state.sends.length,0);
  assert.equal((await env.DB.prepare('SELECT state FROM inbox').first()).state,'failed');
  state.callbackStatus=204;
  assert.equal((await call(worker,env,'verify_group_access',{chat_id:GROUP})).body.result.structuredContent.state,'active');
  assert.deepEqual((await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.result.structuredContent.messages,[]);
  await call(worker,env,'retry_pending_events',{chat_id:GROUP});assert.equal(state.events.length,1);
  // Old webhook retries cannot re-admit a failed event in the new epoch.
  await worker.fetch(telegramRequest(groupUpdate()),env);assert.equal(state.events.length,1);
});

test('private scope, bot access and unverifiable operational state still stop group access',async t=>{
  for(const mutate of [s=>{s.members.get(123456).status='left';},
    s=>{s.chat.username='public_group';},s=>{s.chat.active_usernames=['public_group'];},s=>{s.chat.linked_chat_id=-99;},
    s=>{s.chat.type='channel';},s=>{s.chat.is_forum=true;},s=>{s.fail='getChatMember';},s=>{s.members.get(123456).user.id=30003;},
    s=>{s.members.get(123456).user.is_bot=false;},s=>{s.members.get(123456).status='restricted';s.members.get(123456).is_member=true;s.members.get(123456).can_send_messages=false;},s=>{s.chat.id=-42;}]) {
    const {env,worker,state}=await setup(t);mutate(state);
    assert.ok((await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.error);
    const result=await call(worker,env,'send_message',send);assert.equal(result.body.result.structuredContent.state,'failed');
    assert.equal(state.sends.length,0);
  }
});

test('unapproved, bot and anonymous senders never enter input/history or pause approved activity',async t=>{
  for(const mutate of [m=>{m.from.id=30003;},m=>{m.sender_chat={id:Number(GROUP),type:'supergroup'};},m=>{m.from.is_bot=true;}]) {
    const {env,worker,state}=await setup(t);await subscribe(worker,env);const event=groupUpdate();mutate(event.message);
    state.requests=[];
    assert.equal((await worker.fetch(telegramRequest(event),env)).status,200);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n,0);
    assert.equal(state.events.length,0);assert.equal(state.requests.length,0);
    assert.deepEqual((await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.result.structuredContent.messages,[]);
    assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.groups[0].state,'active');
    await worker.fetch(telegramRequest(groupUpdate(72)),env);assert.equal(state.events.length,1);
  }
});

test('bot access loss arriving during verification prevents stale reactivation',async t=>{
  const {env,worker,state}=await setup(t,{activate:false});let once=false;
  state.hook=async method=>{if(method==='getChatMember'&&!once){once=true;await worker.fetch(telegramRequest(membership()),env);}};
  assert.ok((await call(worker,env,'verify_group_access',{chat_id:GROUP})).body.error);
  assert.equal((await env.DB.prepare('SELECT state FROM group_access').first()).state,'paused');
});

test('group-enabled webhook requests membership events while private mode remains unchanged',async t=>{
  const {env,worker,state}=await setup(t);let payload;
  state.hook=async(method,body)=>{if(method==='setWebhook')payload=body;};
  assert.equal((await call(worker,env,'configure_telegram_webhook')).body.result.structuredContent.configured,true);
  assert.deepEqual(payload.allowed_updates,['message','my_chat_member']);assert.equal(payload.drop_pending_updates,false);
});

test('paused ingress is not replayed after recovery and unsafe sender retries do not pause twice',async t=>{
  const {env,worker,state}=await setup(t);await subscribe(worker,env);
  await call(worker,env,'pause_group_access',{chat_id:GROUP});
  const outsider=groupUpdate(91,30003);
  await worker.fetch(telegramRequest(outsider),env);
  await worker.fetch(telegramRequest(groupUpdate(92)),env); // Arrived during the pause.
  await call(worker,env,'verify_group_access',{chat_id:GROUP});
  await worker.fetch(telegramRequest(outsider),env);
  await worker.fetch(telegramRequest(groupUpdate(92)),env);
  assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.groups[0].state,'active');
  assert.equal(state.events.length,0);
  await worker.fetch(telegramRequest(groupUpdate(93)),env);assert.equal(state.events.length,1);
});

test('changed approvals and removed groups revoke pending work; removed group subscription can be disabled',async t=>{
  const {env,worker,state}=await setup(t);const sub=await subscribe(worker,env);
  state.callbackStatus=503;await worker.fetch(telegramRequest(groupUpdate()),env);
  env.TELEGRAM_ALLOWED_GROUPS=JSON.stringify({[GROUP]:['10001','30003']});
  assert.ok((await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.error);
  await call(worker,env,'retry_pending_events',{chat_id:GROUP});
  assert.equal(state.events.length,1);
  env.TELEGRAM_ALLOWED_GROUPS='';
  assert.ok((await call(worker,env,'send_message',send)).body.error);
  const params=subscription({arguments:{chat_id:GROUP},delivery:{...subscription().delivery,url:'https://callbacks.example.com/events'}});
  const result=await(await worker.fetch(rpc('events/unsubscribe',params),env)).json();assert.deepEqual(result.result,{});
  assert.equal((await env.DB.prepare('SELECT enabled FROM subscriptions WHERE id=?').bind(sub.result.id).first()).enabled,0);
});

test('bot access loss during pre-send verification stops dispatch and concurrent group sends stay idempotent',async t=>{
  const {env,worker,state}=await setup(t);let once=false;
  state.hook=async method=>{if(method==='getChatMember'&&!once){once=true;await worker.fetch(telegramRequest(membership()),env);}};
  assert.equal((await call(worker,env,'send_message',send)).body.result.structuredContent.state,'failed');
  assert.equal(state.sends.length,0);
  state.hook=null;await call(worker,env,'verify_group_access',{chat_id:GROUP});
  await Promise.all(Array.from({length:5},()=>call(worker,env,'send_message',{...send,idempotency_key:'concurrent-group-send'})));
  assert.equal(state.sends.length,1);
});

test('bot removal and group migration service messages pause without subscribing to a replacement ID',async t=>{
  for(const payload of [{update_id:95,my_chat_member:membership().chat_member},
    {update_id:96,message:{chat:{id:Number(GROUP),type:'group'},migrate_to_chat_id:-1004444444444}},
    {update_id:97,message:{chat:{id:Number(GROUP),type:'supergroup'},left_chat_member:{id:123456,is_bot:true}}}]) {
    const {env,worker,state}=await setup(t);await worker.fetch(telegramRequest(payload),env);
    assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.groups[0].state,'paused');
    assert.equal(state.events.length,0);
  }
});

test('group pause leaves existing private chats and subscriptions usable',async t=>{
  const {env,worker,state}=await setup(t);await subscribe(worker,env,'10001');await subscribe(worker,env);
  await worker.fetch(telegramRequest(membership()),env);
  assert.equal((await worker.fetch(telegramRequest(update(101,'Private text')),env)).status,200);
  assert.equal(state.events.length,1);assert.equal(state.events[0].data.chat_id,'10001');
  assert.equal((await call(worker,env,'send_message',{...send,chat_id:'10001'})).body.result.structuredContent.state,'sent');
  assert.equal(state.sends.length,1);assert.equal(state.sends[0].chat_id,'10001');
  assert.equal((await call(worker,env,'get_recent_messages',{chat_id:'10001'})).body.result.structuredContent.messages[0].text,'Private text');
});

test('a fresh Worker preserves paused state and lost bot access blocks callbacks',async t=>{
  const {env,worker,state}=await setup(t);await subscribe(worker,env);state.callbackStatus=503;
  await worker.fetch(telegramRequest(groupUpdate()),env);state.members.get(123456).status='left';
  await call(worker,env,'retry_pending_events',{chat_id:GROUP});assert.equal(state.events.length,1);
  const restarted=createWorker({now:()=>NOW,fetch:async()=>{throw new Error('Must not access a paused group');}});
  assert.ok((await call(restarted,env,'get_recent_messages',{chat_id:GROUP})).body.error);
  assert.equal((await env.DB.prepare('SELECT state FROM inbox').first()).state,'failed');
});

test('status observes missing or changed group approval without creating or mutating access state',async t=>{
  const {env,worker}=await setup(t,{activate:false});
  assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.groups[0].state,'paused');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM group_access').first()).n,0);
  await call(worker,env,'verify_group_access',{chat_id:GROUP});
  env.TELEGRAM_ALLOWED_GROUPS=JSON.stringify({[GROUP]:['10001','30003']});
  assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.groups[0].state,'paused');
  assert.equal((await env.DB.prepare('SELECT state FROM group_access').first()).state,'active');
});

test('a group becoming public during inspection is rejected before any send',async t=>{
  const {env,worker,state}=await setup(t);let once=false;
  state.hook=async method=>{if(method==='getChatMember'&&!once){once=true;state.chat.username='unexpected_public_group';}};
  assert.equal((await call(worker,env,'send_message',send)).body.result.structuredContent.state,'failed');
  assert.equal(state.sends.length,0);
});

test('ordinary group replies are accepted while forum-topic messages stay excluded',async t=>{
  const {env,worker,state}=await setup(t);await subscribe(worker,env);
  const reply=groupUpdate();reply.message.message_thread_id=20;reply.message.reply_to_message={message_id:20};
  await worker.fetch(telegramRequest(reply),env);assert.equal(state.events.length,1);
  const topic=groupUpdate(72);topic.message.is_topic_message=true;
  await worker.fetch(telegramRequest(topic),env);assert.equal(state.events.length,1);
});

test('observed removal or invalid group config latches revocation before identical config is restored',async t=>{
  for(const removed of ['', 'invalid-json']) {
    const {env,worker}=await setup(t);const original=env.TELEGRAM_ALLOWED_GROUPS;
    env.TELEGRAM_ALLOWED_GROUPS=removed;
    await call(worker,env,'get_recent_messages',{chat_id:GROUP});
    env.TELEGRAM_ALLOWED_GROUPS=original;
    assert.ok((await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.error);
  }
});

test('membership notifications still latch a previously stored group while config is absent',async t=>{
  const {env,worker}=await setup(t);const original=env.TELEGRAM_ALLOWED_GROUPS;
  env.TELEGRAM_ALLOWED_GROUPS='';await worker.fetch(telegramRequest(membership()),env);
  env.TELEGRAM_ALLOWED_GROUPS=original;
  assert.ok((await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.error);
});

test('slow group preflight cannot be mistaken for an abandoned Telegram send',async t=>{
  const {env,worker,state}=await setup(t);let repeat;
  state.hook=async method=>{if(method==='getChatMember'&&!repeat){
    state.time+=31000;
    repeat=Promise.resolve(); // Prevent recursion in the nested check.
    repeat=call(worker,env,'send_message',send);await repeat;
  }};
  const first=await call(worker,env,'send_message',send);
  assert.equal(first.body.result.structuredContent.state,'sent');
  assert.equal((await repeat).body.result.structuredContent.state,'sent');
  assert.equal(state.sends.length,1);
});

test('immediate delivery reuses the same-request ingress verification, retries inspect again',async t=>{
  const {env,worker,state}=await setup(t);await subscribe(worker,env);state.requests=[];
  state.callbackStatus=503;await worker.fetch(telegramRequest(groupUpdate()),env);
  assert.equal(state.requests.filter(method=>method==='getChatMember').length,1);
  state.callbackStatus=204;state.requests=[];await call(worker,env,'retry_pending_events',{chat_id:GROUP});
  assert.equal(state.requests.filter(method=>method==='getChatMember').length,1);
  assert.equal(state.events.length,2);
});

test('bad optional group config reports a diagnostic without breaking approved private chats',async t=>{
  const {env,worker,state}=await setup(t);await subscribe(worker,env,'10001');env.TELEGRAM_ALLOWED_GROUPS='invalid-json';
  assert.equal((await worker.fetch(telegramRequest(groupUpdate()),env)).status,200);
  assert.equal((await worker.fetch(telegramRequest(update()),env)).status,200);
  assert.equal(state.events.length,1);
  assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.group_configuration_error,'invalid_group_config');
});

test('bot access loss during the outgoing database claim prevents dispatch',async t=>{
  const {env,worker,state}=await setup(t);let once=false;const prepare=env.DB.prepare.bind(env.DB);
  env.DB.prepare=sql=>{
    const statement=prepare(sql);
    if(sql.startsWith('UPDATE outgoing SET updated_at=')) {
      const bind=statement.bind;
      statement.bind=(...args)=>{
        const bound=bind(...args),run=bound.run;
        bound.run=async()=>{if(!once){once=true;await worker.fetch(telegramRequest(membership()),env);}return run();};
        return bound;
      };
    }
    return statement;
  };
  assert.equal((await call(worker,env,'send_message',send)).body.result.structuredContent.state,'failed');
  assert.equal(state.sends.length,0);
});

test('group-only settings work and concurrent activation reports changed state accurately',async t=>{
  const {env,worker,state}=await setup(t,{activate:false});env.TELEGRAM_ALLOWED_USER_IDS='';env.TELEGRAM_ALLOWED_CHAT_IDS='';
  const results=await Promise.all([call(worker,env,'verify_group_access',{chat_id:GROUP}),call(worker,env,'verify_group_access',{chat_id:GROUP})]);
  assert.ok(results.some(result=>result.body.result?.structuredContent.state==='active'));
  for(const result of results) if(result.body.error) assert.equal(result.body.error.message.includes('remains paused'),false);
  assert.ok((await subscribe(worker,env)).result.id);
  await worker.fetch(telegramRequest(groupUpdate()),env);assert.equal(state.events.length,1);
});

test('a foreign configuration row cannot be activated using stale sender approvals',async t=>{
  const {env,worker}=await setup(t,{activate:false});let once=false;
  const other={...env,TELEGRAM_ALLOWED_GROUPS:JSON.stringify({[GROUP]:['10001','30003']})};
  const prepare=env.DB.prepare.bind(env.DB);
  env.DB.prepare=sql=>{
    const statement=prepare(sql);
    if(sql==='SELECT * FROM group_access WHERE bot_id=? AND chat_id=?') {
      const bind=statement.bind;
      statement.bind=(...args)=>{
        const bound=bind(...args),first=bound.first;
        bound.first=async(...values)=>{
          if(!once){once=true;await call(worker,other,'verify_group_access',{chat_id:GROUP});await call(worker,other,'pause_group_access',{chat_id:GROUP});}
          return first(...values);
        };
        return bound;
      };
    }
    return statement;
  };
  assert.ok((await call(worker,env,'verify_group_access',{chat_id:GROUP})).body.error);
  assert.equal((await prepare('SELECT state FROM group_access').first()).state,'paused');
});

test('explicit owner pause protects configuration changes even without intervening ingress',async t=>{
  const {env,worker}=await setup(t);
  assert.equal((await call(worker,env,'pause_group_access',{chat_id:GROUP})).body.result?.structuredContent.state,'paused');
  const original=env.TELEGRAM_ALLOWED_GROUPS;env.TELEGRAM_ALLOWED_GROUPS='';env.TELEGRAM_ALLOWED_GROUPS=original;
  assert.ok((await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.error);
});

test('migration upgrades populated private data without changing its history or operations',async t=>{
  const db=new TestDatabase(2);t.after(()=>db.close());
  await db.prepare("INSERT INTO inbox(event_id,bot_id,update_id,chat_id,sender_id,message_id,text,occurred_at,received_at) VALUES ('old','123456',1,'10001','10001',11,'Retained private text',?,?)").bind(new Date(NOW).toISOString(),NOW).run();
  await db.prepare("INSERT INTO outgoing(operation_key,request_hash,chat_id,state,created_at,updated_at) VALUES ('old-operation','hash','10001','uncertain',?,?)").bind(NOW,NOW).run();
  const remaining=JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8')).entries.slice(2);
  for(const entry of remaining) db.sqlite.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`,import.meta.url),'utf8'));
  const worker=createWorker({now:()=>NOW,fetch:async()=>{throw new Error('No network needed');}});
  assert.equal((await call(worker,environment(db),'get_recent_messages',{chat_id:'10001'})).body.result.structuredContent.messages[0].text,'Retained private text');
  assert.equal((await db.prepare('SELECT state FROM outgoing').first()).state,'uncertain');
});

test('one bounded recovery invocation inspects each group once and keeps per-event epoch guards',async t=>{
  const {env,worker,state}=await setup(t);await subscribe(worker,env);state.callbackStatus=503;
  await worker.fetch(telegramRequest(groupUpdate(201)),env);await worker.fetch(telegramRequest(groupUpdate(202)),env);
  state.callbackStatus=204;state.requests=[];
  assert.equal((await call(worker,env,'retry_pending_events',{chat_id:GROUP,limit:10})).body.result.structuredContent.delivered,2);
  assert.equal(state.requests.filter(method=>method==='getChatMember').length,1);
});

test('observed forum mode pauses group ingress instead of leaving stale active status',async t=>{
  const {env,worker}=await setup(t);const event=groupUpdate();event.message.chat.is_forum=true;
  await worker.fetch(telegramRequest(event),env);
  assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.groups[0].state,'paused');
});

test('status distinguishes missing bot configuration from malformed group approvals and lists removed records',async t=>{
  const {env,worker}=await setup(t);env.TELEGRAM_BOT_TOKEN='';
  let status=(await call(worker,env,'get_connector_status')).body.result.structuredContent;
  assert.equal(status.group_configuration_error,null);assert.equal(status.groups[0].last_error,'bot_configuration_required');
  env.TELEGRAM_BOT_TOKEN='123456:synthetic-token-not-a-secret';env.TELEGRAM_ALLOWED_GROUPS='';
  status=(await call(worker,env,'get_connector_status')).body.result.structuredContent;
  assert.equal(status.groups[0].chat_id,GROUP);assert.equal(status.groups[0].configured,false);assert.equal(status.groups[0].state,'paused');
});

test('the bot cannot occupy an approved human sender slot',async t=>{
  const {env,worker}=await setup(t,{activate:false});env.TELEGRAM_ALLOWED_GROUPS=JSON.stringify({[GROUP]:['10001','123456']});
  assert.ok((await call(worker,env,'verify_group_access',{chat_id:GROUP})).body.error);
});

test('group audience size, invites and non-admin bot status do not change sender authorization',async t=>{
  const {env,worker,state}=await setup(t,{activate:false});state.count=20;
  state.members.delete(20002);state.members.get(123456).status='member';state.chat.permissions.can_invite_users=true;
  assert.equal((await call(worker,env,'verify_group_access',{chat_id:GROUP})).body.result?.structuredContent.state,'active');
  await subscribe(worker,env);
  for(const event of [membership(101,30003,'member'),membership(102,30003,'left'),membership(103,10001,'restricted'),
    {update_id:104,message:{chat:{id:Number(GROUP),type:'supergroup'},new_chat_members:[{id:40004,is_bot:false}]}},
    {update_id:105,message:{chat:{id:Number(GROUP),type:'supergroup'},left_chat_member:{id:20002,is_bot:false}}}]) {
    await worker.fetch(telegramRequest(event),env);
  }
  assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.groups[0].state,'active');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM group_updates').first()).n,0);
  await worker.fetch(telegramRequest(groupUpdate(106)),env);assert.equal(state.events.length,1);
  assert.equal(state.requests.includes('getChatMemberCount'),false);
});

test('forwards and quotes use actual submitting sender; nested text and source IDs grant no input authority',async t=>{
  const {env,worker,state}=await setup(t);await subscribe(worker,env);
  const rejected=groupUpdate(110,30003);rejected.message.forward_origin={type:'user',sender_user:{id:10001,is_bot:false}};
  rejected.message.reply_to_message={from:{id:10001,is_bot:false},text:'Nested text must not be ingested'};
  await worker.fetch(telegramRequest(rejected),env);assert.equal(state.events.length,0);
  const accepted=groupUpdate(111,20002);accepted.message.forward_origin={type:'user',sender_user:{id:30003,is_bot:false}};
  accepted.message.reply_to_message=rejected.message.reply_to_message;
  await worker.fetch(telegramRequest(accepted),env);
  assert.equal(state.events.length,1);assert.equal(state.events[0].data.sender_id,'20002');assert.equal(state.events[0].data.text,'Shared group text');
  assert.equal(JSON.stringify(state.events).includes('Nested text'),false);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n,1);
});

test('retained incoming history and recovery reapply the current actual-sender allowlist',async t=>{
  const {env,worker,state}=await setup(t);await subscribe(worker,env);
  await worker.fetch(telegramRequest(groupUpdate(120)),env);
  const revision=(await env.DB.prepare('SELECT revision FROM group_access').first()).revision;
  await env.DB.prepare("INSERT INTO inbox(event_id,bot_id,update_id,chat_id,sender_id,message_id,text,occurred_at,received_at,group_revision) VALUES ('invalid-stored','123456',121,?,'30003',131,'Rejected stored input',?,?,?)")
    .bind(GROUP,new Date(NOW).toISOString(),NOW,revision).run();
  for(const include_outgoing of [false,true]) {
    const messages=(await call(worker,env,'get_recent_messages',{chat_id:GROUP,include_outgoing})).body.result.structuredContent.messages;
    assert.equal(messages.length,1);assert.equal(messages[0].sender_id,'20002');
  }
  await call(worker,env,'retry_pending_events',{chat_id:GROUP});assert.equal(state.events.length,1);
});

test('usable bot role changes do not pause but actual loss of text access does',async t=>{
  const {env,worker,state}=await setup(t);
  await worker.fetch(telegramRequest(membership(130,123456,'member')),env);
  assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.groups[0].state,'active');
  state.members.get(123456).status='member';state.chat.permissions.can_send_messages=false;
  assert.ok((await call(worker,env,'get_recent_messages',{chat_id:GROUP})).body.error);
  assert.equal((await call(worker,env,'get_connector_status')).body.result.structuredContent.groups[0].last_error,'group_access_unverified');
  state.members.get(123456).status='restricted';state.members.get(123456).is_member=true;state.members.get(123456).can_send_messages=true;
  assert.equal((await call(worker,env,'verify_group_access',{chat_id:GROUP})).body.result.structuredContent.state,'active');
});
