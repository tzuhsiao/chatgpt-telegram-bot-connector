import type { Env } from './env.ts';
import { AppError } from './errors.ts';

// Syntactic SSRF guard: HTTPS, a dotted DNS name, no credentials, fragment,
// explicit port or IP literal. Origin trust is decided separately by callbackUrl.
export function safeUrl(value: unknown): URL {
  let url;
  try {
    url = new URL(value as string);
  } catch {
    throw new AppError('Invalid callback URL.');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !host.includes('.') ||
    host.endsWith('.') ||
    /^[\d.]+$/.test(host) ||
    host.includes(':') ||
    host.startsWith('[')
  )
    throw new AppError('Invalid callback URL.');
  return url;
}

// Only exact configured HTTPS origins may receive callbacks.
export function callbackUrl(value: unknown, env: Env): string {
  const url = safeUrl(value);
  const allowed = String(env.MCP_CALLBACK_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.includes(url.origin))
    throw new AppError(
      'Callback origin is not configured. Review the requested origin in owner-only connector status.',
      200,
      -32602,
      'callback_origin_not_allowed',
    );
  return url.href;
}
