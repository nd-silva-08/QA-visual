# Layout guide

You place nodes on a grid; the viewer measures text, sizes boxes, and routes every arrow with rounded right-angle bends. Good placement is what makes the result read like a hand-drawn diagram.

## The grid

- **Columns** (`col`, 0-based) are shared by all sections, so things line up vertically down the page. A column is 248px wide with a 72px gap, so 5 columns is about 1,600px. Aim for **5 columns or fewer**. `col` may be fractional (`2.5`) to sit between columns.
- **Rows** (`row`, whole numbers) are local to a section. Every node in a row shares one midline, so neighbours in the same row get perfectly straight arrows.
- **Sections** stack top to bottom, each with a numbered title at its top-left.
- Boxes in a row grow to the tallest box in that row. Diamonds are sized for their text. Notes keep their natural height and sit at the top of their row.
- A gap between neighbouring columns widens automatically when a label on a straight arrow between them needs room.

## Reading order

- The main path runs **left to right along row 0** of each section; the next stage continues in the next section.
- A decision (`"shape": "decision"`) sends one outcome **right** and the other **down**, with the outcome nodes right next to it, like this:

```
  [Risk check] ──▶ ◇ Small and low risk? ───── Yes ─────▶ [Approved]
                          │                 ┊
                          No           Counts as low risk when
                          ▼             • under $50
                   [Finance review]     • score below 30
```

- A loop back to an earlier step (a retry, or "try again") runs below or to the left. Set `fromSide` / `toSide` if the automatic choice isn't the one you want.
- Supporting systems (a store, an external API, a person who decides) sit beside the node that uses them, often joined by a `dashed` edge.

## Things that keep diagrams clean

- **Connected nodes share a row or a column** whenever possible; most arrows are then one straight line.
- **Keep column 0 of a titled section free of arrows from above.** The section title sits there and wires never cross it, so route cross-section arrows into nodes further right.
- **At most about three wires per side** of a box. More than that usually means the node does too much: split it.
- **Notes** (`"shape": "note"`) explain a rule. Put them in the empty cell under the edge they explain and set `"attach": "<edge id>"` for a dotted leader.
- **Labels** should be one to three words. Use `\n` to break a longer one.
- **Removed and added parts:** removed nodes keep their spot; they show in Before and appear faded in After. New nodes go in cells that are empty in Before. A new node may take a removed node's exact cell, in which case the faded copy is dropped.
- More than about 14 nodes or 18 arrows is hard to read. Split it into two diagrams, for example an overview plus the detail of the riskiest path.

## Fixing what `--check` reports

| Report | Fix |
|---|---|
| edge runs through node X | Move X or one end of the edge, or set `fromSide` / `toSide`. |
| edge runs through section "…" | The edge has to cross a section title. Move its target out of column 0, or into the same section as its source. |
| label covers node X | Shorten it or split it with `\n`, or give the nodes more room (move one a column further). |
| "A" and "B" overlap on screen | They share a row and their columns collide. Move one, or reduce `span`. |
| edges share a stretch of line (note) | Two wires run on top of each other. Moving a node a row or column usually separates them. |

Always look at the screenshots too. A diagram can pass the checks and still be hard to follow.
