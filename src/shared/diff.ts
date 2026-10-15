export type DiffSide = 'old' | 'new';
export type DiffLineType = 'context' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldLine?: number;
  newLine?: number;
  noNewline?: boolean;
}

export interface DiffHunk {
  header: string;
  section: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  numbered: boolean;
  lines: DiffLine[];
}

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';

export interface DiffFile {
  oldPath?: string;
  newPath?: string;
  status: DiffFileStatus;
  binary: boolean;
  modeChange?: { from: string; to: string };
  similarity?: number;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripPrefix(path: string): string | undefined {
  const value = path.replace(/\t.*$/, '').trim();
  if (value === '/dev/null') return undefined;
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return unquoted.replace(/^[ab]\//, '');
}

function emptyFile(): DiffFile {
  return { status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0, truncated: false };
}

function finish(file: DiffFile): DiffFile {
  if (file.binary) file.status = 'binary';
  else if (file.oldPath === undefined && file.newPath !== undefined && file.status !== 'renamed') file.status = 'added';
  else if (file.newPath === undefined && file.oldPath !== undefined && file.status !== 'renamed') file.status = 'deleted';
  else if (file.oldPath && file.newPath && file.oldPath !== file.newPath) file.status = 'renamed';
  const last = file.hunks.at(-1);
  if (last?.numbered) {
    const oldSeen = last.lines.filter((line) => line.type !== 'add').length;
    const newSeen = last.lines.filter((line) => line.type !== 'remove').length;
    if (oldSeen < last.oldLines || newSeen < last.newLines) file.truncated = true;
  }
  return file;
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const current = () => (file ??= emptyFile());
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      if (file) files.push(finish(file));
      file = emptyFile();
      hunk = undefined;
      const match = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(raw);
      if (match) { file.oldPath = match[1]; file.newPath = match[2]; }
      continue;
    }
    const target = current();
    const header = HUNK.exec(raw);
    if (header) {
      hunk = { header: raw, section: header[5] ?? '', oldStart: Number(header[1]), oldLines: header[2] === undefined ? 1 : Number(header[2]), newStart: Number(header[3]), newLines: header[4] === undefined ? 1 : Number(header[4]), numbered: true, lines: [] };
      target.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk) {
      if (raw.startsWith('--- ')) { target.oldPath = stripPrefix(raw.slice(4)); continue; }
      if (raw.startsWith('+++ ')) { target.newPath = stripPrefix(raw.slice(4)); continue; }
      if (raw.startsWith('new file mode')) { target.oldPath = undefined; target.status = 'added'; continue; }
      if (raw.startsWith('deleted file mode')) { target.newPath = undefined; target.status = 'deleted'; continue; }
      if (raw.startsWith('rename from ')) { target.oldPath = raw.slice(12); target.status = 'renamed'; continue; }
      if (raw.startsWith('rename to ')) { target.newPath = raw.slice(10); target.status = 'renamed'; continue; }
      if (raw.startsWith('similarity index ')) { target.similarity = Number.parseInt(raw.slice(17), 10); continue; }
      if (raw.startsWith('old mode ')) { target.modeChange = { from: raw.slice(9), to: target.modeChange?.to ?? '' }; continue; }
      if (raw.startsWith('new mode ')) { target.modeChange = { from: target.modeChange?.from ?? '', to: raw.slice(9) }; continue; }
      if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') { target.binary = true; continue; }
      if (/^(index |copy from |copy to |dissimilarity index )/.test(raw)) continue;
      if (!/^[ +-]/.test(raw)) continue;
      hunk = { header: '', section: '', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, numbered: false, lines: [] };
      target.hunks.push(hunk);
    }
    if (raw.startsWith('\\')) {
      const previous = hunk.lines.at(-1);
      if (previous) previous.noNewline = true;
      continue;
    }
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '+') {
      hunk.lines.push({ type: 'add', text, ...(hunk.numbered ? { newLine: newLine++ } : {}) });
      target.additions++;
    } else if (marker === '-') {
      hunk.lines.push({ type: 'remove', text, ...(hunk.numbered ? { oldLine: oldLine++ } : {}) });
      target.deletions++;
    } else if (marker === ' ' || raw === '') {
      hunk.lines.push({ type: 'context', text, ...(hunk.numbered ? { oldLine: oldLine++, newLine: newLine++ } : {}) });
    }
  }
  if (file) files.push(finish(file));
  return files;
}

export function parseFilePatch(patch: string, path?: string): DiffFile {
  const [first, ...rest] = parseUnifiedDiff(patch);
  const file = first ?? emptyFile();
  for (const extra of rest) { file.hunks.push(...extra.hunks); file.additions += extra.additions; file.deletions += extra.deletions; file.truncated ||= extra.truncated; }
  if (path && file.oldPath === undefined && file.newPath === undefined) {
    file.oldPath = path;
    file.newPath = path;
  }
  return file;
}

export function diffHasLine(file: DiffFile, side: DiffSide, line: number): boolean {
  return file.hunks.some((hunk) => hunk.lines.some((entry) => (side === 'old' ? entry.oldLine : entry.newLine) === line));
}

export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) rows.push({ left: removed[index], right: added[index] });
    removed = [];
    added = [];
  };
  for (const line of hunk.lines) {
    if (line.type === 'remove') {
      if (added.length) flush();
      removed.push(line);
    } else if (line.type === 'add') added.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}
