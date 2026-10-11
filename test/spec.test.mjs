import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUnifiedDiff } from '../skills/visual-qa/scripts/lib/diff.mjs';
import {
  autoLayout, coverage, findOverlaps, matchesUnmapped, resolveCode, summaryMarkdown, validateSpec,
} from '../skills/visual-qa/scripts/lib/spec.mjs';

const detail = (extra = {}) => ({ summary: 's', qa: ['q'], code: [{ path: 'a.js' }], ...extra });

function spec(nodes, edges = [], extra = {}) {
  return { version: 1, title: 't', nodes, edges, ...extra };
}

test('a spec needs nodes', () => {
  const { errors } = validateSpec({ version: 1 });
  assert.ok(errors.some((e) => e.includes('"nodes"')));
});

test('edges must point at real nodes and follow status rules', () => {
  const nodes = [
    { id: 'a', title: 'A', col: 0, row: 0 },
    { id: 'b', title: 'B', col: 1, row: 0, status: 'added', detail: detail() },
    { id: 'c', title: 'C', col: 2, row: 0, status: 'removed', detail: detail() },
  ];
  const { errors } = validateSpec(spec(nodes, [
    { id: 'e1', from: 'a', to: 'missing' },
    { id: 'e2', from: 'a', to: 'b' },
    { id: 'e3', from: 'a', to: 'c' },
    { id: 'e4', from: 'b', to: 'c', status: 'added' },
    { id: 'e5', from: 'a', to: 'a' },
  ]));
  assert.ok(errors.some((e) => e.includes('"missing" isn\'t a node id')));
  assert.ok(errors.some((e) => e.includes('edge "e2"') && e.includes('Mark it "added"')));
  assert.ok(errors.some((e) => e.includes('edge "e3"') && e.includes('Mark it "removed"')));
  assert.ok(errors.some((e) => e.includes('edge "e4"') && e.includes("can't connect to a removed node")));
  assert.ok(errors.some((e) => e.includes('edge "e5"')));
});

test('duplicate ids, bad statuses and bad code ranges are errors', () => {
  const { errors } = validateSpec(spec([
    { id: 'a', title: 'A', col: 0, row: 0 },
    { id: 'a', title: 'Again', col: 1, row: 0, status: 'new' },
    { id: 'b', title: 'B', col: 2, row: 0, status: 'changed', detail: { code: [{ path: 'x.js', lines: 'ten' }] } },
  ]));
  assert.ok(errors.some((e) => e.includes('duplicate id')));
  assert.ok(errors.some((e) => e.includes('status must be one of')));
  assert.ok(errors.some((e) => e.includes('lines must look like')));
});

test('changed parts without details produce warnings; notes do not', () => {
  const { errors, warnings } = validateSpec(spec([
    { id: 'a', title: 'A', col: 0, row: 0, status: 'changed' },
    { id: 'n', title: 'Note', shape: 'note', col: 1, row: 0, status: 'added' },
  ]));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('node "a"') && w.includes('detail.summary')));
  assert.ok(warnings.some((w) => w.includes('node "a"') && w.includes('detail.qa')));
  assert.ok(!warnings.some((w) => w.includes('node "n"')));
});

test('several diagrams need ids', () => {
  const { errors } = validateSpec({ diagrams: [{ nodes: [{ id: 'a', title: 'A' }] }, { id: 'x', nodes: [{ id: 'a', title: 'A' }] }] });
  assert.ok(errors.some((e) => e.includes('needs an "id"')));
});

test('findOverlaps flags collisions but allows a replacement in the same cell', () => {
  const d = spec([
    { id: 'a', title: 'A', col: 0, row: 0 },
    { id: 'b', title: 'B', col: 0.5, row: 0 },
    { id: 'old', title: 'Old', col: 3, row: 0, status: 'removed' },
    { id: 'new', title: 'New', col: 3, row: 0, status: 'added' },
  ]);
  const found = findOverlaps(d);
  assert.deepEqual(found.find((o) => o.a === 'a').b, 'b');
  assert.equal(found.find((o) => o.a === 'old').replacement, true);
});

test('autoLayout places unpositioned nodes left to right by dependency', () => {
  const d = spec([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }], [
    { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' },
  ]);
  const warnings = [];
  autoLayout(d, warnings);
  assert.deepEqual(d.nodes.map((n) => [n.col, n.row]), [[0, 0], [1, 0], [2, 0]]);
  assert.equal(warnings.length, 1);
});

test('unmapped entries match exact paths, folders and globs', () => {
  assert.ok(matchesUnmapped('package-lock.json', { path: 'package-lock.json' }));
  assert.ok(matchesUnmapped('docs/a/b.md', { path: 'docs/' }));
  assert.ok(matchesUnmapped('src/x/y.test.ts', { path: 'src/**/*.test.ts' }));
  assert.ok(!matchesUnmapped('src/y.ts', { path: 'src/**/*.test.ts' }));
});

const DIFF = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,3 +1,3 @@ function one() {
 x
-y
+Y
 z
@@ -20,3 +20,4 @@ function two() {
 p
+q
 r
 s
diff --git a/b.js b/b.js
--- a/b.js
+++ b/b.js
@@ -1 +1 @@
-1
+2
`;

test('resolveCode attaches the hunks a range touches and reports coverage', () => {
  const files = parseUnifiedDiff(DIFF);
  const s = spec([
    { id: 'n1', title: 'One', col: 0, row: 0, status: 'changed', detail: detail({ code: [{ path: 'a.js', lines: '2' }] }) },
    { id: 'n2', title: 'Two', col: 1, row: 0, status: 'changed', detail: detail({ code: [{ path: 'a.js', symbol: 'two' }] }) },
    { id: 'n3', title: 'Three', col: 2, row: 0, status: 'changed', detail: detail({ code: [{ path: 'a.js', lines: '50-60' }] }) },
  ]);
  const warnings = [];
  const { files: out, referenced } = resolveCode(s, files, warnings);
  assert.deepEqual(s.nodes[0].detail.code[0].hunks, [0]);
  assert.deepEqual(s.nodes[1].detail.code[0].hunks, [1]);
  assert.deepEqual(s.nodes[2].detail.code[0].hunks, []);
  assert.ok(warnings.some((w) => w.includes('lines 50-60')));
  assert.equal(out['a.js'].hunks.length, 2);
  const cov = coverage(s, files, referenced);
  assert.deepEqual(cov.unexplained.map((f) => f.path), ['b.js']);
});

test('summaryMarkdown lists changes, QA checks and unexplained files', () => {
  const data = {
    title: 'T', pr: { number: 7, base: 'a'.repeat(40), head: 'b'.repeat(40) }, risk: 'high', riskNote: 'money',
    nodes: [{ id: 'a', title: 'Checkout', status: 'changed', detail: { headline: 'Now charges once', qa: [{ check: 'Pay twice', expect: 'one charge' }] } }],
    edges: [],
    coverage: { unexplained: [{ path: 'x.js' }], unmapped: [{ path: 'lock', reason: 'lockfile' }] },
    stats: { files: 2, additions: 3, deletions: 1 },
  };
  const md = summaryMarkdown(data);
  assert.match(md, /PR #7/);
  assert.match(md, /\*\*Changed\*\* · Checkout — Now charges once/);
  assert.match(md, /- \[ \] Checkout: Pay twice → one charge/);
  assert.match(md, /`x\.js`/);
  assert.match(md, /Risk: high/);
});
