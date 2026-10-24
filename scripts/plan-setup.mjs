import {pathToFileURL} from 'node:url';

// Observations only. No host inspection, authorization, persistence or network I/O.
const fields = {
  inventory:['unknown','empty','reuse','stale','ambiguous'],
  installation:['unknown','fresh','existing'],
  site:['unknown','missing','ready'],plugin:['unknown','missing','pending','ready'],
  owner:['unknown','missing','verified','configured','mismatch'],
  telegramId:['unknown','missing','valid','invalid'],allowlists:['unknown','missing','match','conflict'],
  callback:['unknown','missing','candidate','trusted','unverifiable'],
  subscription:['unknown','missing','single','stale','conflict'],
  hostedGates:['unknown','pending','passed','failed'],
  botToken:['unknown','missing','present'],webhookSecret:['unknown','missing','present'],
  webhook:['unknown','absent','ours','other'],policy:['unknown','missing','ready','conflict'],
  verification:['unknown','pending','passed'],operation:['unknown','idle','uncertain'],
  secretEntry:['unknown','unavailable','native'],secretGeneration:['unknown','native','manual'],
};
const invalid = 'Invalid setup evidence. Use only documented enum observations.';
const next = (status,checkpoint,reason)=>({status,checkpoint,reason});
const gap = reason=>next('blocked','verification_gap',reason+' Use read-only checks; do not run lifecycle tests or re-register a live webhook.');

export function planSetup(evidence = {}) {
  if(!evidence || typeof evidence!=='object' || Array.isArray(evidence) ||
    Object.entries(evidence).some(([key,value])=>!Object.hasOwn(fields,key)||!fields[key].includes(value))) {
    throw new Error(invalid);
  }
  const e=Object.fromEntries(Object.entries(fields).map(([key,values])=>[key,evidence[key]??values[0]]));

  if(e.operation==='uncertain') return next('blocked','reconcile_operation','Inspect the previous operation outcome before retrying any mutation.');
  if(['unknown','stale','ambiguous'].includes(e.inventory)) return next('blocked','inventory','Complete Site, canonical plugin and responder inventory; reconcile stale or ambiguous references.');
  if(e.operation!=='idle') return next('blocked','reconcile_operation','Confirm there is no unresolved operation before suggesting any mutation.');
  if(e.inventory==='empty' && (e.site==='ready'||['ready','pending'].includes(e.plugin)||e.subscription==='single')) return next('blocked','inventory','Refresh inventory after creation; correlate the returned Site and use reuse rather than the old empty observation.');
  if(['stale','conflict'].includes(e.subscription)) return next('blocked','reconcile_subscription','Resolve the existing task and subscription with owner approval before creating a responder.');
  if(e.owner==='mismatch') return next('blocked','owner_conflict','The verified caller is not the configured owner. Do not overwrite ownership.');
  if(e.telegramId==='invalid') return next('blocked','telegram_id','Obtain a positive safe-integer Telegram user ID as a string through private configuration.');
  if(e.allowlists==='conflict') return next('blocked','allowlists','Reconcile the private sender and chat allowlists without broadening access.');
  if(e.hostedGates==='failed') return next('blocked','hosted_gates','Repair the hosted authentication or subscription failure without weakening checks.');
  if(e.webhook==='other') return next('blocked','webhook_conflict','Prefer a new dedicated bot, or obtain approval for owner-performed removal of the old webhook through a trusted secret-safe management path.');
  if(e.policy==='conflict') return next('blocked','policy_conflict','Reconcile the existing responder policy; do not create another task.');
  if(e.callback==='unverifiable') return next('blocked','callback_review','Trusted correlation is unavailable. Owner approval cannot replace independent callback-origin evidence.');
  if(e.installation==='unknown') return next('action_required','installation','Establish whether this is a proven fresh empty deployment or a previously used installation.');
  if(e.inventory==='reuse' && e.site==='missing') return next('blocked','inventory','The referenced installation has no verified Site. Reconcile stale resources before creation.');

  if(e.site==='unknown') return next('action_required','inspect_site','Inspect the selected Site state before deciding to create or reuse it.');
  if(e.site==='missing') {
    if(e.installation!=='fresh') return next('blocked','inventory','Reconcile the missing existing Site before considering a fresh installation.');
    return next('approval_required','site','Create one owner-private Site only after complete empty inventory; persist its returned identity privately.');
  }
  if(e.plugin==='unknown') return next('action_required','inspect_plugin','Inspect the Site canonical plugin connection before suggesting installation.');
  if(e.plugin==='missing') return next('action_required','plugin','Retrieve and connect this Site canonical plugin. Do not create a separate plugin.');
  if(e.plugin==='pending') return next('pending','plugin_tools','Wait or reconnect the existing plugin; verify a read-only MCP call.');
  if(['unknown','missing'].includes(e.owner)) return next('action_required','identity','Obtain the Site-scoped identity through a genuine authenticated MCP call.');
  if(e.owner==='verified') return next('approval_required','owner_config','Set the verified owner through native private runtime controls, then verify owner-only status.');
  if(['unknown','missing'].includes(e.telegramId)) return next('user_required','telegram_id','Guide private entry of the numeric Telegram user ID; never request a token in chat.');
  if(e.allowlists==='unknown') return next('action_required','inspect_allowlists','Inspect both private allowlists through native private configuration without changing them.');
  if(e.allowlists==='missing') return next('approval_required','allowlists','Set both private sender and chat allowlists to the confirmed Telegram user ID.');
  if(e.subscription==='unknown') return next('action_required','inspect_subscription','Inspect private task and subscription state before a create or callback probe.');
  if(e.callback==='unknown') return next('action_required','inspect_callback','Inspect callback configuration and recorded trust evidence without changing the subscription.');
  if(e.callback==='missing') {
    if(e.subscription==='single'||e.installation==='existing') return gap('Callback trust evidence is missing for an existing installation or subscription.');
    return next('approval_required','callback_probe','Use one genuine authenticated subscription attempt, then inspect task state and origin-only status before any retry.');
  }
  if(e.callback==='candidate') return next('action_required','callback_review','Independently correlate the candidate with the genuine authenticated request. Approval alone is insufficient; configure the exact origin only after evidence and write approval.');
  if(e.subscription==='missing') return next('approval_required','subscription','Create or resume exactly one authenticated task with a string chat filter; confirm its subscription.');
  if(e.botToken==='unknown'||e.webhookSecret==='unknown') return next('action_required','inspect_credentials','Inspect redacted presence of each secret without reading or exposing values.');
  if(e.hostedGates!=='passed') {
    if(e.installation==='existing'||e.botToken==='present'||e.webhookSecret==='present'||e.webhook==='ours') return gap('Hosted acceptance evidence is absent or secrets were assigned too early. For a proven fresh deployment, obtain owner approval to remove early secrets in native settings, apply the revision and re-inspect before gates.');
    return next('action_required','hosted_gates','Complete hosted identity, persistence and subscription lifecycle gates on the new empty deployment before adding secrets.');
  }
  if(e.botToken==='missing'||e.webhookSecret==='missing') {
    if(e.secretEntry!=='native') return next('blocked','secure_entry','Protected entry is unavailable or unverified. Have the owner use native Sites secret controls and securely generate any missing independent webhook secret, then re-read redacted state.');
    if(e.webhookSecret==='missing' && e.secretGeneration!=='native') return next('user_required','webhook_secret','Secret-safe generation is unavailable or unverified. The owner must generate and enter an independent webhook secret through native controls.');
    return next('approval_required','credentials','Use protected entry for missing secrets only; preserve existing credentials and obtain configuration approval.');
  }
  if(e.webhook==='unknown'||e.webhook==='absent') {
    if(e.installation==='existing') return gap('The existing webhook destination is absent or unverified.');
    return next('approval_required','webhook_register','Use configure_telegram_webhook after owner approval; it checks bot identity and refuses another webhook before registering this Site fixed URL.');
  }
  if(e.policy==='unknown') return next('action_required','inspect_policy','Read the existing single task policy and authorization without changing it.');
  if(e.policy==='missing') return next('approval_required','policy','Configure the existing responder with normal-chat policy and explicit reply authorization.');
  if(e.verification==='unknown' && e.installation==='existing') return gap('Real-message acceptance has not been observed or recorded.');
  if(e.verification!=='passed') return next('user_required','round_trip','Obtain approval for real-message acceptance; have the owner Start the bot and send new private text, then verify event and authorized reply.');
  return next('verified','complete','Required observations were supplied. Report hosted and real-message evidence separately from local tests.');
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    let input='';
    for await(const chunk of process.stdin) {
      input+=chunk;
      if(input.length>8192) throw new Error(invalid);
    }
    process.stdout.write(JSON.stringify(planSetup(JSON.parse(input)))+'\n');
  } catch {
    // Neither parser errors nor rejected values may enter diagnostics.
    process.stderr.write(invalid+'\n');
    process.exitCode=1;
  }
}
