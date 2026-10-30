import assert from 'node:assert/strict';

export interface UstarFixtureEntry {
  readonly body?: string | Uint8Array;
  readonly path: string;
  readonly type?: 'directory' | 'file';
}

export function createUstarFixture(entries: readonly UstarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body === undefined ? Buffer.alloc(0) : Buffer.from(entry.body);
    const type = entry.type ?? 'file';
    const header = Buffer.alloc(512);
    writeAscii(header, entry.path, 0, 100);
    writeOctal(header, type === 'directory' ? 0o755 : 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, body.byteLength, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = type === 'directory' ? 0x35 : 0x30;
    writeAscii(header, 'ustar\0', 257, 6);
    writeAscii(header, '00', 263, 2);
    writeOctal(header, checksum(header), 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - (body.byteLength % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1_024));
  return Buffer.concat(blocks);
}

function writeAscii(buffer: Buffer, value: string, offset: number, width: number): void {
  const source = Buffer.from(value, 'ascii');
  assert.ok(source.byteLength <= width);
  source.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, value: number, offset: number, width: number): void {
  const encoded = value.toString(8).padStart(width - 2, '0');
  writeAscii(buffer, `${encoded}\0`, offset, width);
}

function checksum(header: Buffer): number {
  let total = 0;
  for (const byte of header) total += byte;
  return total;
}
