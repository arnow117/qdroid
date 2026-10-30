import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import { readFrozenBundle } from '../../../packages/package-runtime/src/archive.js';

test('installer archive rejects a malformed gzip header checksum', () => {
  const tar = createUstar([
    { path: 'qdroid.plugin.json', body: '{}' },
    { path: 'qdroid.lock.json', body: '{}' },
  ]);
  const gzip = gzipSync(tar);
  const malformed = Buffer.concat([
    Buffer.from([gzip[0]!, gzip[1]!, gzip[2]!, 0x02]),
    gzip.subarray(4, 10),
    Buffer.from([0x00, 0x00]),
    gzip.subarray(10),
  ]);

  assert.throws(() => readFrozenBundle(malformed), /header checksum is invalid/);
});

test('installer archive rejects checksum-valid high bits in every USTAR numeric field', () => {
  const numericFields = [
    { byte: 101, name: 'mode' },
    { byte: 109, name: 'uid' },
    { byte: 117, name: 'gid' },
    { byte: 125, name: 'size' },
    { byte: 137, name: 'mtime' },
    { byte: 330, name: 'device major' },
    { byte: 338, name: 'device minor' },
    { byte: 149, name: 'checksum' },
  ];

  for (const field of numericFields) {
    const archive = createUstar([
      { path: 'qdroid.plugin.json', body: '{}' },
      { path: 'qdroid.lock.json', body: '{}' },
      { path: 'example.txt', body: 'safe' },
    ]);
    archive[field.byte] = archive[field.byte]! | 0x80;
    const header = archive.subarray(0, 512);
    if (field.name !== 'checksum') {
      header.fill(0x20, 148, 156);
      writeOctal(header, checksum(header), 148, 8);
    }

    assert.throws(() => readFrozenBundle(archive), new RegExp(`tar ${field.name}`));
  }
});

test('installer archive treats directory spellings as one path and permits parent after descendants', () => {
  const valid = createUstar([
    { path: 'qdroid.plugin.json', body: '{}' },
    { path: 'qdroid.lock.json', body: '{}' },
    { path: 'skills/example/SKILL.md', body: '# Example\n' },
    { path: 'skills/example', type: 'directory' },
  ]);
  const archive = readFrozenBundle(valid);
  assert.equal(archive.entries.find((entry) => entry.path === 'skills/example')?.type, 'directory');
  assert.equal(archive.expandedBytes, valid.byteLength);

  const duplicateDirectory = createUstar([
    { path: 'qdroid.plugin.json', body: '{}' },
    { path: 'qdroid.lock.json', body: '{}' },
    { path: 'skills/example', type: 'directory' },
    { path: 'skills/example/', type: 'directory' },
  ]);
  assert.throws(() => readFrozenBundle(duplicateDirectory), /duplicate or case-folded paths/);
});

test('installer archive rejects a file that aliases an existing directory descendant', () => {
  const archive = createUstar([
    { path: 'qdroid.plugin.json', body: '{}' },
    { path: 'qdroid.lock.json', body: '{}' },
    { path: 'assets/example.txt', body: 'safe' },
    { path: 'assets', body: 'not-a-directory' },
  ]);

  assert.throws(() => readFrozenBundle(archive), /file above an existing descendant/);
});

test('installer archive rejects case-folded aliases introduced through implicit parents', () => {
  const explicitParentAlias = createUstar([
    { path: 'qdroid.plugin.json', body: '{}' },
    { path: 'qdroid.lock.json', body: '{}' },
    { path: 'assets/item.txt', body: 'safe' },
    { path: 'Assets', type: 'directory' },
  ]);
  const implicitParentAlias = createUstar([
    { path: 'qdroid.plugin.json', body: '{}' },
    { path: 'qdroid.lock.json', body: '{}' },
    { path: 'A/first.txt', body: 'safe' },
    { path: 'a/second.txt', body: 'safe' },
  ]);

  assert.throws(() => readFrozenBundle(explicitParentAlias), /duplicate or case-folded/);
  assert.throws(() => readFrozenBundle(implicitParentAlias), /duplicate or case-folded/);
});

interface TestEntry {
  readonly body?: string;
  readonly path: string;
  readonly type?: 'directory' | 'file';
}

export function createUstar(entries: readonly TestEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
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
