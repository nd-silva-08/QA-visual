import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHtml, scriptSafeJson, withoutWebFonts } from '../skills/visual-qa/scripts/lib/build.mjs';

test('embedded JSON cannot close its script tag', () => {
  const json = scriptSafeJson({ s: '</script><script>alert(1)</script><!-- & \u2028' });
  assert.ok(!json.includes('<'));
  assert.ok(!json.includes('>'));
  assert.ok(!json.includes('\u2028'));
  assert.deepEqual(JSON.parse(json), { s: '</script><script>alert(1)</script><!-- & \u2028' });
});

test('buildHtml escapes the title and fills placeholders in one pass', () => {
  const html = buildHtml({ title: '</title><script>bad()</script>', summary: '/*__VQA_JS__*/ __VQA_DATA__', nodes: [] });
  assert.ok(html.includes('&lt;/title&gt;&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>bad()'));
  assert.equal(html.split('Draws the embedded report').length - 1, 1, 'viewer inlined exactly once');
  assert.ok(html.includes('/*__VQA_JS__*/ __VQA_DATA__'), 'placeholder-looking data is left alone');
  const data = /<script type="application\/json" id="vqa-data">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.equal(JSON.parse(data).summary, '/*__VQA_JS__*/ __VQA_DATA__');
});

test('withoutWebFonts removes only the font links', () => {
  const html = buildHtml({ title: 'x', nodes: [] });
  assert.ok(html.includes('fonts.googleapis.com'));
  const offline = withoutWebFonts(html);
  assert.ok(!offline.includes('fonts.googleapis.com'));
  assert.ok(!offline.includes('fonts.gstatic.com'));
  assert.ok(offline.includes('id="vqa-data"'));
});
