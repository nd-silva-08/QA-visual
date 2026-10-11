# Analysis playbook

How to get from a diff to an honest before/after model. The diagram is only as good as this step.

## 1. Read the change map

Run `collect.mjs` and read its digest. For each changed file it shows the status (A/M/D/R), +/−, the exact changed lines (`lines 3, 8` are after-side; `removed before-lines 7` are before-side), and the function each change sits in (after `⟶`). `.visual-qa/context.json` has the same data per file.

Sort the files into:

| Kind | Examples | Usually |
|---|---|---|
| Behaviour | conditions, steps, ordering, error handling, retries, permissions | Nodes and edges in a **logic flow** |
| Structure | new or removed modules, services, endpoints, tables, queues, external APIs, jobs | Nodes and edges in an **architecture** view |
| Interface | UI copy and states, API request/response shape, events | A changed node (the screen or endpoint) |
| Data | migrations, schema, seeds | A changed store node, plus QA on old rows |
| Config / infra | env vars, flags, CI, Docker, IaC | A node if it changes behaviour, otherwise `unmapped` |
| Tests, docs, lockfiles, generated, formatting-only | | `unmapped` with a reason. Tests still tell you what the author meant, so read them for QA ideas. |

## 2. Decide what to draw

- **Logic flow** when behaviour changed. Nodes are steps a tester could observe; diamonds are checks the code makes; labels on outgoing edges name the branches (`Yes` / `No`, `valid` / `expired`).
- **Architecture** when structure changed. Nodes are components; edges are calls or data flow; dashed edges are lookups, async messages, or waits.
- **Both, as two diagrams**, for big PRs: an architecture overview plus a flow for the riskiest path. At most three diagrams.
- **A behaviour-preserving refactor:** an architecture view showing where responsibilities moved. Say "no behaviour change intended" in the summary and make the QA checks regression checks.
- **Tiny or mechanical changes** (a version bump, a rename): a small diagram, or tell the user a diagram wouldn't help and summarise in text instead.

Anchor the change with one hop of unchanged context on each side (what calls it, what it calls), so a reviewer recognises where they are. Don't diagram the whole app.

## 3. Build BEFORE from `base` only

- Read files at the base commit: `git show <base>:<path>`. Grep at that revision with `git grep <pattern> <base> -- <path>`.
- Start at the entry points the diff touches: route, handler, job, UI event, CLI command, message consumer. Follow calls one hop up and one hop down.
- Note the steps, decisions, components, and calls *as they were*. Don't let after-knowledge leak in.

## 4. Build AFTER from `head` only

- `git show <head>:<path>`, or the working tree for `--worktree`.
- Same walk, same level of detail, so the two models line up.

## 5. Diff the two models

- The same concept keeps the same id. If it was renamed or behaves differently, it is `changed`; put the old text in `before`.
- Present only after: `added`. Present only before: `removed`.
- An edge that now connects different nodes: the old edge is `removed` and the new one `added` (different ids).
- A responsibility that moved between components: the node it left is `changed` (or `removed`), the node it moved to is `changed` (or `added`), and the edges show the new path.
- Every node keeps one grid position for both views. New nodes take empty cells; removed nodes stay where they were.

## 6. Map every hunk

- For each changed file and hunk, find the node or edge it implements, and add a code ref with `lines` set to the changed after-side lines the digest lists. For deleted code use `"side": "base"` with the removed before-side lines.
- One hunk can back several parts; one part can cite several files.
- Files that truly don't belong go in `unmapped` with an honest reason.
- The renderer warns about changed files nobody explains, and about ranges that touch no change. Fix both.

## 7. Write the details

- `headline`: one sentence on what is different. Bad: "Updated decide.ts". Good: "Refunds under $50 skip finance review."
- `summary`: 1–3 sentences on what it does now and why that matters, in words a tester or PM uses.
- `before` / `after`: observable behaviour, not code.
- `qa`: concrete checks, phrased "Do X" with `expect`. Cover:
  - both sides of every new or changed decision, and the exact boundary (`$50.00` when the rule says "under $50");
  - a dependency failing, slow, or returning junk (timeouts, empty responses);
  - roles and permissions;
  - old data: rows created before a migration, sessions or caches from before the deploy;
  - removed behaviour that must no longer happen (no Slack ping, no 2 a.m. email);
  - retries, double submits, and concurrency where the code has them;
  - UI states: empty, loading, error, long text.
- `risk`:
  - **high**: money, auth, permissions, data loss, irreversible migrations, security, concurrency;
  - **medium**: a new external dependency, a schema change, behaviour change for many users;
  - **low**: copy, styling, an internal refactor that's well tested.
- `uncertain`: anything you couldn't confirm, such as a value read from config you can't see or a behaviour that depends on another service.

## 8. Be honest about scope

- Huge PRs (60+ files): diagram the main path, and put clearly unrelated changes in `unmapped` with a reason like "outside the main change; review in the diff". Say so in the summary.
- If the diff can't be read (binary files, missing history), say what you couldn't see.
- CI runs are non-interactive: make reasonable choices, note assumptions in `uncertain` or the summary, and never stop to ask.
