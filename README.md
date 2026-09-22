<p align="center">
  <img src="https://raw.githubusercontent.com/JRJRJPRO/dsh-tree/main/docs/banner.png" alt="dsh-tree — Conversation trees for dsh" width="860">
</p>

<h1 align="center">dsh-tree</h1>

<p align="center">
  Every branch of a conversation, drawn as a tree down the right edge of
  <a href="https://github.com/deepseek-ai">DeepSeek Harness</a>.<br>
  Click a dot to jump to that turn. Click <b>＋</b> to continue from it.
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">中文</a>
</p>

---

## Install

```sh
dsh plugin --profile web add github:JRJRJPRO/dsh-tree
```

Refresh your browser and it's live — no dsh restart, no other plugins needed.

To remove it: `dsh plugin --profile web remove dsh-tree`. It also shows up under
**Installed** in the plugin market, where the toggle turns it on and off in about a second.

## The tree draws itself

<img src="https://raw.githubusercontent.com/JRJRJPRO/dsh-tree/main/docs/rail.png" alt="The conversation tree" width="300" align="right">

Refresh the page and it's already there, next to your chat.

Every dot is one turn. **Click one to jump to it** — the turn you're looking at
is filled in solid as you scroll.

Branches sit side by side, so you can see at a glance where a conversation split
and which path you're on. Named nodes carry their label right on the tree.

<br clear="right">

## Every node has a card

<img src="https://raw.githubusercontent.com/JRJRJPRO/dsh-tree/main/docs/card.png" alt="Node detail card" width="470" align="right">

Hover a dot for a preview. **Double-click the card to expand it** — rename the
node, pick a shape, pick a color, or upload an image.

On touch devices, a tap does what hovering does.

<br clear="right">

| | |
|---|---|
| **＋** | Continue from this turn as a new branch. On the empty root node, starts a fresh conversation in the same tree |
| **☆** | Favorite. The dot becomes a gold star, and you can give it its own icon and color |
| **⇥ / ⇤** | Split a branch off into its own tree, or put it back |
| **⊕ / ⊖** | Merge another conversation from this folder into the tree, or pull it back out |

A greyed-out button means you can't do it right now — hover it and it will say why.

## The colors mean something

| | |
|---|---|
| Blue outline | This node is part of your current conversation |
| Solid blue | The turn you're looking at |
| Orange triangle | This turn was compacted |
| Faded branch | Turns you rewound — no longer pretending to be part of the conversation |

## Make it yours

<img src="https://raw.githubusercontent.com/JRJRJPRO/dsh-tree/main/docs/settings.png" alt="Settings card" width="470" align="right">

**Settings → Plugins → Conversation tree**.

**Visible range** keeps big trees readable by drawing only what's near your
current turn — by depth or by distance, whichever you prefer. Either one has an
"off" setting. Nodes at the edge shrink and fade rather than vanishing, and come
back the moment you hover them.

**Node size** scales dots, lines and spacing together, 50%–250%.

**Colors** are one row per kind of node, color on the left and shape on the
right. Pick with the color wheel, or type a hex value like `#FFD43B` straight
in. What you set is exactly what gets drawn — the same in light and dark.
**Reset** hands a row back to the default.

<br clear="right">

## Favorite icons

Once a node is starred, its card offers two more rows:

- **12 shapes** — circle, rounded square, square, diamond, triangle, inverted
  triangle, arrow, pentagon, hexagon, cross, four-point star, hourglass
- **A character** — any letter or emoji, drawn inside a rounded outline
- **An image** — png / jpg / webp / svg, any size, scaled for you

Names, favorites, icons and colors are all stored on the dsh side, so they
follow you to another browser or your phone.
- **A color** — 6 presets, a reset swatch, a color picker, or a typed hex value

---

Using Claude Code through dsh-claude? Read the note in [AGENTS.md](AGENTS.md) first.

Want to hack on it? [AGENTS.md](AGENTS.md)

MIT
