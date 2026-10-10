# How boards stay in sync

Everyone on a board edits their own copy straight away and sends the change. Changes reach the server, and from it everyone else, in different orders, so two people can change the same thing at the same moment. The rules below make sure that **everyone who has seen the same changes has the same board**, whatever order they arrived in. In the literature this is a state-based **CRDT**: a map of last-writer-wins registers, with tombstones for removed entries. It's close to what Excalidraw does, with property-level merging added.

The rules live in one place, [`shared/src/board-merge.ts`](../shared/src/board-merge.ts), which the browser and the server both import, so they can't drift apart. Stacking order is in [`shared/src/board-order.ts`](../shared/src/board-order.ts).

## Changes and stamps

A change is an operation: `{ upsert: Element[], remove: Removal[] }`.

Each change carries a **stamp**: a `version` (one past the newest the person making it had seen) and a random `versionNonce`. Of two stamps, the higher version is newer; for the same version, the lower nonce. Every replica compares stamps the same way, so they all pick the same winner. A version is at most `MAX_VERSION` (2^48); the server drops a bigger one and stamps the change itself, so no element can be put where later edits can't follow.

## Property groups

An element's fields are split into groups that change independently:

| Group | Fields |
|---|---|
| `shape` | `type`, `seed`, `imageId`, `x1`, `y1`, `x2`, `y2`, `startId`, `endId`, `startAnchor`, `endAnchor`, `points`, `pressure`, `angle`, `fontSize` |
| `text` | `text` |
| `stroke`, `fill`, `strokeWidth`, `penSize`, `sketchy`, `font`, `name`, `route`, `startHead` | one field each |
| `index` | `index` (its place in the stack) |

Each group carries its own stamp, and when two copies of an element meet, each group is taken from whichever copy has it newer. So a move and a recolor made at the same time are both kept. The fields of one group always travel together: a move never mixes one person's corners with another's (a text's `fontSize` is in `shape` because resizing text changes it, and a connector's `startId` / `endId` / `startAnchor` / `endAnchor` because its ends and what (and which side) they're attached to change together). A connector's label is its `text`, in the `text` group like any other.

**Connectors.** A line or arrow attached to shapes names them in `startId` / `endId`, and an end pinned to one of a shape's sides names the side in `startAnchor` / `endAnchor`; where an attached end is drawn, and the path between the ends (its `route`: straight, curved or elbow, [`routes.js`](../client/src/features/board/routes.ts)), is worked out on each screen from where its shape is now ([`connectors.js`](../client/src/features/board/connectors.ts)). Moving a shape therefore changes only the shape, never its arrows, so a move and someone else's edit to the arrow can't conflict. The stored `x`/`y` of an attached end is a fallback for when its shape is gone, so any change made in the browser that removes a shape (deleting, erasing, emptying a text, an undo or redo) also lets go of its connectors where they're drawn, in the same change. The store does this for every removal, and adds the attached connectors to the undo step so undoing attaches them again.

An element stores its newest stamp as `version` / `versionNonce`, and lists only the groups whose stamp is older in `stamps`, e.g. `stamps: { stroke: [3, 81920], index: [1, 5] }`. A freshly created element has no `stamps`.

**Adding a field to elements?** Put it in a group in `FIELD_GROUPS`, or it won't survive a merge. A client test checks every field the editor creates.

## What the browser stamps

The store ([`store.js`](../client/src/features/board/store.ts)) stamps only the groups a change actually changed, compared with the element it was made from (its **base**), and takes every other group from the element as it is now:

- a step of a drag is compared with the step before it;
- a commit (`{ undo, redo }`) is compared with its other side, so undoing a move puts the shape back but keeps a color someone else picked since;
- otherwise, the element as it is now.

A new element is stamped whole and placed on top. One coming back (an undo of a removal) is stamped whole and goes back to its old place in the stack.

## Removals and tombstones

A removal `{ id, version, versionNonce }` hides an element if it's newer than everything in it. The element is then kept as a **tombstone**: the removal's stamp plus the element's last data. Then:

- a change made before the removal and arriving after it doesn't bring the element back, but is remembered in the tombstone;
- a newer change brings it back (an undo, or an edit by someone who hadn't seen the removal), merged with what the tombstone remembers.

The server passes on every change it takes in, including changes to removed elements, so that whoever brings an element back brings back the same thing everywhere. A change to a removed element goes out together with its removal, so a screen that doesn't know about the removal keeps the element hidden too.

## Stacking order

Each element has an `index`, a string key from [fractional indexing](https://observablehq.com/@dgreensp/implementing-fractional-indexing) (`"a0"`, `"a1"`, … `"b00"`). Boards are kept sorted by key, then by id, and drawn in that order. So two elements added at the same moment (and given the same key) stack the same way on every screen. A key can always be made above, below or between others, so moving an element in the stack only changes that element's `index` (the Layer buttons in the properties panel and Ctrl/⌘ + `[` / `]` do this: forward and backward step past the nearest element that overlaps the selection, and with Shift they go to the very front or back).

## The server

For each `board:op` the server ([`realtime/index.ts`](../server/src/realtime/index.ts)) first checks the sender's rate (a burst of 100, then 40 a second; cursors and views have their own, lower limits), then:

1. **cleans** the elements ([`element-rules.ts`](../shared/src/element-rules.ts));
2. **prepares** the operation (`prepareOperation`): gives new elements without a key a place on top, replaces a stamp that's more than a million versions ahead of what the board has for that element (a forged one would put the element out of reach of every later change) by one for the newest edit, and handles browsers still running an older app, which say so by not sending `sync: 2` when they join. Their elements are taken whole at their version, and ones without a version are stamped as the newest edit;
3. **plans** it with the shared rules, without changing anything (`planOperation`);
4. **checks sizes** against what would actually change (`admit`), including changes to removed elements, each of which must fit as an element;
5. **commits** it and passes on what changed (`effectOf`): each element as the server now has it, merged.

The sender's acknowledgement is `{ ok: true }`, plus `cleaned` (elements as the board stored them, where that isn't how they were sent, such as a label cut to the length limit, or the stored copy of an element whose change was refused) and `dropped` (ids of elements it refused, including new ones left out because the board is at its element cap). Or `{ ok: false, reason }`: `noSession` (join the board first), `invalid`, `tooLarge`, `forbidden` or `rate`. Only `noSession` (after joining again) and `rate` are worth sending again.

Removed elements' data is kept in memory while a board is open, up to 12 MB (a browser keeps up to about 4 MB of it). Past that the oldest keep only their stamp. An element that would come back on a board already at its element cap stays removed, tombstone and all. Stamps are also **saved with the board** (`removed`, hidden from ordinary queries), for 30 days and up to 5,000, so an edit from someone who was offline while everyone left can't bring back what was removed since. A removal of an id the board has never had leaves no tombstone, so made-up ids can't push real ones out.

Each open board is saved by one write at a time (changes made during a write go in the next round of the same save), a board someone opens again while it's being saved stays open, and a shutdown saves everything before disconnecting people and again afterwards, within a 20-second deadline.

**Restoring a version** stamps the restored elements well ahead of everything else (`RESTORE_LEAD`), and removes what the version doesn't have with removals just as new. Changes still on their way from before the restore can't undo parts of it.

## Opening and reconnecting

When a browser opens a board, the server sends the stamps of what was removed from it lately (`removed`), and the browser starts its tombstones from them (`store.load`). So an undo of a removal is stamped past the removal, and a change to a removed element still on its way can't bring it back on that screen. A restore sends them too (`board:reset`).

A browser that reconnects takes the board as the server has it, with its unsent changes merged on top (`store.rejoin`). Its tombstones are replaced by the server's, because the server's copy is the reference: an unsent change to something removed meanwhile stays hidden, as it does on the server. A change that fails to send is merged in again before being resent, which is harmless if it's already there.

## Tests

- [`shared/tests/board-merge.test.js`](../shared/tests/board-merge.test.js): the rules, including the defining property. Random changes are applied in many orders, and every order must give the same board, stacking order included (500 sets × 6 orders).
- [`server/tests/convergence.test.js`](../server/tests/convergence.test.js): three real browser stores and the real server rules, adding, dragging, recoloring, removing, undoing and redoing, with messages delivered in random order. Every browser must match the server exactly (400 sessions; 6,000 longer ones were also run while building this).
- [`server/tests/sync.test.js`](../server/tests/sync.test.js): the same over real sockets, older apps, saved removals and restores.

## Known limits

- Two edits with the same version *and* the same random nonce (about 1 in 2 billion per pair of crossing edits) can be resolved differently on different screens until a reload.
- Text is one register: two people typing in the same text box at once keep one person's text, not both. Merging characters would need a text CRDT (e.g. Yjs).
- If a board's removed-element data passes the in-memory budget, or after a board is closed and reopened, a removed element brought back by a partial edit returns with that edit's data only. The server's copy stays the reference, and screens match it after a reconnect.
