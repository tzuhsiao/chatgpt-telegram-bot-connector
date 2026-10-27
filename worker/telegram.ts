import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { MAX_BODY, readJson } from './http.ts';

// The bot ID is the numeric prefix of a well-formed dedicated bot token.
export function botId(env: Env): string {
  if (
    typeof env.TELEGRAM_BOT_TOKEN !== 'string' ||
    !/^[1-9][0-9]*:[A-Za-z0-9_-]{10,}$/.test(env.TELEGRAM_BOT_TOKEN)
  )
    throw new AppError('Bot configuration is required.', 503, -32002);
  // The regex above guarantees a non-empty prefix before ':'.
  return env.TELEGRAM_BOT_TOKEN.split(':')[0] as string;
}

export function webhookSecret(env: Env): string {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret))
    throw new AppError('Webhook secret configuration is required.', 503, -32002);
  return secret;
}

// Calls one Bot API method. Anything other than a well-formed success is either a
// definite client-error rejection (AppError with telegramCode) or an ambiguous
// failure (plain Error); callers must not treat ambiguity as "not sent".
export async function telegramApi(
  method: string,
  body: unknown,
  env: Env,
  runtime: Runtime,
): Promise<unknown> {
  botId(env);
  const response = await runtime.fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error('Ambiguous API response.');
  }
  // Untrusted envelope: every field read below is checked first.
  const data = (await readJson(response, MAX_BODY)) as Record<string, unknown> | null;
  if (
    !response.ok ||
    data?.ok !== true ||
    Array.isArray(data) ||
    !Object.hasOwn(data, 'result') ||
    data.error_code !== undefined
  ) {
    // Only an explicit, consistent client-error envelope establishes definite rejection.
    if (
      response.status < 400 ||
      response.status >= 500 ||
      data?.ok !== false ||
      data.error_code !== response.status ||
      typeof data.description !== 'string' ||
      Object.hasOwn(data, 'result')
    )
      throw new Error('Ambiguous API response.');
    const error = new AppError('Telegram rejected the request.', 200, -32010);
    // Equal to response.status per the check above.
    error.telegramCode = data.error_code as number;
    throw error;
  }
  return data.result;
}
