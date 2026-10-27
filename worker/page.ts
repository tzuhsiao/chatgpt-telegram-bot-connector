import { callerId } from './access.ts';
import type { Env } from './env.ts';

export function landingPage(): Response {
  const nonce = crypto.randomUUID();
  const html = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Telegram Bot Connector</title><meta name="description" content="An unofficial Telegram Bot connector primarily designed for dots, powered by MCP tools and events.">
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#18312c;background:#f5f6f1;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:40px 32px 64px}header{display:flex;justify-content:space-between;align-items:center;gap:24px;border-bottom:1px solid #d8dfd5;padding-bottom:24px}.brand{font-size:14px;font-weight:700;letter-spacing:.01em}.pill{font:11px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;border:1px solid #ccd5ca;border-radius:99px;padding:8px 12px}.hero{max-width:730px;margin:64px 0 44px}.eyebrow{font:12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.15em;color:#55735d}h1{font-size:clamp(36px,6vw,62px);letter-spacing:-.055em;line-height:1.06;margin:18px 0 24px;font-weight:600}.intro{font-size:18px;line-height:1.65;color:#597067;max-width:620px}.layout{display:grid;grid-template-columns:1.1fr 1fr;gap:22px}.card{border:1px solid #d8dfd5;background:#fffefb;border-radius:18px;padding:28px}h2{font-size:19px;margin:0 0 18px;letter-spacing:-.02em}p,li{line-height:1.65;color:#5c6d64;font-size:14px}ol{padding-left:20px;margin-bottom:0}li{padding:0 0 14px 7px}li:last-child{padding-bottom:0}code{font:12px ui-monospace,monospace;color:#244e3c;background:#eff3eb;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}.actions{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}button,.button{font:inherit;font-size:13px;font-weight:600;display:inline-block;padding:11px 16px;border:1px solid #274d3d;border-radius:8px;cursor:pointer;text-decoration:none;background:#274d3d;color:#fff}.secondary{background:transparent;color:#274d3d}button:disabled{opacity:.5;cursor:wait}button:focus-visible,a:focus-visible{outline:3px solid #9ec6a5;outline-offset:3px}.status{background:#eff3eb;border-radius:10px;padding:16px;margin-top:18px}.status p{margin:0}dl{display:grid;grid-template-columns:1fr auto;gap:12px;font-size:13px;margin:16px 0 0}dt{color:#5c6d64}dd{margin:0;font-variant-numeric:tabular-nums}pre{font:12px ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding:14px;background:#f0f3ed;border-radius:8px;color:#244e3c}.foot{display:flex;justify-content:space-between;gap:24px;font-size:12px;color:#758178;margin-top:30px}.foot a{color:inherit}#identity-area[hidden],#metrics[hidden]{display:none}@media(max-width:700px){main{padding:24px 20px 44px}.hero{margin:44px 0 32px}.layout{grid-template-columns:1fr}.card{padding:23px}header{align-items:flex-start}.foot{flex-direction:column;gap:10px}.pill{white-space:nowrap;font-size:10px}}
</style></head><body><main>
<header><div class="brand">Telegram Bot Connector</div><span class="pill">Unofficial · Experimental</span></header>
<section class="hero"><div class="eyebrow">MCP tools + events</div><h1>Your bot.<br>A direct line to your dot.</h1><p class="intro">A bridge in your own ChatGPT Sites account for your dot and private Telegram bot. The Site holds connector records; the plugin gives your dot its tools.</p></section>
<div class="layout"><section class="card"><h2>Connect with care</h2><ol><li>Start with an owner-private Site. Call <code>get_connector_identity</code> from ChatGPT and configure the verified owner ID.</li><li>Configure allowed IDs and review the callback origin from a genuine subscription attempt. Verify the public authentication boundary and subscription lifecycle before adding bot credentials.</li><li>Add a dedicated bot token and independent webhook secret in Sites runtime settings. Never paste credentials into this page.</li><li>Subscribe to <code>telegram.message.received</code>, then call <code>configure_telegram_webhook</code> when ready. With consent and confirmed reachability, send one welcome; otherwise use Start or a new message. Verify incoming events and replies separately.</li></ol></section>
<section class="card"><h2>Deployment status</h2><p>Sign in to inspect your own identity. Operational details are available only to the configured owner.</p><div class="actions"><a class="button" href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a><button id="refresh" class="secondary" type="button">Refresh status</button></div><div class="status" role="status" aria-live="polite"><p id="status-text">Checking your session…</p></div><div id="identity-area" hidden><p>Your Site-scoped caller ID:</p><pre id="identity"></pre><p>This is not a Telegram ID. Owner configuration is changed only through Sites runtime settings.</p></div><dl id="metrics" hidden></dl></section></div>
<footer class="foot"><span>Text replies + experimental image retrieval · Private chats + approved groups</span><span>Not affiliated with or endorsed by OpenAI or Telegram.</span></footer>
</main><script nonce="${nonce}">
const statusText=document.getElementById('status-text');
const refresh=document.getElementById('refresh');
async function updateStatus(){
 refresh.disabled=true;
 document.getElementById('metrics').hidden=true;
 document.getElementById('identity-area').hidden=true;
 try{
  const identityResponse=await fetch('/api/identity',{credentials:'same-origin',cache:'no-store'});
  if(!identityResponse.ok)throw new Error('Session check failed.');
  const identity=await identityResponse.json();
  if(!identity.authenticated){statusText.textContent='Sign in with ChatGPT to continue. The public page exposes no bot data.';return;}
  document.getElementById('identity-area').hidden=false;
  document.getElementById('identity').textContent=identity.caller_user_id;
  if(!identity.owner_configured){statusText.textContent='Owner setup is required. Bot operations are disabled until configuration is complete.';return;}
  if(!identity.is_owner){statusText.textContent='This signed-in account is not the configured connector owner.';return;}
  const response=await fetch('/api/status',{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw new Error('Status is unavailable. Check the deployment configuration.');
  const result=await response.json();
  const ready=Object.values(result.configured).every(Boolean);
  statusText.textContent=ready?'Configuration is present. Verify a real message round trip before relying on this connector.':'Setup is incomplete. Configure the missing runtime settings before enabling Telegram.';
  const metrics=document.getElementById('metrics');metrics.replaceChildren();
  const entries=[['Active subscriptions',result.active_subscriptions],['Pending deliveries',result.pending_deliveries],['Automatic retries exhausted',result.retry_exhausted_deliveries],['Failed deliveries',result.failed_deliveries],['Uncertain sends',result.uncertain_sends],['Uncertain reactions',result.uncertain_reactions]];
  for(const [label,value] of entries){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(value);metrics.append(dt,dd);}metrics.hidden=false;
 }catch(error){statusText.textContent='Status could not be loaded. Sign in again or inspect the private deployment settings.';}
 finally{refresh.disabled=false;}
}
refresh.addEventListener('click',updateStatus);updateStatus();
</script></body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'`,
    },
  });
}

export function identityFor(request: { headers: Headers }, env: Env) {
  const caller = callerId(request);
  return {
    authenticated: !!caller,
    caller_user_id: caller,
    owner_configured: !!env.OWNER_USER_ID,
    is_owner: !!caller && caller === env.OWNER_USER_ID,
  };
}
