import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { Parser } from 'tar';

export const INSTALL_ARCHIVE_LIMITS = Object.freeze({
  expandedBytes: 32 * 1024 * 1024,
  files: 1_024,
  fileBytes: 8 * 1024 * 1024,
  gzipRatio: 100,
  maxComponentBytes: 64,
  maxDepth: 16,
  maxPathBytes: 240,
  transportBytes: 16 * 1024 * 1024,
});

export interface FrozenArchiveEntry {
  bytes: Buffer;
  digest: string;
  executable: boolean;
  path: string;
  type: 'directory' | 'file';
}

export interface FrozenArchive {
  entries: readonly FrozenArchiveEntry[];
  /** Exact decoded USTAR bytes, including headers, padding, and terminator. */
  expandedBytes: number;
  expandedDigest: string;
  transportDigest: string;
  transport: Buffer;
}

/**
 * Validates the narrow qdroid USTAR dialect before the trusted writer creates a
 * path. The maintained tar parser also consumes the same frozen bytes so its
 * checksum and end-of-stream handling remains part of the acceptance path.
 */
export function readFrozenBundle(transportInput: Uint8Array): FrozenArchive {
  return readFrozenUstar(transportInput, { requirePackageMetadata: true });
}

export function readFrozenUstar(
  transportInput: Uint8Array,
  options: { requirePackageMetadata: boolean },
): FrozenArchive {
  const transport = Buffer.from(transportInput);
  if (transport.byteLength > INSTALL_ARCHIVE_LIMITS.transportBytes) {
    throw new Error('The package transport exceeds the 16 MiB limit.');
  }

  const archive = transport.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))
    ? inflateSingleGzipMember(transport)
    : Buffer.from(transport);

  if (archive.byteLength > INSTALL_ARCHIVE_LIMITS.expandedBytes) {
    throw new Error('The package archive exceeds the 32 MiB expanded limit.');
  }
  if (
    transport.byteLength > 0 &&
    archive.byteLength / transport.byteLength > INSTALL_ARCHIVE_LIMITS.gzipRatio
  ) {
    throw new Error('The package archive exceeds the gzip expansion ratio limit.');
  }

  const entries = parseUstarEntries(archive);
  verifyTarLibraryAccepts(archive);
  const files = entries.filter((entry) => entry.type === 'file');
  if (
    options.requirePackageMetadata &&
    !files.some((entry) => entry.path === 'qdroid.plugin.json')
  ) {
    throw new Error('The package archive does not contain qdroid.plugin.json at its root.');
  }
  if (options.requirePackageMetadata && !files.some((entry) => entry.path === 'qdroid.lock.json')) {
    throw new Error('The package archive does not contain qdroid.lock.json at its root.');
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    expandedBytes: archive.byteLength,
    expandedDigest: sha256(archive),
    transportDigest: sha256(transport),
    transport,
  });
}

function inflateSingleGzipMember(transport: Buffer): Buffer {
  const deflateOffset = gzipDeflateOffset(transport);
  const compressed = transport.subarray(deflateOffset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };

  try {
    result = inflateRawSync(compressed, {
      info: true,
      maxOutputLength: INSTALL_ARCHIVE_LIMITS.expandedBytes,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch {
    throw new Error('The package gzip member is invalid or exceeds the expanded limit.');
  }

  const trailerOffset = deflateOffset + result.engine.bytesWritten;
  if (trailerOffset + 8 !== transport.byteLength) {
    throw new Error(
      'The package transport must contain exactly one gzip member with no trailing bytes.',
    );
  }

  const expectedCrc = transport.readUInt32LE(trailerOffset);
  const expectedLength = transport.readUInt32LE(trailerOffset + 4);
  if (crc32(result.buffer) !== expectedCrc || result.buffer.byteLength >>> 0 !== expectedLength) {
    throw new Error('The package gzip trailer does not match its decompressed payload.');
  }

  return Buffer.from(result.buffer);
}

function gzipDeflateOffset(buffer: Buffer): number {
  if (buffer.byteLength < 18 || buffer[0] !== 0x1f || buffer[1] !== 0x8b || buffer[2] !== 8) {
    throw new Error('The package gzip header is invalid.');
  }

  const flags = buffer[3]!;
  if ((flags & 0xe0) !== 0) {
    throw new Error('The package gzip header contains reserved flags.');
  }

  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > buffer.byteLength)
      throw new Error('The package gzip extra field is truncated.');
    const extraLength = buffer.readUInt16LE(offset);
    offset += 2 + extraLength;
  }
  for (const flag of [0x08, 0x10]) {
    if ((flags & flag) !== 0) {
      const end = buffer.indexOf(0, offset);
      if (end < 0) throw new Error('The package gzip string field is truncated.');
      offset = end + 1;
    }
  }
  if ((flags & 0x02) !== 0) {
    if (offset + 2 > buffer.byteLength) {
      throw new Error('The package gzip header checksum is truncated.');
    }

    const expectedHeaderCrc = buffer.readUInt16LE(offset);
    const actualHeaderCrc = crc32(buffer.subarray(0, offset)) & 0xffff;
    if (actualHeaderCrc !== expectedHeaderCrc) {
      throw new Error('The package gzip header checksum is invalid.');
    }

    offset += 2;
  }
  if (offset > buffer.byteLength - 8) throw new Error('The package gzip member is truncated.');
  return offset;
}

function parseUstarEntries(archive: Buffer): FrozenArchiveEntry[] {
  const entries: FrozenArchiveEntry[] = [];
  const paths = new Map<string, RegisteredArchivePath>();
  let offset = 0;
  let sawTerminator = false;

  while (offset < archive.byteLength) {
    if (offset + 512 > archive.byteLength) {
      throw new Error('The package tar archive has a truncated header.');
    }

    const header = archive.subarray(offset, offset + 512);
    if (isAllZero(header)) {
      if (
        offset + 1_024 > archive.byteLength ||
        !isAllZero(archive.subarray(offset + 512, offset + 1_024))
      ) {
        throw new Error('The package tar archive is missing its two zero-block terminator.');
      }
      if (!isAllZero(archive.subarray(offset + 1_024))) {
        throw new Error('The package tar archive has non-zero data after its terminator.');
      }
      sawTerminator = true;
      break;
    }

    const entry = parseUstarHeader(header);
    if (entries.length >= INSTALL_ARCHIVE_LIMITS.files) {
      throw new Error('The package tar archive exceeds the entry limit.');
    }
    const bodyOffset = offset + 512;
    const paddedSize = roundUpToBlock(entry.size);
    if (bodyOffset + paddedSize > archive.byteLength) {
      throw new Error('The package tar entry body is truncated.');
    }
    if (!isAllZero(archive.subarray(bodyOffset + entry.size, bodyOffset + paddedSize))) {
      throw new Error('The package tar entry padding must be zero-filled.');
    }
    if (entry.size > INSTALL_ARCHIVE_LIMITS.fileBytes) {
      throw new Error('The package tar entry exceeds the file size limit.');
    }

    const normalizedPath = validateArchivePath(entry.name, entry.type);
    registerArchivePath(paths, normalizedPath, entry.type);

    const bytes =
      entry.type === 'file'
        ? Buffer.from(archive.subarray(bodyOffset, bodyOffset + entry.size))
        : Buffer.alloc(0);
    entries.push(
      Object.freeze({
        bytes,
        digest: sha256(bytes),
        executable: entry.mode === 0o755,
        path: normalizedPath,
        type: entry.type,
      }),
    );
    offset = bodyOffset + paddedSize;
  }

  if (!sawTerminator) throw new Error('The package tar archive is missing its terminator.');
  return entries;
}

function parseUstarHeader(header: Buffer): {
  mode: number;
  name: string;
  size: number;
  type: 'directory' | 'file';
} {
  if (
    !header.subarray(257, 263).equals(Buffer.from('ustar\0')) ||
    !header.subarray(263, 265).equals(Buffer.from('00'))
  ) {
    throw new Error('The package tar archive must use the POSIX USTAR header dialect.');
  }
  if (readNullTerminatedAscii(header, 157, 100).length > 0) {
    throw new Error('The package tar archive may not contain link targets.');
  }
  const typeFlag = header[156]!;
  const type =
    typeFlag === 0 || typeFlag === 0x30 ? 'file' : typeFlag === 0x35 ? 'directory' : undefined;
  if (type === undefined)
    throw new Error('The package tar archive contains an unsupported entry type.');
  verifyTarChecksum(header);

  const mode = readOctal(header, 100, 8, 'mode');
  if (
    (type === 'file' && mode !== 0o644 && mode !== 0o755) ||
    (type === 'directory' && mode !== 0o755)
  ) {
    throw new Error('The package tar archive contains an unsupported entry mode.');
  }
  // Archive ownership and timestamps are not preserved, but every numeric
  // field still needs strict POSIX-octal syntax. Otherwise Node's ASCII
  // decoding can mask a base-256 or high-bit value that tar interprets
  // differently before the trusted writer normalizes it.
  void readOctal(header, 108, 8, 'uid');
  void readOctal(header, 116, 8, 'gid');
  const size = readOctal(header, 124, 12, 'size');
  void readOctal(header, 136, 12, 'mtime');
  void readOptionalOctal(header, 329, 8, 'device major');
  void readOptionalOctal(header, 337, 8, 'device minor');
  if (type === 'directory' && size !== 0)
    throw new Error('The package directory entry must be empty.');
  const prefix = readNullTerminatedAscii(header, 345, 155);
  const name = readNullTerminatedAscii(header, 0, 100);
  if (name.length === 0) throw new Error('The package tar archive contains an empty path.');
  return { mode, name: prefix.length === 0 ? name : `${prefix}/${name}`, size, type };
}

function validateArchivePath(path: string, type: 'directory' | 'file'): string {
  if (!/^[A-Za-z0-9_.\-/]+$/.test(path) || path.startsWith('/') || path.includes('\\')) {
    throw new Error('The package tar archive contains an invalid path.');
  }
  const hasTrailingSlash = path.endsWith('/');
  if (type === 'file' && hasTrailingSlash) {
    throw new Error('The package tar entry type does not match its path form.');
  }
  const normalized = hasTrailingSlash ? path.slice(0, -1) : path;
  if (Buffer.byteLength(normalized) > INSTALL_ARCHIVE_LIMITS.maxPathBytes)
    throw new Error('The package path is too long.');
  const components = normalized.split('/');
  if (
    components.length > INSTALL_ARCHIVE_LIMITS.maxDepth ||
    components.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        Buffer.byteLength(part) > INSTALL_ARCHIVE_LIMITS.maxComponentBytes,
    )
  ) {
    throw new Error('The package path contains an invalid component.');
  }
  return normalized;
}

interface RegisteredArchivePath {
  explicit: boolean;
  spelling: string;
  type: 'directory' | 'file';
}

function registerArchivePath(
  paths: Map<string, RegisteredArchivePath>,
  path: string,
  type: 'directory' | 'file',
): void {
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const spelling = parts.slice(0, index).join('/');
    const canonical = spelling.toLowerCase();
    const existing = paths.get(canonical);
    if (existing?.type === 'file') {
      throw new Error('The package tar archive places an entry below a file path.');
    }
    if (existing !== undefined && existing.spelling !== spelling) {
      throw new Error('The package tar archive contains duplicate or case-folded paths.');
    }
    if (existing === undefined) {
      paths.set(canonical, { explicit: false, spelling, type: 'directory' });
    }
  }

  const canonical = path.toLowerCase();
  if (type === 'file') {
    const prefix = `${canonical}/`;
    for (const existingPath of paths.keys()) {
      if (existingPath.startsWith(prefix)) {
        throw new Error('The package tar archive places a file above an existing descendant.');
      }
    }
  }
  const existing = paths.get(canonical);
  if (existing !== undefined) {
    if (existing.spelling !== path || existing.explicit || existing.type !== type) {
      throw new Error('The package tar archive contains duplicate or case-folded paths.');
    }
    // A same-spelling explicit directory after its descendants makes the
    // already-registered implicit ancestor explicit without changing identity.
    existing.explicit = true;
    return;
  }

  paths.set(canonical, { explicit: true, spelling: path, type });
}

function verifyTarLibraryAccepts(archive: Buffer): void {
  let warning: Error | undefined;
  const parser = new Parser({
    onReadEntry: (entry) => entry.resume(),
    onwarn: (_code, message, data) => {
      warning = new Error(`tar parser warning: ${message} ${String(data)}`);
    },
    strict: true,
  });
  parser.on('error', (error) => {
    warning = error;
  });
  parser.end(archive);
  if (warning !== undefined) throw warning;
}

function readNullTerminatedAscii(buffer: Buffer, offset: number, length: number): string {
  const value = buffer.subarray(offset, offset + length);
  const terminator = value.indexOf(0);
  const content = terminator < 0 ? value : value.subarray(0, terminator);
  if (content.some((byte) => byte < 0x20 || byte > 0x7e))
    throw new Error('The package tar header is not ASCII.');
  if (terminator >= 0 && !isAllZero(value.subarray(terminator)))
    throw new Error('The package tar header has non-zero bytes after a terminator.');
  return content.toString('ascii');
}

function readOctal(buffer: Buffer, offset: number, length: number, field: string): number {
  const raw = buffer.subarray(offset, offset + length);
  validateOctalEncoding(raw, field);
  const text = raw
    .toString('ascii')
    .replace(/[\0 ]+$/, '')
    .trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`The package tar ${field} is not an octal value.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`The package tar ${field} is too large.`);
  return value;
}

function readOptionalOctal(buffer: Buffer, offset: number, length: number, field: string): number {
  const raw = buffer.subarray(offset, offset + length);
  validateOctalEncoding(raw, field);
  if (raw.every((byte) => byte === 0 || byte === 0x20)) return 0;
  return readOctal(buffer, offset, length, field);
}

function validateOctalEncoding(raw: Buffer, field: string): void {
  if (raw.some((byte) => (byte & 0x80) !== 0)) {
    throw new Error(`The package tar ${field} uses an unsupported non-ASCII encoding.`);
  }
  if (raw.some((byte) => byte !== 0 && byte !== 0x20 && (byte < 0x30 || byte > 0x37))) {
    throw new Error(`The package tar ${field} is not an octal value.`);
  }
}

function verifyTarChecksum(header: Buffer): void {
  const declared = readOctal(header, 148, 8, 'checksum');
  let calculated = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    calculated += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (declared !== calculated) throw new Error('The package tar header checksum is invalid.');
}

function roundUpToBlock(value: number): number {
  return Math.ceil(value / 512) * 512;
}

function isAllZero(buffer: Uint8Array): boolean {
  return buffer.every((byte) => byte === 0);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const CRC_TABLE = createCrcTable();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function createCrcTable(): readonly number[] {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    table.push(value >>> 0);
  }
  return Object.freeze(table);
}
