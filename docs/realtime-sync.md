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
| `text` | `text`, `alt` (a picture's description) |
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

## Typing in the same text

The fields people type into are a text's, note's or label's `text`, a frame's `name` and a picture's `alt`. Each is still one value in its group, but two people typing in the same one at once both keep what they typed: the changes are merged letter by letter ([`text-merge.ts`](../shared/src/text-merge.ts)).

**How.** A change that types into a field carries its `base`: what the field was on the screen it was made on. Where the board's text has changed since (someone else's typing got there first), the server makes a three-way merge: what the base became on the board, and what it became on that screen, are worked out as character diffs (Myers' diff, the fewest letters added and removed), and both are applied. A letter either deleted is gone, and what either typed is kept where they typed it; typed at the same spot, what got to the board first goes ahead. The result is stamped one version past the newer of the two, with the change's nonce, so a copy of either change sent again can't replace it, and the same two changes merge to the same element anywhere. A merge that comes to the newer side's text as it is just keeps that side, as last writer wins would.

**Why not a text CRDT.** A sequence CRDT (Yjs, Automerge, or a small one of our own) gives every letter an id, which means storing and sending those ids with every text, a new format for saved boards, the API and previews, and a second kind of merge next to the stamps. A three-way merge needs none of that: elements stay as they are, and only a change on its way carries one extra field. What it gives up is that it depends on the order changes arrive in, which a state-based CRDT doesn't; here that order exists anyway, because the server takes changes one at a time and everyone takes the board from it.

**Keeping it small.** The editor sends a text once, when it's committed (on blur), not per keystroke; the frame name and a picture's description are sent as they're typed, and are short. The base goes as a splice against the new text, `[prefix, suffix, middle]` (the letters at either end that are the same, and what was between them), usually a few letters. A diff stops after about a millisecond's work (two unrelated long texts), and so does a merge that would pass the field's length limit: the newer text then wins whole, as before. The server merges at most 20 elements per change.

**In the browser.**

- The store makes its change from the text it was typed against (the editor passes it to `commitText`), so typing that reached this screen while the editor was open is merged in, not overwritten; so is an undo of typing, which takes out only that typing (`typedOnto` in [`store.ts`](../client/src/features/board/store.ts)). The change's base is the text as this screen has it.
- The editor takes in someone else's typing while it's open, merged with what's being typed, and the caret keeps its place among the letters around it (`followText`; text typed right at the caret goes after it). It waits while an input method is composing.
- Until the server answers a change that typed, others' changes to that text don't replace it on this screen (`outbox.typing()`, `store.applyRemote`): the server merges the two, and its answer brings the result (`cleaned`, see below), which replaces the text whatever its stamp. Otherwise what was just typed would disappear for a moment, and anything typed meanwhile would be typed against a text without it.
- Two changes queued before sending are one change, typed against what the text was before both. A change sent again without knowing whether the server took it in (a timeout, a dropped connection) goes without its base, so it can't be merged in twice: it's taken whole, as before.

**Older apps.** A browser on an older app sends no bases, and one that doesn't say `sync: 2` has any it sends dropped, so its typing replaces the text whole, the newer winning, as it always did. Saved boards need no change: bases are never stored.

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

The sender's acknowledgement is `{ ok: true }`, plus `cleaned` (elements as the board stored them, where that isn't how they were sent, such as a label cut to the length limit, a text its typing was merged into, or the stored copy of an element whose change was refused) and `dropped` (ids of elements it refused, including new ones left out because the board is at its element cap). Or `{ ok: false, reason }`: `noSession` (join the board first), `invalid`, `tooLarge`, `forbidden` or `rate`. Only `noSession` (after joining again) and `rate` are worth sending again.

Removed elements' data is kept in memory while a board is open, up to 12 MB (a browser keeps up to about 4 MB of it). Past that the oldest keep only their stamp. An element that would come back on a board already at its element cap stays removed, tombstone and all. Stamps are also **saved with the board** (`removed`, hidden from ordinary queries), for 30 days and up to 5,000, so an edit from someone who was offline while everyone left can't bring back what was removed since. A removal of an id the board has never had leaves no tombstone, so made-up ids can't push real ones out.

Each open board is saved by one write at a time (changes made during a write go in the next round of the same save), a board someone opens again while it's being saved stays open, and a shutdown saves everything before disconnecting people and again afterwards, within a 20-second deadline.

**Restoring a version** stamps the restored elements well ahead of everything else (`RESTORE_LEAD`), and removes what the version doesn't have with removals just as new. Changes still on their way from before the restore can't undo parts of it.

## Opening and reconnecting

When a browser opens a board, the server sends the stamps of what was removed from it lately (`removed`), and the browser starts its tombstones from them (`store.load`). So an undo of a removal is stamped past the removal, and a change to a removed element still on its way can't bring it back on that screen. A restore sends them too (`board:reset`).

A browser that reconnects takes the board as the server has it, with its unsent changes merged on top (`store.rejoin`). Its tombstones are replaced by the server's, because the server's copy is the reference: an unsent change to something removed meanwhile stays hidden, as it does on the server. A change that fails to send is merged in again before being resent, which is harmless if it's already there.

## Tests

- [`shared/tests/board-merge.test.ts`](../shared/tests/board-merge.test.ts): the rules, including the defining property. Random changes are applied in many orders, and every order must give the same board, stacking order included (500 sets × 6 orders).
- [`server/tests/convergence.test.ts`](../server/tests/convergence.test.ts): three real browser stores and the real server rules, adding, dragging, recoloring, removing, undoing and redoing, with messages delivered in random order. Every browser must match the server exactly (400 sessions; 6,000 longer ones were also run while building this). The same file plays three people typing into one note and a frame's name at once, through the real store, outbox and editor merge: inserting and deleting at their own and the same places, committing, undoing and recoloring while others' typing arrives. Every browser must match the server (500 sessions), and with nothing deleted every letter anyone typed must be on the board (300). Without bases the newer text wins whole, and letters are lost in nearly all of those sessions. 20,000 sessions were run while building this (10,000 with deletes, 10,000 without): none diverged, none lost a letter; without merging, 9,936 of the 10,000 lost some.
- [`shared/tests/text-merge.test.ts`](../shared/tests/text-merge.test.ts): diffs, merges, carets and bases.
- [`server/tests/sync.test.ts`](../server/tests/sync.test.ts): the same over real sockets, older apps, saved removals and restores.

## Known limits

- Two edits with the same version *and* the same random nonce (about 1 in 2 billion per pair of crossing edits) can be resolved differently on different screens until a reload.
- Typing is merged as character diffs, so where a diff can line up the same letters more than one way, someone's typing can land a letter off where they meant (a CRDT would know). Two people typing at the same spot get both, one after the other, not interleaved word by word. Typing sent again without its base (after a timeout or a dropped connection) wins whole, as all typing did before. The frame-name and description fields in the properties panel show others' typing as it arrives, but don't keep the caret's place among the letters as the canvas editors do (it can jump to the end).
- If a board's removed-element data passes the in-memory budget, or after a board is closed and reopened, a removed element brought back by a partial edit returns with that edit's data only. The server's copy stays the reference, and screens match it after a reconnect.
