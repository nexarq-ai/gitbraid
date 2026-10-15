export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'literal';
export interface Token { text: string; kind?: TokenKind }

type Grammar = { pattern: RegExp; keywords: Set<string> };

const words = (list: string) => new Set(list.split(' '));
const LITERALS = words('true false null undefined nil None True False NaN Infinity this self super');

const C_LIKE = words('abstract as async await break case catch class const continue debugger default defer delete do else enum export extends final finally fn for from func function go goto if impl implements import in instanceof interface let loop match mod module move mut namespace new of override package private protected pub public readonly return satisfies static struct switch throw trait try type typeof use var void where while with yield');
const PYTHON_SHELL = words('and as assert async await break case class continue def del do done elif else esac except exec export fi finally for from function global if import in is lambda local match nonlocal not or pass raise readonly return then try until while with yield');
const CSS = words('important media supports import layer keyframes from to and not only');

const C_PATTERN = /(\/\/.*$|\/\*.*?(?:\*\/|$))|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|(\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;
const HASH_PATTERN = /(#.*$)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w-]*)/g;
const CSS_PATTERN = /(\/\*.*?(?:\*\/|$))|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?)|(#[0-9a-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b)|@?([A-Za-z_][\w-]*)/g;

const GRAMMARS: Record<string, Grammar> = {
  c: { pattern: C_PATTERN, keywords: C_LIKE },
  hash: { pattern: HASH_PATTERN, keywords: PYTHON_SHELL },
  css: { pattern: CSS_PATTERN, keywords: CSS },
};

const EXTENSIONS: Record<string, keyof typeof GRAMMARS> = {
  js: 'c', jsx: 'c', mjs: 'c', cjs: 'c', ts: 'c', tsx: 'c', mts: 'c', cts: 'c', json: 'c', jsonc: 'c', java: 'c', kt: 'c', go: 'c', rs: 'c', c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', swift: 'c', php: 'c', dart: 'c', scala: 'c', zig: 'c',
  py: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', rb: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash', ini: 'hash', conf: 'hash', r: 'hash', pl: 'hash',
  css: 'css', scss: 'css', less: 'css',
};

export function grammarFor(path: string): Grammar | undefined {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile' || name === 'makefile' || name.startsWith('.env') || name === '.gitignore') return GRAMMARS.hash;
  const extension = name.includes('.') ? name.split('.').pop()! : '';
  const key = EXTENSIONS[extension];
  return key ? GRAMMARS[key] : undefined;
}

export function tokenize(text: string, grammar: Grammar | undefined): Token[] {
  if (!grammar || text.length > 2000) return [{ text }];
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(grammar.pattern)) {
    const index = match.index ?? 0;
    const kind: TokenKind | undefined = match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'number' : match[4] && grammar.keywords.has(match[4]) ? 'keyword' : match[4] && LITERALS.has(match[4]) ? 'literal' : undefined;
    if (!kind) continue;
    if (index > last) tokens.push({ text: text.slice(last, index) });
    tokens.push({ text: match[0], kind });
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last) });
  return tokens;
}
