export function stripJsonComments(text: string): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      output += text.slice(start, ++index);
    } else if (character === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else output += text[index++];
  }
  return output;
}

function stripTrailingCommas(text: string): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      output += text.slice(start, ++index);
      continue;
    }
    if (character === ',') {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === '}' || text[next] === ']') { index++; continue; }
    }
    output += character;
    index++;
  }
  return output;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text.replace(/^﻿/, ''))));
}

type Table = Record<string, unknown>;
const bareKey = /[A-Za-z0-9_-]/;
const isTable = (value: unknown): value is Table => !!value && typeof value === 'object' && !Array.isArray(value);

export function parseToml(text: string): Table {
  const source = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const root: Table = {};
  let current = root;
  let index = 0;
  const line = () => source.slice(0, index).split('\n').length;
  const failure = (message: string) => new Error(`${message} on line ${line()}`);
  const spaces = () => { while (source[index] === ' ' || source[index] === '\t') index++; };
  const comment = () => { if (source[index] === '#') while (index < source.length && source[index] !== '\n') index++; };
  const blank = () => { for (;;) { spaces(); comment(); if (source[index] === '\n') index++; else break; } };

  function quoted(): string {
    const quote = source[index];
    const triple = source.startsWith(quote.repeat(3), index);
    if (triple) {
      index += 3;
      if (source[index] === '\n') index++;
      const end = source.indexOf(quote.repeat(3), index);
      if (end < 0) throw failure('Unterminated string');
      const raw = source.slice(index, end);
      index = end + 3;
      return quote === '"' ? unescape(raw.replace(/\\\n\s*/g, '')) : raw;
    }
    index++;
    let raw = '';
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\n') throw failure('Unterminated string');
      if (quote === '"' && source[index] === '\\') { raw += source.slice(index, index + 2); index += 2; continue; }
      raw += source[index++];
    }
    if (source[index] !== quote) throw failure('Unterminated string');
    index++;
    return quote === '"' ? unescape(raw) : raw;
  }

  function unescape(raw: string): string {
    return raw.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, code: string) => {
      if (code[0] === 'u' || code[0] === 'U') return String.fromCodePoint(parseInt(code.slice(1), 16));
      return ({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' } as Record<string, string>)[code] ?? code;
    });
  }

  function key(): string[] {
    const parts: string[] = [];
    for (;;) {
      spaces();
      if (source[index] === '"' || source[index] === "'") parts.push(quoted());
      else {
        const start = index;
        while (index < source.length && bareKey.test(source[index])) index++;
        if (start === index) throw failure('Expected a key');
        parts.push(source.slice(start, index));
      }
      spaces();
      if (source[index] !== '.') return parts;
      index++;
    }
  }

  function value(): unknown {
    spaces();
    const character = source[index];
    if (character === '"' || character === "'") return quoted();
    if (character === '[') {
      index++;
      const items: unknown[] = [];
      for (;;) {
        blank();
        if (source[index] === ']') { index++; return items; }
        items.push(value());
        blank();
        if (source[index] === ',') { index++; continue; }
        if (source[index] === ']') { index++; return items; }
        throw failure('Expected , or ] in an array');
      }
    }
    if (character === '{') {
      index++;
      const table: Table = {};
      spaces();
      if (source[index] === '}') { index++; return table; }
      for (;;) {
        const path = key();
        if (source[index] !== '=') throw failure('Expected = in an inline table');
        index++;
        assign(table, path, value());
        spaces();
        if (source[index] === ',') { index++; continue; }
        if (source[index] === '}') { index++; return table; }
        throw failure('Expected , or } in an inline table');
      }
    }
    const start = index;
    while (index < source.length && !/[,\]}\n#]/.test(source[index])) index++;
    const token = source.slice(start, index).trim();
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(token)) return Number(token.replace(/_/g, ''));
    if (/^0x[0-9a-fA-F_]+$/.test(token)) return parseInt(token.slice(2).replace(/_/g, ''), 16);
    if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^\d{2}:\d{2}/.test(token)) return token;
    throw failure(`Unsupported value ${token.slice(0, 40)}`);
  }

  function descend(table: Table, part: string): Table {
    const existing = table[part];
    if (existing === undefined) return (table[part] = {}) as Table;
    if (Array.isArray(existing) && isTable(existing[existing.length - 1])) return existing[existing.length - 1] as Table;
    if (isTable(existing)) return existing;
    throw failure(`Key ${part} is not a table`);
  }

  function assign(table: Table, path: string[], item: unknown) {
    let target = table;
    for (const part of path.slice(0, -1)) target = descend(target, part);
    const last = path[path.length - 1];
    if (last in target) throw failure(`Duplicate key ${last}`);
    target[last] = item;
  }

  for (;;) {
    blank();
    if (index >= source.length) return root;
    if (source[index] === '[') {
      const array = source[index + 1] === '[';
      index += array ? 2 : 1;
      const path = key();
      if (source.slice(index, index + (array ? 2 : 1)) !== (array ? ']]' : ']')) throw failure('Expected ] after a table name');
      index += array ? 2 : 1;
      let parent = root;
      for (const part of path.slice(0, -1)) parent = descend(parent, part);
      const last = path[path.length - 1];
      if (array) {
        const list = parent[last] ?? (parent[last] = []);
        if (!Array.isArray(list)) throw failure(`Key ${last} is not an array of tables`);
        const table: Table = {};
        list.push(table);
        current = table;
      } else current = descend(parent, last);
    } else {
      const path = key();
      if (source[index] !== '=') throw failure('Expected =');
      index++;
      assign(current, path, value());
    }
    spaces();
    comment();
    if (index < source.length && source[index] !== '\n') throw failure('Expected a new line');
  }
}
