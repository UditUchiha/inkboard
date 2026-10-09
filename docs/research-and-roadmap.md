# Inkboard: research and roadmap

A living document. It records what we learned about the whiteboard market, what Inkboard has and lacks, the ideas we could build, and the decisions still open. Update it as we go: tick items off, move them between priorities, and add to the decision log.

- **Research date:** 2026-10-06. Prices, limits and product pages change often, so re-check anything before quoting it outside this document.
- **How the research was done:** five parallel web-research passes (big platforms, lightweight/open-source tools, dashboard and sharing patterns, feature trends, user pain points), then synthesis. Claims are cited with URLs. Anything marked *(unverified)* rests on snippets or secondary sources, or could not be confirmed.
- **Status legend:** `[x]` shipped, `[~]` in progress, `[ ]` not started. Effort: **S** = days, **M** = 1-3 weeks, **L** = a month or more. Effort figures are estimates for one person working on the current architecture.

---

## 1. Where Inkboard is today

### Shipped

- **Canvas and drawing:** pen (pressure-sensitive), rectangle, ellipse, arrow and line (which stay attached to the shapes they connect), text, sticky notes, frames, eraser, select-and-move; bring to front, send to back and step forward or backward; hand-drawn (Rough.js) or crisp rendering; infinite canvas with pan and zoom; light and dark themes; keyboard shortcuts; PNG and SVG export (SVG embeds its fonts and pictures); board files (`.inkboard.json`) to export and import, pictures included.
- **Live collaboration:** live cursors and presence, per-person undo and redo, queued edits while briefly offline, follow mode.
- **Sharing levels:**
  - Roles: **owner**, invited **editor**, link **contributor** (anyone with the link can edit), link **viewer** (read-only), and **guest** (no account).
  - Per-board link setting: **Restricted**, **Anyone with the link can view**, **Anyone with the link can edit**.
  - Viewers are read-only on the server, not just in the UI. Non-members never see invitees' email addresses. Access changes (invite, removal, link setting) apply live to people who already have the board open.
- **Accounts:** email and password, Google and GitHub sign-in (needs server keys), settings and profile.
- **Guests:** scratch drawing at `/draw` (kept in the browser only), with a "save board" step into sign-up. Guests can open shared links under a name they pick.
- **Collaboration extras:** comments with @mentions, notifications, version history, templates (built-in and saved).
- **Dashboard:** sidebar with All boards, Your boards, Shared with you, Starred, Archived, Trash (each with a count); grid and list views; sort; search (`/` focuses it); bulk actions with undo toasts; link-opened boards listed under "Shared with you".

### Architecture facts that shape what we can build

- **Sync model:** every change is an operation `{ upsert: [element], remove: [id] }`, sent over Socket.IO. The server applies it to an in-memory session and flushes to MongoDB about once a second, and when the last person leaves.
- **Conflict handling:** a state-based CRDT shared by the browser and the server (`shared/src/board-merge.js`, explained in `docs/realtime-sync.md`). Each group of an element's properties (shape, text, stroke, fill, …) carries the stamp of its latest change, and the newest wins group by group, so a move and a recolor made at the same time are both kept. Removals leave tombstones (also saved with the board for 30 days) so a late, older edit can't bring an element back. Stacking order is a fractional-index key on each element. So everyone converges whatever order changes arrive in.
- **Elements are small JSON objects**, stored together in one array on the board document. Socket messages are capped at 3 MB (`maxHttpBufferSize`, sized for one image upload), boards at 5,000 elements, one element at 500 KB and a whole board at 12 MB, all measured as MongoDB stores them (BSON, two to three times the JSON size for pen strokes). Images therefore cannot be embedded as base64; they are stored as separate files and elements hold only an image id (see `docs/image-storage.md`).
- **Single server instance** with in-memory sessions. A hard crash can lose whatever has not been saved yet: a quarter of a second for a small board, up to a few seconds for a very large one (the delay grows with the board's size, because saving a big board costs real time). A normal shutdown flushes everything first.
- **Per-person state** lives in a `BoardState` collection: `lastOpenedAt` and `archived`. Stars live on the board (`starredBy`); trash is the board's `deletedAt` (owner only, hides the board for everyone, erased after 30 days).
- **Dashboard payload:** the board list sends a preview of each board instead of its drawing: pen strokes thinned to what a thumbnail can show, at most 1,000 elements (the biggest), cached per board until it changes. Thumbnails draw pictures from a small copy (about 400 px) stored with each image.
- **Dark mode** converts each ink color on the canvas (`ink.js`, the same maths as the CSS `invert(93%) hue-rotate(180deg)` used for swatches), so pictures are drawn in their own colors.

---

## 2. Decision log

| Date | Decision | Why |
| --- | --- | --- |
| 2026-10-05 | Link access is a per-board setting with view-only link viewers, enforced on the server | Owner asked for "anyone with the link can view, only invited can edit" |
| 2026-10-05 | Guests can open shared links without an account; guests have no dashboard entry | "Anyone with the link" includes people without accounts |
| 2026-10-05 | Boards opened through a view link appear on the dashboard under "Shared with you" (a `BoardState` record is created when a signed-in person opens the board) | Matches Overleaf's behaviour; matches Google Drive ("files shared with a link that you have opened") |
| 2026-10-05 | A link-opened board disappears if the owner closes the link, and returns if reopened | Access follows the owner's current setting |
| 2026-10-05 | Archive is per person; star is per person (invited members only); trash is owner-only and hides the board for everyone for 30 days | Per-person archive matches Overleaf. Owner-only 30-day trash matches Google Drive. Hiding for everyone is the riskiest of these rules (see open decisions) |
| 2026-10-05 | Removing a collaborator also clears their `BoardState` | So a board with an open link does not linger on the dashboard of someone who left |
| 2026-10-06 | Tests use Node's built-in runner, an in-memory MongoDB and real sockets (no mocks); test users are created directly in the database | Fast (about 45 s for 119 tests), no new dependencies beyond the socket client, and tests exercise the same code paths as the app |
| 2026-10-06 | Cap one element at 500 KB and a board at 12 MB (BSON); refuse the change with a `tooLarge` reply and put the sender's screen back to the saved board | An anonymous guest on an editable link could push a board past MongoDB's 16 MB document limit, after which saving failed for everyone until a restart. Reproduced before fixing |
| 2026-10-06 | The save delay grows with board size (250 ms for small boards, up to 5 s for huge ones), and boards are written through the plain driver instead of Mongoose | Measured: saving costs about 0.2 ms per KB through Mongoose, and the plain driver is two to three times faster. A fixed short delay would let a heavy board spend all its time saving |
| 2026-10-06 | Do not build on tldraw | Its SDK now needs a paid commercial license for production use (per its license page, below) |
| 2026-10-06 | Login is optional: guests draw on a scratch board at `/draw` that is kept only in the browser (`localStorage`) and is uploaded when they sign up. Guest boards are never written to the database | Most visitors will not create an account just to try the app, so a required login hides the product. Keeping guest boards out of MongoDB stops casual visitors and bots from filling the free 512 MB Atlas tier. The rule of thumb: guests draw, accounts keep and share |
| 2026-10-06 | Google or GitHub sign-in never attaches itself to an existing password account. Someone whose email already has an account is asked to log in and connect the provider from Settings | Sign-up does not verify email addresses, so attaching by matching email would let whoever registered an address first be taken over by a later provider login (or the reverse). Provider emails are only accepted when the provider says they are verified |
| 2026-10-06 | Comments are for signed-in people only; link visitors (including editors) cannot see or write them. Link editors also cannot clear a board or see version history or the member list | Comments and mentions need real identities to notify. Clearing a board is too destructive to give anonymous link holders when the same edit link is shared widely |
| 2026-10-06 | Version history: a checkpoint is saved before the first change after 10 quiet minutes, the newest 50 automatic ones are kept per board, named versions are kept, and a restore saves the current board first so it can be undone | Gives a recovery point before each burst of work without a version per stroke. Pruning bounds the storage, except for named versions (see section 8) |
| 2026-10-07 | Each board's version history gets a 30 MB budget. The oldest autosaves go first when it's over (the newest 3 always stay), before-restore snapshots are kept to the newest 10, and saved versions are capped at 50 and refused when they alone would pass the budget. Members can delete saved versions | A busy 12 MB board could otherwise keep 50 full copies, more than the whole free database. Saved versions are never removed behind people's backs, so the limit is applied when saving, with a message saying what to do. Sizes are recorded per version; older versions are measured by the database the first time their board's history is trimmed |
| 2026-10-08 | Email verification, lighter version: accounts work before verifying, but invites by email only reach verified addresses. Password reset by emailed link (1 hour, once), which also verifies. Links hold a random secret stored only as a hash. Emails go through Brevo's HTTP API | Invites match on email and anyone could register any address; this closes that without making people verify before they can draw. Render's free plan blocks SMTP, and Brevo can send from a single verified address without owning a domain (Resend needs one). Without a domain some emails land in spam, so the screens say to check there |
| 2026-10-09 | Connectors can be pinned to a side of a shape (`startAnchor` / `endAnchor`, in the `shape` group), drawn from the four dots around a hovered shape, routed straight, curved or elbowed (`route`), given an arrowhead at the start too (`startHead`) and labelled (`text`, written halfway along with the line broken around it). Curved and elbow routes are worked out from the ends when drawn, like the ends themselves: each end leaves out of its side (a floating end out of the side facing the other end), and an elbow takes the route with the fewest turns, then the shortest, that never doubles back. Nothing about a route is stored but its kind. The selected shape shows its resize handles instead of dots | Miro, FigJam and Lucid all connect from dots on a shape's sides, and their flowcharts use elbow connectors with labels on them ("Yes" / "No"). Storing only the kind keeps routes conflict-free, as the ends are: a stored list of corners would need fixing up whenever a shape moves, by whoever moved it. On a selected shape the dots would sit on top of the edge resize handles and the turn handle, so they're shown only on shapes that aren't selected. Routing elbows around other shapes in the way is left for later |
| 2026-10-08 | Conflicts: each change carries the element's version and a random tie-breaker; the newest wins everywhere, removals are versioned too and leave tombstones, and the server drops stale changes before storing or passing them on. Changes from browsers on the older app are stamped by the server as the newest edit | Two people editing one element, or one deleting while another edits, could leave screens out of step until a reload. This is the per-element last-writer-wins register Excalidraw also uses, which converges without a central lock. Field-level merging (both a color change and a move surviving) is left for later |
| 2026-10-08 | Conflicts, extended into a CRDT: property groups carry their own stamps and merge group by group; the browser stamps only the groups a change made (compared with the element it was made from), so undo only reverts what it changed; elements carry a fractional-index stacking key; tombstones keep the removed element's data in memory and their stamps are saved with the board (30 days, 2,000); restores are stamped ahead of edits in flight. The rules live in a `shared` workspace both sides import | Concurrent move and recolor kept only one; elements created at the same moment could stack differently per screen; a stale edit from someone offline across a board closing could bring back a removed element; a restore could be partly undone by edits in flight. A full CRDT library (Yjs, Automerge) would have meant rewriting the store, protocol and storage for merging text characters, which a whiteboard rarely needs |
| 2026-10-08 | Stacking moves change only the element's `index` key. Forward and backward step past the nearest element that overlaps the selected one, not simply the next in the list; a move that would change nothing visible is greyed out. A key the server would refuse (over 100 characters, after very many moves into the same gap) is not made | On a large board the next element in the stack is usually somewhere else, so a plain one-step move often changes nothing anyone can see; tldraw steps past overlapping shapes for the same reason. Keeping the move to one property group means it merges with a concurrent move or recolor and undo reverts only the order |
| 2026-10-09 | Connectors store only what each end is attached to (`startId`, `endId`, in the `shape` group with the ends). Where an attached end is drawn is worked out on each screen, aiming at the shape's middle and stopping a small gap outside its outline (rectangle, rotated box or ellipse). Moving or copying a connector without its shapes lets go of them; copying them together keeps it attached to the copies; deleting a shape leaves its connectors where they're drawn. Shapes win over a text label lying on them | Excalidraw rewrites an arrow's points whenever its shape moves, so one person moving a shape while another edits the arrow is a conflict and the arrow can end up detached. Working the ends out when drawing needs no change to the arrow at all, so it can't conflict and every screen agrees. Labels sit on shapes as separate text here, so attaching to the label would stop arrows in the middle of the shape. Fixed anchor points on a shape (rather than aiming at its middle) are left for later |
| 2026-10-08 | A frame holds whatever lies wholly inside it, worked out from positions when it's moved, copied or deleted, not stored on the elements. Each element belongs to one frame (the smallest around it; between two the same size, the one it sits nearer the middle of), and a frame inside a bigger one goes with it. Frames are drawn beneath everything else, picked by their name, border or empty inside, and a copy is placed beside the original | Nothing to keep in step: a stored parent link would be one more field two people could change at once, and could disagree with what people see. Excalidraw and tldraw store the link, which needs extra rules when a child moves out. Placing copies beside the original stops two frames covering the same contents, which made deleting a copy take the original's notes with it (found in testing) |
| 2026-10-08 | Sticky notes size their writing to the note: it starts at a seventh of the note's side and shrinks by tenths until every line fits, the same layout for the canvas, the editor and SVG export. An empty note is kept | Matches FigJam and Miro, where a note never overflows. A fixed size would need people to pick one per note |
| 2026-10-08 | Code is formatted with Prettier (120 columns, the closest to how it was written), checked in CI. Markdown is left out. The one-off reformat is listed in `.git-blame-ignore-revs` | Formatting by hand drifted, and a formatter run with its defaults rewrote whole files. A shared config makes the diffs of later changes only the change |
| 2026-10-06 | Notifications (mentions, replies, invites) expire after 60 days; trash after 30 days; each person can keep 30 templates | Keeps the free database small without a cleanup job for notifications (a MongoDB TTL index handles it) |
| 2026-10-07 | Images are stored in MongoDB GridFS behind a four-function storage layer (`image-storage.js`), uploaded over the board socket, served at `/api/images/:id` by a random 128-bit id with a one-year immutable cache. They are shrunk in the browser (2000 px, WebP, under 1.8 MB), capped at 2 MB each and 25 MB per board, and checked by file signature. SVG is refused. Templates skip images. Files go when their board is deleted for good. Space is also capped per owner (100 MB, all their boards) and for the whole app (300 MB), uploads are handled one at a time, and images no board or version shows are swept after an hour | GridFS needs no new account, so it works on a fresh deploy. The socket reuses the edit permission check, so guests with an edit link can add images and viewers cannot. Access by unguessable id is how Google Docs and Miro do it; the cost is that a copied link keeps working after a board is restricted. R2 and Cloudinary are the upgrade path |
| 2026-10-07 | Dark mode converts ink colors in the renderer instead of filtering the whole canvas with CSS | The CSS filter turned photos into near-negatives, and no pre-correction can undo it: saturated colors such as pure red are outside what the filter can output. Converting colors with the filter's own maths keeps drawings looking exactly as before (checked against Chromium over 223 colors, within 2/255) and leaves pictures alone |
| 2026-10-07 | Dashboard thumbnails are drawn in the browser from server-made previews (thinned pen strokes, capped element count, small picture copies), not stored as images | A stored thumbnail image would be wrong in dark mode (it would need a second copy per theme), goes stale when nobody with edit rights reopens the board, and needs an upload path. Previews are always current, cost no storage, and are cached by the board's `updatedAt` |

---

## 3. Competitive landscape

### Big collaborative platforms

| Product | Free-plan limits | Sharing and roles | Signature | AI | Weakness |
| --- | --- | --- | --- | --- | --- |
| **Miro** | 3 editable boards; Starter $8 and Business $20 per member per month (annual) | Link access as view, comment or edit, with no sign-up. Password on paid plans. Link expiry exists with a 30-day minimum | Broadest feature set; 250+ integrations; Talktrack; MCP server (beta) | Credit-metered (25 per member on Starter, 50 on Business) | Lag on big boards; seat-billing and cancellation complaints |
| **FigJam** | 3 files in a team space; 500 AI credits per month | Can view / can edit. **Open sessions**: any visitor can edit for 24 hours with just a name; paid plans only, no comments | Light facilitation (voting, stamps, timers); Figma ecosystem | Summarize, generate templates, sort stickies (credits) | Weaker diagramming than Miro; students need accounts |
| **Mural** | 3 editable murals; unlimited view-only visitors; Team+ $9.99, Business $17.99 | Visitor link as view or edit, no account | Facilitation-first (private mode, voting, timers on all plans) | Paid tiers only | Pricey; slow or blank boards reported; few integrations |
| **Lucidspark** | 3 editable boards | "Anyone with the link" as edit, comment or view; guest collaborators only on Team and Enterprise | Diagramming heritage; Google named it a Jamboard successor | Exists; gating unverified | 3-board free tier described as impractical |
| **Microsoft Whiteboard** | Free personal use has ended; now Microsoft 365 organizations only | Org-only links; anonymous guests only inside a shared Teams meeting | Teams and OneDrive integration | Copilot (needs M365 licensing) | Locked to the org. Sources disagree on retirement dates, so verify before quoting |
| **Canva Whiteboards** | Free tier exists; exact whiteboard limits unverified | View, comment or edit links | Design-asset ecosystem | Credit pools (figures unverified) | Facilitation depth unverified |
| **Apple Freeform** | Free with Apple devices | "Only people you invite" or "anyone with the link", with edit or view | Pencil and iCloud feel | Unverified | Apple devices only; no real web client |
| **Google Jamboard** | Shut down (read-only from 2024-10-01, gone after 2024-12-31) | n/a | n/a | n/a | Google pointed users to FigJam, Lucidspark and Miro |

### Lightweight, open-source and diagram-focused tools

| Product | Why people pick it | Sharing | Free vs paid | Technical notes | Gaps |
| --- | --- | --- | --- | --- | --- |
| **Excalidraw / Excalidraw+** | No signup, instant, hand-drawn look, MIT licensed | Link with an end-to-end-encryption key in the URL `#fragment`; unlimited collaborators | Free: 1 scene. Plus ($6 per user per month): unlimited scenes, cloud storage, edit/view rights, read-only and embeddable links, presentations, comments, MCP and API | Rough.js; per-element last-write-wins with tombstones (no CRDT); multiplayer undo since v0.18 | One scene on free; no roles on free; collaboration described as laggy; self-hosting is on the Plus backlog |
| **tldraw** | Best-feeling canvas; builder SDK; AI and agent work | tldraw.com and self-hosted sync | SDK needs a production license key; hobby tier shows a watermark; commercial pricing is custom | Server-authoritative sync (not CRDT) | Not OSI open source; sync client and server versions must match |
| **draw.io / diagrams.net** | Free, privacy-first, huge shape libraries | Files live in Drive, OneDrive, GitHub and similar | Free | XML files; real-time collaboration only through Google Drive, OneDrive, Dropbox or Confluence | Collaboration is tied to storage, not links; dated UI |
| **Whimsical** | Polished flowcharts, wireframes, mind maps | Unlimited guests and viewers | Free: 50 board objects; Pro $10 per editor | Closed SaaS | Object-count cap; per-editor pricing |
| **Eraser** | Engineers: diagram-as-code plus docs plus AI | Unlimited free guests; public sharing | Free: 3 files and 3 AI diagrams | Canvas plus markdown plus a DSL | Narrow audience; tight free caps |
| **Milanote** | Visual boards for creatives | Unlimited shared boards | Free: 100 notes and limited uploads | Closed SaaS | Metered free tier; not a diagramming tool |
| **AFFiNE** | Open-source Notion-plus-Miro hybrid, local-first | Cloud workspaces; self-host | Free: 10 GB and 3 members | Yjs CRDT; editor MIT, backend under an EE license | Heavier than a pure whiteboard; backend license limits production self-hosting |
| **Obsidian Canvas** | Local, owned notes graph; open JSON Canvas format | None built in | Free | Local JSON files | No native real-time collaboration |
| **Nextcloud Whiteboard** | Self-hosted inside Nextcloud | Nextcloud permissions | Free (AGPL) | Excalidraw plus Socket.IO | Small project |

### Why Excalidraw won mindshare

1. **Zero friction:** open the URL and draw, no signup.
2. **A virality loop:** one-click live link that needs no recipient account, plus a privacy story (the key lives in the `#fragment`, so the server stores only ciphertext).
3. **Embeds:** it is an embeddable React component used inside Notion, Obsidian and VS Code.
4. **A recognizable hand-drawn style** that pastes well into docs and slides.
5. **MIT license and self-hosting**, so developers trust and fork it.

Its limits are the opening for Inkboard: end-to-end-encrypted links give no revocation and no roles (the URL *is* the access control), and its free plan has a single scene.

### Where Inkboard already sits

Excalidraw's feel plus **real accounts, per-board roles and revocable links, with no board cap.** None of the big platforms offers unlimited free boards, and none of the lightweight tools offers roles and revocable links on a free plan.

---

## 4. Dashboard and sharing patterns (how mature products behave)

| Product | Item opened only through a link | Starred | Archive | Trash and retention | Folders or tags |
| --- | --- | --- | --- | --- | --- |
| **Google Drive** | Listed in "Shared with me" ("files shared with a link that you have opened"); non-owners can only "remove" it | Yes | None | Owner only; auto-erased after 30 days | Folders, shortcuts |
| **Figma / FigJam** | Recents plus a "Shared files" tab; a forum thread says removing a file from it is not supported (possibly dated) | Yes | None | Anyone with edit rights on the file and project can trash it, for all collaborators; no auto-expiry | Teams, projects, drafts |
| **Canva** | "Shared with you" with a per-person Hide; hidden items return when the link is reopened *(snippets)* | Unverified | None | 30 days; a recipient's delete removes only their own access | Projects, folders |
| **Overleaf** | Docs do not say how link-opened projects appear *(unverified)*; the dashboard screenshot we reviewed shows them with a link icon in the Owner column | Not verified | Per person; never affects collaborators | Per person, no auto-delete; the owner then deletes permanently for everyone; collaborators can only "Leave" | Colored tags (desktop and tablet only) |
| **Miro** | "Leave board" works on paid plans only (community thread) | Starred tab | None | 90 days; trash is paid-plan only | Teams, projects; no multi-select (open request) |
| **Notion** | Pages shared with you appear in the sidebar's Shared section | Favorites | None | 30 days; pages are deleted from trash one by one | Page tree |
| **Excalidraw+** | Unverified | Unverified | "Archive (trash)" shipped | Soft delete | Collections |

### Verdict on our dashboard rules

1. **Link-opened boards under "Shared with you" with a "View only" badge:** matches Drive and Figma. Figma's refusal to let people remove them is a known complaint; ours can be removed.
2. **Removable, and returns when the link is reopened:** matches Canva's per-person Hide, the best case found.
3. **Per-person star and per-person archive:** matches Overleaf and the common pattern.
4. **Owner-only trash that hides the board for everyone, erased after 30 days:** matches Drive. Overleaf and Canva trash per person instead, so collaborators keep access. Hiding for everyone is the riskiest rule: collaborators need a clear signal when it happens (see backlog).
5. **Bulk actions, undo toasts, grid and list views:** ahead of Miro (no multi-select) and level with Figma and Drive.

### Cheap polish ideas, ranked by value

1. "Make a copy" for viewers and editors (Figma's "duplicate to drafts"; Notion enables duplication by default). Turns a dead-end view link into a growth path.
2. Request-access and request-edit flows that notify the owner (Drive and Notion do this).
3. Show "Erases in N days" on trash cards, with "Delete forever" and "Empty trash" (done in our dashboard).
4. A one-click "Leave board" for invited editors (Overleaf forces trash first).
5. Optional link expiry (1, 7 or 30 days). Paid or enterprise-only elsewhere; it is a single date field for us.
6. Per-person tags or colored labels (defer folders; Excalidraw+ itself still lists them as backlog).
7. Search polish: `/` to focus (done), match on title and owner name (done), helpful empty states per section (done).

---

## 5. Feature gap analysis

### Table stakes we are missing

Every major competitor has these. They are the cost of being taken seriously as a whiteboard.

| Feature | Notes |
| --- | --- |
| ~~Resize and rotate handles~~ | Done: see the backlog |
| ~~Image upload~~ | Done: see the backlog and `docs/image-storage.md` |
| ~~SVG and JSON export (with JSON import)~~ | Done: see the backlog |
| ~~Sticky notes~~ | Done: see the backlog |
| ~~Frames~~ | Done: membership is worked out from positions (see the decision log) |
| ~~Connectors that stay attached to shapes~~ | Done: attached ends are worked out from their shapes when drawn, with connection dots, curved and elbow routes and labels (see the decision log) |
| Presentation mode, laser pointer | Presentation is paid at Excalidraw+; laser and follow are free in tldraw and Mural |

### Common but paid elsewhere

AI generation and summarization (credit-metered everywhere); timer, voting and private mode (Miro paid tiers, Mural all plans); long version history (Eraser and AFFiNE give 7 days on free); high-resolution export (Miro paid); advanced integrations (Mural Business); MCP and agent access (Excalidraw+, Miro).

### Rare or unclaimed

- Free AI diagram generation with no signup (credit caps are everywhere).
- **Mermaid round-trip:** import is common; exporting a drawn canvas back to Mermaid is not (Miro users are still asking).
- Open JSON and SVG export with no lock-in.
- Handwriting-to-text and handwriting-to-math *(unverified in any product)*.
- Local-first plus real-time (AFFiNE only).
- A free, self-hostable board with a public API and MCP.

### Effort and main risk for the most relevant features

Estimates are for one person, on the current operation-based sync.

| # | Feature | Effort | Main technical risk |
| --- | --- | --- | --- |
| 1 | Resize and rotate handles | M | Transforms for Rough.js seeds, pen strokes and text; coalesce operations during a drag |
| 2 | Connectors bound to shapes | M | Binding fix-ups when an endpoint moves; deterministic order for concurrent edits |
| 3 | Image upload | M | Blob storage and size/abuse limits on free hosting |
| 4 | Sticky notes and frames | S-M | Frame membership and z-order; moving a parent emits child operations |
| 5 | Follow, laser pointer, cursor chat | S | Ephemeral events only; throttle presence (follow mode already shipped) |
| 6 | SVG and JSON export and import | S | Embed fonts and seeds |
| 7 | Presentation from frames | M | Camera sync; mostly client work |
| 8 | Mermaid import | M | Layout quality; check the converter's license and its past XSS issue (CVE-2025-54881) |
| 9 | Mermaid export from canvas | M-L | Needs an inferable graph structure; best effort |
| 10 | AI prompt to board | M | Structured-output schema, prompt-injection safety, cost control |
| 11 | Public API and MCP server with scoped tokens | M | Auth model and rate limits; writes must go through the same operation pipeline as clients |
| 12 | Timer, voting, private mode | S-M | Private mode needs per-client filtering, which breaks broadcast-everything |
| 13 | Shape recognition on pen strokes | M | Tuning false positives; $1-style recognizers are the cheap route |
| 14 | Pen pressure and palm rejection | S-M | Pointer-event handling across devices (pressure is partly done) |
| 15 | Large-board performance (viewport culling, spatial index) | L | Rendering cost and operation volume |

---

## 6. What users complain about

Ranked by strength and recurrence of evidence. Reddit and Hacker News were hard to retrieve, so this leans on vendor community "ideas" boards (vote-counted), review sites and education blogs.

1. **Per-seat pricing and free-tier caps** push out occasional participants (Miro: 3 editable boards).
2. **Guests and students are forced to sign up** (FigJam); Miro's anonymous guest editors give random "Guest" names, and users asked for passwords and custom names.
3. **Tools are too heavy for quick work.** Jamboard was missed for being simple; Miro is described as overwhelming.
4. **No per-region or per-person edit rights.** Miro frame locking blocks move and resize only, not drawing inside the frame (request open since 2022, 12 votes). A "Contributor" role that edits only your own objects (8 votes, open since 2022). A teacher complained of students vandalizing each other's work; the workaround was one board per student. FigJam: "limit students to one section" is not supported.
5. **Math and LaTeX are missing.** Miro's "math expressions" request has 79 votes and has been open since March 2020. A handwriting-recognition request is also open.
6. **Performance and latency:** slow large boards (Miro), pen lag for tutors (Miro, Lessonspace), Microsoft Whiteboard latency backlash.
7. **No replay or timelapse of how a board evolved.** Miro's request: 33 votes, open since 2020. interviewing.io built its own Excalidraw-based whiteboard mainly to get replay.
8. **Simple tools lack governance.** Excalidraw has no auth or roles; possession of the URL is access.
9. **Boards become chaotic; export is weak** (no editable slide export).
10. **Interview tooling is fragmented.** CoderPad's drawing mode is described as lackluster, so companies use Excalidraw, which has no replay.

### Underserved segments

- **Independent tutors (math and science):** native LaTeX, a low-latency pen, zero-friction student join.
- **K-12 and higher-ed teachers after Jamboard:** replacements are account-gated (FigJam), complex (Miro) or paid (Whiteboard.fi, free up to a small student count). They want per-student safe zones.
- **Interviewers and coaches:** replay and a recap.
- **Small dev teams:** Excalidraw-simple boards with comments, history and roles, without enterprise per-seat pricing.

---

## 7. Hypotheses we tested

For each idea, did we find a product that already does it?

| # | Hypothesis | Verdict | Evidence |
| --- | --- | --- | --- |
| H1 | A "suggest" level: link viewers propose drawings on an overlay that editors accept or reject; or a comment-only link role | **Not found** as a drawing overlay; partial for comment-only | Suggested edits exist for text documents (Notion). Miro has view, comment and edit levels. Miro's "Contributor" request is the nearest and is still open |
| H2 | Instant board with no signup, real-time collaboration, claim to an account later | **Partial** | tldraw and Excalidraw need no signup; tldraw's demo data lasts up to 24 hours. Miro's anonymous guests need an account-owning board owner. No explicit "claim later" flow found. *Inkboard now has guest scratch boards with save-to-account.* |
| H3 | Board time-travel and a shareable timelapse | **Partial** | interviewing.io has replay inside its own product; CoderPad has session playback for code. Miro: requested since 2020. No general shareable timelapse found |
| H4 | Native LaTeX or math elements | **Partial** | LearnBoard has native LaTeX. Miro lacks it. FigJam and tldraw: not found. Handwriting-to-math found only as requests and indie projects |
| H5 | Live read-only iframe embed | **Exists (Miro)** | Miro Live Embed has a view-only mode, inside its paid platform. A free, lightweight option was not found |
| H6 | Classroom mode (teacher template, per-student copies, live grid) | **Exists (Whiteboard.fi, Classkick)** | Whiteboard.fi gives each student a board and the teacher sees all live; paid beyond a free tier; not an infinite canvas |
| H7 | Screen-reader or keyboard-accessible outline of a board | **Partial** | FigJam added screen-reader support (May 2023) with gaps; Miro has known WCAG failures; tldraw claims WCAG 2.2 AA primitives (vendor claim, untested). No structured outline view found |
| H8 | End-to-end-encrypted shared boards | **Exists (Excalidraw)** | AES-GCM, key in the URL fragment. Limits: no authentication, key leakage through URL and history. Conflicts with per-user roles and server-side features |
| H9 | Narrated async tours of a board | **Exists (Miro Talktrack)** | A screen recording with voice, not a camera-path tour; the free plan allows 5. Equivalents elsewhere not found |
| H10 | Link expiry, password, request-access | **Exists (Miro, paid)** | Password on Team, Business and Education plans; expiry has a 30-day minimum. Free small tools: not found |
| H11 | Frame-level permissions | **Not found** | Miro request open since 2022; FigJam confirmed unsupported; Miro breakout rooms only partly lock participants |
| H12 | Interview mode (timed board, code blocks, auto recap and replay) | **Partial** | CodeSignal has a first-party whiteboard; CoderPad has playback; interviewing.io has replay. No single free or indie product combining all of it |

---

## 8. Engineering risks and debt

- [x] **Per-element versions (fixed):** two people changing the same element at once could leave one of them seeing a different board until they reloaded, and so could a removal crossing an edit. Changes are now versioned (see section 1); a simulation of 400 sessions of crossing edits, removals and undos found the old way diverged in 356 and the new way in none. Extended the same day into a property-level CRDT with stacking keys and saved tombstones (see section 1 and `docs/realtime-sync.md`); a simulation of three people adding, dragging, recoloring, removing and undoing converges in all 6,000 sessions tried, stacking order included. *Still open:* two people typing in the same text box at once keep one person's text, not both.
- [x] **Durability (improved):** small boards now save within about 250 ms (was 1 s), the delay scales with board size, and saves go through the faster driver path. Graceful shutdown already flushes open boards. *Still open:* a hard crash loses what has not been saved yet; closing that completely needs an append-only operation log (which would also give us replay, see idea B).
- [x] **Unbounded element size (fixed):** found and reproduced during the test work. Element validation only checked `id` and `type`, so any editor, including an anonymous guest on an editable link, could push a board past MongoDB's 16 MB limit and break saving for everyone. Now capped (see section 1). Every element is also checked against rules for its type (`element-rules.js`): broken geometry or content is refused, odd style values are reset or clamped, and unknown fields are dropped.
- [x] **Dashboard payload (fixed):** the board list now sends thinned previews instead of full drawings, and thumbnails use small picture copies (see section 1).
- [x] **Automated tests (server and client done):** 119 tests run with `npm test` and in GitHub Actions. *Still open:* browser end-to-end flows (the dashboard and sharing were checked by hand in a browser, not by a repeatable test). Adding them means a Playwright dev dependency and a browser download in CI.
- [ ] **Free-tier hosting** sleeps after inactivity; the GitHub Actions keep-alive covers this only while the workflow runs.
- [ ] **Owner trash hides a board for everyone.** Collaborators should be notified when it happens.
- [ ] **Single instance:** sessions live in one process's memory, so running a second server instance would split boards. Fine for now; note it before scaling.
- [x] **Version history storage (bounded):** every version is still a full copy of the board, but each board's history now has a 30 MB budget (see the decision log). *Still open:* storing versions compressed, or as deltas from an operation log, would fit far more history in the same space.
- [x] **Email verification (lighter version):** new accounts get a verification link and work straight away, but invites by email only reach verified addresses, so registering someone else's address no longer gets you their invites. Whoever really owns an address can take it back with "Forgot password". Emails go through Brevo's API (Render's free plan blocks SMTP). *Still open:* sessions are signed tokens that can't be revoked, so resetting a password doesn't log out other devices; adding a token version to the account would fix it.
- [ ] **Edit links can be abused.** "Anyone with the link can edit" includes anonymous guests, so a leaked link allows vandalism or spam. Today the recovery is version history and the owner switching the link back to restricted. Cheap hardening: a per-connection limit on change operations, a link password or expiry (see the backlog), and notifying the owner when many guests join.
- [x] **OAuth verified for real:** Google and GitHub sign-in both worked end to end on the live app (2026-10-08).
- [ ] **Comment threads and notifications are unbounded per board and per person.** Message length is capped (2,000 characters), but the number of threads and messages is not.

---

## 9. Ideas for a real differentiator (USP)

Ranked by fit with what Inkboard already has. Pick one as the headline; the others are supporting features.

### A. Suggest-mode links *(recommended headline)*

- **Pitch:** share a link where viewers draw proposals on an overlay, and editors accept or reject each one. Like Google Docs "suggesting", for boards.
- **Segment:** client feedback for designers, teachers reviewing student work, peer reviewers.
- **Why unserved:** no whiteboard with propose-and-accept drawings was found (H1). It extends the link levels we already have.
- **Effort:** M-L. **Risk:** designing the accept/reject experience for drawn objects; unproven demand.

### B. Replay and shareable timelapse

- **Pitch:** scrub through how a board was built; share the replay as a link.
- **Why us:** every change is already an operation, so the data model fits. Miro's request has 33 votes and has been open since 2020.
- **Effort:** M. **Risk:** storing an operation log costs money on free hosting; needs compaction (snapshots plus recent operations).

### C. Classroom mode with a "my zone" frame

- **Pitch:** a teacher drops a template; each student gets a private copy, or a single shared board gives each student a frame only they can edit.
- **Why unserved:** frame permissions are unsupported in Miro and FigJam (H11). Whiteboard.fi does the grid view but is paid and not infinite-canvas. Jamboard and personal Microsoft Whiteboard are gone, which leaves teachers looking.
- **Effort:** L. **Risk:** schools expect rostering and SSO; obligations around minors' data (COPPA, FERPA); Whiteboard.fi is entrenched.

### D. Math-first board

- **Pitch:** native LaTeX equation elements; handwriting-to-math later.
- **Why unserved:** Miro's request has 79 votes and has been open since 2020. LearnBoard is the only indie answer found.
- **Effort:** S-M for typed LaTeX (KaTeX); L for handwriting. **Risk:** handwriting recognition is hard and costly; competitors such as Desmos and Mathpix exist *(unverified)*.

### E. Open board API and AI-agent access (MCP), with Mermaid round-trip

- **Pitch:** a free, open API and MCP server that writes through the same operation pipeline as the app, plus Mermaid export from a canvas.
- **Why now:** Miro (Feb 2026), FigJam in Claude (Jan 2026), Lucid and Excalidraw+ all shipped MCP. Excalidraw puts API and MCP behind its paid plan.
- **Effort:** M. **Risk:** auth model, rate limits, prompt-injection safety for AI features.

### F. Supporting ideas (cheap)

- Link password and expiry; "request access" on private boards.
- Reactions and comment pins for link viewers (FigJam lets link viewers comment and react).
- A free live read-only embed (`<iframe>` snippet).
- "Make a copy" for viewers.
- A bring-your-own-key AI option or a small free allotment, avoiding the credit-gating complaints.
- Unlimited boards on the free tier as an explicit marketing promise (verify hosting costs first).
- A predictable, capped price with instant cancellation, if we ever charge (Miro's top complaints are surprise seats and hard cancellation).

### Timing factors

- Microsoft Whiteboard stopped personal use and moved to Microsoft 365 organizations in 2026; Jamboard ended in 2024. Teachers and individuals lack a free, no-account option. *(Retirement dates differ between sources; verify before quoting.)*
- AI is credit-metered everywhere; a free tier with bring-your-own-key is a differentiator.
- Enterprise facilitation depth (Miro Sidekicks and Flows, SSO, data residency) is not something one person can match. Skip it.

---

## 10. Backlog

Priorities are suggestions. Move items as decisions are made. Each item can link to a branch or PR when work starts.

### Done

- [x] Link access levels (restricted, view, edit), server-enforced viewer role, guest sockets, live role changes
- [x] Dashboard: sections, grid and list views, sort, search, bulk actions, undo toasts
- [x] Link-opened boards on the dashboard; archive, star and trash (owner trash, 30 days)
- [x] Guest scratch drawing with save-to-account (`/draw`)
- [x] Google and GitHub sign-in; settings and profile
- [x] Comments with @mentions; notifications
- [x] Version history; templates (built-in and saved); follow mode

### P0: foundations everything else needs

- [x] **Resize and rotate handles:** shapes, strokes and text resize from any side or corner (opposite side stays fixed, even when turned) and turn about their centre; lines and arrows have end handles. Shift keeps proportions or snaps turns to 15°. One undo step per gesture.
- [x] **Image upload:** toolbar button, paste and drop; shrunk in the browser (2000 px, WebP), stored in MongoDB GridFS behind a one-file storage layer; permission-checked over the board's socket; resize, turn, undo, PNG export and guests with an edit link all work. Options for R2 and Cloudinary are in `docs/image-storage.md`
- [ ] **Image follow-ups** (S-M each): show owners how much image space they use; move storage to R2 when the database nears 300 MB; crop, and alt text
- [x] **SVG and JSON export and import:** SVG draws exactly what the canvas does (rough.js paths, pen outlines, text on the right baseline) with the fonts and pictures embedded; board files carry the pictures and import into the open board as one undo step, re-uploading pictures to it. Large changes are now sent in pieces under 1 MB, since a message over the 3 MB socket limit dropped the connection and was resent forever
- [x] **Automated test suite:** server API and sockets, client store and dashboard rules, client/server parity, CI (browser end-to-end flows still to do)
- [x] **Durability hardening:** quicker, size-aware saves; element and board size limits (an append-only operation log would close the rest)
- [ ] ~~**Browser end-to-end tests in CI**~~: decided against for now (open decision 5); main flows are checked by hand in a browser when they change
- [x] **Per-type element validation** on the server: geometry and content must be right, style values are repaired, unknown fields are dropped
- [x] **Dashboard thumbnails:** the board list sends thinned, cached previews instead of full drawings; thumbnails use small picture copies; pictures keep their colors in dark mode
- [x] **Real Google and GitHub sign-ins** worked on the live app (2026-10-08)
- [ ] **Turn on email verification and password reset:** built and tested (verification link at sign-up, invites need a verified address, "Forgot password?" with a 1-hour link, via Brevo), but off until `BREVO_API_KEY` and `EMAIL_FROM` are set on the server, waiting on a dedicated sender address (S)
- [x] **Bound version-history storage:** a 30 MB budget per board, oldest autosaves trimmed first, saved versions capped and deletable

### P1: close table stakes and start the differentiator

- [x] **Per-element versions** for conflict handling: stamped edits and removals, tombstones, the same rule on server and client
- [x] **Property-level merging (CRDT):** a move and a recolor at the same time both survive, the same stacking order everywhere, removals remembered across the board closing, restores that win over edits in flight
- [x] **Bring to front, send to back, and step forward or backward:** buttons on the selection panel and Ctrl/⌘ + ] / [ (with Shift for front and back). A move only changes the element's stacking key, so it merges with other people's edits and undoes on its own
- [x] **Sticky notes and frames:** notes whose writing wraps and shrinks to fit; named frames that move, copy and delete with what's inside them. The Kanban and Retrospective templates use them
- [x] **Connectors that stay attached:** arrows and lines attach to the shapes, notes, pictures and text they start or end on, follow them on every screen, and can be reconnected by dragging an end. Connection dots on a hovered shape, straight, curved or elbow routes, arrowheads at one end or both, and labels. The Flowchart and Brainstorm templates use them
- [ ] **Headline differentiator** (pick one from section 9; suggested: suggest-mode links)
- [ ] Notify collaborators when an owner trashes a board (S)
- [ ] Link password and expiry (S-M); request-access flow (S-M)
- [ ] "Make a copy" for viewers and editors (S)
- [ ] Reactions and comment pins for link viewers (S-M)

### P2: growth and niches

- [ ] Replay and shareable timelapse (M)
- [ ] Presentation mode from frames; laser pointer (M)
- [ ] Live read-only embed (S)
- [ ] Math-first board: LaTeX elements (S-M)
- [ ] Public API and MCP server (M)
- [ ] Mermaid import (M) and export (M-L)
- [ ] AI prompt-to-board with a bring-your-own-key option (M)
- [ ] Classroom mode (L)
- [ ] Shape recognition on pen strokes (M)
- [ ] Timer, voting, private mode (S-M each)
- [ ] Accessibility: keyboard-only drawing, an outline view of a board (M)
- [ ] Large-board performance: viewport culling, spatial index (L)

### Parked (decided not to do, for now)

- Enterprise features: SSO, data residency, advanced admin.
- End-to-end-encrypted boards: conflicts with per-user roles, invites and server-side features.
- A 5,000-template library.

---

## 11. Open decisions

1. **Which headline differentiator first?** (section 9: A suggest-mode links, B replay, C classroom, D math, E API and MCP). Suggested: A, then B.
2. **Where do image files live?** *Decided 2026-10-07: MongoDB GridFS for now; R2 and Cloudinary are written up in `docs/image-storage.md` for later.* The Atlas free tier is 512 MB shared with all board data, so revisit when the database passes about 300 MB. Access control can start with long random file URLs that only people who can open the board will see; the trade-off is that a copied URL keeps working after a board becomes restricted. Signed short-lived URLs are the stricter alternative.
3. **Merge and deploy:** *Done 2026-10-07: account features, resize and rotate, and images are on `main`, and the OAuth keys are set on the server.* Real Google and GitHub sign-ins worked on 2026-10-08.
4. **Per-person versus owner trash:** keep "owner trash hides the board for everyone" (with notifications), or switch to Overleaf and Canva's per-person trash?
5. **Browser end-to-end tests:** *Decided 2026-10-08: not in CI for now.* CI keeps to the server and client tests; UI flows are checked by hand in a browser when they change.
6. **Free-tier promise:** commit to unlimited boards for free? Check hosting and storage costs first.
7. **Email verification:** *Decided 2026-10-08: the lighter version, through Brevo* (no domain needed to start; Resend would need one). Accounts work before verifying; invites by email need a verified address. Password reset came with it. Both stay off until the Brevo settings are added (waiting on a dedicated sender address).
8. **Version history limits:** *Decided 2026-10-07: a 30 MB budget per board, with the rules in the decision log.* Revisit the numbers (`VERSION_LIMITS` in `server/src/services/versions.js`) once real boards show how big histories get.

---

## 12. Evidence quality and caveats

- **User-complaint evidence is thin on Reddit and Hacker News.** Searches surfaced almost no actual threads, so Part 6 leans on vendor community "ideas" boards, review aggregators and education blogs. No quotes are used.
- **Pages that blocked or failed to load:** Canva help, Lucid pricing, parts of Miro and Mural help, Apple Freeform help bodies, FigJam help, tldraw's pricing page. Those entries rest on secondary sources or search snippets.
- **Several figures are single-source** (for example the Canva AI credit pools, Lucid prices, Milanote pricing). Treat them as indicative.
- **Competitor-authored comparisons** (Miro, Balsamiq, Collaboard, Mockflow and similar) were used as pointers only.
- **Unverified in any product:** handwriting-to-text and handwriting-to-math; whether Miro's MCP server is free or paid; whether Miro and FigJam presentation, timer and voting are free.
- **Dates conflict** on Microsoft Whiteboard's retirement across sources; use Microsoft's own pages.

---

## 13. Sources

Grouped by topic. Fetched during the 2026-10-06 research; pages may have changed since.

**Platforms and pricing**
- Miro pricing: https://miro.com/pricing/ and what's new (May 2026): https://miro.com/blog/whats-new-may-2026/
- Miro link access: https://help.miro.com/hc/articles/360017730813; password expiry limits: https://community.miro.com/ideas/public-link-password-expiration-minimum-time-limit-17856
- Miro MCP launch: https://miro.com/newsroom/miro-launches-mcp-server-to-connect-visual-collaboration-with-ai-coding/
- Figma pricing: https://www.figma.com/pricing/; FigJam open sessions: https://help.figma.com/hc/en-us/articles/4410786053911
- Mural pricing: https://www.mural.co/pricing
- Microsoft Whiteboard retirement: https://support.microsoft.com/whiteboard/retirement-standalone-microsoft-whiteboard-apps and https://www.windowscentral.com/software-apps/microsoft-whiteboard-is-not-shutting-down-but-you-still-may-lose-access-next-month
- Jamboard shutdown: https://support.google.com/jamboard/answer/14084927
- Apple Freeform sharing: https://support.apple.com/guide/freeform/frfma5307056b

**Lightweight tools**
- Excalidraw+ pricing and roadmap: https://plus.excalidraw.com/pricing, https://plus.excalidraw.com/roadmap
- Excalidraw end-to-end encryption: https://plus.excalidraw.com/blog/end-to-end-encryption
- Excalidraw collaboration design: https://plus.excalidraw.com/blog/building-excalidraw-p2p-collaboration-feature
- Excalidraw releases (multiplayer undo, Mermaid security fix): https://github.com/excalidraw/excalidraw/releases
- tldraw license: https://tldraw.dev/community/license; sync docs: https://tldraw.dev/docs/sync; features: https://tldraw.dev/features
- draw.io real-time collaboration: https://www.drawio.com/blog/real-time-collaboration-diagrams
- Whimsical pricing: https://whimsical.com/pricing; Eraser pricing: https://www.eraser.io/pricing; AFFiNE pricing: https://affine.pro/pricing
- JSON Canvas: https://obsidian.md/blog/json-canvas/; Nextcloud Whiteboard: https://github.com/nextcloud/whiteboard

**Dashboard and sharing**
- Google Drive "Shared with me": https://support.google.com/drive/answer/2375057; trash and removal: https://support.google.com/drive/answer/2375102; link roles: https://support.google.com/drive/answer/2494822
- Figma file browser: https://figma-signup.helpjuice.com/using-the-file-browser/guide-to-the-file-browser; duplicate to drafts: https://help.figma.com/hc/en-us/articles/360047512294
- Overleaf archive, trash and leave: https://docs.overleaf.com/managing-projects-and-files/archiving-deleting-and-leaving-projects; tags: https://docs.overleaf.com/managing-projects-and-files/organizing-projects-with-tags.md; sharing: https://docs.overleaf.com/collaborating/sharing-a-project.md
- Miro restore and trash: https://help.miro.com/hc/articles/360017572614
- Notion sharing: https://www.notion.com/help/sharing-and-permissions; trash: https://www.notion.com/help/duplicate-delete-and-restore-content

**Feature gaps and user pain points**
- Miro requests: math expressions https://community.miro.com/ideas/math-expressions-96; timelapse https://community.miro.com/ideas/time-lapse-recording-of-activity-on-board-2065; frame permissions https://community.miro.com/ideas/different-permissions-for-different-frames-8322; contributor role https://community.miro.com/ideas/new-role-contributor-can-only-edit-their-content-10814; classroom vandalism thread https://community.miro.com/ask-the-community-45/classroom-management-unruly-students-vandalising-each-others-work-what-to-do-3243
- Miro Live Embed (view-only): https://developers.miro.com/docs/miro-live-embed-view-only-mode
- FigJam "limit students to one section": https://forum.figma.com/ask-the-community-7/limit-students-to-one-section-25896
- LearnBoard: https://alternativeto.net/software/learnboard/about
- interviewing.io replayable whiteboard: https://interviewing.io/blog/building-interviewing-ios-collaborative-replayable-whiteboard
- Whiteboard.fi limits: https://support.whiteboard.fi/is-there-a-limit-on-how-many-students-can-join
- FigJam screen-reader support: https://www.figma.com/blog/announcing-figjam-screen-reader-support/
