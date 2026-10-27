import test from 'node:test';
import assert from 'node:assert/strict';
import { imageType } from '../worker/image.ts';

// Golden results from the original JavaScript parser, before out-of-range reads
// were made explicit. Covers each accepted container plus the edge cases where
// the parser reads past the end of the input (GIF flags at exactly 10 bytes,
// JPEG fill bytes up to the end), truncation, animation and size limits.
const cases = [
  [
    'png: valid 100x80',
    '89504e470d0a1a0a0000000d494844520000006400000050080200000000000000000000014944415407000000000000000049454e4400000000',
    'image/png',
  ],
  [
    'png: missing IEND (truncated before final chunk)',
    '89504e470d0a1a0a0000000d49484452000000640000005008020000000000000000000001494441540700000000',
    null,
  ],
  [
    'png: shorter than header minimum',
    '89504e470d0a1a0a0000000d4948445200000064000000500802000000000000',
    null,
  ],
  [
    'png: animated (acTL chunk)',
    '89504e470d0a1a0a0000000d494844520000006400000050080200000000000000000000086163544c000000010000000000000000000000014944415407000000000000000049454e4400000000',
    null,
  ],
  [
    'gif: valid 100x80',
    '474946383961640050000000002c0000000064005000000203010203003b',
    'image/gif',
  ],
  ['gif: exactly 10 bytes (flags byte out of range)', '47494638396164005000', null],
  ['gif: 11 bytes with global colour table flag', '4749463839616400500081', null],
  ['gif: no trailer', '474946383961640050000000002c000000006400500000020301020300', null],
  [
    'gif: two frames',
    '474946383961640050000000002c0000000064005000000203010203002c0000000064005000000203010203003b',
    null,
  ],
  [
    'gif: frame outside canvas',
    '474946383961640050000000002c0100000064005000000203010203003b',
    null,
  ],
  [
    'gif: data sub-block runs past end',
    '474946383961640050000000002c00000000640050000002090102',
    null,
  ],
  [
    'webp: valid VP8L 100x80',
    '524946461a000000574542505650384c0d0000002f63000100000000000000000000',
    'image/webp',
  ],
  [
    'webp: RIFF size mismatch',
    '524946461b000000574542505650384c0d0000002f63000100000000000000000000',
    null,
  ],
  [
    'webp: VP8X with animation flag',
    '524946461600000057454250565038580a000000020000006300004f0000',
    null,
  ],
  [
    'webp: VP8X static 100x80',
    '524946461600000057454250565038580a000000000000006300004f0000',
    'image/webp',
  ],
  [
    'webp: VP8 lossy 100x80',
    '524946461800000057454250565038200c0000000000009d012a640050000000',
    'image/webp',
  ],
  ['jpeg: valid 100x80', 'ffd8ffc0000b080050006401011100ffda0002ffd9', 'image/jpeg'],
  ['jpeg: fill bytes to end of input (marker out of range)', 'ffd8ffffffff', null],
  ['jpeg: SOF segment longer than input', 'ffd8ffc000ff08005000640101', null],
  ['jpeg: SOS before any SOF', 'ffd8ffda0002ffd9', null],
  ['jpeg: oversized 9000x10', 'ffd8ffc0000b08000a232801011100ffd9', null],
  ['jpeg: 4000x4001 exceeds pixel budget', 'ffd8ffc0000b080fa10fa001011100ffd9', null],
  ['empty input', '', null],
  ['random bytes', '00112233445566778899aabbccddeeff', null],
];

for (const [name, hex, expected] of cases)
  test(`imageType: ${name}`, () => {
    assert.equal(imageType(Uint8Array.from(Buffer.from(hex, 'hex'))), expected);
  });

test('imageType reads only its own view of a shared buffer', () => {
  for (const [, hex, expected] of cases) {
    const bytes = Buffer.from(hex, 'hex');
    const shared = new Uint8Array(bytes.length + 16).fill(0xff);
    shared.set(bytes, 7);
    assert.equal(imageType(shared.subarray(7, 7 + bytes.length)), expected);
  }
});
