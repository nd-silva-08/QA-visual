// Minimal argv parser: --key value, --key=value, -k value, boolean flags, and positionals.
export function parseArgs(argv, { boolean = [], alias = {} } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    let key = null;
    let value;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) value = a.slice(eq + 1);
    } else if (/^-[A-Za-z]$/.test(a)) {
      key = a.slice(1);
    } else {
      out._.push(a);
      continue;
    }
    key = alias[key] || key;
    if (value === undefined) {
      if (boolean.includes(key)) value = true;
      else {
        value = argv[++i];
        if (value === undefined) throw new Error(`--${key} needs a value`);
      }
    }
    out[key] = value;
  }
  return out;
}
