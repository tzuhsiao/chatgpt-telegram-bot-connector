import { AppError } from './errors.ts';

export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

// Compares fixed-length SHA-256 digests in constant time; non-strings never match.
export async function equalSecret(a: unknown, b: unknown): Promise<boolean> {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

// Standard Webhooks `whsec_` key with 24-64 decoded bytes.
export function signingKey(secret: unknown): Uint8Array {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new AppError('Invalid signing secret.');
  let bytes;
  try {
    bytes = Uint8Array.from(atob(secret.slice(6)), (value) => value.charCodeAt(0));
  } catch {
    throw new AppError('Invalid signing secret.');
  }
  if (bytes.length < 24 || bytes.length > 64) throw new AppError('Invalid signing secret.');
  return bytes;
}

export async function signature(
  secret: unknown,
  id: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    signingKey(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return 'v1,' + btoa(String.fromCharCode(...bytes));
}
