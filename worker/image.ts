// Read container headers only, never execute/transcode attachments. Bounds also
// limit compressed image bombs. Unsupported/animated containers stay opaque.
export function imageType(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    n = bytes.length;
  // Out-of-range reads yield NaN. Every use below is numeric (arithmetic, bitwise
  // or a strict comparison with a number), where NaN behaves exactly like the
  // `undefined` an out-of-range index used to produce: it matches nothing.
  const byte = (i: number): number => bytes[i] ?? NaN;
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  // NaN, like the previous `undefined`, fails every dimension check below.
  let mime: string | undefined,
    width = NaN,
    height = NaN;
  if (
    n >= 33 &&
    text(0, 8) === '\x89PNG\r\n\x1a\n' &&
    view.getUint32(8) === 13 &&
    text(12, 4) === 'IHDR'
  ) {
    mime = 'image/png';
    width = view.getUint32(16);
    height = view.getUint32(20);
    let p = 8,
      ended = false,
      hasData = false;
    while (p + 12 <= n) {
      const size = view.getUint32(p),
        type = text(p + 4, 4);
      if (type === 'acTL' || size > n - p - 12) return null;
      if (type === 'IDAT') hasData = true;
      p += size + 12;
      if (type === 'IEND') {
        if (size !== 0) return null;
        ended = true;
        break;
      }
    }
    if (!ended || !hasData) return null;
  } else if (n >= 10 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) {
    mime = 'image/gif';
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
    let p = 13 + (byte(10) & 128 ? 3 * 2 ** ((byte(10) & 7) + 1) : 0),
      frames = 0,
      ended = false;
    const blocks = () => {
      while (p < n) {
        const size = byte(p++);
        if (size === 0) return true;
        if (p + size > n) return false;
        p += size;
      }
      return false;
    };
    while (p < n) {
      const tag = byte(p++);
      if (tag === 59) {
        ended = true;
        break;
      }
      if (tag === 33) {
        p++;
        if (!blocks()) return null;
      } else if (tag === 44) {
        if (p + 9 > n || ++frames > 1) return null;
        if (
          !view.getUint16(p + 4, true) ||
          !view.getUint16(p + 6, true) ||
          view.getUint16(p, true) + view.getUint16(p + 4, true) > width ||
          view.getUint16(p + 2, true) + view.getUint16(p + 6, true) > height
        )
          return null;
        const flags = byte(p + 8);
        p += 9;
        if (flags & 128) p += 3 * 2 ** ((flags & 7) + 1);
        p++;
        if (!blocks()) return null;
      } else return null;
    }
    if (!ended || frames !== 1) return null;
  } else if (n >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    if (view.getUint32(4, true) + 8 !== n) return null;
    let p = 12;
    while (p + 8 <= n) {
      const kind = text(p, 4),
        size = view.getUint32(p + 4, true);
      if (kind === 'ANIM' || kind === 'ANMF' || size > n - p - 8) return null;
      p += 8 + size + (size & 1);
    }
    if (p !== n) return null;
    mime = 'image/webp';
    const kind = text(12, 4);
    if (kind === 'VP8X') {
      if (byte(20) & 2) return null;
      width = 1 + (byte(24) | (byte(25) << 8) | (byte(26) << 16));
      height = 1 + (byte(27) | (byte(28) << 8) | (byte(29) << 16));
    } else if (kind === 'VP8 ' && text(23, 3) === '\x9d\x01\x2a') {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    } else if (kind === 'VP8L' && byte(20) === 47) {
      const bits = view.getUint32(21, true);
      width = (bits & 16383) + 1;
      height = ((bits >>> 14) & 16383) + 1;
    }
  } else if (n >= 4 && byte(0) === 255 && byte(1) === 216) {
    mime = 'image/jpeg';
    let p = 2;
    while (p + 4 <= n) {
      if (byte(p++) !== 255) break;
      while (p < n && byte(p) === 255) p++;
      const marker = byte(p++);
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > n) break;
      const length = view.getUint16(p);
      if (length < 2 || p + length > n) break;
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        length >= 8
      ) {
        height = view.getUint16(p + 3);
        width = view.getUint16(p + 5);
        break;
      }
      p += length;
    }
  }
  return mime &&
    width > 0 &&
    height > 0 &&
    width <= 8192 &&
    height <= 8192 &&
    width * height <= 16_000_000
    ? mime
    : null;
}
