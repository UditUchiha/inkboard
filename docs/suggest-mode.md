# Suggest-mode links: design

Status: **built** (decisions taken and shipped 2026-10-11, PRs #24–#28). This is the roadmap's headline differentiator (section 9A, H1 in [research-and-roadmap.md](research-and-roadmap.md)).

## What it is

A fourth share-link level, **"Anyone with the link can suggest"**. People who open the link, signed-in or guests, can do anything they could on an edit link: draw, move, resize, recolor, retype or delete. Instead of changing the board, each of those becomes a **suggestion**. An owner or editor **accepts** it, which makes it part of the board, or **rejects** it, which drops it. It is Google Docs' "suggesting" for a whiteboard.

Who it's for: a designer collecting client feedback, a teacher marking up student work, peer review. In each case the owner wants input without handing over the pen.

## Decisions

| | Decision |
|---|---|
| Scope | **Additions, deletions and edits** in the first version. |
| Visibility | **Everyone on the board sees open suggestions**; anyone can hide the layer. |
| Guests | **Guests can suggest** through the link, within limits. |
| Reviewers | **Owner and editors** accept and reject. Contributors (edit links) can't. |

Also settled, as smaller calls:
- **Pictures can't be suggested at first.** Uploads take up the owner's storage and are the costliest thing to abuse.
- **The unit is one element.** The review panel groups elements by author and time; there is no "submit" step.

## The three kinds of suggestion

Each suggestion is about one element:

| Kind | What it holds | How others see it | Accepting it |
|---|---|---|---|
| **add** | A new element. | The element, faded, with a dashed outline in the author's color. | Adds it to the board with the same id. |
| **change** | The target element's id, the element as the author wants it, and which **field groups** they changed (shape, style, text…; `FIELD_GROUPS` in shared/src/board-merge.ts). | The original stays; the proposed version is drawn over it as a dashed ghost in the author's color. | Copies **only the changed field groups** onto the element as it is now. |
| **remove** | The target element's id. | The original, hatched in red with a strike-out badge. | Removes the element. |

**Why a change carries field groups:** if Ana suggests moving a box while an editor recolors it, accepting the move must not undo the recolor. The board already merges this way, one field group at a time (the CRDT in board-merge.ts). A change suggestion therefore applies like a remote edit to its own groups only.

**Out of date:** a change records the target's stamps, for the groups it changes, from when it was made. If the element has since been edited in those same groups, the panel shows "changed since this was suggested", and accepting replaces that edit. If the target is deleted, its change and remove suggestions are deleted with it, and the author's layer updates.

**One per person per element:** each author has at most one open change or remove suggestion per element, and further edits by them update it. Different authors can each suggest something for the same element; the panel lists them side by side.

## How it works

### Access

- `LinkAccess` gains `"suggest"`, and `Role` gains `"suggester"`. In `roleOf` (server/src/services/boards.ts), members keep their roles, and a link set to suggest gives everyone else `"suggester"`.
- A suggester is refused by `board:op` and `board:image`, as a viewer is. The new suggestion events are what they can send.
- `suggestion:resolve` takes a member (owner or editor).
- When an owner switches the link from suggest to view, `syncAccess` makes suggesters viewers live. Their open suggestions stay for review.

### Storage

- A new `Suggestion` collection, next to the board, as comment threads are:
  ```
  { board, id, kind: "add" | "change" | "remove",
    target?,           // change, remove: the board element's id
    element?,          // add: the new element; change: the element as proposed
    groups?, base?,    // change: the field groups it changes, and their stamps when suggested
    author: { userId | null, guestId | null, name, color }, createdAt, updatedAt, bytes }
  ```
  `id` is the element's id for an add, and the author and target for a change or remove, so each author has one per element.
- Elements go through the same `cleanElement` and size rules as board elements (server/src/realtime/operations.ts).
- Suggestions don't count toward the board's 5,000 elements or 12 MB, or the owner's quota. They have limits of their own (below).
- They are deleted when accepted or rejected, when their target is removed, when the board is deleted for good, and after **30 days** if nobody acts on them. Version history doesn't include them.

### Live events (Socket.IO, declared in `shared/src/socket.ts`)

| Event | From | What it does |
|---|---|---|
| `board:join` reply | server | Carries the open suggestions, so guests get them too. (Comment threads come over HTTP, which guests can't use.) |
| `suggestion:put` `{ boardId, suggestions }` | suggester | Adds or updates the author's own suggestions. Refused for someone else's. |
| `suggestion:withdraw` `{ boardId, ids }` | suggester | Removes the author's own. |
| `suggestion:resolve` `{ boardId, ids, outcome }` | member | `"accepted"` or `"rejected"`. Deletes them. |
| `suggestion:upsert` / `suggestion:delete` | server → room | Keeps everyone's layer current. |

The server deletes the change and remove suggestions on an element when a board operation removes it (in the session pipeline, `updateSession`), and announces that with `suggestion:delete`.

### Suggesting: a private copy of the board

This is the hard part. Every tool has to work for a suggester, on new elements and on the board's own, without changing the board.

- **The private copy:** a suggester's editor store *is* their private copy (as built: simpler than a separate sandbox store, with the same effect). It holds the board with the author's suggestions applied: their additions added, their changes applied, their removals left out. Every tool (pen, shapes, text, notes, connectors, select, move, resize, recolor, delete) then works unchanged, and undo and redo cover the suggester's own edits. Beside it, `client/src/features/board/suggesting.ts` keeps a second store with the board as the server has it, without their suggestions: it tells what each change is, and when one of their suggestions goes (rejected, its element removed, refused, or taken back), the copy is rebuilt from it with their remaining suggestions on top, keeping their history.
- **Remote changes:** other people's board operations reach the copy (and the board beside it) through `applyRemote`, as they reach any copy of the board. The copy merges them one field group at a time, so a suggester sees the live board with their own suggestions on top.
- **Where the copy's changes go:** to the server as suggestions, not to `board:op`. Each element the suggester changes is compared with the board:
  - an element that isn't on the board is an **add**
  - a board element that differs is a **change**, with the field groups that differ
  - a board element that was deleted is a **remove**
  - an element put back as the board has it **withdraws** that suggestion
- **Connectors and frames:** moving a shape re-routes the arrows attached to it, and moving a frame moves what's in it. Each element moved that way becomes its own change suggestion. They are made in the same moment, so the panel groups them, and they're accepted together.
- **Other people's suggestions** are drawn on the suggestion layer like everyone else's, but they aren't in the copy's elements and can't be selected.

### Reviewing

- Everyone has a **suggestion layer**, drawn by `renderScene` after the board's elements, in the styles in the table above.
- For members, a small DOM overlay (like the comment pins) puts an author chip with ✓ and ✕ by each group.
- A **Suggestions** panel lists open groups by author and time:
  - Accept and Reject for each group, plus "Accept all from …" for an author.
  - Hovering a group highlights it.
  - Out-of-date suggestions are marked.
  - A "Show suggestions" toggle is there for everyone.
- **Accepting is a member's own edit:**
  1. The member's board store commits the accepted suggestions as **one undo step**: adds with their ids, changes as their field groups on the current element, removes as removals.
  2. Their browser sends `suggestion:resolve`.

  So acceptance goes through the normal operation pipeline, merges with everyone's live edits, and can be undone like any change. Accepting the same add twice is harmless, because the second upsert finds the element already there.

### Notifications

A new notification type, `"suggestion"`, tells the owner, at most once per board while it's unread: "3 people suggested changes on Sprint board". Guests are named by their guest name.

### Abuse and limits

- **Per board:** at most 300 open suggestions and 2 MB in total.
- **Per author:** at most 100 open suggestions.
- **Rate:** the same bucket as board operations (rate-limit.ts), keyed by address for guests.
- **Element rules:** text and stroke limits are the same as on the board.
- **Owner controls:** "Reject all" in the panel, and switching the link off. Either one clears a vandalized suggestion layer in one click.
- **Guest identity:** a guest's id is chosen by their browser (server/src/realtime/index.ts:294), so a guest could pretend to be another guest and withdraw or move their suggestions. Members' decisions can't be faked this way. This is accepted for the first version; a server-issued author key per guest would close it.

### What else changes

These places switch on link access or role, so each needs the new value:
- **Server:** `boards.ts` (roleOf, canEdit), `board.model.ts` (`LINK_ACCESS`), `board.controller.ts` (`listBoards` includes `"suggest"` links), `thread.controller.ts` (suggesters can read comments but not post), `notification.controller.ts`.
- **Client:** BoardEditor (`readOnly`), `useBoardSync.ts` (`onRole`, `lostEditing`), ShareDialog (option, toast and role copy), the dashboard's role labels (`BoardCard.tsx`, `BoardParts.tsx`, `BoardTable.tsx`, `sections.ts`), `StatusPanels.tsx` (a "You're suggesting" notice instead of "view only").

## Build order

Each step is its own `feat/suggest-…` branch and PR. Each leaves `main` deployable, and the link option stays hidden until the last step. (As built, steps 3 and 4 went in together, in #27, since the private copy handles all three kinds the same way.)

1. **Server and shared types:**
   - `"suggest"`, `"suggester"`, the `Suggestion` model with its three kinds, the socket events, suggestions in the join reply
   - limits, expiry, and cleanup when a target is removed
   - tests for access, limits, own-only put and withdraw, and resolve
2. **The suggestion layer and review:**
   - drawing adds, changes and removes for everyone
   - the Suggestions panel and on-canvas chips
   - accepting (adds, field-group changes, removes, as one undo step) and rejecting
   - out-of-date marking
3. **Suggesting new elements:**
   - the sandbox store, with remote operations merged in
   - additions and withdrawals from it
   - own-only selection of additions
4. **Suggesting changes and deletions:**
   - edits and deletions of board elements in the sandbox become change and remove suggestions, connectors and frame contents included
   - undo and withdraw for them
5. **Turning it on:**
   - the Share dialog option and copy, the status notice, notifications
   - a check in two browser windows (member and guest)
   - docs and the roadmap

Steps 3 and 4 are the largest. Step 4 is where the sandbox's merge with live remote edits needs the most testing: a suggester moving a box while its owner recolors and then deletes it.

## Private mode

Private mode reuses suggestions. While a member has it on, everyone else who could change the board is a suggester (`effectiveRole` in `server/src/realtime/index.ts`; their screens are sent `board:role` and join again), and each suggestion goes only to its author's screens, on joining as well. A member's **Reveal** turns it off: roles go back, and every open suggestion is sent to everyone. Whoever turned it on keeps editing, and a guest on an edit link can neither turn it on nor reveal. It is saved with the board (`privateMode`), like the timer.

## Later

- A note on a suggestion group, which could reuse comment threads.
- Pictures in suggestions.
- A server-issued author key for guests.
