import { callbackUrl } from './callback-url.ts';
import { signature } from './crypto.ts';
import type { Env, Runtime } from './env.ts';

// Stored subscription fields used for delivery. Values come from D1 and stay
// unchecked here: callbackUrl and signature (via signingKey) validate them.
export interface CallbackSubscription {
  id: unknown;
  callback_url: unknown;
  secret: unknown;
  previous_secret?: unknown;
  rotation_until?: unknown;
}

// Signs and POSTs one Standard Webhooks payload. Redirects are never followed.
// During key rotation both signatures are sent. `guard` runs last, after signing,
// so a revocation observed at that point still prevents the request.
export async function sendCallback(
  subscription: CallbackSubscription,
  payload: Record<string, unknown>,
  env: Env,
  runtime: Runtime,
  guard?: (() => Promise<unknown>) | null,
): Promise<Response> {
  const url = callbackUrl(subscription.callback_url, env);
  const body = JSON.stringify(payload);
  const id = (payload.eventId as string) || 'verification_' + crypto.randomUUID();
  const timestamp = String(Math.floor(runtime.now() / 1000));
  const signatures = [await signature(subscription.secret, id, timestamp, body)];
  if (subscription.previous_secret && (subscription.rotation_until as number) > runtime.now())
    signatures.push(await signature(subscription.previous_secret, id, timestamp, body));
  if (guard) await guard();
  return runtime.fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signatures.join(' '),
      'X-MCP-Subscription-Id': subscription.id as string,
    },
    body,
  });
}
