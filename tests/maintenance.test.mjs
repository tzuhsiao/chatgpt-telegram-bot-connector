import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createWorker} from '../worker/index.js';
import {publicSource} from '../scripts/public-source.mjs';
import {NOW,environment,call,rpc,subscription} from './helpers.mjs';

const args={chat_id:'10001',text:'Synthetic text',idempotency_key:'frozen-test'};
const getDiagnostic=result=>result.body.error?.data.diagnostics??result.body.result.structuredContent.diagnostics;

test('MCP diagnostics separate invocation, configuration, permission and unknown without private data',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const worker=createWorker({now:()=>NOW,fetch:async()=>{throw new Error('PRIVATE_EXCEPTION_TOKEN');}});
  const invalid=await call(worker,env,'send_message',{...args,text:''});
  assert.equal(getDiagnostic(invalid).category,'invocation');assert.equal(getDiagnostic(invalid).operation_state,'not_started');
  const forbidden=await call(worker,env,'send_message',{...args,chat_id:'999'});
  assert.equal(getDiagnostic(forbidden).category,'permission');
  const config=await call(worker,{...env,TELEGRAM_BOT_TOKEN:''},'send_message',args);
  assert.equal(getDiagnostic(config).category,'configuration');
  const internal=await call(worker,{...env,DB:{prepare(){throw new Error('PRIVATE_EXCEPTION_TOKEN');}}},'get_connector_status');
  assert.equal(getDiagnostic(internal).category,'unknown');assert.equal(getDiagnostic(internal).retry.safe,true);
  const serialized=JSON.stringify([invalid,forbidden,config,internal].map(getDiagnostic));
  assert.doesNotMatch(serialized,/10001|999|Synthetic text|frozen-test|owner-test|PRIVATE_EXCEPTION_TOKEN|synthetic-token|connector.example/);
  for(const result of [invalid,forbidden,config,internal]) {
    const diagnostic=getDiagnostic(result);
    assert.match(diagnostic.correlation_id,/^diag_[0-9a-f-]{36}$/);
    assert.equal(diagnostic.source_version,'unbuilt');assert.equal(diagnostic.schema_version,1);
  }
  assert.equal(new Set([invalid,forbidden,config,internal].map(r=>getDiagnostic(r).correlation_id)).size,4);
});

test('send diagnostics preserve frozen replay, failed cause, conflicts and ambiguous outcomes',async t=>{
  const env=environment();t.after(()=>env.DB.close());let requests=0;
  const worker=createWorker({now:()=>NOW,fetch:async()=>{requests++;throw new Error('PRIVATE');}});
  for(let i=0;i<2;i++) {
    const result=await call(worker,env,'send_message',args),d=getDiagnostic(result);
    assert.equal(result.body.result.structuredContent.state,'uncertain');assert.equal(d.operation_state,'uncertain');
    assert.deepEqual(d.retry,{safe:false,action:'reconcile_privately'});
    assert.equal(JSON.parse(result.body.result.content[0].text).diagnostics.correlation_id,d.correlation_id);
  }
  const conflict=getDiagnostic(await call(worker,env,'send_message',{...args,text:'Changed'}));
  assert.equal(conflict.reason,'idempotency_conflict');assert.equal(conflict.retry.safe,false);assert.equal(requests,1);
  const rejected=createWorker({now:()=>NOW,fetch:async()=>{requests++;return Response.json({ok:false,error_code:403,description:'PRIVATE_UPSTREAM'},{status:403});}});
  for(let i=0;i<2;i++) {
    const result=await call(rejected,env,'send_message',{...args,idempotency_key:'failed-test'});
    assert.equal(getDiagnostic(result).category,'permission');assert.equal(getDiagnostic(result).operation_state,'failed');
    assert.equal(getDiagnostic(result).retry.safe,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_UPSTREAM/);
  }
  assert.equal(requests,2);
  const unauthorized=createWorker({now:()=>NOW,fetch:async()=>Response.json({ok:false,error_code:401,description:'PRIVATE_CREDENTIAL_DETAIL'},{status:401})});
  for(let i=0;i<2;i++)assert.equal(getDiagnostic(await call(unauthorized,env,'send_message',{...args,idempotency_key:'credential-test'})).category,'configuration');
});

test('exceptions after possible mutation never advertise safe retry',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const broken={...env,DB:{prepare(){throw new Error('private-db-context');}}};
  for(const name of ['send_message','configure_telegram_webhook','pause_group_access','retry_pending_events']) {
    const d=getDiagnostic(await call(createWorker(),broken,name,args));
    assert.equal(d.operation_state,'unknown');assert.deepEqual(d.retry,{safe:false,action:'reconcile_privately'});
  }
});

test('event diagnostics correlate safe failures and omit attacker-controlled key names',async t=>{
  const env=environment();t.after(()=>env.DB.close());env.MCP_DIAGNOSTICS='1';
  const records=[],log=console.info;console.info=(...parts)=>records.push(parts.join(' '));t.after(()=>{console.info=log;});
  const response=await createWorker().fetch(rpc('events/subscribe',{...subscription(),PRIVATE_KEY_CONTAINING_CONVERSATION:'PRIVATE_VALUE'}),env);
  const result=await response.json();
  assert.equal(result.error.data.diagnostics.operation_state,'unknown');
  assert.doesNotMatch(records.join(' '),/PRIVATE_KEY|PRIVATE_VALUE|opaque-test-path|whsec_|owner-test/);
  const rejected=JSON.parse(records.find(r=>r.includes('rejected')).slice('mcp_event_diagnostic '.length));
  assert.equal(rejected.diagnostics.correlation_id,result.error.data.diagnostics.correlation_id);
  const callback=await createWorker({fetch:async()=>Response.json({challenge:'wrong'})}).fetch(rpc('events/subscribe',subscription()),env);
  const body=await callback.json();assert.equal(body.error.data.reason,'challenge_failed');
  assert.equal(body.error.data.diagnostics.category,'platform');
});

test('tool discovery exposes maintenance without changing names or image contract',async t=>{
  const env=environment();t.after(()=>env.DB.close());
  const response=await createWorker().fetch(rpc('tools/list'),env),body=await response.json();
  assert.equal(body.result.tools.length,9);
  for(const tool of body.result.tools) assert.match(tool.description,/telegram-maintenance/);
  const media=body.result.tools.find(tool=>tool.name==='get_message_media');
  assert.deepEqual(media.inputSchema.required,['chat_id','message_id','update_id']);
});

test('public source fingerprints exclude private manifests and change with public runtime inputs',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'maintenance-source-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const name of ['worker','drizzle','scripts','.agents']) await cp(new URL('../'+name,import.meta.url),join(dir,name),{recursive:true});
  const first=await publicSource(dir);
  const original=await readFile(join(dir,'worker/index.js'),'utf8');
  await writeFile(join(dir,'worker/index.js'),original.replaceAll('\n','\r\n'));
  assert.deepEqual(await publicSource(dir),first);await writeFile(join(dir,'worker/index.js'),original);
  await mkdir(join(dir,'.openai'));await writeFile(join(dir,'.openai/hosting.json'),'PRIVATE_DEPLOYMENT');
  assert.deepEqual(await publicSource(dir),first);
  await writeFile(join(dir,'worker/index.js'),(await readFile(join(dir,'worker/index.js'),'utf8'))+'\n// Synthetic change\n');
  assert.notEqual((await publicSource(dir)).version,first.version);
  assert.doesNotMatch(JSON.stringify(first),/PRIVATE_DEPLOYMENT|project_id/);
});

test('plugin overlay preserves App configuration, prompts and legacy metadata; refuses overwrite',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'maintenance plugin with spaces-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,'source'),output=join(dir,'output');await mkdir(join(source,'.codex-plugin'),{recursive:true});
  const original={name:'synthetic-plugin',version:'1.2.3',extensions:{'com.openai':{apps:'./.app.json',interface:{defaultPrompt:['First','Second'],displayName:'Synthetic'}}}};
  const legacy={name:original.name,version:original.version,mcpServers:'./.mcp.json',interface:{defaultPrompt:['Legacy','Prompt']}};
  await writeFile(join(source,'plugin.json'),JSON.stringify(original));await writeFile(join(source,'.codex-plugin/plugin.json'),JSON.stringify(legacy));
  const script=new URL('../scripts/prepare-maintenance-plugin.mjs',import.meta.url);
  execFileSync(process.execPath,[fileURLToPath(script),source,output]);
  assert.deepEqual(JSON.parse(await readFile(join(output,'plugin.json'),'utf8')),{...original,version:'1.2.4'});
  assert.deepEqual(JSON.parse(await readFile(join(output,'.codex-plugin/plugin.json'),'utf8')),{...legacy,version:'1.2.4'});
  assert.equal(await readFile(join(output,'skills/telegram-maintenance/SKILL.md'),'utf8'),await readFile(new URL('../.agents/skills/telegram-maintenance/SKILL.md',import.meta.url),'utf8'));
  assert.throws(()=>execFileSync(process.execPath,[fileURLToPath(script),source,output],{stdio:'pipe'}),/Output directory must not exist/);
  assert.equal(JSON.parse(await readFile(join(source,'plugin.json'),'utf8')).version,'1.2.3');
  await writeFile(join(source,'plugin.json'),JSON.stringify({...original,skills:'./custom-skills'}));
  assert.throws(()=>execFileSync(process.execPath,[fileURLToPath(script),source,join(dir,'invalid')],{stdio:'pipe'}),/unsupported portable skill declarations/);
});

test('owner and protocol rejection before dispatch reports not_started without touching storage',async()=>{
  const env={OWNER_USER_ID:'owner-test',DB:{prepare(){throw new Error('Storage must not be touched.');}}};
  for(const params of [{name:'configure_telegram_webhook'},{name:'retry_pending_events'},{name:'get_message_media'}]) {
    const response=await createWorker().fetch(rpc('tools/call',params,'not-owner'),env);
    const body=await response.json();assert.equal(body.error.code,-32001);
    assert.equal(body.error.data.diagnostics.operation_state,'not_started');assert.equal(body.error.data.diagnostics.retry.safe,false);
  }
  const response=await createWorker().fetch(rpc('events/subscribe',subscription(),'not-owner'),env);
  assert.equal((await response.json()).error.data.diagnostics.operation_state,'not_started');
});
