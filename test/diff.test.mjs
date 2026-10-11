import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hunkTouches, outline, parsePatchHunks, parseRange, parseUnifiedDiff, unquote } from '../skills/visual-qa/scripts/lib/diff.mjs';

const SAMPLE = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,4 +1,5 @@ function top() {
 const a = 1;
--- this removed line starts with dashes
+++ this added line starts with pluses
+added
 const b = 2;
 const c = 3;
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
index 5555555..6666666 100644
--- a/old name.txt
+++ b/new name.txt
@@ -2 +2 @@
-x
+y
diff --git a/img.png b/img.png
index 7777777..8888888 100644
Binary files a/img.png and b/img.png differ
`;

test('parses modified, added, deleted, renamed and binary files', () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [
    ['src/a.js', 'modified'],
    ['new.txt', 'added'],
    ['gone.txt', 'deleted'],
    ['new name.txt', 'renamed'],
    ['img.png', 'modified'],
  ]);
  const [a, added, gone, renamed, img] = files;
  assert.equal(a.additions, 2);
  assert.equal(a.deletions, 1);
  assert.equal(a.hunks[0].header, 'function top() {');
  assert.deepEqual(a.hunks[0].lines[1], ['-', 2, null, '-- this removed line starts with dashes']);
  assert.deepEqual(a.hunks[0].lines[2], ['+', null, 2, '++ this added line starts with pluses']);
  assert.deepEqual(a.hunks[0].lines[4], [' ', 3, 4, 'const b = 2;']);
  assert.equal(added.additions, 2);
  assert.equal(gone.deletions, 1);
  assert.equal(renamed.oldPath, 'old name.txt');
  assert.equal(img.binary, true);
});

test('handles git-quoted paths', () => {
  const diff = 'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n';
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.path, 'café.txt');
  assert.equal(unquote('"tab\\there"'), 'tab\there');
});

test('hunkTouches looks at changed lines on the requested side', () => {
  const [a] = parseUnifiedDiff(SAMPLE);
  const hk = a.hunks[0];
  assert.equal(hunkTouches(hk, [2, 2], 'head'), true);
  assert.equal(hunkTouches(hk, [3, 3], 'head'), true);
  assert.equal(hunkTouches(hk, [4, 5], 'head'), false, 'context lines only');
  assert.equal(hunkTouches(hk, [2, 2], 'base'), true);
  assert.equal(hunkTouches(hk, [3, 3], 'base'), true, 'insertions are anchored where they go in');
  assert.equal(hunkTouches(hk, [4, 4], 'base'), false);
});

test('parsePatchHunks recomputes counts from the body', () => {
  const hunks = parsePatchHunks(['@@ -10,99 +10,99 @@ fn()', ' keep', '-old', '+new', '+more', ' tail'].join('\n'));
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].oldLines, 3);
  assert.equal(hunks[0].newLines, 4);
  assert.deepEqual(hunks[0].lines[2], ['+', null, 11, 'new']);
});

test('parseRange accepts single lines and ranges', () => {
  assert.deepEqual(parseRange('40'), [40, 40]);
  assert.deepEqual(parseRange('88-40'), [40, 88]);
  assert.equal(parseRange('forty'), null);
});

test('outline finds the definitions new code starts, in several languages', () => {
  const src = [
    "import { mail } from './mail.js';",
    "const fs = require('fs');",
    'export async function pay(refund) {',
    '  const total = 1;',
    '}',
    'export const LIMIT = 50;',
    'class Refunds:',
    '    def approve(self):',
    '        def inner(): pass',
    'func (r *Repo) Save(ctx context.Context) error {',
    'pub(crate) fn decide() {}',
    'impl<T> Store for Cache<T> where T: Clone {',
    '    pub fn get(&self) {}',
    'type(value)',
    'type Props = { a: string }',
  ];
  assert.deepEqual(outline(src.map((t, i) => [i + 1, t])), [
    { line: 3, label: 'function pay' },
    { line: 6, label: 'const LIMIT' },
    { line: 7, label: 'class Refunds' },
    { line: 8, label: 'def approve' },
    { line: 10, label: 'func Save' },
    { line: 11, label: 'fn decide' },
    { line: 12, label: 'impl<T> Store for Cache<T>' },
    { line: 13, label: 'fn get' },
    { line: 15, label: 'type Props' },
  ]);
});
