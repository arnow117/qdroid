import { ContractError, type JsonValue } from './index.js';

export interface StrictJsonOptions {
  maxBytes: number;
  maxDepth?: number;
}

/**
 * Parses JSON without accepting duplicate object keys or ill-formed Unicode.
 * JSON.parse deliberately accepts duplicate keys by taking the last value.
 */
export function parseStrictJson(source: string, options: StrictJsonOptions): JsonValue {
  if (Buffer.byteLength(source, 'utf8') > options.maxBytes) {
    throw strictJsonFailure();
  }

  return new StrictJsonParser(source, options.maxDepth ?? 1_024).parse();
}

export function parseStrictJsonBytes(bytes: Uint8Array, options: StrictJsonOptions): JsonValue {
  if (bytes.byteLength > options.maxBytes) {
    throw strictJsonFailure();
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw strictJsonFailure();
  }

  return parseStrictJson(source, options);
}

class StrictJsonParser {
  private depth = 0;
  private index = 0;

  public constructor(
    private readonly source: string,
    private readonly maxDepth: number,
  ) {}

  public parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();

    if (this.index !== this.source.length) {
      throw strictJsonFailure();
    }

    return value;
  }

  private parseValue(): JsonValue {
    this.depth += 1;
    if (this.depth > this.maxDepth) {
      throw strictJsonFailure();
    }

    try {
      const character = this.source[this.index];
      if (character === '"') return this.parseString();
      if (character === '{') return this.parseObject();
      if (character === '[') return this.parseArray();
      if (character === 't' && this.consumeLiteral('true')) return true;
      if (character === 'f' && this.consumeLiteral('false')) return false;
      if (character === 'n' && this.consumeLiteral('null')) return null;
      if (character === '-' || (character !== undefined && /[0-9]/.test(character))) {
        return this.parseNumber();
      }
      throw strictJsonFailure();
    } finally {
      this.depth -= 1;
    }
  }

  private parseObject(): { [key: string]: JsonValue } {
    this.expect('{');
    this.skipWhitespace();
    const record = Object.create(null) as { [key: string]: JsonValue };
    const keys = new Set<string>();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return record;
    }

    while (true) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"') throw strictJsonFailure();
      const key = this.parseString();
      if (keys.has(key)) throw strictJsonFailure();
      keys.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      record[key] = this.parseValue();
      this.skipWhitespace();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return record;
      }
      this.expect(',');
    }
  }

  private parseArray(): JsonValue[] {
    this.expect('[');
    this.skipWhitespace();
    const entries: JsonValue[] = [];
    if (this.source[this.index] === ']') {
      this.index += 1;
      return entries;
    }

    while (true) {
      entries.push(this.parseValue());
      this.skipWhitespace();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return entries;
      }
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.expect('"');
    let value = '';
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        if (!value.isWellFormed()) throw strictJsonFailure();
        return value;
      }
      if (character === '\\') {
        this.index += 1;
        value += this.parseEscape();
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        throw strictJsonFailure();
      }
      value += character;
      this.index += 1;
    }
    throw strictJsonFailure();
  }

  private parseEscape(): string {
    const character = this.source[this.index];
    this.index += 1;
    switch (character) {
      case '"':
      case '\\':
      case '/':
        return character;
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
        return this.parseUnicodeEscape();
      default:
        throw strictJsonFailure();
    }
  }

  private parseUnicodeEscape(): string {
    const firstCodeUnit = this.readEscapedCodeUnit();
    if (firstCodeUnit >= 0xd800 && firstCodeUnit <= 0xdbff) {
      if (this.source.slice(this.index, this.index + 2) !== '\\u') throw strictJsonFailure();
      this.index += 2;
      const secondCodeUnit = this.readEscapedCodeUnit();
      if (secondCodeUnit < 0xdc00 || secondCodeUnit > 0xdfff) throw strictJsonFailure();
      return String.fromCharCode(firstCodeUnit, secondCodeUnit);
    }
    if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) throw strictJsonFailure();
    return String.fromCharCode(firstCodeUnit);
  }

  private readEscapedCodeUnit(): number {
    const hex = this.source.slice(this.index, this.index + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw strictJsonFailure();
    this.index += 4;
    return Number.parseInt(hex, 16);
  }

  private parseNumber(): number {
    const remaining = this.source.slice(this.index);
    const match = remaining.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (match === null) throw strictJsonFailure();
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw strictJsonFailure();
    return value;
  }

  private consumeLiteral(literal: string): boolean {
    if (!this.source.startsWith(literal, this.index)) return false;
    this.index += literal.length;
    return true;
  }

  private expect(expected: string): void {
    if (this.source[this.index] !== expected) throw strictJsonFailure();
    this.index += 1;
  }

  private skipWhitespace(): void {
    while (/[\t\n\r ]/.test(this.source[this.index] ?? '')) this.index += 1;
  }
}

function strictJsonFailure(): ContractError {
  return new ContractError('QD_VALIDATION_FAILED', 'Invalid JSON input.');
}
