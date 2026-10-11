# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Layout of the repository

```
.claude-plugin/          plugin.json and marketplace.json (Claude Code)
skills/visual-qa/
  SKILL.md               what the agent follows
  references/            spec format, analysis playbook, layout guide
  scripts/collect.mjs    change map from git (read-only)
  scripts/render.mjs     spec → single-file HTML report
  scripts/lib/           diff parsing, git, validation, Chrome helpers
  assets/                viewer (template.html, viewer.css, viewer.js) and example specs
templates/visual-qa.yml  GitHub Actions workflow for other repositories
examples/refunds/        rendered demo report and PR summary
test/                    node:test suites
```

Everything the skill needs lives under `skills/visual-qa/`, because `npx skills add` installs only that folder.

## Ground rules

- **No dependencies.** The scripts use Node's standard library; the viewer is plain browser JavaScript.
- **Read-only.** Nothing may change the user's working tree, index, or branches. `collect.mjs` may fetch a PR head into `refs/visual-qa/`, and that's all.
- **Untrusted text stays text.** Spec content comes from code and PR text. The viewer builds DOM with `textContent` only, and embedded JSON goes through `scriptSafeJson`.
- **Keep the demo green.** After changing the viewer, run `npm run demo` and look at the result (or `--screenshot` it). `--check` should report `layout check: ok`.

## Tests

```bash
npm test
```

The viewer test runs only when Chrome or Chromium is found; set `VISUAL_QA_CHROME` to point at one.

## Changing the spec format

Update `scripts/lib/spec.mjs` (validation), `assets/viewer.js` (rendering), `references/spec-format.md` (docs), and add a test. Keep old specs working: `version` is still `1`.
