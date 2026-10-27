import { requireOwner } from './access.ts';
import { AppError } from './errors.ts';
import { json } from './http.ts';
import { telegramWebhook } from './ingress.ts';
import { mcp } from './mcp.ts';
import { identityFor, landingPage } from './page.ts';
import { connectorStatus } from './status.ts';

// workerd's native fetch requires its global receiver even when stored on runtime.
export function createWorker({
  fetch: networkFetch = globalThis.fetch.bind(globalThis),
  now = Date.now,
} = {}) {
  return {
    async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (path === '/' && request.method === 'GET') return landingPage();
      if (path === '/favicon.ico' && request.method === 'GET')
        return new Response(null, { status: 204 });
      if (path === '/api/identity' && request.method === 'GET')
        return json(identityFor(request, env));
      if (path === '/api/status' && request.method === 'GET') {
        try {
          requireOwner(request, env);
          return json(await connectorStatus(env, { fetch: networkFetch, now }));
        } catch (error) {
          return json(
            { error: error instanceof AppError ? error.message : 'Status unavailable.' },
            error instanceof AppError ? error.status : 503,
          );
        }
      }
      if (path === '/mcp') {
        if (request.method !== 'POST')
          return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
        return mcp(request, env, { fetch: networkFetch, now }, ctx);
      }
      if (path === '/telegram/webhook') {
        if (request.method !== 'POST')
          return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
        return telegramWebhook(request, env, { fetch: networkFetch, now }, ctx);
      }
      return json({ error: 'Not found.' }, 404);
    },
  };
}

export default createWorker();
