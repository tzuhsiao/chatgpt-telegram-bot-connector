import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../worker/index.js';
import {environment,NOW,call,rpc,subscription,challengeResponse,update,telegramRequest,TestDatabase} from './helpers.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const CHAT='-1001234567890';
function incoming(id,thread=70) {
  const value=update(id,`Topic text ${id}`);value.message.chat={id:Number(CHAT),type:'supergroup',is_forum:true};
  value.message.from.id=20002;
  if(thread!==null){value.message.message_thread_id=thread;value.message.is_topic_message=thread!==1;}
  return value;
}
async function fixture(t,{forum=true}={}) {
  const env=environment();t.after(()=>env.DB.close());env.TELEGRAM_ALLOWED_GROUPS=JSON.stringify({[CHAT]:['10001','20002']});
  const state={time:NOW,forum,count:3,events:[],sends:[],fail:false,wrongThread:false,nextId:500,callbackStatus:204};
  const worker=createWorker({now:()=>state.time,fetch:async(url,init)=>{
    const args=JSON.parse(init.body),method=new URL(url).pathname.split('/').at(-1);let result;
    if(method==='events') {if(args.type==='verification')return challengeResponse(init);state.events.push(args);return new Response(null,{status:state.callbackStatus});}
    if(method==='getChat')result={id:Number(CHAT),type:'supergroup',...(state.forum?{is_forum:true}:{}),permissions:{can_invite_users:false}};
    else if(method==='getChatMemberCount')result=state.count;
    else if(method==='getChatMember')result={user:{id:args.user_id,is_bot:args.user_id===123456},status:args.user_id===123456?'administrator':'member'};
    else if(method==='sendMessage') {
      state.sends.push(args);if(state.fail)throw new Error('Synthetic ambiguity');
      result={message_id:state.nextId++,chat:{id:Number(args.chat_id)},...(args.message_thread_id?{message_thread_id:state.wrongThread?999:args.message_thread_id,is_topic_message:true}:{})};
    } else throw new Error(`Unexpected method ${method}`);
    return Response.json({ok:true,result});
  }});
  assert.equal((await call(worker,env,'verify_group_access',{chat_id:CHAT})).body.result?.structuredContent.state,'active');
  return {env,worker,state};
}
async function subscribe(worker,env){return (await(await worker.fetch(rpc('events/subscribe',subscription({arguments:{chat_id:CHAT},delivery:{...subscription().delivery,url:'https://callbacks.example.com/events'}})),env)).json());}
const args={chat_id:CHAT,message_thread_id:70,text:'A topic answer',idempotency_key:'topic-70-answer'};
const content=result=>result.body.result?.structuredContent;

test('forum topic and General events retain validated topic context through duplicates and retries',async t=>{
  const {env,worker,state}=await fixture(t);assert.ok((await subscribe(worker,env)).result.id);
  state.callbackStatus=503;await worker.fetch(telegramRequest(incoming(10)),env);state.callbackStatus=204;
  await call(worker,env,'retry_pending_events',{chat_id:CHAT});
  await worker.fetch(telegramRequest(incoming(10)),env);
  assert.equal(state.events.length,2);assert.deepEqual(state.events[0],state.events[1]);assert.equal(state.events[0].data.message_thread_id,70);
  await worker.fetch(telegramRequest(incoming(11,null)),env);
  assert.equal(state.events.at(-1).data.message_thread_id,1);
  const generalReply=incoming(12,null);generalReply.message.message_thread_id=123;generalReply.message.is_topic_message=false;
  await worker.fetch(telegramRequest(generalReply),env);assert.equal(state.events.at(-1).data.message_thread_id,1);
  assert.deepEqual((await env.DB.prepare('SELECT message_thread_id FROM inbox ORDER BY update_id').all()).results,[{message_thread_id:70},{message_thread_id:1},{message_thread_id:1}]);
});

test('topic sends require explicit routing; General omits Telegram thread argument without quoting',async t=>{
  const {env,worker,state}=await fixture(t);
  assert.ok((await call(worker,env,'send_message',{chat_id:CHAT,text:'Ambiguous destination',idempotency_key:'missing-thread'})).body.error);
  assert.equal(content(await call(worker,env,'send_message',args)).state,'sent');
  assert.equal(state.sends[0].message_thread_id,70);assert.equal(state.sends[0].reply_parameters,undefined);
  assert.equal(content(await call(worker,env,'send_message',{...args,message_thread_id:1,idempotency_key:'general-answer'})).state,'sent');
  assert.equal(state.sends[1].message_thread_id,undefined);
});

test('topic identity participates in idempotency and uncertain or misrouted responses never resend',async t=>{
  const {env,worker,state}=await fixture(t);
  await call(worker,env,'send_message',args);await call(worker,env,'send_message',args);assert.equal(state.sends.length,1);
  assert.equal((await call(worker,env,'send_message',{...args,message_thread_id:80})).body.error.code,-32004);
  state.wrongThread=true;const wrong={...args,idempotency_key:'wrong-response'};
  assert.equal(content(await call(worker,env,'send_message',wrong)).state,'uncertain');await call(worker,env,'send_message',wrong);assert.equal(state.sends.length,2);
  state.wrongThread=false;state.fail=true;const uncertain={...args,idempotency_key:'network-unknown'};
  assert.equal(content(await call(worker,env,'send_message',uncertain)).state,'uncertain');await call(worker,env,'send_message',uncertain);assert.equal(state.sends.length,3);
});

test('history isolates topics and can include only confirmed retained bot text with sender and role',async t=>{
  const {env,worker,state}=await fixture(t);await subscribe(worker,env);
  for(const [id,thread] of [[20,70],[21,80],[22,null]]) await worker.fetch(telegramRequest(incoming(id,thread)),env);
  assert.ok((await call(worker,env,'get_recent_messages',{chat_id:CHAT})).body.error);
  state.time+=1000;await call(worker,env,'send_message',args);
  const history=content(await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:70,include_outgoing:true})).messages;
  assert.deepEqual(history.map(m=>[m.role,m.sender_id,m.message_thread_id]),[['bot','123456',70],['user','20002',70]]);
  assert.equal(history[0].text,args.text);
  assert.equal(content(await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:80,include_outgoing:true})).messages.length,1);
  assert.equal(content(await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:1,include_outgoing:true})).messages[0].message_id,32);
  assert.equal(content(await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:70})).messages.length,1);
  state.fail=true;await call(worker,env,'send_message',{...args,idempotency_key:'unknown-history'});
  assert.equal(content(await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:70,include_outgoing:true})).messages.length,2);
});

test('invalid topic IDs and cross-topic or unretained quote targets fail before send',async t=>{
  const {env,worker,state}=await fixture(t);await subscribe(worker,env);
  await worker.fetch(telegramRequest(incoming(30,70)),env);await worker.fetch(telegramRequest(incoming(31,80)),env);
  for(const message_thread_id of [0,-1,1.5,'70',null,9007199254740992]) {
    assert.ok((await call(worker,env,'send_message',{...args,message_thread_id})).body.error);
    assert.ok((await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id})).body.error);
  }
  for(const reply_to_message_id of [41,999]) assert.ok((await call(worker,env,'send_message',{...args,reply_to_message_id})).body.error);
  assert.equal(state.sends.length,0);
  assert.equal(content(await call(worker,env,'send_message',{...args,reply_to_message_id:40})).state,'sent');
});

test('malformed named-topic ingress is rejected rather than rerouted to General',async t=>{
  const {env,worker,state}=await fixture(t);await subscribe(worker,env);
  for(const thread of [0,-1,'70',null,9007199254740992]) {
    const value=incoming(40);value.message.message_thread_id=thread;
    assert.equal((await worker.fetch(telegramRequest(value),env)).status,400);
  }
  assert.equal(state.events.length,0);
});

test('ordinary non-forum reply threads stay unthreaded and private topics remain unsupported',async t=>{
  const {env,worker,state}=await fixture(t,{forum:false});await subscribe(worker,env);
  const ordinary=incoming(50);delete ordinary.message.chat.is_forum;delete ordinary.message.is_topic_message;
  await worker.fetch(telegramRequest(ordinary),env);assert.equal(state.events[0].data.message_thread_id,undefined);
  assert.equal(content(await call(worker,env,'send_message',{chat_id:CHAT,text:'Legacy plain group',idempotency_key:'legacy-group'})).state,'sent');
  assert.ok((await call(worker,env,'send_message',args)).body.error);
  const privateTopic=update(60);privateTopic.message.is_topic_message=true;privateTopic.message.message_thread_id=70;
  await worker.fetch(telegramRequest(privateTopic),env);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE chat_id='10001'").first()).n,0);
  assert.ok((await call(worker,env,'send_message',{...args,chat_id:'10001'})).body.error);
});

test('forum mode changes and membership failures pause access and hide prior-epoch topic history',async t=>{
  const {env,worker,state}=await fixture(t);await subscribe(worker,env);await worker.fetch(telegramRequest(incoming(70)),env);
  await call(worker,env,'send_message',args);state.count=4;
  assert.ok((await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:70,include_outgoing:true})).body.error);
  state.count=3;await call(worker,env,'verify_group_access',{chat_id:CHAT});
  assert.deepEqual(content(await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:70,include_outgoing:true})).messages,[]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM sent_messages').first()).n,1);
  state.forum=false;assert.ok((await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:70})).body.error);
});

test('migration preserves legacy private idempotency and never invents pre-upgrade bot history',async t=>{
  const db=new TestDatabase(3);t.after(()=>db.close());const env=environment(db);
  const legacy={chat_id:'10001',text:'An older frozen reply',idempotency_key:'legacy-operation'};
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  await db.prepare("INSERT INTO outgoing(operation_key,request_hash,chat_id,state,message_id,created_at,updated_at) VALUES (?,?,'10001','sent',88,?,?)")
    .bind(hash(['owner-test','123456',legacy.idempotency_key]),hash(['10001',legacy.text,null]),NOW,NOW).run();
  db.sqlite.exec(readFileSync(new URL('../drizzle/0003_group_topics.sql',import.meta.url),'utf8'));
  const worker=createWorker({now:()=>NOW,fetch:async()=>{throw new Error('Legacy replay must not dispatch');}});
  assert.equal(content(await call(worker,env,'send_message',legacy)).reused,true);
  assert.deepEqual(content(await call(worker,env,'get_recent_messages',{chat_id:'10001',include_outgoing:true})).messages,[]);
});

test('concurrent duplicate topic sends dispatch once and General quotes cannot target another topic',async t=>{
  const {env,worker,state}=await fixture(t);await subscribe(worker,env);await worker.fetch(telegramRequest(incoming(80,70)),env);
  assert.ok((await call(worker,env,'send_message',{...args,message_thread_id:1,reply_to_message_id:90})).body.error);
  await Promise.all(Array.from({length:5},()=>call(worker,env,'send_message',args)));assert.equal(state.sends.length,1);
  assert.equal(content(await call(worker,env,'get_recent_messages',{chat_id:'10001',include_outgoing:true})).messages.length,0);
});

test('inconsistent forum payload mode pauses instead of silently admitting General',async t=>{
  const {env,worker,state}=await fixture(t);await subscribe(worker,env);
  const value=incoming(91,null);delete value.message.chat.is_forum;
  await worker.fetch(telegramRequest(value),env);assert.equal(state.events.length,0);
  assert.equal(content(await call(worker,env,'get_connector_status')).groups[0].state,'paused');
});

test('verified mode differences have a precise pause reason and paused forum calls still require a topic',async t=>{
  const {env,worker,state}=await fixture(t);state.forum=false;
  await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:70});
  assert.equal(content(await call(worker,env,'get_connector_status')).groups[0].last_error,'group_mode_changed');
  assert.ok((await call(worker,env,'send_message',{chat_id:CHAT,text:'Missing topic',idempotency_key:'paused-missing'})).body.error);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM outgoing').first()).n,0);
});

test('combined history uses message order rather than mixed Telegram and confirmation clocks',async t=>{
  const {env,worker}=await fixture(t);await subscribe(worker,env);
  const value=incoming(92,70);value.message.date+=120;await worker.fetch(telegramRequest(value),env);
  await call(worker,env,'send_message',args);
  const messages=content(await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:70,include_outgoing:true})).messages;
  assert.deepEqual(messages.map(m=>m.role),['bot','user']);
});

test('confirmed outgoing content expires in seven days while operation metadata retains its thirty-day window',async t=>{
  const {env,worker,state}=await fixture(t);await call(worker,env,'send_message',args);state.time+=8*86400000;
  assert.deepEqual(content(await call(worker,env,'get_recent_messages',{chat_id:CHAT,message_thread_id:70,include_outgoing:true})).messages,[]);
  await call(worker,env,'retry_pending_events',{chat_id:CHAT});
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM sent_messages').first()).n,0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM outgoing').first()).n,1);
});
