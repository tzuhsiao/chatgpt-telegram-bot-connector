import { groupConfig, observedGroups, securityConfigured } from './access.ts';
import { safeUrl } from './callback-url.ts';
import { first } from './db.ts';
import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { botId, telegramApi, webhookSecret } from './telegram.ts';
import type { UntypedJson } from './untyped.ts';
import { objectArgs } from './validate.ts';

export async function configureWebhook(args: unknown, env: Env, runtime: Runtime) {
  objectArgs(args, []);
  webhookSecret(env);
  if (!securityConfigured(env) || !env.MCP_CALLBACK_ORIGINS)
    throw new AppError('Connector security configuration is incomplete.', 503, -32002);
  const origin = safeUrl(env.SITE_ORIGIN);
  if (env.SITE_ORIGIN !== origin.origin)
    throw new AppError('SITE_ORIGIN must be an exact HTTPS origin.', 503, -32002);
  const url = origin.origin + '/telegram/webhook';
  const me: UntypedJson = await telegramApi('getMe', {}, env, runtime);
  if (me?.is_bot !== true || String(me.id) !== botId(env))
    throw new AppError('Bot identity could not be verified.', 200, -32010);
  const info: UntypedJson = await telegramApi('getWebhookInfo', {}, env, runtime);
  if (typeof info?.url !== 'string')
    throw new AppError('Webhook status could not be verified.', 200, -32010);
  if (info.url && info.url !== url)
    throw new AppError(
      'This bot already has a different webhook. Use a dedicated bot or explicitly remove its old integration first.',
      200,
      -32005,
    );
  if (observedGroups(env).error) throw new AppError('Invalid group configuration.', 503, -32002);
  const allowed_updates = groupConfig(env).size ? ['message', 'my_chat_member'] : ['message'];
  const configured: UntypedJson = await telegramApi(
    'setWebhook',
    {
      url,
      secret_token: webhookSecret(env),
      max_connections: 1,
      allowed_updates,
      drop_pending_updates: false,
    },
    env,
    runtime,
  );
  if (configured !== true) throw new AppError('Webhook setup was not confirmed.', 200, -32010);
  return {
    configured: true,
    bot_username: typeof me.username === 'string' ? me.username : null,
    pending_update_count: Number.isInteger(info.pending_update_count)
      ? info.pending_update_count
      : null,
  };
}
