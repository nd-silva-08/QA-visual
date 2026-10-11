/* visual-qa viewer · MIT · https://github.com/nd-silva-08/QA-visual
 * Draws the embedded report (#vqa-data) as Before / After / Side-by-side diagrams that share
 * one layout, with a change ledger and a details drawer. No dependencies, no network calls. */
(() => {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const STATUSES = ['unchanged', 'added', 'changed', 'removed'];
  const BADGE = { added: '+ New', changed: 'Δ Changed', removed: '− Removed' };
  const WORD = { unchanged: 'Unchanged', added: 'New', changed: 'Changed', removed: 'Removed' };
  const SYM = { added: '+', changed: 'Δ', removed: '−' };
  const LAYOUT = {
    colWidth: 248, gapX: 72, rowGap: 64, padX: 40, padY: 36,
    sectionHeader: 64, sectionGap: 44, minNodeHeight: 88, decisionRatio: 0.62,
  };
  const SIDES = ['right', 'bottom', 'left', 'top'];
  const DIR = { right: [1, 0], left: [-1, 0], top: [0, -1], bottom: [0, 1] };
  const STUB = 18;      // straight run out of / into a node before the first bend
  const PAD = 8;        // clearance a wire keeps from boxes it passes
  const CORNER = 8;     // bend radius
  const ZOOMS = [0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];
  const VIEWS = ['before', 'after', 'compare'];

  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const snap = (v) => Math.round(v / 4) * 4;
  const uniq = (a) => [...new Set(a.map((v) => Math.round(v * 2) / 2))];
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const shortSha = (s) => (/^[0-9a-f]{12,40}$/i.test(str(s)) ? str(s).slice(0, 7) : str(s));

  const root = document.getElementById('vqa-app');
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const SHOT = params.has('shot');
  const CHECK = params.has('check');

  let report;
  let state;
  let store;
  const ui = {};
  const layouts = new Map();

  // ---------------------------------------------------------------- DOM helpers

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'style') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function s(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
    return el;
  }

  // Plain text with paragraphs (blank line) and `inline code`, built without innerHTML.
  function rich(text, tag = 'p') {
    return str(text).split(/\n\s*\n/).filter((p) => p.trim()).map((p) => {
      const el = h(tag);
      str(p).split('`').forEach((part, i) => {
        if (!part) return;
        el.append(i % 2 ? h('code', { text: part }) : document.createTextNode(part));
      });
      return el;
    });
  }

  function makeStore(key) {
    return {
      get() {
        try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { return {}; }
      },
      set(value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ }
      },
    };
  }

  function save() {
    store.set({ theme: state.theme, reviewed: [...state.reviewed], checks: state.checks });
  }

  // ---------------------------------------------------------------- data

  function normalize(r) {
    const pr = r && typeof r.pr === 'object' && r.pr ? r.pr : {};
    const rep = {
      title: str(r.title) || str(pr.title) || 'Visual QA',
      summary: str(r.summary),
      risk: ['low', 'medium', 'high'].includes(r.risk) ? r.risk : '',
      riskNote: str(r.riskNote),
      pr,
      theme: r.theme,
      generated: r.generated || {},
      stats: r.stats || pr.stats || null,
      files: r.files && typeof r.files === 'object' ? r.files : {},
      coverage: r.coverage || { unmapped: Array.isArray(r.unmapped) ? r.unmapped : [], unexplained: [], partial: [] },
    };
    const list = Array.isArray(r.diagrams) && r.diagrams.length ? r.diagrams : [r];
    rep.diagrams = list.map((d, i) => normDiagram(d, i, list.length, rep.title));
    return rep;
  }

  function normDiagram(d, i, count, fallbackTitle) {
    const rawSecs = Array.isArray(d.sections) && d.sections.length ? d.sections : [{ id: '_main' }];
    const sections = rawSecs.map((sec, j) => ({
      id: str(sec.id) || 's' + j,
      title: str(sec.title),
      subtitle: str(sec.subtitle),
      number: sec.number != null ? str(sec.number) : sec.title && rawSecs.length > 1 ? String(j + 1) : '',
    }));
    const secIds = new Set(sections.map((x) => x.id));
    const items = new Map();
    const nodes = [];
    const rawNodes = [...(Array.isArray(d.nodes) ? d.nodes : []), ...(Array.isArray(d.notes) ? d.notes : []).map((x) => ({ shape: 'note', ...x }))];
    for (const n of rawNodes) {
      if (!n || n.id == null || items.has(str(n.id))) continue;
      const node = {
        ...n,
        kind: 'node',
        id: str(n.id),
        title: str(n.title),
        status: STATUSES.includes(n.status) ? n.status : 'unchanged',
        shape: ['decision', 'note'].includes(n.shape) ? n.shape : 'box',
        section: secIds.has(n.section) ? n.section : sections[0].id,
        col: num(n.col, 0),
        row: Math.round(num(n.row, 0)),
        span: Math.max(0.25, num(n.span, 1)),
        before: n.before && typeof n.before === 'object' ? n.before : null,
        detail: n.detail && typeof n.detail === 'object' ? n.detail : {},
      };
      nodes.push(node);
      items.set(node.id, node);
    }
    const edges = [];
    (Array.isArray(d.edges) ? d.edges : []).forEach((e, k) => {
      if (!e || !items.has(str(e.from)) || !items.has(str(e.to)) || str(e.from) === str(e.to)) return;
      let id = str(e.id) || 'e' + k;
      while (items.has(id)) id += '_';
      const edge = {
        ...e,
        kind: 'edge',
        id,
        from: str(e.from),
        to: str(e.to),
        status: STATUSES.includes(e.status) ? e.status : 'unchanged',
        style: e.style === 'dashed' ? 'dashed' : 'solid',
        before: e.before && typeof e.before === 'object' ? e.before : null,
        detail: e.detail && typeof e.detail === 'object' ? e.detail : {},
      };
      edges.push(edge);
      items.set(id, edge);
    });
    return {
      id: str(d.id) || (count > 1 ? 'd' + i : 'main'),
      title: str(d.title) || (count > 1 ? 'Diagram ' + (i + 1) : fallbackTitle),
      description: str(d.description),
      layout: { ...LAYOUT, ...(d.layout && typeof d.layout === 'object' ? d.layout : {}) },
      legend: d.legend === false ? false : Array.isArray(d.legend) ? d.legend : [],
      sections,
      nodes,
      edges,
      items,
    };
  }

  function textOf(item, view) {
    const b = view === 'before' && item.before ? item.before : {};
    const pick = (k) => (b[k] !== undefined ? b[k] : item[k]);
    return {
      title: str(pick('title')),
      sub: str(pick('sub')),
      tech: str(pick('tech')),
      bullets: Array.isArray(pick('bullets')) ? pick('bullets').map(str) : [],
      label: str(pick('label')),
      style: pick('style') === 'dashed' ? 'dashed' : 'solid',
    };
  }

  const cur = () => report.diagrams.find((d) => d.id === state.diagram) || report.diagrams[0];

  function itemTitle(d, it) {
    if (it.kind === 'edge') {
      const a = d.items.get(it.from);
      const b = d.items.get(it.to);
      const label = textOf(it, it.status === 'removed' ? 'before' : 'after').label.replace(/\n/g, ' ');
      return `${a.title} → ${b.title}${label ? ` (${label})` : ''}`;
    }
    return textOf(it, it.status === 'removed' ? 'before' : 'after').title || it.title;
  }

  // An edge with no details of its own that comes or goes with a new or removed node says so.
  function impliedNote(d, it) {
    if (it.kind !== 'edge' || str(it.detail.headline) || str(it.detail.summary)) return '';
    if (it.status !== 'added' && it.status !== 'removed') return '';
    const end = [d.items.get(it.from), d.items.get(it.to)].find((n) => n && n.status === it.status);
    return end ? `${it.status === 'added' ? 'Comes with the new part' : 'Goes with the removed part'} “${end.title}”.` : '';
  }

  // The changes in a partly explained file that nothing links to.
  function missingText(f) {
    return [f.lines ? `lines ${str(f.lines)}` : '', f.removed ? `removed before-lines ${str(f.removed)}` : ''].filter(Boolean).join('; ');
  }

  // Sections that have parts but show none in this mode: all new (Before) or all removed (the
  // clean After of side by side).
  function emptySections(d, mode) {
    const gone = mode === 'before' ? 'added' : mode === 'after-clean' ? 'removed' : null;
    if (!gone) return [];
    return d.sections.filter((sec) => {
      const ns = d.nodes.filter((n) => n.section === sec.id);
      return ns.length && ns.every((n) => n.status === gone);
    }).map((sec) => sec.id);
  }

  function changeList(d) {
    const secIndex = new Map(d.sections.map((x, i) => [x.id, i]));
    const key = (n) => [secIndex.get(n.section) || 0, n.row, n.col];
    const rows = [];
    for (const n of d.nodes) if (n.status !== 'unchanged') rows.push({ it: n, k: [...key(n), 0] });
    for (const e of d.edges) if (e.status !== 'unchanged') rows.push({ it: e, k: [...key(d.items.get(e.from)), 1] });
    rows.sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i];
      return 0;
    });
    return rows.map((r) => r.it);
  }

  function normQa(qa) {
    return (Array.isArray(qa) ? qa : []).map((q) => (typeof q === 'string'
      ? { check: q, expect: '' }
      : { check: str(q && (q.check || q.text)), expect: str(q && q.expect), why: str(q && q.why) })).filter((q) => q.check);
  }

  function parseRange(v) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(str(v).trim());
    if (!m) return null;
    const a = +m[1];
    const b = m[2] ? +m[2] : a;
    return [Math.min(a, b), Math.max(a, b)];
  }

  // ---------------------------------------------------------------- layout

  // Column geometry. A gap widens when a label on a straight link between neighbours needs room.
  function columnGrid(d, L) {
    const nCols = Math.max(1, ...d.nodes.map((n) => Math.ceil(n.col + n.span)));
    const gaps = new Array(nCols + 1).fill(L.gapX);
    for (const e of d.edges) {
      const a = d.items.get(e.from);
      const b = d.items.get(e.to);
      if (a.section !== b.section || a.row !== b.row) continue;
      const [l, r] = a.col <= b.col ? [a, b] : [b, a];
      if (!Number.isInteger(l.col) || !Number.isInteger(l.span) || l.col + l.span !== r.col) continue;
      const labels = [textOf(e, 'after').label, textOf(e, 'before').label].filter(Boolean);
      if (!labels.length) continue;
      const need = snap(Math.max(...labels.map((t) => labelSize(t).w)) + 32);
      gaps[r.col - 1] = Math.max(gaps[r.col - 1], need);
    }
    const left = [L.padX];
    for (let i = 1; i <= nCols + 1; i++) left[i] = left[i - 1] + L.colWidth + gaps[i - 1];
    const colX = (c) => {
      const i = Math.max(0, Math.floor(c));
      return left[i] + (c - i) * (L.colWidth + gaps[i]);
    };
    const width = (n) => snap(n.span <= 1 ? n.span * L.colWidth : colX(n.col + n.span - 1) + L.colWidth - colX(n.col));
    const lanes = [];
    for (let i = 1; i <= nCols; i++) lanes.push(left[i] - gaps[i - 1] / 2);
    return { nCols, colX, width, lanes };
  }

  function ensureLayout(d) {
    if (!layouts.has(d.id)) {
      const lay = layoutDiagram(d);
      const routes = routeAll(d, lay);
      layouts.set(d.id, { lay, routes });
    }
    return layouts.get(d.id);
  }

  function layoutDiagram(d) {
    const L = d.layout;
    const grid = columnGrid(d, L);
    const meas = h('div', { class: 'vqa-canvas vqa-measure' });
    document.body.append(meas);
    const size = new Map();
    for (const n of d.nodes) {
      const w = grid.width(n);
      let tall = 0;
      for (const v of n.before ? ['before', 'after'] : ['after']) {
        let el;
        if (n.shape === 'decision') {
          const t = textOf(n, v);
          el = h('div', { class: 'vqa-dtext', style: { width: Math.round(w * 0.56) + 'px', maxWidth: 'none' } },
            h('span', { class: 'vqa-title', text: t.title }), t.sub ? h('span', { class: 'vqa-sub', text: t.sub }) : null);
        } else {
          el = nodeEl(n, v, true);
          el.style.width = w + 'px';
        }
        meas.append(el);
        tall = Math.max(tall, el.getBoundingClientRect().height);
      }
      let hgt;
      if (n.shape === 'decision') hgt = Math.max(Math.round(w * L.decisionRatio), Math.ceil(tall / 0.46) + 8);
      else if (n.shape === 'note') hgt = Math.ceil(tall);
      else hgt = Math.max(L.minNodeHeight, Math.ceil(tall));
      size.set(n.id, { w, h: Math.ceil(hgt / 4) * 4 });
    }

    const colX = grid.colX;
    const rects = new Map();
    const sections = [];
    const rowGaps = [];
    let maxRight = 0;
    let y = L.padY;
    for (const sec of d.sections) {
      const ns = d.nodes.filter((n) => n.section === sec.id);
      if (!ns.length && !sec.title) continue;
      let sep = null;
      if (sections.length) {
        sep = y + L.sectionGap / 2;
        rowGaps.push(sep);
        y += L.sectionGap;
      }
      const top = y;
      let headerBox = null;
      if (sec.title) {
        const hd = sectionHeaderEl(sec);
        hd.style.position = 'absolute';
        meas.append(hd);
        const hr = hd.getBoundingClientRect();
        headerBox = { x: L.padX - 4, y: top - 4, w: Math.ceil(hr.width) + 8, h: Math.ceil(hr.height) + 8 };
        y += L.sectionHeader;
      }
      const rows = [...new Set(ns.map((n) => n.row))].sort((a, b) => a - b);
      rows.forEach((r, ri) => {
        const rn = ns.filter((n) => n.row === r);
        const boxH = Math.max(0, ...rn.filter((n) => n.shape === 'box').map((n) => size.get(n.id).h));
        const rowH = Math.max(boxH, ...rn.map((n) => size.get(n.id).h));
        for (const n of rn) {
          const sz = size.get(n.id);
          const nh = n.shape === 'box' ? boxH : sz.h;
          const topAligned = n.shape === 'note' ? n.valign !== 'center' : n.valign === 'top';
          // Heights are multiples of 4, so centring keeps every node in a row on one exact midline.
          const ny = (topAligned ? y : y + (rowH - nh) / 2) + snap(num(n.dy, 0));
          const nx = snap(colX(n.col) + num(n.dx, 0));
          rects.set(n.id, { x: nx, y: ny, w: sz.w, h: nh });
          maxRight = Math.max(maxRight, nx + sz.w);
        }
        y += rowH;
        if (ri < rows.length - 1) {
          rowGaps.push(y + L.rowGap / 2);
          y += L.rowGap;
        }
      });
      sections.push({ ...sec, top, bottom: y, sep, headerBox });
    }

    const width = Math.max(snap(maxRight + L.padX), 560);
    const colGaps = [L.padX / 2, width - L.padX / 2, ...grid.lanes];

    // A lane under the last row, then the legend strip below it.
    rowGaps.push(L.padY / 2, y + 18);
    let legend = null;
    const items = legendItems(d);
    if (items.length) {
      const el = legendEl(items);
      el.style.position = 'static';
      el.style.width = (width - 2 * L.padX) + 'px';
      meas.append(el);
      const lh = Math.ceil(el.getBoundingClientRect().height);
      legend = { sep: y + 36, top: y + 60, height: lh, items };
      y = legend.top + lh;
    }
    meas.remove();
    const height = snap(y + L.padY);

    // Places wires and labels must stay out of: section titles and the legend strip.
    const keepOut = [];
    for (const sec of sections) if (sec.headerBox) keepOut.push({ id: '§' + sec.id, label: `section "${sec.title}"`, ...sec.headerBox });
    if (legend) keepOut.push({ id: '§legend', label: 'the legend', x: L.padX, y: legend.sep - 4, w: width - 2 * L.padX, h: legend.top - legend.sep + legend.height + 8 });
    return { L, width, height, rects, sections, rowGaps, colGaps, legend, keepOut };
  }

  function sectionHeaderEl(sec) {
    return h('div', { class: 'vqa-sec' },
      sec.number ? h('span', { class: 'vqa-sec-num', text: sec.number }) : null,
      h('span', { class: 'vqa-sec-title', text: sec.title }),
      sec.subtitle ? h('span', { class: 'vqa-sec-sub', text: sec.subtitle }) : null);
  }

  // ---------------------------------------------------------------- routing

  function port(r, shape, side, off) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (shape === 'decision') {
      const k = Math.abs(off);
      switch (side) {
        case 'right': return { x: r.x + r.w - k * r.w / r.h, y: cy + off };
        case 'left': return { x: r.x + k * r.w / r.h, y: cy + off };
        case 'top': return { x: cx + off, y: r.y + k * r.h / r.w };
        default: return { x: cx + off, y: r.y + r.h - k * r.h / r.w };
      }
    }
    switch (side) {
      case 'right': return { x: r.x + r.w, y: cy + off };
      case 'left': return { x: r.x, y: cy + off };
      case 'top': return { x: cx + off, y: r.y };
      default: return { x: cx + off, y: r.y + r.h };
    }
  }

  const step = (p, side, dist) => ({ x: p.x + DIR[side][0] * dist, y: p.y + DIR[side][1] * dist });

  // Drop duplicate points, reject U-turns, merge straight runs.
  function tidy(pts) {
    const out = [];
    for (const p of pts) {
      const q = out[out.length - 1];
      if (q && Math.abs(q.x - p.x) < 0.5 && Math.abs(q.y - p.y) < 0.5) continue;
      out.push({ x: p.x, y: p.y });
    }
    if (out.length < 2) return null;
    const res = [out[0]];
    for (let i = 1; i < out.length; i++) {
      const p = out[i];
      if (res.length >= 2) {
        const a = res[res.length - 2];
        const b = res[res.length - 1];
        const d1 = [Math.sign(b.x - a.x), Math.sign(b.y - a.y)];
        const d2 = [Math.sign(p.x - b.x), Math.sign(p.y - b.y)];
        if (d1[0] === -d2[0] && d1[1] === -d2[1]) return null;
        if (d1[0] === d2[0] && d1[1] === d2[1]) { res[res.length - 1] = p; continue; }
      }
      res.push(p);
    }
    return res;
  }

  function segHits(p, q, r, pad) {
    return Math.max(p.x, q.x) > r.x - pad && Math.min(p.x, q.x) < r.x + r.w + pad
      && Math.max(p.y, q.y) > r.y - pad && Math.min(p.y, q.y) < r.y + r.h + pad;
  }

  function overlapLen(p, q, sg) {
    const hz = p.y === q.y;
    if (hz !== (sg.a.y === sg.b.y)) return 0;
    if (hz) {
      if (Math.abs(p.y - sg.a.y) >= 8) return 0;
      return Math.max(0, Math.min(Math.max(p.x, q.x), Math.max(sg.a.x, sg.b.x)) - Math.max(Math.min(p.x, q.x), Math.min(sg.a.x, sg.b.x)));
    }
    if (Math.abs(p.x - sg.a.x) >= 8) return 0;
    return Math.max(0, Math.min(Math.max(p.y, q.y), Math.max(sg.a.y, sg.b.y)) - Math.max(Math.min(p.y, q.y), Math.min(sg.a.y, sg.b.y)));
  }

  function crosses(p, q, sg) {
    const hz = p.y === q.y;
    if (hz === (sg.a.y === sg.b.y)) return false;
    const H = hz ? [p, q] : [sg.a, sg.b];
    const V = hz ? [sg.a, sg.b] : [p, q];
    const y = H[0].y;
    const x = V[0].x;
    return x > Math.min(H[0].x, H[1].x) + 1 && x < Math.max(H[0].x, H[1].x) - 1
      && y > Math.min(V[0].y, V[1].y) + 1 && y < Math.max(V[0].y, V[1].y) - 1;
  }

  function scoreRoute(pts, e, ctx, fs, ts, firstPass) {
    let len = 0;
    let hits = 0;
    let overlap = 0;
    let xings = 0;
    const n = pts.length - 1;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      len += Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      for (const o of ctx.obstacles) {
        if (i === 0 && o.id === e.from) continue;
        if (i === n - 1 && o.id === e.to) continue;
        const own = o.id === e.from || o.id === e.to;
        if (segHits(p, q, o, own ? 1 : PAD)) hits++;
      }
      for (const sg of ctx.segs) {
        if (sg.edge === e.id) continue;
        const ov = overlapLen(p, q, sg);
        if (ov > (firstPass ? STUB + 6 : 2)) overlap += ov;
        else if (crosses(p, q, sg)) xings++;
      }
    }
    let side = 0;
    if (firstPass) {
      // Prefer a free side, never mix incoming and outgoing wires on one side if avoidable,
      // and leave / enter through the side that faces the other end.
      const out = ctx.sideUse.get(e.from + '|' + fs) || { in: 0, out: 0 };
      const inn = ctx.sideUse.get(e.to + '|' + ts) || { in: 0, out: 0 };
      side += (out.in + out.out) * (ctx.shapeOf(e.from) === 'decision' ? 400 : 50) + out.in * 140;
      side += (inn.in + inn.out) * (ctx.shapeOf(e.to) === 'decision' ? 400 : 50) + inn.out * 140;
      const a = ctx.rects.get(e.from);
      const b = ctx.rects.get(e.to);
      let vx = b.x + b.w / 2 - (a.x + a.w / 2);
      let vy = b.y + b.h / 2 - (a.y + a.h / 2);
      const m = Math.hypot(vx, vy) || 1;
      vx /= m;
      vy /= m;
      side += 160 * (1 - (DIR[fs][0] * vx + DIR[fs][1] * vy));
      side += 160 * (1 + (DIR[ts][0] * vx + DIR[ts][1] * vy));
    }
    return hits * 1e5 + overlap * 10 + (overlap ? 600 : 0) + xings * 90 + len + (n - 1) * 40 + side;
  }

  function bestRoute(e, ctx, fixed, firstPass) {
    const a = ctx.rects.get(e.from);
    const b = ctx.rects.get(e.to);
    const sa = ctx.shapeOf(e.from);
    const sb = ctx.shapeOf(e.to);
    const fss = fixed ? [fixed.fs] : DIR[e.fromSide] ? [e.fromSide] : SIDES;
    const tss = fixed ? [fixed.ts] : DIR[e.toSide] ? [e.toSide] : SIDES;
    let best = null;
    for (const fs of fss) {
      for (const ts of tss) {
        const p0 = port(a, sa, fs, fixed ? fixed.fo : 0);
        const p1 = port(b, sb, ts, fixed ? fixed.to : 0);
        const P0 = step(p0, fs, STUB);
        const P1 = step(p1, ts, STUB);
        const mids = [[{ x: P1.x, y: P0.y }], [{ x: P0.x, y: P1.y }]];
        for (const x of ctx.lanesX.concat([(P0.x + P1.x) / 2])) mids.push([{ x, y: P0.y }, { x, y: P1.y }]);
        for (const y of ctx.lanesY.concat([(P0.y + P1.y) / 2])) mids.push([{ x: P0.x, y }, { x: P1.x, y }]);
        for (const m of mids) {
          const pts = tidy([p0, P0, ...m, P1, p1]);
          if (!pts) continue;
          const sc = scoreRoute(pts, e, ctx, fs, ts, firstPass);
          if (!best || sc < best.score) best = { pts, score: sc, fs, ts };
        }
      }
    }
    return best;
  }

  function addSegs(ctx, id, pts) {
    for (let i = 0; i < pts.length - 1; i++) ctx.segs.push({ edge: id, a: pts[i], b: pts[i + 1] });
  }

  function routeAll(d, lay) {
    const ctx = {
      rects: lay.rects,
      obstacles: d.nodes.map((n) => ({ id: n.id, ...lay.rects.get(n.id) })).concat(lay.keepOut),
      shapeOf: (id) => d.items.get(id).shape,
      lanesX: uniq(lay.colGaps.flatMap((x) => [x, x - 14, x + 14])),
      lanesY: uniq(lay.rowGaps.flatMap((y) => [y, y - 14, y + 14])),
      segs: [],
      sideUse: new Map(),
    };
    // Short, simple connections claim their natural sides first; long ones work around them.
    const center = (id) => { const r = lay.rects.get(id); return [r.x + r.w / 2, r.y + r.h / 2]; };
    const dist = (e) => { const [ax, ay] = center(e.from); const [bx, by] = center(e.to); return Math.abs(ax - bx) + Math.abs(ay - by); };
    const order = d.edges.map((e, i) => ({ e, i, k: dist(e) })).sort((p, q) => p.k - q.k || p.i - q.i).map((x) => x.e);
    const use = (key, dir) => {
      const v = ctx.sideUse.get(key) || { in: 0, out: 0 };
      v[dir]++;
      ctx.sideUse.set(key, v);
    };
    const first = new Map();
    for (const e of order) {
      const r = bestRoute(e, ctx, null, true);
      if (!r) continue;
      first.set(e.id, r);
      addSegs(ctx, e.id, r.pts);
      use(e.from + '|' + r.fs, 'out');
      use(e.to + '|' + r.ts, 'in');
    }

    // Spread wires that share a side so each gets its own attach point.
    const groups = new Map();
    const push = (k, v) => (groups.get(k) || groups.set(k, []).get(k)).push(v);
    for (const e of d.edges) {
      const r = first.get(e.id);
      if (!r) continue;
      push(e.from + '|' + r.fs, { id: e.id, end: 'from', node: e.from, side: r.fs, other: r.pts[r.pts.length - 1] });
      push(e.to + '|' + r.ts, { id: e.id, end: 'to', node: e.to, side: r.ts, other: r.pts[0] });
    }
    const offs = new Map();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const { node, side } = list[0];
      const rect = lay.rects.get(node);
      const vertical = side === 'left' || side === 'right';
      list.sort((p, q) => (vertical ? p.other.y - q.other.y : p.other.x - q.other.x));
      const len = vertical ? rect.h : rect.w;
      const isDecision = ctx.shapeOf(node) === 'decision';
      const room = isDecision ? len * 0.22 : len - 28;
      const gap = Math.min(isDecision ? 14 : 26, room / (list.length - 1));
      let o = list.map((_, k) => (k - (list.length - 1) / 2) * gap);
      // Keep a wire that is already dead straight on the centre line; shift the others aside.
      const mid = vertical ? rect.y + rect.h / 2 : rect.x + rect.w / 2;
      const straight = list.findIndex((it) => Math.abs((vertical ? it.other.y : it.other.x) - mid) < 1.5 && d.items.get(it.id).status !== 'removed');
      if (straight >= 0) {
        const shifted = o.map((v) => v - o[straight]);
        if (shifted.every((v) => Math.abs(v) <= (isDecision ? len * 0.22 : len / 2 - 14))) o = shifted;
      }
      list.forEach((it, k) => offs.set(it.id + '|' + it.end, o[k]));
    }

    ctx.segs = [];
    const routes = new Map();
    for (const e of order) {
      const r1 = first.get(e.id);
      if (!r1) continue;
      const fixed = { fs: r1.fs, ts: r1.ts, fo: offs.get(e.id + '|from') || 0, to: offs.get(e.id + '|to') || 0 };
      const r = bestRoute(e, ctx, fixed, false) || r1;
      routes.set(e.id, { pts: r.pts, fs: r.fs, ts: r.ts, labels: {} });
      addSegs(ctx, e.id, r.pts);
    }

    // Labels: the after (or only) text first, then before-only wording.
    const placed = [];
    const obstacles = ctx.obstacles;
    for (const pass of ['after', 'before']) {
      for (const e of d.edges) {
        const r = routes.get(e.id);
        if (!r) continue;
        const textAfter = textOf(e, 'after').label;
        const text = textOf(e, pass).label;
        if (!text || (pass === 'before' && text === textAfter)) continue;
        const box = placeLabel(e.id, r.pts, text, obstacles, placed, ctx.segs);
        placed.push(box);
        r.labels[pass] = { text, box };
      }
    }
    for (const r of routes.values()) if (!r.labels.before && r.labels.after) r.labels.before = r.labels.after;
    return routes;
  }

  let measureCtx = null;
  let labelFont = '';
  function labelSize(text) {
    if (!measureCtx) {
      measureCtx = document.createElement('canvas').getContext('2d');
      labelFont = '500 13.5px ' + (getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'sans-serif');
    }
    measureCtx.font = labelFont;
    const lines = text.split('\n');
    const w = Math.max(...lines.map((t) => measureCtx.measureText(t).width));
    return { w: Math.ceil(w) + 12, h: lines.length * 18 + 6, lines };
  }

  function boxesOverlap(a, b, pad) {
    return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
  }

  function placeLabel(edgeId, pts, text, obstacles, placed, segs) {
    const { w, h: hh } = labelSize(text);
    const segsOf = [];
    for (let i = 0; i < pts.length - 1; i++) segsOf.push({ a: pts[i], b: pts[i + 1], len: Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y) });
    segsOf.sort((p, q) => q.len - p.len);
    const candidates = [];
    for (const sg of segsOf) {
      const mx = (sg.a.x + sg.b.x) / 2;
      const my = (sg.a.y + sg.b.y) / 2;
      if (sg.a.y === sg.b.y) {
        candidates.push({ x: mx - w / 2, y: my - 5 - hh, w, h: hh }, { x: mx - w / 2, y: my + 5, w, h: hh });
      } else {
        candidates.push({ x: mx + 7, y: my - hh / 2, w, h: hh }, { x: mx - 7 - w, y: my - hh / 2, w, h: hh });
      }
    }
    const freeOf = (box, withWires) => !obstacles.some((o) => boxesOverlap(box, o, 4))
      && !placed.some((p) => boxesOverlap(box, p, 4))
      && (!withWires || !segs.some((sg) => sg.edge !== edgeId && segHits(sg.a, sg.b, box, 1)));
    const pick = candidates.find((c) => freeOf(c, true)) || candidates.find((c) => freeOf(c, false));
    if (pick) return { ...pick, edge: edgeId };
    const sg = segsOf[0];
    return { x: (sg.a.x + sg.b.x) / 2 - w / 2, y: (sg.a.y + sg.b.y) / 2 - hh / 2, w, h: hh, edge: edgeId, onLine: true };
  }

  function roundedPath(pts) {
    let d = `M${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const l1 = Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y);
      const l2 = Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y);
      const r = Math.min(CORNER, l1 / 2, l2 / 2);
      const a = { x: p1.x - Math.sign(p1.x - p0.x) * r, y: p1.y - Math.sign(p1.y - p0.y) * r };
      const b = { x: p1.x + Math.sign(p2.x - p1.x) * r, y: p1.y + Math.sign(p2.y - p1.y) * r };
      d += ` L${a.x} ${a.y} Q${p1.x} ${p1.y} ${b.x} ${b.y}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last.x} ${last.y}`;
  }

  function nearestOnPath(pts, p) {
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const q = {
        x: Math.min(Math.max(p.x, Math.min(a.x, b.x)), Math.max(a.x, b.x)),
        y: Math.min(Math.max(p.y, Math.min(a.y, b.y)), Math.max(a.y, b.y)),
      };
      const dd = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      if (!best || dd < best.dd) best = { ...q, dd };
    }
    return best;
  }

  // Dotted leader from a note to the edge or node it explains.
  function attachPoints(note, lay, routes) {
    const r = lay.rects.get(note.id);
    const target = str(note.attach);
    if (!r || !target) return null;
    const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    let P = null;
    if (routes.has(target)) P = nearestOnPath(routes.get(target).pts, { x: center.x, y: r.y });
    else if (lay.rects.has(target)) {
      const t = lay.rects.get(target);
      P = nearestOnPath([{ x: t.x, y: t.y }, { x: t.x + t.w, y: t.y }, { x: t.x + t.w, y: t.y + t.h }, { x: t.x, y: t.y + t.h }, { x: t.x, y: t.y }], center);
    }
    if (!P) return null;
    const clampX = (x) => Math.min(Math.max(x, r.x + 10), r.x + r.w - 10);
    const clampY = (y) => Math.min(Math.max(y, r.y + 10), r.y + r.h - 10);
    let S;
    if (P.y < r.y) S = { x: clampX(P.x), y: r.y - 8 };
    else if (P.y > r.y + r.h) S = { x: clampX(P.x), y: r.y + r.h + 8 };
    else if (P.x < r.x) S = { x: r.x - 8, y: clampY(P.y) };
    else S = { x: r.x + r.w + 8, y: clampY(P.y) };
    const vertical = S.y !== clampY(S.y);
    if (vertical) {
      if (Math.abs(S.x - P.x) < 1) return [P, S];
      const my = (P.y + S.y) / 2;
      return [P, { x: P.x, y: my }, { x: S.x, y: my }, S];
    }
    if (Math.abs(S.y - P.y) < 1) return [P, S];
    const mx = (P.x + S.x) / 2;
    return [P, { x: mx, y: P.y }, { x: mx, y: S.y }, S];
  }

  // ---------------------------------------------------------------- drawing

  function visibility(item, mode) {
    if (mode === 'before') return item.status === 'added' ? 0 : 1;
    if (item.status === 'removed') return mode === 'after' ? 2 : 0;
    return 1;
  }

  function isInteractive(it) {
    return it.status !== 'unchanged' || !!(it.detail && (it.detail.summary || (it.detail.code && it.detail.code.length)));
  }

  function nodeEl(n, view, measuring) {
    const t = textOf(n, view);
    const tag = measuring || n.shape !== 'note' || isInteractive(n) ? 'button' : 'div';
    const el = h(tag, { class: `vqa-node vqa-${n.shape} st-${n.status}`, 'data-id': n.id });
    if (tag === 'button') el.type = 'button';
    if (n.shape === 'decision') {
      const svg = s('svg', { class: 'vqa-diamond', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      svg.append(s('polygon', { points: '50,1 99,50 50,99 1,50' }));
      el.append(svg, h('span', { class: 'vqa-dtext' }, h('span', { class: 'vqa-title', text: t.title }), t.sub ? h('span', { class: 'vqa-sub', text: t.sub }) : null));
    } else {
      el.append(h('span', { class: 'vqa-title', text: t.title }));
      if (t.sub) el.append(h('span', { class: 'vqa-sub', text: t.sub }));
      if (t.bullets.length) el.append(h('span', { class: 'vqa-bullets' }, t.bullets.map((b) => h('span', { class: 'vqa-bullet', text: b }))));
      if (t.tech && n.shape !== 'note') el.append(h('span', { class: 'vqa-tech', text: t.tech }));
    }
    if (BADGE[n.status]) el.append(h('span', { class: 'vqa-badge', text: BADGE[n.status], 'aria-hidden': 'true' }));
    if (tag === 'button') el.setAttribute('aria-label', `${WORD[n.status]}: ${t.title}${t.sub ? '. ' + t.sub : ''}`);
    return el;
  }

  function legendItems(d) {
    if (d.legend === false) return [];
    const present = new Set([...d.nodes, ...d.edges].map((i) => i.status));
    const out = [];
    if (present.has('added')) out.push({ sw: 'box', st: 'added', label: 'New in this PR' });
    if (present.has('changed')) out.push({ sw: 'box', st: 'changed', label: 'Changed' });
    if (present.has('removed')) out.push({ sw: 'box', st: 'removed', label: 'Removed' });
    out.push({ sw: 'box', st: 'unchanged', label: 'Unchanged' });
    if (d.nodes.some((n) => n.shape === 'decision')) out.push({ sw: 'diamond', label: 'A check it makes' });
    if (d.edges.some((e) => e.style === 'dashed' || (e.before && e.before.style === 'dashed'))) out.push({ sw: 'dashed', label: 'Looks up, or waits on something' });
    for (const x of d.legend) {
      if (!x || !x.label) continue;
      out.push({ sw: ['box', 'diamond', 'dashed', 'solid'].includes(x.swatch) ? x.swatch : 'box', st: STATUSES.includes(x.status) ? x.status : 'unchanged', label: str(x.label) });
    }
    return out;
  }

  function legendEl(items) {
    return h('div', { class: 'vqa-legend' }, items.map((it) => {
      let sw;
      if (it.sw === 'diamond') {
        sw = s('svg', { class: 'vqa-sw-diamond', viewBox: '0 0 30 20', 'aria-hidden': 'true' });
        sw.append(s('polygon', { points: '15,1 29,10 15,19 1,10' }));
      } else if (it.sw === 'dashed' || it.sw === 'solid') {
        sw = h('span', { class: 'vqa-sw-line' + (it.sw === 'solid' ? ' is-solid' : '') });
      } else {
        sw = h('span', { class: 'vqa-sw st-' + (it.st || 'unchanged') });
      }
      return h('span', { class: 'vqa-legend-item' }, sw, h('span', { text: it.label }));
    }));
  }

  function buildCanvas(d, lay, routes, mode, key) {
    const L = lay.L;
    const view = mode === 'before' ? 'before' : 'after';
    const cv = h('div', { class: 'vqa-canvas', 'data-mode': mode, style: { width: lay.width + 'px', height: lay.height + 'px' } });

    const empty = new Set(emptySections(d, mode));
    for (const sec of lay.sections) {
      if (sec.sep != null) cv.append(h('div', { class: 'vqa-sep', style: { top: sec.sep + 'px', left: L.padX + 'px', width: lay.width - 2 * L.padX + 'px' } }));
      if (sec.title) {
        const hd = sectionHeaderEl(sec);
        Object.assign(hd.style, { top: sec.top + 'px', left: L.padX + 'px' });
        cv.append(hd);
      }
      if (empty.has(sec.id)) {
        const top = sec.headerBox ? sec.top + L.sectionHeader : sec.top;
        cv.append(h('div', {
          class: 'vqa-sec-empty',
          text: mode === 'before' ? 'Nothing here before this change' : 'Nothing here after this change',
          style: { top: top + 'px', height: Math.max(24, sec.bottom - top) + 'px', left: L.padX + 'px', width: lay.width - 2 * L.padX + 'px' },
        }));
      }
    }

    // A removed part that shares its spot with a new part is not drawn as a ghost.
    const added = d.nodes.filter((n) => n.status === 'added').map((n) => lay.rects.get(n.id));
    const nodeVis = new Map(d.nodes.map((n) => {
      let v = visibility(n, mode);
      if (v === 2 && added.some((r) => boxesOverlap(r, lay.rects.get(n.id), -2))) v = 0;
      return [n.id, v];
    }));

    const svg = s('svg', { class: 'vqa-wires', width: lay.width, height: lay.height, viewBox: `0 0 ${lay.width} ${lay.height}`, 'aria-hidden': 'true' });
    const defs = s('defs');
    for (const st of STATUSES) {
      const m = s('marker', { id: `vqa-ah-${key}-${st}`, viewBox: '0 0 10 10', refX: 9.6, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
      m.append(s('path', { d: 'M0 0.8 L9.6 5 L0 9.2 Z', class: 'vqa-ah st-' + st }));
      defs.append(m);
    }
    svg.append(defs);

    for (const n of d.nodes) {
      if (!n.attach || !nodeVis.get(n.id)) continue;
      const target = d.items.get(str(n.attach));
      if (!target) continue;
      const tv = target.kind === 'edge' ? Math.min(visibility(target, mode), nodeVis.get(target.from) || 0, nodeVis.get(target.to) || 0) : nodeVis.get(target.id);
      if (!tv) continue;
      const pts = attachPoints(n, lay, routes);
      if (pts) svg.append(s('path', { class: 'vqa-attach', d: roundedPath(pts) }));
    }

    const labels = s('g', { class: 'vqa-labels' });
    for (const e of d.edges) {
      const r = routes.get(e.id);
      if (!r) continue;
      const ends = Math.min(nodeVis.get(e.from) || 0, nodeVis.get(e.to) || 0);
      let v = visibility(e, mode);
      if (!ends) v = 0;
      if (!v) continue;
      if (ends === 2) v = 2;
      const t = textOf(e, view);
      const g = s('g', { class: `vqa-edge st-${e.status}${t.style === 'dashed' ? ' is-dashed' : ''}${v === 2 ? ' is-ghost' : ''}`, 'data-id': e.id });
      const dpath = roundedPath(r.pts);
      if (isInteractive(e)) g.append(s('path', { class: 'vqa-edge-hit', d: dpath }));
      g.append(s('path', {
        class: 'vqa-edge-line',
        d: dpath,
        'marker-end': `url(#vqa-ah-${key}-${e.status})`,
        'marker-start': e.both ? `url(#vqa-ah-${key}-${e.status})` : null,
      }));
      svg.append(g);
      const lab = r.labels[view];
      if (lab && t.label && v !== 2) {
        const lg = s('g', { class: `vqa-edge st-${e.status}${v === 2 ? ' is-ghost' : ''}`, 'data-id': e.id });
        lg.append(s('rect', { class: 'vqa-lmask', x: lab.box.x, y: lab.box.y, width: lab.box.w, height: lab.box.h, rx: 3 }));
        const text = s('text', { class: 'vqa-ltext', x: lab.box.x + lab.box.w / 2, y: lab.box.y + 3, 'text-anchor': 'middle' });
        t.label.split('\n').forEach((line, i) => {
          const tsp = s('tspan', { x: lab.box.x + lab.box.w / 2, dy: i ? 18 : 14 });
          tsp.textContent = line;
          text.append(tsp);
        });
        lg.append(text);
        labels.append(lg);
      }
    }
    svg.append(labels);
    cv.append(svg);

    for (const n of d.nodes) {
      const v = nodeVis.get(n.id);
      if (!v) continue;
      const r = lay.rects.get(n.id);
      const el = nodeEl(n, view, false);
      Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      if (v === 2) el.classList.add('is-ghost');
      cv.append(el);
    }

    if (lay.legend) {
      cv.append(h('div', { class: 'vqa-sep', style: { top: lay.legend.sep + 'px', left: L.padX + 'px', width: lay.width - 2 * L.padX + 'px' } }));
      const lg = legendEl(lay.legend.items);
      Object.assign(lg.style, { left: L.padX + 'px', top: lay.legend.top + 'px', width: lay.width - 2 * L.padX + 'px' });
      cv.append(lg);
    }

    cv.addEventListener('click', (ev) => {
      if (SHOT) return;
      const hit = ev.target.closest('[data-id]');
      if (hit && cv.contains(hit)) {
        const it = d.items.get(hit.dataset.id);
        if (it && (it.kind === 'node' ? hit.tagName === 'BUTTON' : isInteractive(it))) {
          select(it.id);
          return;
        }
      }
      if (ev.target === cv || ev.target.closest('.vqa-wires')) select(null);
    });
    return cv;
  }

  // ---------------------------------------------------------------- app shell

  function cap(s0) { return s0.charAt(0).toUpperCase() + s0.slice(1); }

  function buildShell() {
    root.textContent = '';
    const pr = report.pr;
    const eyebrow = h('div', { class: 'vqa-eyebrow' }, h('span', { text: 'Visual QA' }));
    if (pr.number != null && pr.number !== '') {
      const url = safeUrl(pr.url);
      eyebrow.append(url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: `PR #${pr.number} ↗` }) : h('span', { text: `PR #${pr.number}` }));
    }
    if (report.diagrams.length > 1) eyebrow.append(h('span', { text: `${report.diagrams.length} diagrams` }));

    const meta = h('div', { class: 'vqa-meta' });
    if (pr.headRef || pr.baseRef) {
      meta.append(h('span', null,
        pr.author ? `${pr.author} wants to merge ` : 'Merging ',
        h('code', { text: str(pr.headRef) || shortSha(pr.head) || 'this branch' }),
        ' into ',
        h('code', { text: str(pr.baseRef) || shortSha(pr.base) || 'the base' })));
    }
    const st = report.stats;
    if (st && (st.files || st.additions || st.deletions)) {
      meta.append(h('span', null, `${st.files} file${st.files === 1 ? '' : 's'} `, h('span', { class: 'vqa-plus', text: '+' + (st.additions || 0) }), ' ', h('span', { class: 'vqa-minus', text: '−' + (st.deletions || 0) })));
    }
    if (pr.base || pr.head) {
      meta.append(h('span', { class: 'vqa-sha-line' }, h('code', { text: shortSha(pr.base) || '?' }), ' → ', h('code', { text: report.generated.worktree ? 'working tree' : shortSha(pr.head) || '?' })));
    }

    ui.seg = h('div', { class: 'vqa-seg', role: 'radiogroup', 'aria-label': 'Diagram view' },
      VIEWS.map((v) => h('button', { type: 'button', role: 'radio', 'data-view': v, onclick: () => setView(v), text: v === 'compare' ? 'Side by side' : cap(v) })));
    ui.zoomVal = h('button', { class: 'vqa-btn vqa-zoom-val', type: 'button', title: 'Fit to width (0)', onclick: () => setZoom('fit') });
    const zoom = h('div', { class: 'vqa-zoom' },
      h('button', { class: 'vqa-btn', type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out (−)', onclick: () => zoomBy(-1), text: '−' }),
      ui.zoomVal,
      h('button', { class: 'vqa-btn', type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in (+)', onclick: () => zoomBy(1), text: '+' }));
    const themeBtn = h('button', { class: 'vqa-btn', type: 'button', onclick: toggleTheme, title: 'Light or dark', text: '◐' });
    themeBtn.setAttribute('aria-label', 'Switch between light and dark');

    root.append(h('header', { class: 'vqa-top' },
      h('div', { class: 'vqa-top-main' }, eyebrow, h('h1', { class: 'vqa-h1', text: report.title }), meta),
      h('div', { class: 'vqa-controls' }, ui.seg, zoom, themeBtn)));

    const chips = h('div', { class: 'vqa-chips' });
    const totals = { added: 0, changed: 0, removed: 0 };
    for (const d of report.diagrams) for (const it of changeList(d)) totals[it.status]++;
    if (report.risk) chips.append(h('span', { class: 'vqa-chip risk-' + report.risk, title: report.riskNote || null, text: `${report.risk} risk` }));
    for (const k of ['added', 'changed', 'removed']) if (totals[k]) chips.append(h('span', { class: 'vqa-chip st-' + k, text: `${totals[k]} ${WORD[k].toLowerCase()}` }));
    if (report.summary || chips.childNodes.length) {
      root.append(h('section', { class: 'vqa-brief' },
        report.summary || report.riskNote ? h('div', { class: 'vqa-brief-text' }, rich(report.summary), report.riskNote ? rich('Risk: ' + report.riskNote) : null) : null,
        chips));
    }

    ui.tabs = h('nav', { class: 'vqa-tabs', role: 'tablist', 'aria-label': 'Diagrams' });
    if (report.diagrams.length > 1) root.append(ui.tabs);
    ui.ledger = h('aside', { class: 'vqa-ledger', 'aria-label': 'What changed' });
    ui.stage = h('main', { class: 'vqa-stage' });
    root.append(h('div', { class: 'vqa-body' }, ui.ledger, ui.stage));
    ui.drawer = h('aside', { class: 'vqa-drawer', 'aria-label': 'Details', 'aria-hidden': 'true' });
    ui.toast = h('div', { class: 'vqa-toast', role: 'status', 'aria-live': 'polite' });
    root.append(ui.drawer, ui.toast);
  }

  function renderAll() {
    renderSeg();
    renderTabs();
    renderLedger();
    renderStage();
    renderDrawer();
  }

  function renderSeg() {
    for (const b of ui.seg.children) b.setAttribute('aria-checked', String(b.dataset.view === state.view));
  }

  function renderTabs() {
    ui.tabs.textContent = '';
    if (report.diagrams.length < 2) return;
    for (const d of report.diagrams) {
      const n = changeList(d).length;
      ui.tabs.append(h('button', {
        class: 'vqa-tab', type: 'button', role: 'tab', 'aria-selected': String(d.id === state.diagram),
        onclick: () => setDiagram(d.id),
      }, d.title, h('span', { class: 'vqa-tab-count', text: n ? `${n} change${n === 1 ? '' : 's'}` : 'no changes' })));
    }
  }

  function renderLedger() {
    const d = cur();
    const L = ui.ledger;
    L.textContent = '';
    const changes = changeList(d);
    const done = changes.filter((c) => state.reviewed.has(d.id + ':' + c.id)).length;
    L.append(h('div', { class: 'vqa-ledger-head' }, h('h2', { text: 'What changed' }), h('span', { class: 'vqa-count', text: String(changes.length) })));
    if (changes.length) {
      L.append(h('div', { class: 'vqa-progress' },
        h('div', { class: 'vqa-progress-bar' }, h('span', { style: { width: Math.round((done / changes.length) * 100) + '%' } })),
        h('span', { text: `${done} of ${changes.length} reviewed` })));
      const ol = h('ol', { class: 'vqa-ledger-list' });
      for (const c of changes) {
        const reviewed = state.reviewed.has(d.id + ':' + c.id);
        const line = str(c.detail.headline) || firstSentence(c.detail.summary) || impliedNote(d, c);
        ol.append(h('li', null, h('button', {
          class: 'vqa-li' + (state.selected === c.id ? ' is-selected' : ''), type: 'button', 'data-id': c.id,
          onclick: () => select(c.id, { scroll: true }),
        },
        h('span', { class: 'vqa-sym st-' + c.status, text: SYM[c.status], title: WORD[c.status] }),
        h('span', { class: 'vqa-li-title' }, itemTitle(d, c), c.kind === 'edge' ? h('span', { class: 'vqa-li-kind', text: 'link' }) : null),
        h('span', { class: 'vqa-li-check', text: reviewed ? '✓' : '', title: reviewed ? 'Reviewed' : null }),
        line ? h('span', { class: 'vqa-li-line', text: line }) : null)));
      }
      L.append(ol);
    } else {
      L.append(h('p', { class: 'vqa-empty', text: 'Nothing in this diagram changes in this PR.' }));
    }

    const cov = report.coverage || {};
    const fileList = (title, files, warn) => h('div', { class: 'vqa-ledger-sec' + (warn ? ' is-warn' : '') },
      h('h3', { text: `${title} (${files.length})` }),
      h('ul', { class: 'vqa-files' }, files.map((f) => h('li', null,
        h('code', { text: str(f.path) + (f.lines ? ` · lines ${str(f.lines)}` : '') }),
        f.reason ? str(f.reason) : f.missing ? `Not linked: ${f.missing}` : warn ? 'Not linked to any part of the diagram.' : null))));
    if (Array.isArray(cov.unexplained) && cov.unexplained.length) L.append(fileList('Changed, not explained', cov.unexplained, true));
    if (Array.isArray(cov.partial) && cov.partial.length) L.append(fileList('Explained only in part', cov.partial.map((f) => ({ path: f.path, missing: missingText(f) })), true));
    if (Array.isArray(cov.unmapped) && cov.unmapped.length) L.append(fileList('Not in the diagram', cov.unmapped, false));

    L.append(h('div', { class: 'vqa-ledger-actions' }, h('button', { class: 'vqa-btn', type: 'button', onclick: copyChecklist, text: 'Copy QA checklist' })));
    const kbd = (k) => h('kbd', { text: k });
    L.append(h('p', { class: 'vqa-keys' }, kbd('B'), ' before  ', kbd('A'), ' after  ', kbd('C'), ' side by side  ', kbd('J'), ' ', kbd('K'), ' next / previous change  ', kbd('R'), ' reviewed  ', kbd('Esc'), ' close'));
  }

  function firstSentence(t) {
    const m = /^(.+?[.!?])(\s|$)/.exec(str(t).replace(/\s+/g, ' ').trim());
    const out = m ? m[1] : str(t).trim();
    return out.length > 140 ? out.slice(0, 137) + '…' : out;
  }

  function renderStage() {
    const d = cur();
    const { lay, routes } = ensureLayout(d);
    ui.stage.textContent = '';
    if (d.description) ui.stage.append(h('p', { class: 'vqa-desc', text: d.description }));
    const panes = h('div', { class: 'vqa-panes' + (state.view === 'compare' ? ' is-compare' : '') });
    const list = state.view === 'compare' ? [['before', 'before'], ['after', 'after-clean']] : [[state.view, state.view]];
    for (const [which, mode] of list) panes.append(paneEl(d, lay, routes, which, mode));
    ui.stage.append(panes);
    ui.panes = [...panes.children];
    if (ui.panes.length === 2) {
      const [a, b] = ui.panes.map((p) => p.querySelector('.vqa-scroll'));
      let lock = false;
      const sync = (from, to) => from.addEventListener('scroll', () => {
        if (lock) return;
        lock = true;
        to.scrollLeft = from.scrollLeft;
        to.scrollTop = from.scrollTop;
        requestAnimationFrame(() => { lock = false; });
      });
      sync(a, b);
      sync(b, a);
    }
    rescale();
    applySelection();
  }

  function paneEl(d, lay, routes, which, mode) {
    const pr = report.pr;
    const isBefore = which === 'before';
    const ref = isBefore ? pr.baseRef : pr.headRef;
    const sha = isBefore ? pr.base : report.generated.worktree ? 'working tree' : pr.head;
    const removedCount = d.nodes.filter((n) => n.status === 'removed').length;
    const head = h('div', { class: 'vqa-pane-head' },
      h('span', { class: 'vqa-dot ' + (isBefore ? 'is-before' : 'is-after') }),
      h('span', { text: isBefore ? 'Before' : 'After' }),
      ref ? h('code', { text: str(ref) }) : null,
      sha ? h('span', { class: 'vqa-sha', text: shortSha(sha) }) : null,
      mode === 'after' && removedCount ? h('span', { class: 'vqa-pane-note', text: '· removed parts are shown faded' }) : null,
      mode === 'before' && state.view === 'before' && d.nodes.some((n) => n.status === 'added') ? h('span', { class: 'vqa-pane-note', text: '· empty spots are filled by new parts in After' }) : null);
    const canvas = buildCanvas(d, lay, routes, mode, which + '-' + d.id.replace(/[^\w-]/g, '_'));
    const scroll = h('div', { class: 'vqa-scroll' }, h('div', { class: 'vqa-sizer' }, canvas));
    return h('section', { class: 'vqa-pane', 'aria-label': `${isBefore ? 'Before' : 'After'}: ${d.title}` }, head, scroll);
  }

  let lastScale = 1;
  function rescale() {
    if (!ui.panes || !ui.panes.length) return;
    const { lay } = ensureLayout(cur());
    for (const p of ui.panes) {
      const scroll = p.querySelector('.vqa-scroll');
      const sizer = p.querySelector('.vqa-sizer');
      const cv = p.querySelector('.vqa-canvas');
      const fit = Math.max(0.3, Math.min(1, (scroll.clientWidth - 2) / lay.width));
      const sc = state.zoom === 'fit' ? fit : state.zoom;
      cv.style.transform = `scale(${sc})`;
      sizer.style.width = Math.ceil(lay.width * sc) + 'px';
      sizer.style.height = Math.ceil(lay.height * sc) + 'px';
      lastScale = sc;
    }
    ui.zoomVal.textContent = (state.zoom === 'fit' ? 'Fit · ' : '') + Math.round(lastScale * 100) + '%';
  }

  function setZoom(z) {
    state.zoom = z;
    rescale();
  }

  function zoomBy(dir) {
    const nowZ = state.zoom === 'fit' ? lastScale : state.zoom;
    let i = ZOOMS.findIndex((z) => z > nowZ + 0.001);
    if (i < 0) i = ZOOMS.length;
    const next = dir > 0 ? ZOOMS[Math.min(ZOOMS.length - 1, i)] : ZOOMS[Math.max(0, ZOOMS.findIndex((z) => z >= nowZ - 0.001) - 1)];
    setZoom(next || nowZ);
  }

  function setView(v) {
    if (!VIEWS.includes(v) || v === state.view) return;
    state.view = v;
    const it = state.selected && cur().items.get(state.selected);
    if (it && it.status === 'added' && v === 'before') state.selected = null;
    renderSeg();
    renderStage();
    renderDrawer();
    updateHash();
  }

  function setDiagram(id) {
    if (id === state.diagram) return;
    state.diagram = id;
    state.selected = null;
    renderTabs();
    renderLedger();
    renderStage();
    renderDrawer();
    updateHash();
  }

  function toggleTheme() {
    state.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme();
    save();
  }

  function applyTheme() {
    let t = state.theme;
    if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
  }

  // ---------------------------------------------------------------- selection + drawer

  function select(id, opts = {}) {
    let d = cur();
    let switched = false;
    if (id && !d.items.has(id)) {
      const other = report.diagrams.find((x) => x.items.has(id));
      if (!other) id = null;
      else {
        state.diagram = other.id;
        renderTabs();
        renderLedger();
        d = other;
        switched = true;
      }
    }
    const it = id ? d.items.get(id) : null;
    const wasOpen = !!state.selected;
    state.selected = id || null;
    let rerender = switched || !ui.panes || ui.panes.length === 0 || !ui.stage.contains(ui.panes[0]);
    if (it && it.status === 'added' && state.view === 'before') { state.view = 'after'; rerender = true; }
    if (it && it.status === 'removed' && state.view === 'after' && !isVisibleIn(d, it, 'after')) { state.view = 'compare'; rerender = true; }
    if (rerender) { renderSeg(); renderStage(); } else applySelection();
    for (const b of ui.ledger.querySelectorAll('.vqa-li')) b.classList.toggle('is-selected', b.dataset.id === state.selected);
    renderDrawer();
    updateHash();
    if (it && opts.scroll) scrollToItem(it.id);
    if (it && !wasOpen) {
      const close = ui.drawer.querySelector('.vqa-close');
      if (close && opts.focus !== false) close.focus({ preventScroll: true });
    }
  }

  function isVisibleIn(d, it, mode) {
    const pane = (ui.panes || []).find((p) => p.querySelector(`.vqa-canvas[data-mode="${mode}"]`));
    return !!(pane && pane.querySelector(`[data-id="${CSS.escape(it.id)}"]`));
  }

  function applySelection() {
    const d = cur();
    const id = state.selected;
    const related = new Set();
    const it = id ? d.items.get(id) : null;
    if (it && it.kind === 'node') {
      for (const e of d.edges) if (e.from === id || e.to === id) { related.add(e.id); related.add(e.from); related.add(e.to); }
      if (it.attach) related.add(str(it.attach));
    }
    if (it && it.kind === 'edge') { related.add(it.from); related.add(it.to); }
    for (const p of ui.panes || []) {
      const cv = p.querySelector('.vqa-canvas');
      cv.classList.toggle('has-sel', !!it);
      for (const el of cv.querySelectorAll('[data-id]')) {
        el.classList.toggle('is-selected', el.dataset.id === id);
        el.classList.toggle('is-related', related.has(el.dataset.id));
      }
    }
    const open = !!it;
    if (document.body.classList.contains('vqa-drawer-open') !== open) {
      document.body.classList.toggle('vqa-drawer-open', open);
      rescale();
    }
  }

  function scrollToItem(id) {
    for (const p of ui.panes || []) {
      const el = p.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (el) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        return;
      }
    }
  }

  function dsec(title, ...content) {
    return h('section', { class: 'vqa-dsec' }, h('h3', { text: title }), content);
  }

  function renderDrawer() {
    const dr = ui.drawer;
    dr.textContent = '';
    const d = cur();
    const it = state.selected ? d.items.get(state.selected) : null;
    dr.classList.toggle('is-open', !!it);
    dr.setAttribute('aria-hidden', it ? 'false' : 'true');
    if (!it) return;
    const det = it.detail || {};
    const key = d.id + ':' + it.id;
    const sec = it.kind === 'node' ? d.sections.find((x) => x.id === it.section) : d.sections.find((x) => x.id === d.items.get(it.from).section);
    const where = [d.title, sec && sec.title ? sec.title : null, it.kind === 'edge' ? 'connection' : null].filter(Boolean).join(' · ');

    dr.append(h('div', { class: 'vqa-drawer-head' },
      h('div', { class: 'vqa-drawer-top' },
        h('span', { class: 'vqa-chip st-' + it.status, text: BADGE[it.status] || 'Unchanged' }),
        h('span', { class: 'vqa-drawer-where', text: where }),
        h('button', { class: 'vqa-btn vqa-close', type: 'button', 'aria-label': 'Close details', title: 'Close (Esc)', onclick: () => select(null), text: '✕' })),
      h('h2', { class: 'vqa-drawer-title', text: itemTitle(d, it) }),
      det.headline ? h('p', { class: 'vqa-drawer-headline', text: str(det.headline) }) : null));

    const body = h('div', { class: 'vqa-drawer-body' });
    if (det.summary) body.append(dsec(it.status === 'unchanged' ? 'What it does' : 'What changed', rich(det.summary)));
    else if (impliedNote(d, it)) body.append(dsec('What changed', rich(impliedNote(d, it))));
    if (it.kind === 'node' && it.shape === 'note' && !det.summary) {
      const t = textOf(it, it.status === 'removed' ? 'before' : 'after');
      const said = [t.sub, ...t.bullets.map((b) => '• ' + b)].filter(Boolean);
      if (said.length) body.append(dsec('What it says', said.map((line) => h('p', { text: line }))));
    }

    const tb = textOf(it, 'before');
    const ta = textOf(it, 'after');
    const beforeText = str(det.before) || (it.before ? [tb.title !== ta.title ? tb.title : '', it.kind === 'edge' ? tb.label : tb.sub].filter(Boolean).join(': ') : '');
    const afterText = str(det.after) || (it.before ? [tb.title !== ta.title ? ta.title : '', it.kind === 'edge' ? ta.label : ta.sub].filter(Boolean).join(': ') : '');
    if (it.status === 'changed' && (beforeText || afterText)) {
      body.append(dsec('Before → after', h('div', { class: 'vqa-ba' },
        h('div', null, h('span', { class: 'lbl', text: 'Before' }), rich(beforeText || 'Not described', 'div')),
        h('div', { class: 'is-after' }, h('span', { class: 'lbl', text: 'After' }), rich(afterText || 'Not described', 'div')))));
    } else if (it.status === 'added' && det.after) {
      body.append(dsec('What it does now', rich(det.after)));
    } else if (it.status === 'removed' && det.before) {
      body.append(dsec('What it used to do', rich(det.before)));
    }

    if (det.uncertain) body.append(dsec('Not clear from the code', h('div', { class: 'vqa-callout' }, rich(det.uncertain, 'div'))));

    const risk = ['low', 'medium', 'high'].includes(det.risk) ? det.risk : '';
    if (risk || det.riskNote) {
      body.append(dsec('Risk', h('div', { class: 'vqa-risk' },
        risk ? h('span', { class: 'vqa-chip risk-' + risk, text: risk }) : null,
        det.riskNote ? h('div', null, rich(det.riskNote)) : null)));
    }

    const qa = normQa(det.qa);
    if (qa.length) {
      const ul = h('ul', { class: 'vqa-qa' });
      qa.forEach((q, i) => {
        const ck = key + ':' + i;
        const box = h('input', { type: 'checkbox' });
        box.checked = !!state.checks[ck];
        const label = h('label', { class: box.checked ? 'is-done' : null }, box, h('span', null, rich(q.check, 'span'), q.expect ? h('small', { text: 'Expect: ' + q.expect }) : null, q.why ? h('small', { text: q.why }) : null));
        box.addEventListener('change', () => {
          if (box.checked) state.checks[ck] = true; else delete state.checks[ck];
          label.classList.toggle('is-done', box.checked);
          save();
        });
        ul.append(h('li', null, label));
      });
      body.append(dsec(`Test this (${qa.length})`, ul));
    }

    const conns = h('ul', { class: 'vqa-conns' });
    const connBtn = (target, dir, label, status, onClick) => h('li', null, h('button', { class: 'vqa-conn', type: 'button', onclick: onClick },
      status !== 'unchanged' ? h('span', { class: 'vqa-sym st-' + status, text: SYM[status] }) : null,
      h('span', { class: 'dir', text: dir }),
      h('span', { text: target }),
      label ? h('span', { class: 'lbl', text: label }) : null));
    if (it.kind === 'node') {
      for (const e of d.edges) {
        if (e.from !== it.id && e.to !== it.id) continue;
        const out = e.from === it.id;
        const other = d.items.get(out ? e.to : e.from);
        const t = textOf(e, e.status === 'removed' ? 'before' : 'after');
        conns.append(connBtn(other.title, e.both ? '↔' : out ? '→' : '←', t.label.replace(/\n/g, ' '), e.status, () => select(e.id, { scroll: true })));
      }
    } else {
      const a = d.items.get(it.from);
      const b = d.items.get(it.to);
      conns.append(connBtn(a.title, 'from', '', a.status, () => select(a.id, { scroll: true })));
      conns.append(connBtn(b.title, 'to', '', b.status, () => select(b.id, { scroll: true })));
    }
    if (conns.childNodes.length) body.append(dsec('Connections', conns));

    const refs = Array.isArray(det.code) ? det.code.filter((r) => r && r.path) : [];
    if (refs.length) body.append(dsec(`Code (${refs.length} ${refs.length === 1 ? 'place' : 'places'})`, refs.map(fileBlock)));
    if (!body.childNodes.length) body.append(dsec('Details', h('p', { text: 'No details were written for this part.' })));
    dr.append(body);

    const changes = changeList(d);
    const reviewed = state.reviewed.has(key);
    dr.append(h('div', { class: 'vqa-drawer-foot' },
      h('button', { class: 'vqa-btn', type: 'button', disabled: !changes.length || null, onclick: () => stepChange(-1), text: '← Previous' }),
      it.status !== 'unchanged'
        ? h('button', { class: 'vqa-btn vqa-primary' + (reviewed ? ' is-on' : ''), type: 'button', 'aria-pressed': String(reviewed), onclick: () => toggleReviewed(), text: reviewed ? '✓ Reviewed' : 'Mark reviewed' })
        : h('span'),
      h('button', { class: 'vqa-btn', type: 'button', disabled: !changes.length || null, onclick: () => stepChange(1), text: 'Next →' })));
  }

  function fileBlock(ref) {
    const pr = report.pr;
    const f = report.files[str(ref.file) || str(ref.path)];
    const base = ref.side === 'base';
    const sha = base ? pr.base : pr.head;
    const range = parseRange(ref.lines);
    let link = null;
    const repo = safeUrl(pr.repoUrl);
    const published = !report.generated.links || report.generated.links[base ? 'base' : 'head'] !== false;
    if (repo && published && sha && /^[0-9a-f]{7,40}$/i.test(str(sha)) && !(report.generated.worktree && !base)) {
      const p = str(ref.path).split('/').map(encodeURIComponent).join('/');
      link = `${repo.replace(/\/+$/, '')}/blob/${sha}/${p}${range ? `#L${range[0]}${range[1] !== range[0] ? '-L' + range[1] : ''}` : ''}`;
    }
    const box = h('div', { class: 'vqa-file' },
      h('div', { class: 'vqa-file-head' },
        h('span', { class: 'vqa-file-path', text: str(ref.path) }),
        f && (f.additions || f.deletions) ? h('span', { class: 'vqa-file-stat' }, h('span', { class: 'vqa-plus', text: '+' + (f.additions || 0) }), ' ', h('span', { class: 'vqa-minus', text: '−' + (f.deletions || 0) })) : null,
        link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: 'Open ↗' }) : null));
    const bits = [str(ref.symbol), range ? `${base ? 'before · ' : ''}lines ${range[0]}${range[1] !== range[0] ? '–' + range[1] : ''}` : '', str(ref.note)].filter(Boolean);
    if (bits.length) box.append(h('div', { class: 'vqa-file-meta', text: bits.join(' · ') }));
    const hunks = (Array.isArray(ref.hunks) ? ref.hunks : []).map((i) => f && f.hunks && f.hunks[i]).filter(Boolean);
    if (hunks.length) box.append(diffTable(hunks, range, base));
    else box.append(h('div', { class: 'vqa-file-empty', text: f && f.hunks && f.hunks.length ? 'No changed lines in this range.' : 'Not changed in this PR. Linked for context.' }));
    return box;
  }

  // `range` marks the lines this part points at (head-side numbers, or base-side when `base`).
  function diffTable(hunks, range, base) {
    const LIMIT = 160;
    const rows = [];
    for (const hk of hunks) {
      const head = `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@${hk.header ? ' ' + hk.header : ''}`;
      rows.push(h('tr', { class: 'h' }, h('td', { colspan: '3', text: head })));
      for (const ln of hk.lines || []) {
        const [t, o, n, text] = ln;
        const at = base ? o : n;
        const focus = range && at != null && at >= range[0] && at <= range[1];
        rows.push(h('tr', { class: (t === '+' ? 'a' : t === '-' ? 'd' : 'x') + (focus ? ' f' : '') },
          h('td', { class: 'n', text: o == null ? '' : o }),
          h('td', { class: 'n', text: n == null ? '' : n }),
          h('td', { class: 'c', text: (t === '+' ? '+ ' : t === '-' ? '− ' : '  ') + str(text) })));
      }
      if (hk.truncated) rows.push(h('tr', { class: 'h' }, h('td', { colspan: '3', text: `… ${hk.truncated} more lines not included in this report` })));
    }
    const tbody = h('tbody', null, rows.slice(0, LIMIT));
    const wrap = h('div', { class: 'vqa-diff-wrap' }, h('table', { class: 'vqa-diff' }, tbody));
    if (rows.length > LIMIT) {
      const more = h('button', { class: 'vqa-btn vqa-more', type: 'button', text: `Show ${rows.length - LIMIT} more lines` });
      more.addEventListener('click', () => { tbody.append(...rows.slice(LIMIT)); more.remove(); });
      wrap.append(more);
    }
    return wrap;
  }

  function stepChange(dir) {
    const d = cur();
    const changes = changeList(d);
    if (!changes.length) return;
    const i = changes.findIndex((c) => c.id === state.selected);
    const next = i < 0 ? (dir > 0 ? 0 : changes.length - 1) : (i + dir + changes.length) % changes.length;
    select(changes[next].id, { scroll: true, focus: false });
  }

  function toggleReviewed() {
    const d = cur();
    const it = state.selected && d.items.get(state.selected);
    if (!it || it.status === 'unchanged') return;
    const key = d.id + ':' + it.id;
    if (state.reviewed.has(key)) state.reviewed.delete(key); else state.reviewed.add(key);
    save();
    renderLedger();
    renderDrawer();
  }

  function checklistMarkdown() {
    const pr = report.pr;
    const out = [`## Visual QA${pr.number != null && pr.number !== '' ? ` · PR #${pr.number}` : ''}: ${report.title}`, ''];
    for (const d of report.diagrams) {
      const changes = changeList(d);
      if (!changes.length) continue;
      if (report.diagrams.length > 1) out.push(`### ${d.title}`, '');
      for (const c of changes) {
        const reviewed = state.reviewed.has(d.id + ':' + c.id);
        const head = str(c.detail.headline) || impliedNote(d, c);
        out.push(`- [${reviewed ? 'x' : ' '}] **${WORD[c.status]}: ${itemTitle(d, c)}**${head ? '. ' + head : ''}`);
        normQa(c.detail.qa).forEach((q, i) => {
          const done = state.checks[`${d.id}:${c.id}:${i}`];
          out.push(`  - [${done ? 'x' : ' '}] ${q.check}${q.expect ? ' → ' + q.expect : ''}`);
        });
      }
      out.push('');
    }
    const un = (report.coverage && report.coverage.unexplained) || [];
    if (un.length) out.push(`**Changed but not explained:** ${un.map((f) => '`' + f.path + '`').join(', ')}`);
    const part = (report.coverage && report.coverage.partial) || [];
    if (part.length) out.push(`**Explained only in part:** ${part.map((f) => '`' + f.path + '` (' + missingText(f) + ')').join(', ')}`);
    return out.join('\n').trim() + '\n';
  }

  function copyChecklist() {
    const text = checklistMarkdown();
    const done = () => toast('QA checklist copied as Markdown');
    const fallback = () => {
      const ta = h('textarea', { style: { position: 'fixed', left: '-9999px' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (_) { toast('Copy failed'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  let toastTimer = null;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('is-on'), 1800);
  }

  function updateHash() {
    if (SHOT || CHECK) return;
    const p = new URLSearchParams();
    if (report.diagrams.length > 1) p.set('diagram', state.diagram);
    if (state.view !== 'after') p.set('view', state.view);
    if (state.selected) p.set('item', state.selected);
    const next = p.toString();
    try { history.replaceState(null, '', next ? '#' + next : location.pathname + location.search); } catch (_) { /* file:// quirks */ }
  }

  function onKey(ev) {
    const t = ev.target;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) return;
    const k = ev.key;
    if (k === 'Escape') { if (state.selected) select(null); else return; }
    else if (k === 'a' || k === 'A') setView('after');
    else if (k === 'b' || k === 'B') setView('before');
    else if (k === 'c' || k === 'C') setView('compare');
    else if (k === 'j' || k === 'J' || k === 'n') stepChange(1);
    else if (k === 'k' || k === 'K' || k === 'p') stepChange(-1);
    else if (k === 'r' || k === 'R') toggleReviewed();
    else if (k === '+' || k === '=') zoomBy(1);
    else if (k === '-' || k === '_') zoomBy(-1);
    else if (k === '0') setZoom('fit');
    else return;
    ev.preventDefault();
  }

  // ---------------------------------------------------------------- checks (used by render.mjs --check)

  function checkReport() {
    const out = { ok: true, diagrams: [] };
    for (const d of report.diagrams) {
      const { lay, routes } = ensureLayout(d);
      const res = {
        id: d.id, width: lay.width, height: lay.height, crossings: [], overlaps: [], labels: [], sharedLines: [], unrouted: [],
        empty: { before: emptySections(d, 'before'), after: emptySections(d, 'after-clean') },
      };
      const nodeRects = d.nodes.map((n) => ({ id: n.id, status: n.status, ...lay.rects.get(n.id) }));
      const rects = nodeRects.concat(lay.keepOut.map((k) => ({ ...k, id: k.label, status: 'keep-out' })));
      for (let i = 0; i < nodeRects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const pair = [a.status, b.status].sort().join();
          if (pair === 'added,removed') continue;
          if (boxesOverlap(a, b, -1)) res.overlaps.push([a.id, b.id]);
        }
      }
      const segs = [];
      for (const e of d.edges) {
        const r = routes.get(e.id);
        if (!r) { res.unrouted.push(e.id); continue; }
        const n = r.pts.length - 1;
        for (let i = 0; i < n; i++) {
          const p = r.pts[i];
          const q = r.pts[i + 1];
          for (const o of rects) {
            if ((i === 0 && o.id === e.from) || (i === n - 1 && o.id === e.to)) continue;
            const own = o.id === e.from || o.id === e.to;
            if (segHits(p, q, o, own ? 0 : 2) && !res.crossings.some((c) => c.edge === e.id && c.node === o.id)) res.crossings.push({ edge: e.id, node: o.id, area: o.status === 'keep-out' });
          }
          for (const sg of segs) {
            if (sg.edge !== e.id && overlapLen(p, q, sg) > 6 && !res.sharedLines.some((c) => c.join() === [sg.edge, e.id].join())) res.sharedLines.push([sg.edge, e.id]);
          }
          segs.push({ edge: e.id, a: p, b: q });
        }
        for (const lab of Object.values(r.labels)) {
          const box = lab.box;
          const hit = rects.find((o) => boxesOverlap(box, o, 0));
          if (hit && !res.labels.some((x) => x.edge === e.id)) res.labels.push({ edge: e.id, node: hit.id, area: hit.status === 'keep-out' });
        }
      }
      if (res.crossings.length || res.overlaps.length || res.labels.length || res.unrouted.length) out.ok = false;
      out.diagrams.push(res);
    }
    return out;
  }

  function writeReport(obj) {
    let el = document.getElementById('vqa-report');
    if (!el) {
      el = document.createElement('script');
      el.type = 'application/json';
      el.id = 'vqa-report';
      document.body.append(el);
    }
    el.textContent = JSON.stringify(obj).replace(/</g, '\\u003c');
  }

  // ---------------------------------------------------------------- boot

  function renderShot() {
    document.body.classList.add('vqa-shot');
    const d = report.diagrams.find((x) => x.id === params.get('diagram')) || report.diagrams[0];
    const { lay, routes } = ensureLayout(d);
    const mode = params.get('view') === 'before' ? 'before' : 'after';
    root.textContent = '';
    root.append(buildCanvas(d, lay, routes, mode, 'shot'));
  }

  function boot() {
    report = normalize(JSON.parse(document.getElementById('vqa-data').textContent));
    store = makeStore('vqa:' + [report.pr.repoUrl, report.pr.number, report.pr.head].map(str).join('|'));
    const saved = store.get();
    const first = report.diagrams.find((d) => d.id === params.get('diagram')) || report.diagrams[0];
    state = {
      diagram: first.id,
      view: VIEWS.includes(params.get('view')) ? params.get('view') : 'after',
      selected: null,
      zoom: 'fit',
      theme: params.get('theme') || saved.theme || report.theme || 'dark',
      reviewed: new Set(Array.isArray(saved.reviewed) ? saved.reviewed : []),
      checks: saved.checks && typeof saved.checks === 'object' ? saved.checks : {},
    };
    applyTheme();
    if (SHOT) {
      renderShot();
    } else {
      buildShell();
      renderAll();
      const want = params.get('item');
      if (want) select(want, { scroll: true, focus: false });
      document.addEventListener('keydown', onKey);
      let t = null;
      window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(rescale, 60); });
    }
    if (CHECK) writeReport(checkReport());
    document.documentElement.dataset.vqaReady = '1';
  }

  function fail(err) {
    const msg = err && err.stack ? err.stack : String(err);
    root.textContent = '';
    root.append(h('pre', { class: 'vqa-error', text: 'visual-qa could not draw this report.\n\n' + msg }));
    if (CHECK) writeReport({ ok: false, error: String(err && err.message ? err.message : err) });
    document.documentElement.dataset.vqaReady = 'error';
  }

  const fontsReady = document.fonts && document.fonts.ready
    ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))])
    : Promise.resolve();
  fontsReady.then(() => {
    try { boot(); } catch (err) { fail(err); }
  });
})();
