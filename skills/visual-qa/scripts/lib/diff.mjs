// Unified-diff parsing for visual-qa. Lines are stored compactly as [type, oldNo, newNo, text]
// where type is ' ', '+', or '-' and a missing line number is null.

/** Parse `git diff` output into files with hunks. Hunk bodies are read by their header counts,
 * so content lines that happen to start with "---" or "+++" are handled correctly. */
export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (hunk && (hunk._old > 0 || hunk._new > 0)) {
      const c = line[0];
      if (c === ' ' || line === '') {
        hunk.lines.push([' ', oldNo++, newNo++, line.slice(1)]);
        hunk._old--;
        hunk._new--;
        continue;
      }
      if (c === '-') {
        hunk.lines.push(['-', oldNo++, null, line.slice(1)]);
        hunk._old--;
        file.deletions++;
        continue;
      }
      if (c === '+') {
        hunk.lines.push(['+', null, newNo++, line.slice(1)]);
        hunk._new--;
        file.additions++;
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
      hunk = null; // malformed: fall through to header parsing
    }
    if (line.startsWith('\\')) continue;

    if (line.startsWith('diff --git ')) {
      file = { path: null, oldPath: null, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      const guess = splitDiffGitLine(line.slice(11));
      if (guess) {
        file.oldPath = guess[0];
        file.path = guess[1];
      }
      continue;
    }
    if (!file) continue;

    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (hm) {
      hunk = {
        oldStart: +hm[1],
        oldLines: hm[2] === undefined ? 1 : +hm[2],
        newStart: +hm[3],
        newLines: hm[4] === undefined ? 1 : +hm[4],
        header: hm[5] || '',
        lines: [],
      };
      hunk._old = hunk.oldLines;
      hunk._new = hunk.newLines;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) { file.oldPath = unquote(line.slice(12)); file.status = 'renamed'; }
    else if (line.startsWith('rename to ')) { file.path = unquote(line.slice(10)); file.status = 'renamed'; }
    else if (line.startsWith('copy from ')) { file.oldPath = unquote(line.slice(10)); file.status = 'copied'; }
    else if (line.startsWith('copy to ')) { file.path = unquote(line.slice(8)); file.status = 'copied'; }
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
    else if (line.startsWith('--- ')) { const p = diffPath(line.slice(4)); if (p) file.oldPath = p; }
    else if (line.startsWith('+++ ')) { const p = diffPath(line.slice(4)); if (p) file.path = p; }
  }

  for (const f of files) {
    if (f.status === 'deleted' && f.oldPath) f.path = f.oldPath;
    if (!f.path) f.path = f.oldPath;
    if (f.oldPath === f.path) f.oldPath = null;
    for (const hk of f.hunks) { delete hk._old; delete hk._new; }
  }
  return files.filter((f) => f.path);
}

/** Lenient parser for hand-supplied patch text (one or more "@@" hunks). Counts are recomputed
 * from the body, so a slightly wrong header still renders. */
export function parsePatchHunks(text) {
  const hunks = [];
  let hunk = null;
  let oldNo = 1;
  let newNo = 1;
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (hm) {
      hunk = { oldStart: +hm[1], oldLines: 0, newStart: +hm[2], newLines: 0, header: hm[3] || '', lines: [] };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (/^(diff --git|index |--- |\+\+\+ )/.test(raw) || raw === '') continue;
      hunk = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, header: '', lines: [] };
      hunks.push(hunk);
    }
    const c = raw[0];
    if (c === '\\') continue;
    if (c === '+') { hunk.lines.push(['+', null, newNo++, raw.slice(1)]); hunk.newLines++; }
    else if (c === '-') { hunk.lines.push(['-', oldNo++, null, raw.slice(1)]); hunk.oldLines++; }
    else { hunk.lines.push([' ', oldNo++, newNo++, c === ' ' ? raw.slice(1) : raw]); hunk.oldLines++; hunk.newLines++; }
  }
  for (const hk of hunks) {
    while (hk.lines.length && hk.lines[hk.lines.length - 1][0] === ' ' && hk.lines[hk.lines.length - 1][3] === '') {
      hk.lines.pop();
      hk.oldLines--;
      hk.newLines--;
    }
  }
  return hunks.filter((hk) => hk.lines.length);
}

/** True when the hunk changes a line inside [a, b] on the given side ("head" = new file). */
export function hunkTouches(hunk, [a, b], side = 'head') {
  let anchorOld = hunk.oldStart;
  let anchorNew = hunk.newStart;
  for (const [t, o, n] of hunk.lines) {
    if (t === ' ') { anchorOld = o + 1; anchorNew = n + 1; continue; }
    if (side === 'base') {
      const at = t === '-' ? o : anchorOld;
      if (at >= a && at <= b) return true;
      if (t === '-') anchorOld = o + 1;
    } else {
      const at = t === '+' ? n : anchorNew;
      if (at >= a && at <= b) return true;
      if (t === '+') anchorNew = n + 1;
    }
  }
  return false;
}

/** Exact changed lines: added lines by after-side number, deleted lines by before-side number. */
export function changedRanges(hunks) {
  const head = [];
  const base = [];
  const push = (arr, n) => {
    const last = arr[arr.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else arr.push([n, n]);
  };
  for (const hk of hunks) {
    for (const [t, o, n] of hk.lines) {
      if (t === '+') push(head, n);
      else if (t === '-') push(base, o);
    }
  }
  return { head, base };
}

export const formatRanges = (ranges) => ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');

export function parseRange(v) {
  const m = /^\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*$/.exec(String(v ?? ''));
  if (!m) return null;
  const a = +m[1];
  const b = m[2] ? +m[2] : a;
  return [Math.min(a, b), Math.max(a, b)];
}

function diffPath(s) {
  const p = unquote(s.replace(/\t.*$/, ''));
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

function splitDiffGitLine(rest) {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest);
    return m ? [unquote(m[1]).replace(/^a\//, ''), unquote(m[2]).replace(/^b\//, '')] : null;
  }
  // Unquoted: "a/<p> b/<p>" — only trust it when both halves are equal (the common case).
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half)) {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) return [a.slice(2), b.slice(2)];
  }
  const m = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return m ? [m[1], m[2]] : null;
}

/** Undo git's C-style path quoting ("a/caf\303\251.txt" → a/café.txt). */
export function unquote(s) {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const body = s.slice(1, -1);
  const bytes = [];
  const map = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '\\': 92, '"': 34 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const nx = body[i + 1];
    if (/[0-7]/.test(nx)) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else {
      bytes.push(map[nx] ?? nx.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
