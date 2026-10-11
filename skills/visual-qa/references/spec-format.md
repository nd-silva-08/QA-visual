# Spec format (version 1)

A spec is one JSON file. The renderer validates it, fills in the real diff hunks from git, and embeds it in the HTML report. A complete two-diagram example lives in [`../assets/example-spec.json`](../assets/example-spec.json); a blank starting point in [`../assets/spec-template.json`](../assets/spec-template.json).

```jsonc
{
  "version": 1,
  "title": "Auto-approve small, low-risk refunds",
  "summary": "Two to four plain sentences: what changes for users or the system.",
  "risk": "medium",
  "riskNote": "Why that risk level.",
  "pr": { /* paste the "Spec pr block" that collect.mjs prints */ },
  "diagrams": [ { "id": "flow", "title": "Refund flow", "sections": [], "nodes": [], "edges": [] } ],
  "unmapped": [ { "path": "package-lock.json", "reason": "Dependency lockfile" } ]
}
```

A single diagram can skip the `diagrams` array: put `sections`, `nodes`, `edges`, `notes`, `legend`, and `layout` at the top level.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | Spec version. |
| `title` | string | Report title, usually the PR title. |
| `summary` | string | 2–4 plain sentences on what the PR changes. A blank line starts a new paragraph; `` `backticks` `` mark code. |
| `risk` | `low` \| `medium` \| `high` | Overall risk of merging. |
| `riskNote` | string | Why. |
| `theme` | `dark` \| `light` \| `auto` | Starting theme (default `dark`); viewers can switch. |
| `pr` | object | See below. |
| `diagrams` | array | 1–3 diagrams, shown as tabs. |
| `unmapped` | array of `{ path, lines?, side?, reason }` | Changes deliberately left out of every diagram. Without `lines`, a whole file: `path` can be exact, a directory ending in `/`, or a glob (`*`, `**`, `?`). With `lines` (`"40"` or `"40-88"`, after-side numbers, or before-side with `"side": "base"`), only the changes in those lines of one file, such as a formatting fix next to the real change. Every other change must be referenced from some `detail.code`. |

### `pr`

| Field | Meaning |
|---|---|
| `number`, `title`, `url`, `author` | Shown in the header. `url` must be http(s). |
| `baseRef`, `headRef` | Branch names for labels. |
| `base` | The **before** commit, normally the merge-base SHA from `collect.mjs`. A branch name also works; the renderer always compares from the merge-base, as GitHub does. |
| `head` | The **after** commit SHA, or `"WORKTREE"` to include uncommitted changes. |
| `repoUrl` | `https://github.com/owner/repo`, used for "Open ↗" links. Filled from `origin` if omitted. |
| `stats` | `{ files, additions, deletions }`. Only needed for demos rendered with `--no-git`. |

Without `pr.base` / `pr.head` (or with `--no-git`), code only shows for refs that carry an inline `patch`.

## Diagram

| Field | Meaning |
|---|---|
| `id` | Required when there are several diagrams. Letters, digits, `_ . : -`. |
| `title` | Tab label. |
| `description` | One sentence shown above the diagram. |
| `sections` | Horizontal bands, top to bottom, each with a numbered title (like "1 Asking for a refund"). Optional. |
| `nodes` | Boxes, decisions, and notes. |
| `edges` | Arrows between nodes. |
| `notes` | Same as nodes with `"shape": "note"`; a convenience. |
| `legend` | Extra legend entries `{ "swatch": "box" \| "diamond" \| "dashed" \| "solid", "status"?, "label" }`, or `false` to hide the legend. The status colours, diamond, and dashed line are added automatically when used. |
| `layout` | Optional overrides: `colWidth` (248), `gapX` (72), `rowGap` (64), `padX` (40), `padY` (36), `sectionHeader` (64), `sectionGap` (44), `minNodeHeight` (88). |

### Section

`{ "id": "decide", "title": "Deciding", "subtitle": "for every new request" }`. `number` is filled in automatically (1, 2, 3…) when there are several titled sections; set it to override.

## Node

| Field | Meaning |
|---|---|
| `id` | Stable identity, the same in before and after. Unique within the diagram (nodes and edges share one namespace). |
| `title` | Short name, in plain words ("Risk check", not `getRiskScore`). |
| `sub` | One line on what it does. |
| `tech` | Optional technical tag in mono: `POST /refunds`, `refunds table`, `Stripe`. |
| `shape` | `box` (default), `decision` (diamond: a check or branch), or `note` (free text with optional `bullets`). |
| `status` | `unchanged` (default), `added`, `changed`, or `removed`. |
| `before` | For `changed` nodes: the fields that differed before the PR, e.g. `{ "sub": "Every refund waits here" }`. The Before view shows them. Only the fields you list change: any you leave out, `tech` and `title` included, show their after text in Before too, so list every field that was different. |
| `section` | Section id (default: the first). |
| `col`, `row` | Grid position. `col` is 0-based and may be fractional (e.g. `2.5`); `row` is a whole number within the section. Columns line up across all sections. Omit both on every node of a section to get an automatic left-to-right layout. |
| `span` | Width in columns (default 1). |
| `dx`, `dy` | Pixel nudges, rarely needed. |
| `valign` | `top` or `center` within its row (boxes and decisions default to centre, notes to top). |
| `bullets` | Notes: a list of short lines. |
| `attach` | Notes: an edge or node id. Draws a dotted leader from the note to it. |
| `detail` | What the drawer shows (see below). Expected on every added, changed, or removed node. |

## Edge

| Field | Meaning |
|---|---|
| `id` | Stable id. Required in practice for changed edges, so links to them don't break. |
| `from`, `to` | Node ids. Direction matters. |
| `label` | Short text on the line (`Yes`, `No`, `saves`). Use `\n` for a second line. |
| `style` | `solid` (default: calls, leads to) or `dashed` (looks up, async, waits on a person). |
| `both` | `true` for arrowheads at both ends. |
| `status` | `unchanged`, `added`, `changed`, `removed`. |
| `before` | For `changed` edges: `{ "label": "next morning", "style": "dashed" }`. |
| `fromSide`, `toSide` | Force a side: `left`, `right`, `top`, `bottom`. Usually unnecessary; use them to fix a tangled route. |
| `detail` | As for nodes. Expected on every added, changed, or removed edge, except one that comes or goes with a new or removed node: the node's details tell that story, and the report says the edge comes (or goes) with it. Write details for such an edge only when it adds something, like a new call to an outside service. |

Status rules the validator enforces:
- An edge touching an `added` node must be `added`; an edge touching a `removed` node must be `removed`.
- An added edge can't touch a removed node, and the other way round.
- An edge that now connects different nodes is a `removed` edge plus an `added` edge, with different ids.

## `detail`

| Field | Meaning |
|---|---|
| `headline` | One sentence, at most about 100 characters: what is different. Shown in the change list and the PR comment. |
| `summary` | 1–3 plain sentences: what it does now and why it matters. |
| `before`, `after` | Observable behaviour before and after, as prose. Changed items show both side by side; added items show `after`; removed items show `before`. |
| `qa` | Checks to run. Each is a string or `{ "check": "Do X", "expect": "Y", "why": "…" }`. They become checkboxes that persist in the reader's browser and are included in "Copy QA checklist". |
| `risk`, `riskNote` | `low` / `medium` / `high` for this part, and why. |
| `uncertain` | Anything you couldn't confirm from the code. Shown as a highlighted callout. |
| `code` | Where in the code this lives. See below. |

### Code refs: `detail.code[]`

```json
{ "path": "src/refunds/decide.ts", "lines": "13-16", "symbol": "decideRefund", "note": "where the rule is applied" }
```

| Field | Meaning |
|---|---|
| `path` | Repo-relative path, as git prints it. For a renamed file, either the old or the new path works. |
| `lines` | `"40"` or `"40-88"`. The drawer shows the diff hunks that change a line in this range and highlights the range. Without `lines` it shows all of the file's hunks (or only those mentioning `symbol`). |
| `side` | `head` (default: after-side line numbers) or `base` (before-side numbers, for code that was deleted). |
| `symbol` | Function or class name, for the reader (and as a hunk filter when `lines` is missing). The renderer checks that it's in the file and, with `lines`, in those lines or on the line that opens the block they sit in (the function's signature). Put descriptions in `note`, not here. |
| `note` | A few words on why this place matters. |
| `patch` | Inline unified-diff text (string or array of lines). **Only** for demos and repos without git; normal runs read hunks from git. |

The renderer adds the `hunks` and the file stats itself. It warns when a range touches no change, runs past the end of the file, or doesn't hold its `symbol`. Inside a new file every line is a change, so pick ranges there from the definitions `collect.mjs` lists.

## What the renderer adds

`files` (the diff hunks for every referenced file), `coverage` (`unmapped`, the changed files nobody explains, and the files explained only in `partial`, with the lines nothing points at), `stats`, and `generated` (with `links`, which says whether the before and after commits are on the remote, so "Open" links to them work). Don't write these yourself.
