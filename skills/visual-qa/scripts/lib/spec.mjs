// Spec validation, automatic placement, code-to-diff resolution, and coverage for visual-qa.
import { hunkTouches, parsePatchHunks, parseRange } from './diff.mjs';

export const STATUSES = ['unchanged', 'added', 'changed', 'removed'];
export const SHAPES = ['box', 'decision', 'note'];
export const SIDES = ['left', 'right', 'top', 'bottom'];
export const RISKS = ['low', 'medium', 'high'];
const ID_RE = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const DEFAULT_LAYOUT = { colWidth: 248, gapX: 72 };
const MAX_HUNK_LINES = 400;
const MAX_HUNKS_PER_FILE = 80;

const str = (v) => (typeof v === 'string' ? v : '');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function diagramsOf(spec) {
  return Array.isArray(spec.diagrams) && spec.diagrams.length ? spec.diagrams : [spec];
}

export function nodesOf(d) {
  return [
    ...(Array.isArray(d.nodes) ? d.nodes : []),
    ...(Array.isArray(d.notes) ? d.notes : []).map((n) => (isObj(n) ? { shape: 'note', ...n } : n)),
  ];
}

export function forEachItem(spec, fn) {
  const ds = diagramsOf(spec);
  ds.forEach((d, di) => {
    const where = ds.length > 1 ? `diagram "${d.id ?? di}"` : 'diagram';
    for (const n of nodesOf(d)) if (isObj(n)) fn(n, `${where} node "${n.id}"`, d);
    (Array.isArray(d.edges) ? d.edges : []).forEach((e, i) => {
      if (isObj(e)) fn(e, `${where} edge "${e.id ?? `#${i + 1}`}"`, d);
    });
  });
}

// ------------------------------------------------------------------ validation

export function validateSpec(spec) {
  const errors = [];
  const warnings = [];
  if (!isObj(spec)) return { errors: ['The spec must be a JSON object.'], warnings };
  if (spec.version !== undefined && spec.version !== 1) warnings.push(`Spec version ${spec.version} is unknown; this renderer reads version 1.`);
  if (spec.pr !== undefined && !isObj(spec.pr)) errors.push('"pr" must be an object.');
  if (spec.risk !== undefined && !RISKS.includes(spec.risk)) errors.push(`"risk" must be one of ${RISKS.join(', ')}.`);
  if (spec.unmapped !== undefined) {
    if (!Array.isArray(spec.unmapped)) errors.push('"unmapped" must be an array of { path, reason }.');
    else spec.unmapped.forEach((u, i) => {
      if (!isObj(u) || !str(u.path)) errors.push(`unmapped[${i}] needs a "path".`);
      else if (!str(u.reason)) warnings.push(`unmapped "${u.path}": add a "reason" so reviewers know why it isn't in the diagram.`);
    });
  }

  const diagrams = diagramsOf(spec);
  const multi = diagrams.length > 1;
  const diagramIds = new Set();
  let changeCount = 0;

  diagrams.forEach((d, di) => {
    const where = multi ? `diagram "${d.id ?? di}"` : 'diagram';
    if (!isObj(d)) { errors.push(`${where}: must be an object.`); return; }
    if (multi) {
      if (typeof d.id !== 'string' || !ID_RE.test(d.id)) errors.push(`${where}: needs an "id" (letters, digits, _ . : -).`);
      else if (diagramIds.has(d.id)) errors.push(`${where}: duplicate diagram id.`);
      diagramIds.add(d.id);
    }
    if (d.layout !== undefined && !isObj(d.layout)) errors.push(`${where}: "layout" must be an object.`);
    if (!Array.isArray(d.nodes) || !d.nodes.length) errors.push(`${where}: "nodes" must be a non-empty array.`);
    const sections = Array.isArray(d.sections) ? d.sections : [];
    if (d.sections !== undefined && !Array.isArray(d.sections)) errors.push(`${where}: "sections" must be an array.`);
    const secIds = new Set();
    sections.forEach((sec, i) => {
      if (!isObj(sec) || typeof sec.id !== 'string' || !sec.id) errors.push(`${where}: section ${i + 1} needs an "id".`);
      else if (secIds.has(sec.id)) errors.push(`${where}: duplicate section id "${sec.id}".`);
      else secIds.add(sec.id);
    });

    const ids = new Map();
    for (const n of nodesOf(d)) {
      if (!isObj(n)) { errors.push(`${where}: every node must be an object.`); continue; }
      if (typeof n.id !== 'string' || !ID_RE.test(n.id)) {
        errors.push(`${where}: node id ${JSON.stringify(n.id)} must start with a letter and use only letters, digits, _ . : -`);
        continue;
      }
      const label = `${where} node "${n.id}"`;
      if (ids.has(n.id)) errors.push(`${label}: duplicate id.`);
      ids.set(n.id, n);
      if (!str(n.title).trim()) errors.push(`${label}: needs a "title".`);
      if (n.status !== undefined && !STATUSES.includes(n.status)) errors.push(`${label}: status must be one of ${STATUSES.join(', ')}.`);
      if (n.shape !== undefined && !SHAPES.includes(n.shape)) errors.push(`${label}: shape must be one of ${SHAPES.join(', ')}.`);
      if (sections.length && n.section !== undefined && !secIds.has(n.section)) errors.push(`${label}: unknown section "${n.section}".`);
      if (sections.length > 1 && n.section === undefined) warnings.push(`${label}: no "section", so it goes in the first one.`);
      for (const k of ['col', 'row', 'span', 'dx', 'dy']) {
        if (n[k] !== undefined && (typeof n[k] !== 'number' || !Number.isFinite(n[k]))) errors.push(`${label}: "${k}" must be a number.`);
      }
      if (typeof n.row === 'number' && !Number.isInteger(n.row)) errors.push(`${label}: "row" must be a whole number.`);
      if (typeof n.col === 'number' && n.col < 0) errors.push(`${label}: "col" can't be negative.`);
      if (typeof n.span === 'number' && n.span <= 0) errors.push(`${label}: "span" must be greater than 0.`);
      if (n.before !== undefined && !isObj(n.before)) errors.push(`${label}: "before" must be an object of the fields that differ before the PR.`);
      if (n.before && (n.status || 'unchanged') !== 'changed') warnings.push(`${label}: has "before" text but isn't "changed", so that text is never shown.`);
      if (n.bullets !== undefined && !Array.isArray(n.bullets)) errors.push(`${label}: "bullets" must be an array of strings.`);
      if (n.attach !== undefined && typeof n.attach !== 'string') errors.push(`${label}: "attach" must be a node or edge id.`);
      checkDetail(n, label, errors, warnings);
      if ((n.status || 'unchanged') !== 'unchanged') changeCount++;
    }

    const edgeIds = new Set();
    (Array.isArray(d.edges) ? d.edges : []).forEach((e, i) => {
      if (!isObj(e)) { errors.push(`${where}: edge ${i + 1} must be an object.`); return; }
      const label = `${where} edge "${e.id ?? `#${i + 1}`}"`;
      if (e.id !== undefined) {
        if (typeof e.id !== 'string' || !ID_RE.test(e.id)) errors.push(`${label}: id must start with a letter and use only letters, digits, _ . : -`);
        else if (ids.has(e.id) || edgeIds.has(e.id)) errors.push(`${label}: id is already used.`);
        else edgeIds.add(e.id);
      } else if ((e.status || 'unchanged') !== 'unchanged') {
        warnings.push(`${label}: give changed edges an "id" so links to them stay stable.`);
      }
      const a = ids.get(e.from);
      const b = ids.get(e.to);
      if (!a) errors.push(`${label}: "from" ${JSON.stringify(e.from)} isn't a node id.`);
      if (!b) errors.push(`${label}: "to" ${JSON.stringify(e.to)} isn't a node id.`);
      if (e.from === e.to) errors.push(`${label}: can't start and end on the same node.`);
      if (e.status !== undefined && !STATUSES.includes(e.status)) errors.push(`${label}: status must be one of ${STATUSES.join(', ')}.`);
      if (e.style !== undefined && !['solid', 'dashed'].includes(e.style)) errors.push(`${label}: style must be "solid" or "dashed".`);
      for (const k of ['fromSide', 'toSide']) if (e[k] !== undefined && !SIDES.includes(e[k])) errors.push(`${label}: "${k}" must be one of ${SIDES.join(', ')}.`);
      if (e.before !== undefined && !isObj(e.before)) errors.push(`${label}: "before" must be an object.`);
      if (a && b) {
        const st = e.status || 'unchanged';
        const ends = [a.status || 'unchanged', b.status || 'unchanged'];
        if (st !== 'added' && st !== 'removed' && ends.includes('added')) errors.push(`${label}: connects to a new node, so it can't exist before the PR. Mark it "added".`);
        if (st !== 'added' && st !== 'removed' && ends.includes('removed')) errors.push(`${label}: connects to a removed node, so it can't exist after the PR. Mark it "removed".`);
        if (st === 'added' && ends.includes('removed')) errors.push(`${label}: a new edge can't connect to a removed node.`);
        if (st === 'removed' && ends.includes('added')) errors.push(`${label}: a removed edge can't connect to a new node.`);
      }
      checkDetail(e, label, errors, warnings);
      if ((e.status || 'unchanged') !== 'unchanged') changeCount++;
    });

    for (const n of nodesOf(d)) {
      if (isObj(n) && typeof n.attach === 'string' && !ids.has(n.attach) && !edgeIds.has(n.attach)) {
        errors.push(`${where} node "${n.id}": "attach" points at "${n.attach}", which isn't a node or edge id.`);
      }
    }
    const count = nodesOf(d).filter((n) => isObj(n) && n.shape !== 'note').length;
    if (count > 18) warnings.push(`${where}: ${count} nodes is a lot to read. Consider splitting it into two diagrams (aim for 6–14).`);
  });

  if (!changeCount && !errors.length) warnings.push('Nothing is marked added, changed or removed, so the report will have no highlights.');
  return { errors, warnings };
}

function checkDetail(item, label, errors, warnings) {
  const st = item.status || 'unchanged';
  const det = item.detail;
  if (det !== undefined && !isObj(det)) { errors.push(`${label}: "detail" must be an object.`); return; }
  if (det) {
    if (det.risk !== undefined && !RISKS.includes(det.risk)) errors.push(`${label}: detail.risk must be one of ${RISKS.join(', ')}.`);
    if (det.qa !== undefined && !Array.isArray(det.qa)) errors.push(`${label}: detail.qa must be an array.`);
    if (det.code !== undefined) {
      if (!Array.isArray(det.code)) errors.push(`${label}: detail.code must be an array of { path, lines?, symbol?, side?, note? }.`);
      else det.code.forEach((ref, i) => {
        if (!isObj(ref) || !str(ref.path)) { errors.push(`${label}: detail.code[${i}] needs a "path".`); return; }
        if (ref.lines !== undefined && !parseRange(ref.lines)) errors.push(`${label}: detail.code[${i}].lines must look like "40" or "40-88".`);
        if (ref.side !== undefined && !['head', 'base'].includes(ref.side)) errors.push(`${label}: detail.code[${i}].side must be "head" or "base".`);
        if (ref.patch !== undefined && typeof ref.patch !== 'string' && !(Array.isArray(ref.patch) && ref.patch.every((l) => typeof l === 'string'))) {
          errors.push(`${label}: detail.code[${i}].patch must be a string or an array of lines.`);
        }
      });
    }
  }
  if (st === 'unchanged' || item.shape === 'note') return;
  if (!det || !str(det.summary).trim()) warnings.push(`${label}: is ${st} but has no detail.summary, so reviewers won't know what changed.`);
  if (!det || !Array.isArray(det.code) || !det.code.length) warnings.push(`${label}: is ${st} but has no detail.code. Link it to the lines that changed.`);
  if (!det || !Array.isArray(det.qa) || !det.qa.length) warnings.push(`${label}: is ${st} but has no detail.qa checks.`);
  if (st === 'changed' && !item.before && !(det && (det.before || det.after))) warnings.push(`${label}: is changed but says nothing about before (add "before" fields or detail.before/after).`);
}

// ------------------------------------------------------------------ placement

/** Fill in col/row for any section that has unplaced nodes (simple left-to-right layering). */
export function autoLayout(d, warnings) {
  const nodes = nodesOf(d).filter(isObj);
  const sections = Array.isArray(d.sections) && d.sections.length ? d.sections.map((x) => x.id) : [undefined];
  const secOf = (n) => (sections.includes(n.section) ? n.section : sections[0]);
  for (const sec of sections) {
    const group = nodes.filter((n) => secOf(n) === sec);
    if (!group.some((n) => typeof n.col !== 'number' || typeof n.row !== 'number')) continue;
    const ids = new Set(group.map((n) => n.id));
    const preds = new Map(group.map((n) => [n.id, []]));
    for (const e of Array.isArray(d.edges) ? d.edges : []) {
      if (isObj(e) && ids.has(e.from) && ids.has(e.to)) preds.get(e.to).push(e.from);
    }
    const layer = new Map();
    const visiting = new Set();
    const depth = (id) => {
      if (layer.has(id)) return layer.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let v = 0;
      for (const p of preds.get(id)) v = Math.max(v, depth(p) + 1);
      visiting.delete(id);
      layer.set(id, v);
      return v;
    };
    const used = new Map();
    for (const n of group) {
      const c = depth(n.id);
      const r = used.get(c) || 0;
      used.set(c, r + 1);
      n.col = c;
      n.row = r;
    }
    warnings.push(`${sec ? `section "${sec}"` : 'diagram'}: nodes were placed automatically. Set "col" and "row" for a cleaner layout.`);
  }
}

/** Nodes that would overlap in the same row. A new node may take a removed node's spot. */
export function findOverlaps(d) {
  const L = { ...DEFAULT_LAYOUT, ...(isObj(d.layout) ? d.layout : {}) };
  const nodes = nodesOf(d).filter((n) => isObj(n) && typeof n.col === 'number' && typeof n.row === 'number');
  const sections = Array.isArray(d.sections) && d.sections.length ? d.sections.map((x) => x.id) : [undefined];
  const secOf = (n) => (sections.includes(n.section) ? n.section : sections[0]);
  const span = (n) => (typeof n.span === 'number' && n.span > 0 ? n.span : 1);
  const x0 = (n) => n.col * (L.colWidth + L.gapX) + (typeof n.dx === 'number' ? n.dx : 0);
  const width = (n) => span(n) * L.colWidth + Math.max(0, Math.ceil(span(n)) - 1) * L.gapX;
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (secOf(a) !== secOf(b) || a.row !== b.row) continue;
      if (x0(a) < x0(b) + width(b) - 1 && x0(b) < x0(a) + width(a) - 1) {
        const pair = [a.status || 'unchanged', b.status || 'unchanged'].sort().join();
        out.push({ a: a.id, b: b.id, replacement: pair === 'added,removed' });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ code ↔ diff

function slimHunk(hk) {
  const lines = hk.lines.length > MAX_HUNK_LINES ? hk.lines.slice(0, MAX_HUNK_LINES) : hk.lines;
  const out = { oldStart: hk.oldStart, oldLines: hk.oldLines, newStart: hk.newStart, newLines: hk.newLines, header: hk.header, lines };
  if (hk.lines.length > MAX_HUNK_LINES) out.truncated = hk.lines.length - MAX_HUNK_LINES;
  return out;
}

/**
 * Attach real diff hunks to every detail.code ref. Mutates the refs (adds `file` and `hunks`)
 * and returns the files the report needs plus which changed paths were referenced.
 */
export function resolveCode(spec, diffFiles, warnings) {
  const byPath = new Map((diffFiles || []).map((f) => [f.path, f]));
  const byOld = new Map((diffFiles || []).filter((f) => f.oldPath).map((f) => [f.oldPath, f]));
  const files = {};
  const referenced = new Set();
  const inlineFiles = new Map();

  // Pass 1: hand-supplied patches (demos, or when git isn't available).
  forEachItem(spec, (item) => {
    for (const ref of item.detail && Array.isArray(item.detail.code) ? item.detail.code : []) {
      if (!isObj(ref) || !str(ref.path)) continue;
      const patch = Array.isArray(ref.patch) ? ref.patch.join('\n') : ref.patch;
      delete ref.patch;
      if (typeof patch !== 'string' || !patch.trim()) continue;
      const f = inlineFiles.get(ref.path) || { path: ref.path, oldPath: null, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] };
      inlineFiles.set(ref.path, f);
      const start = f.hunks.length;
      for (const hk of parsePatchHunks(patch)) {
        f.hunks.push(hk);
        for (const ln of hk.lines) { if (ln[0] === '+') f.additions++; else if (ln[0] === '-') f.deletions++; }
      }
      ref.file = ref.path;
      ref.hunks = f.hunks.map((_, i) => i).slice(start);
      ref.inline = true;
      files[ref.path] = f;
    }
  });

  // Pass 2: everything else resolves against the git diff (or, without git, the inline patches).
  forEachItem(spec, (item, label) => {
    const code = item.detail && Array.isArray(item.detail.code) ? item.detail.code : null;
    if (!code) return;
    let touched = 0;
    for (const ref of code) {
      if (!isObj(ref) || !str(ref.path)) continue;
      if (ref.inline) {
        delete ref.inline;
        if (ref.hunks.length) touched++;
        continue;
      }
      const side = ref.side === 'base' ? 'base' : 'head';
      const range = parseRange(ref.lines);
      const f = byPath.get(ref.path) || byOld.get(ref.path) || (!diffFiles ? inlineFiles.get(ref.path) : null);
      if (!f) {
        ref.hunks = [];
        continue;
      }
      referenced.add(f.path);
      ref.file = f.path;
      let idx = f.hunks.map((_, i) => i).slice(0, MAX_HUNKS_PER_FILE);
      if (range) {
        idx = idx.filter((i) => hunkTouches(f.hunks[i], range, side));
        if (!idx.length && !f.binary) warnings.push(`${label}: ${ref.path} lines ${ref.lines}${side === 'base' ? ' (before)' : ''} don't touch any change in that file. Check the range and "side".`);
      } else if (str(ref.symbol)) {
        const sym = ref.symbol;
        const hit = idx.filter((i) => f.hunks[i].header.includes(sym) || f.hunks[i].lines.some((l) => l[0] !== ' ' && l[3].includes(sym)));
        if (hit.length) idx = hit;
      }
      ref.hunks = idx;
      if (idx.length || f.binary) touched++;
      files[f.path] = f;
    }
    const st = item.status || 'unchanged';
    if (st !== 'unchanged' && code.length && !touched && diffFiles) {
      warnings.push(`${label}: is ${st}, but none of its code refs point at lines this PR changes.`);
    }
  });

  const out = {};
  for (const [p, f] of Object.entries(files)) {
    out[p] = {
      path: f.path, oldPath: f.oldPath, status: f.status, binary: f.binary,
      additions: f.additions, deletions: f.deletions,
      hunks: f.hunks.slice(0, MAX_HUNKS_PER_FILE).map(slimHunk),
    };
  }
  return { files: out, referenced, inlineFiles: [...inlineFiles.values()] };
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

export function matchesUnmapped(path, entry) {
  const p = str(entry.path);
  if (!p) return false;
  if (p === path) return true;
  if (p.endsWith('/')) return path.startsWith(p);
  if (p.includes('*') || p.includes('?')) return globToRegExp(p).test(path);
  return false;
}

/** Which changed files the diagram explains, which are set aside on purpose, and which nobody explains. */
export function coverage(spec, diffFiles, referenced) {
  const unmapped = (Array.isArray(spec.unmapped) ? spec.unmapped : []).filter((u) => isObj(u) && str(u.path)).map((u) => ({ path: u.path, reason: str(u.reason) }));
  if (!diffFiles) return { unmapped, unexplained: [], explained: [] };
  const unexplained = [];
  const explained = [];
  for (const f of diffFiles) {
    if (referenced.has(f.path)) explained.push(f.path);
    else if (!unmapped.some((u) => matchesUnmapped(f.path, u))) {
      unexplained.push({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions });
    }
  }
  return { unmapped, unexplained, explained };
}

export function diffStats(files) {
  return {
    files: files.length,
    additions: files.reduce((a, f) => a + (f.additions || 0), 0),
    deletions: files.reduce((a, f) => a + (f.deletions || 0), 0),
  };
}

// ------------------------------------------------------------------ PR summary (Markdown)

const WORD = { added: 'New', changed: 'Changed', removed: 'Removed' };

function changesOf(d) {
  const rows = [];
  for (const n of nodesOf(d)) if (isObj(n) && n.status && n.status !== 'unchanged') rows.push(n);
  for (const e of Array.isArray(d.edges) ? d.edges : []) if (isObj(e) && e.status && e.status !== 'unchanged') rows.push(e);
  return rows;
}

function titleOf(d, it) {
  if (it.from) {
    const nodes = new Map(nodesOf(d).filter(isObj).map((n) => [n.id, n]));
    const label = str(it.status === 'removed' && it.before && it.before.label ? it.before.label : it.label).replace(/\n/g, ' ');
    return `${nodes.get(it.from)?.title ?? it.from} → ${nodes.get(it.to)?.title ?? it.to}${label ? ` (${label})` : ''}`;
  }
  return str(it.title);
}

const md = (s) => str(s).replace(/\r?\n+/g, ' ').trim();

export function summaryMarkdown(data, { reportName = 'report.html' } = {}) {
  const pr = data.pr || {};
  const lines = [];
  lines.push(`### Visual QA${pr.number != null ? ` · PR #${pr.number}` : ''}: ${md(data.title || pr.title || 'Changes')}`, '');
  if (data.summary) lines.push(md(data.summary), '');
  if (data.risk) lines.push(`**Risk: ${data.risk}**${data.riskNote ? ` — ${md(data.riskNote)}` : ''}`, '');
  const ds = diagramsOf(data);
  const qaLines = [];
  const line = (d, it) => {
    const head = md(it.detail?.headline) || md(it.detail?.summary).split(/(?<=[.!?])\s/)[0];
    const risk = it.detail?.risk === 'high' ? ' ⚠️ high risk' : '';
    return `- **${WORD[it.status]}** · ${md(titleOf(d, it))}${head ? ` — ${head}` : ''}${risk}`;
  };
  for (const d of ds) {
    const ch = changesOf(d);
    if (!ch.length) continue;
    const parts = ch.filter((it) => it.from === undefined && it.shape !== 'note');
    const links = ch.filter((it) => it.from !== undefined);
    const count = (k) => parts.filter((it) => it.status === k).length;
    const tally = ['added', 'changed', 'removed'].filter((k) => count(k)).map((k) => `${count(k)} ${k === 'added' ? 'new' : k}`).join(', ');
    const heading = ds.length > 1 ? md(d.title || d.id) : 'What changed';
    lines.push(`**${heading}**${tally ? ` (${tally})` : ''}`);
    for (const it of parts) lines.push(line(d, it));
    if (links.length) {
      lines.push('', `<details><summary>${links.length} changed connection${links.length === 1 ? '' : 's'}</summary>`, '');
      for (const it of links) lines.push(line(d, it));
      lines.push('', '</details>');
    }
    lines.push('');
    for (const it of ch) {
      for (const q of Array.isArray(it.detail?.qa) ? it.detail.qa : []) {
        const text = typeof q === 'string' ? q : str(q?.check);
        const expect = typeof q === 'string' ? '' : str(q?.expect);
        if (text) qaLines.push(`- [ ] ${md(titleOf(d, it))}: ${md(text)}${expect ? ` → ${md(expect)}` : ''}`);
      }
    }
  }
  if (qaLines.length) {
    lines.push('<details><summary><b>QA checklist</b> (' + qaLines.length + ')</summary>', '', ...qaLines, '', '</details>', '');
  }
  const cov = data.coverage || {};
  if (cov.unexplained?.length) lines.push(`⚠️ **Changed but not explained by the diagram:** ${cov.unexplained.map((f) => '`' + f.path + '`').join(', ')}`, '');
  if (cov.unmapped?.length) lines.push(`Not in the diagram: ${cov.unmapped.map((f) => '`' + f.path + '`' + (f.reason ? ` (${md(f.reason)})` : '')).join(', ')}`, '');
  const st = data.stats;
  const range = pr.base && pr.head ? ` · \`${String(pr.base).slice(0, 7)}\` → \`${data.generated?.worktree ? 'working tree' : String(pr.head).slice(0, 7)}\`` : '';
  lines.push(`<sub>${st ? `${st.files} files, +${st.additions} −${st.deletions}` : ''}${range} · interactive before/after diagram: <code>${reportName}</code> · made with visual-qa</sub>`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
