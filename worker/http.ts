import { AppError } from './errors.ts';

export const MAX_BODY = 64 * 1024;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

// Reads a bounded UTF-8 JSON body. The result is untrusted and stays `unknown`.
export async function readJson(
  request: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  limit = MAX_BODY,
): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > limit) throw new AppError('Request body too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('Invalid JSON.', 400, -32700);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new AppError('Request body too large.', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    // ignoreBOM: false is the platform default; Workers types require it explicitly.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new AppError('Invalid JSON.', 400, -32700);
  }
}
