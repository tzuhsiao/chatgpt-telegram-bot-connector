import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {planSetup} from '../scripts/plan-setup.mjs';

const complete = {
  inventory:'reuse',installation:'existing',site:'ready',plugin:'ready',owner:'configured',
  telegramId:'valid',allowlists:'match',callback:'trusted',subscription:'single',
  hostedGates:'passed',botToken:'present',webhookSecret:'present',webhook:'ours',policy:'ready',
  verification:'passed',operation:'idle',secretEntry:'native',secretGeneration:'native',
};
const fresh = {...complete,installation:'fresh',botToken:'missing',webhookSecret:'missing',
  webhook:'absent',policy:'missing',verification:'pending'};
const checkpoint = (values)=>planSetup({...complete,...values}).checkpoint;

test('fresh setup installs Site and canonical plugin before asking for owner inputs',()=>{
  assert.equal(planSetup({}).checkpoint,'inventory');
  assert.equal(planSetup({inventory:'empty',operation:'idle',installation:'fresh',site:'missing'}).checkpoint,'site');
  assert.equal(checkpoint({plugin:'missing',telegramId:'missing'}),'plugin');
  assert.equal(checkpoint({plugin:'pending',telegramId:'missing'}),'plugin_tools');
  assert.equal(checkpoint({owner:'missing',telegramId:'missing'}),'identity');
  assert.equal(checkpoint({owner:'verified',telegramId:'missing'}),'owner_config');
  assert.equal(checkpoint({telegramId:'missing'}),'telegram_id');
});

test('resumption blocks uncertain outcomes, incomplete inventory, stale or ambiguous resources',()=>{
  assert.equal(checkpoint({operation:'uncertain',site:'missing'}),'reconcile_operation');
  for(const inventory of ['unknown','stale','ambiguous']) {
    assert.equal(checkpoint({inventory,site:'missing'}),'inventory');
  }
  for(const subscription of ['stale','conflict']) {
    assert.equal(checkpoint({subscription,site:'missing'}),'reconcile_subscription');
  }
  assert.equal(checkpoint({inventory:'empty',site:'ready'}),'inventory');
  assert.equal(checkpoint({site:'missing',plugin:'missing',subscription:'missing'}),'inventory');
});

test('omitted observations never authorize duplicate creates or false completion',()=>{
  const {operation,...unobservedOperation}=complete;
  assert.equal(planSetup(unobservedOperation).checkpoint,'reconcile_operation');
  assert.equal(planSetup({inventory:'empty',installation:'fresh',site:'missing'}).checkpoint,'reconcile_operation');
  const {callback,...unobservedCallback}=complete;
  assert.equal(planSetup(unobservedCallback).checkpoint,'inspect_callback');
  const {subscription,...unobservedSubscription}=complete;
  assert.equal(planSetup(unobservedSubscription).checkpoint,'inspect_subscription');
  assert.equal(planSetup({inventory:'empty',operation:'idle',site:'missing'}).checkpoint,'installation');
});

test('security conflicts block creation and cannot be bypassed by complete settings',()=>{
  for(const [field,value,expected] of [
    ['owner','mismatch','owner_conflict'],['telegramId','invalid','telegram_id'],
    ['allowlists','conflict','allowlists'],['hostedGates','failed','hosted_gates'],
    ['webhook','other','webhook_conflict'],['policy','conflict','policy_conflict'],
  ]) {
    const result=planSetup({...complete,[field]:value,site:'missing'});
    assert.equal(result.status,'blocked');
    assert.equal(result.checkpoint,expected);
  }
});

test('callback candidate requires independent evidence; approval does not establish trust',()=>{
  assert.equal(planSetup({...fresh,callback:'missing',subscription:'missing'}).checkpoint,'callback_probe');
  const candidate=planSetup({...fresh,callback:'candidate',subscription:'missing'});
  assert.equal(candidate.checkpoint,'callback_review');
  assert.equal(candidate.status,'action_required');
  assert.equal(checkpoint({callback:'unverifiable'}),'callback_review');
  assert.equal(planSetup({...complete,callback:'unverifiable'}).status,'blocked');
  assert.equal(planSetup({...fresh,subscription:'missing'}).checkpoint,'subscription');
});

test('existing subscriptions with missing callback evidence never start another probe',()=>{
  assert.equal(checkpoint({callback:'missing'}),'verification_gap');
  assert.equal(planSetup({...fresh,callback:'missing'}).checkpoint,'verification_gap');
});

test('live resume with missing hosted evidence or unknown webhook stays read-only',()=>{
  assert.equal(checkpoint({hostedGates:'pending'}),'verification_gap');
  assert.equal(checkpoint({webhook:'unknown'}),'verification_gap');
  assert.equal(checkpoint({webhook:'absent'}),'verification_gap');
  assert.equal(checkpoint({hostedGates:'unknown'}),'verification_gap');
  const premature=planSetup({...fresh,hostedGates:'pending',botToken:'present'});
  assert.equal(premature.checkpoint,'verification_gap');
  assert.equal(premature.status,'blocked');
});

test('fresh setup gates precede credentials and guarded webhook registration',()=>{
  assert.equal(planSetup({...fresh,hostedGates:'pending'}).checkpoint,'hosted_gates');
  assert.equal(planSetup({...fresh,secretEntry:'unavailable'}).checkpoint,'secure_entry');
  assert.equal(planSetup(fresh).checkpoint,'credentials');
  assert.equal(planSetup({...fresh,botToken:'present',webhookSecret:'present',webhook:'unknown'}).checkpoint,'webhook_register');
});

test('token and webhook secret presence and generation capability are separate observations',()=>{
  assert.equal(planSetup({...fresh,botToken:'present',webhookSecret:'missing'}).checkpoint,'credentials');
  assert.equal(planSetup({...fresh,secretGeneration:'manual'}).checkpoint,'webhook_secret');
  assert.equal(planSetup({...fresh,botToken:'present',webhookSecret:'present',secretGeneration:'manual'}).checkpoint,'webhook_register');
  const {webhookSecret,...unknownSecret}=fresh;
  assert.equal(planSetup(unknownSecret).checkpoint,'inspect_credentials');
});

test('a completed installation does not mutate or claim unobserved real-message verification',()=>{
  assert.equal(checkpoint({allowlists:'missing'}),'allowlists');
  assert.equal(checkpoint({policy:'missing'}),'policy');
  assert.equal(checkpoint({verification:'pending'}),'round_trip');
  assert.equal(planSetup(complete).status,'verified');
  assert.equal(checkpoint({secretEntry:'unavailable',secretGeneration:'manual'}),'complete');
});

test('planner accepts only enum observations and never echoes rejected secret-like input',()=>{
  const sensitive='synthetic-do-not-echo';
  for(const evidence of [null,[],{token:sensitive},{owner:sensitive},{operation:true},{...complete,version:1}]) {
    assert.throws(()=>planSetup(evidence),error=>{
      assert.equal(error.message,'Invalid setup evidence. Use only documented enum observations.');
      return !error.message.includes(sensitive);
    });
  }
  const evidence={...complete}; planSetup(evidence); assert.deepEqual(evidence,complete);
});

const welcomeReady = {...complete,installation:'fresh',verification:'pending',
  welcomeRecord:'ready',welcomeConsent:'granted',welcomeReachability:'confirmed'};

test('welcome planning needs durable frozen state, exact-chat consent and confirmed reachability',()=>{
  assert.equal(planSetup(welcomeReady).checkpoint,'welcome_send');
  assert.equal(planSetup({...welcomeReady,welcomeConsent:'unknown'}).checkpoint,'welcome_consent');
  for(const welcomeReachability of ['unknown','needs_start','unavailable']) {
    assert.equal(planSetup({...welcomeReady,welcomeReachability}).checkpoint,'round_trip');
  }
  assert.equal(planSetup({...welcomeReady,welcomeConsent:'declined'}).checkpoint,'round_trip');
  assert.equal(planSetup({...welcomeReady,welcomeRecord:'unknown'}).checkpoint,'inspect_welcome');
  assert.equal(planSetup({...welcomeReady,welcomeRecord:'unavailable'}).checkpoint,'round_trip');
  assert.equal(planSetup({...welcomeReady,installation:'existing',welcomeRecord:'unknown'}).checkpoint,'round_trip');
});

test('welcome success is not incoming verification and repeated setup never welcomes again',()=>{
  const sent=planSetup({...welcomeReady,welcomeRecord:'sent'});
  assert.equal(sent.checkpoint,'round_trip');
  assert.notEqual(sent.status,'verified');
  assert.equal(planSetup({...welcomeReady,verification:'passed'}).checkpoint,'complete');
  assert.equal(planSetup({...complete,welcomeRecord:'sent'}).checkpoint,'complete');
});

test('welcome failure does not retry; in-flight and uncertain welcome require reconciliation',()=>{
  assert.equal(planSetup({...welcomeReady,welcomeRecord:'failed'}).checkpoint,'round_trip');
  for(const welcomeRecord of ['sending','uncertain']) {
    const result=planSetup({...welcomeReady,welcomeRecord});
    assert.equal(result.checkpoint,'welcome_review');
    assert.equal(result.status,'blocked');
  }
  assert.equal(planSetup({...welcomeReady,owner:'mismatch'}).checkpoint,'owner_conflict');
  assert.equal(planSetup({...welcomeReady,allowlists:'conflict'}).checkpoint,'allowlists');
  assert.equal(planSetup({...welcomeReady,operation:'uncertain'}).checkpoint,'reconcile_operation');
});

test('choosing Start fallback permanently skips welcome even after reachability becomes confirmed',()=>{
  const fallback=planSetup({...welcomeReady,welcomeReachability:'needs_start'});
  assert.equal(fallback.checkpoint,'round_trip');
  assert.equal(fallback.recordWelcomeAs,'skipped');
  const resumed=planSetup({...welcomeReady,welcomeRecord:fallback.recordWelcomeAs});
  assert.equal(resumed.checkpoint,'round_trip');
  assert.notEqual(resumed.checkpoint,'welcome_send');
  assert.equal(planSetup({...welcomeReady,installation:'existing'}).checkpoint,'welcome_send');
  assert.equal(planSetup({...welcomeReady,installation:'existing',welcomeRecord:'unknown'}).recordWelcomeAs,'skipped');
});

test('CLI reads observations from stdin and redacts malformed, oversized or unexpected input',()=>{
  const run=input=>spawnSync(process.execPath,['scripts/plan-setup.mjs'],{input,encoding:'utf8'});
  const ok=run(JSON.stringify(complete));
  assert.equal(ok.status,0); assert.equal(JSON.parse(ok.stdout).checkpoint,'complete');
  for(const input of ['{"token":"synthetic-do-not-echo"}','synthetic-do-not-echo','x'.repeat(9000)]) {
    const failure=run(input); assert.equal(failure.status,1);
    assert.ok(!failure.stdout.includes('synthetic-do-not-echo'));
    assert.ok(!failure.stderr.includes('synthetic-do-not-echo'));
  }
});
