// Assemble the single-file HTML report: template + styles + viewer + embedded data.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** JSON that is safe inside <script type="application/json">: no "</script", "<!--", or line separators. */
export function scriptSafeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The same page without web-font links, for headless checks that must not depend on the network. */
export function withoutWebFonts(html) {
  return html.replace(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/g, '');
}

export function buildHtml(data) {
  const read = (f) => readFileSync(path.join(ASSETS, f), 'utf8');
  const title = [data.pr && data.pr.number != null ? `PR #${data.pr.number}` : null, data.title || 'Visual QA'].filter(Boolean).join(' · ');
  const parts = {
    __VQA_TITLE__: escapeHtml(title),
    __VQA_DATA__: scriptSafeJson(data),
    '/*__VQA_CSS__*/': read('viewer.css'),
    '/*__VQA_JS__*/': read('viewer.js'),
  };
  // One pass, so inserted content is never scanned for placeholders.
  return read('template.html').replace(/__VQA_TITLE__|__VQA_DATA__|\/\*__VQA_CSS__\*\/|\/\*__VQA_JS__\*\//g, (m) => parts[m]);
}
