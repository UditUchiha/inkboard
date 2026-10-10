# Code review issues

A full review of every commit from `704f1f3` to `dcbd5da` (branch `connectors`, 2026-10-09), checked against the code at `dcbd5da`. At review time all 343 tests passed, Prettier was clean, the build worked and `npm audit` found nothing, so everything below is something the tests don't catch.

**How to use:** tick the box when an issue is fixed, and note the commit next to it. Work top to bottom: Critical and High first.

**Confidence:** *Reproduced* means a script or browser run showed it happening. *Verified* means confirmed by reading the code. *Plausible* means the code path exists, but the impact depends on timing or the environment.

| Severity | Count | Meaning |
| --- | --- | --- |
| Critical | 5 | Takes the server down, loses saved work, or lets someone take over an account |
| High | 7 | Breaks a feature in production or loses work in a common situation |
| Medium | 58 | Real bugs, security gaps or performance problems with a narrower trigger |
| Low | 79 | Edge cases, polish, docs, tests and maintainability |

### Second review of the fixes (2026-10-10)

A strict review of the uncommitted fixes found that some fixes were incomplete or introduced new bugs. All of them are now fixed (uncommitted), each with a regression test. After the follow-up, 656 tests pass, lint and Prettier are clean, and the build works.

- **Must-fix**
  - **M57:** big changes are sent in pieces. A second piece-group used to drop the first one, a delete made mid-upload was overwritten when the upload landed, and leaving the board mid-upload lost the rest. Now the client sends nothing new until a group's last piece is acked, and drains the whole group before `board:leave`. Held groups expire after 60 s and are capped per sender and in total.
  - **H1:** undo couldn't clear an old connector's label, route or start head. `withDefaults` now backfills those fields at stamp [0,0] in `cleanElement`, on board load and on restore. The store sends undo-to-default as an explicit value.
  - **C5:** the takeover still worked if the victim clicked the verify link. The verify link now needs a login to that account.
  - **L54:** the board title renamed itself back after someone else's rename. It now saves only text the person actually typed.
  - The dashboard crashed when site storage was blocked. Storage is now read inside the `try` in `useStoredState`.
- **Medium**
  - A quick join/leave/join could put a socket in two rooms. Join, leave and disconnect now run one at a time per socket, events carry `boardId`, and the client ignores other boards' events.
  - **M35:** connection dots now show on hover, and you can start a second arrow from a side that already has one.
  - A missed pointerup could leave the canvas ignoring the mouse until reload. Stale pointers are now dropped, and `lostpointercapture` is handled.
  - The picture cache no longer reloads pictures that are on screen.
  - **M49:** a chunk-load failure after a deploy now reloads the page once.
  - **H6:** retrying a guest save no longer creates a duplicate board.
  - **M9:** the login limit is keyed on email+IP, so a stranger can't lock the owner out.
  - **M2/M10:** connecting a provider uses a confirm step on the Settings page instead of a third-party cookie.
  - `APP_URL` falls back to `RENDER_EXTERNAL_URL` and is declared in `render.yaml`.
- **Previously partial, now complete**
  - **M25:** the space quota counts boards, versions and templates; it is serialized per owner and covers drawing (`ownerFull`). The version budget is a hard limit.
  - **L2:** the client pages notifications with the server's `next` cursor.
  - **L5:** the purge claims a board with `purgingAt` before deleting anything, and restore refuses a board being purged.
  - **M30:** the image sweep now runs outside the request.
  - **M1:** there's a "Log out everywhere" option.
  - **M7:** the OAuth callback has an offline state with a retry, and keeps `next`.
  - **L30:** a logout clears the stored token only if it is still this tab's.
  - The rest: M12, M16, M36, M38, M39, M41, M42 (following a follower), L33, L37, L41, L44, L51, L60, L65, L66, L69.
- **Low:** elbow routing around turned shapes, handle-drag threshold, tiny elbow arrowheads, the `Intl.Segmenter` fallback, the error screen after a delete or revoke, the email budget kept for resets, legacy-bcrypt timing, the open redirect via `/\`, notifications marked read when the menu unmounts, previews loaded only in grid view, the Vite `codeSplitting` option, the image stream answering 500, and the invite message for a trashed board.

### Third review (2026-10-10)

A review of the second-round fixes found the items below. All are fixed (uncommitted), each with a regression test. After this round, 718 tests pass, lint, Prettier and the build are clean, and the main flows were checked in a browser.

- **High**
  - **C5, again (login CSRF):** `/auth/callback#token=` adopted any token, so a victim could be logged into the attacker's account and verify it. OAuth sign-in now ends with a short-lived single-use code, which is traded for a token only by the tab holding the matching `bind` secret. Tokens never appear in URLs. The verify page also shows which account is signed in and offers to switch accounts when the link is for a different one.
- **Medium**
  - **Two sessions for one board:** a board ID with upper-case hex created a second session and room, so one person's saves overwrote the other's. Every session, room and event now uses the ID as the database spells it.
  - **Autosaves blocking drawing:** autosaves counted toward the owner's 100 MB, which eventually refused all drawing. Automatic history is now excluded from the owner quota; it is bounded by the per-board history budget.
  - **Named versions refused:** a named version could be refused on a board that had none. Saving one now pushes out autosaves.
  - **Skipped autosaves:** they are now logged.
  - **Trash sweep:** it no longer scans every board; it uses a partial index on `purgingAt`.
  - **Picture cache leak:** detached canvases (dashboard previews, PNG exports) were never released.
  - **`APP_URL` fallback:** the fallback to Render's own URL broke custom domains. It now applies to email links only.
- **Low**
  - **Sync:** reconcile now applies the server's copy one field group at a time; "rate" retries back off; the owner-space figure is shared per owner, looked up at join and refreshed before a refusal; tabs that haven't been updated stop retrying on `ownerFull`.
  - **Data:** a purge that loses to a restore returns 409, and no versions are left behind after a board is permanently deleted.
  - **Auth:**
    - The legacy-bcrypt timing is now a rolling minimum, clamped.
    - An explicit logout always ends this tab.
    - `#connect` survives a session lapse.
    - Verify-page dead ends are fixed, and its offline state offers a retry.
    - Settings no longer darkens custom colours.
    - The test loader uses Vite's public `transformWithOxc`.
  - **Canvas:**
    - Shift-resizing a flat stroke behaves.
    - Stuck touch entries are cleared.
    - A press on an arrow beside a dot selects the arrow.
    - The danger button keeps its contrast on hover.
    - The landing demo accepts finger drawing again.
    - The ctrl+wheel listener is scoped to the board.
    - One hit-scan per pointer move.
  - **UI:**
    - Popover focus is restored only from inside the popover.
    - An empty notifications page with `more` keeps "Show older".
    - Focus moves to a list item after the last page loads.
    - Automatic chunk reloads are capped at 2 every 5 minutes.

---

## Critical

- [x] **C1 · One request can freeze the server (email regex ReDoS)** - **Done** (uncommitted): email length capped at 254 and the pattern made unambiguous; ReDoS regression test
  - Where: `server/src/controllers/auth.controller.js:14`, used by register (:51) and forgot-password (:163)
  - Introduced: 704f1f3
  - Problem: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` backtracks quadratically, because `[^\s@]` also matches `.`. Nothing caps the email's length, and `express.json` accepts 2 MB.
  - Repro: `POST /api/auth/register` with `email = "a@" + ".".repeat(80000) + "@"` blocks the event loop for about 8 s. A 2 MB body blocks it for hours. HTTP, sockets, saves and health checks all stop.
  - Fix: reject `email.length > 254` before the regex, and use a pattern without the ambiguity, e.g. `/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/`.
  - Confidence: Reproduced (20k chars → 466 ms, growing quadratically)

- [x] **C2 · Every deploy (SIGTERM) can lose edits that haven't been saved yet** - **Done** (uncommitted): keeps each save as a promise on the session; flush/close await it; shutdown flushes, disconnects, flushes again under a 20 s deadline (closeRealtime)
  - Where: `server/src/index.js:34-37`, `server/src/realtime/sessions.js:260-296`
  - Introduced: 704f1f3
  - Problem: `io.close()` disconnects every socket. Each emptied room then calls `closeSession` → `persist`, which sets `dirty=false` and starts a write nobody awaits. `flushAllSessions()` then finds every session clean and returns at once, and `mongoose.disconnect()` cuts off the writes still in flight.
  - Repro: join, send an op, run the shutdown sequence. The log says "Cannot use a session that has ended" and the database has 0 elements. The clients had already been told `ok:true`.
  - Fix: keep the in-flight save promise on the session, and have `persist`, `closeSession` and `flushAllSessions` await it, then save again if still dirty. Flush before `io.close()` and add a shutdown deadline.
  - Confidence: Reproduced

- [x] **C3 · Re-joining a board rebuilds it from a stale database read and loses recent edits for good** - **Done** (uncommitted): join reads elements only after leaving (acquireSession); joining the board you are already on is a plain re-sync
  - Where: `server/src/realtime/index.js:118-125`
  - Introduced: 704f1f3
  - Problem: `findBoardForViewing` reads `board.elements` *before* `await leaveBoard(socket)`. If this socket is the board's only user, `leaveBoard` saves and deletes the session, and `openSession` then rebuilds it from the stale read. The client re-joins the same board on `tooLarge` (useBoardSync.js:66) and when editing is lost (:183). The same thing happens when B joins just as A, the last user, leaves.
  - Repro: an op adds "fresh", then the same socket joins the same board again. The join reply is `[]`, and after the next save the database no longer has "fresh".
  - Fix: use `getSession(boardId)` when a session exists, and read elements only after leaving. Make a join to the board the socket is already on a plain re-sync, not leave-and-rejoin.
  - Confidence: Reproduced

- [x] **C4 · Joining just as the last person leaves leaves the joiner with no session; every edit they make is refused forever** - **Done** (uncommitted): a session being closed is only deleted once saved and not re-held; join holds it in the same turn it joins the room; board:op says noSession otherwise
  - Where: `server/src/realtime/sessions.js:280-285`, `server/src/realtime/index.js:122-126, 156-159`
  - Introduced: 704f1f3
  - Problem: `closeSession` awaits `persist` and only then deletes the session. A join that lands in between gets the dying session, which is then deleted. `board:op` finds no session and replies `ok:false`, and the client re-queues every 400 ms.
  - Repro: B joins as A disconnects. B's later ops were refused in 11 of 30 tries.
  - Fix: mark the session closing (or delete it) before awaiting `persist`, and re-check the room size afterwards. Or have `board:op` and `board:join` reopen a missing session.
  - Confidence: Reproduced

- [x] **C5 · Someone who registers your email first keeps access even after you reset the password (pre-account takeover)** - **Done** (uncommitted): providers can't be linked until the email is verified (when email is on); a reset, or a verification of an account with providers, unlinks them and revokes sessions
  - Where: `server/src/controllers/oauth.controller.js:222-234` (`connectProvider`), `server/src/controllers/auth.controller.js:179-191` (`resetPassword`)
  - Introduced: 9482d14 / 569fa83
  - Problem: an unverified account can link Google or GitHub. A password reset proves the address belongs to the person resetting, yet it neither removes providers linked before verification nor revokes tokens already issued.
  - Repro:
    1. The attacker registers victim@corp.com and links their own GitHub.
    2. The victim can't sign up (409), so they use Forgot password, and the account becomes verified.
    3. The attacker signs in with GitHub and sees every board shared with victim@corp.com.
  - Fix: refuse provider linking until `emailVerified`. When a reset or verification succeeds on an unverified account, unlink every provider and revoke all sessions (see M1).
  - Confidence: Verified

## High

- [x] **H1 · Moving a connector while someone labels it deletes the label (also its route, arrowheads and font)** - **Done** (uncommitted): a copy lacking a property group no longer wins it in mergeElement; connectors and template arrows now also carry text
  - Where: `shared/src/board-merge.js:120-126` (`groupStamps`), `:168-186` (`mergeElement`/`copyGroup`); `client/src/features/board/elements.js:85-90`; `client/src/features/templates/builtin.js:38-52`
  - Introduced: 2aa9493, made worse by dcbd5da
  - Problem: when a copy of an element lacks a property group, that group counts as stamped with the copy's newest stamp. Connectors are created without `text`, and older or template arrows have no `route`, `font` or `startHead`, so a concurrent move "wins" the missing group and `copyGroup` deletes the field.
  - Repro: A labels an arrow while B drags it. The label was lost 200 times out of 200, everywhere.
  - Fix: treat a group that is missing and not in `stamps` as stamp `{0,0}`. Clearing a field must then keep it present (e.g. `""`). Also create connectors and template arrows with every optional field set.
  - Confidence: Reproduced

- [x] **H2 · No drag threshold: a click with 1px of jitter detaches a connector from both shapes** - **Done** (uncommitted): a press moves, draws or lets go of connectors only after 4 screen px of travel (`hasDragged`); shapes are made on the first real drag
  - Where: `client/src/features/board/BoardCanvas.jsx:340-351, 446-452`; `client/src/features/board/connectors.js:277-285` (`readyToMove`)
  - Introduced: 704f1f3 (no threshold), made destructive by e02a5cc
  - Problem: pointer-down always starts a move, and `readyToMove` already lets go of the connector's ends. The first pointermove of any size commits it. A pen tap counts too. Clicking empty space inside a frame re-sends every element in it. Every jittery click also adds an undo step and a broadcast.
  - Fix: start the move only after 3–4 screen pixels of travel (divided by zoom), and release connectors only once the drag has really begun.
  - Confidence: Reproduced

- [x] **H3 · Going from one board to another in the same tab reuses the editor and sync state; unsent edits can go to the wrong board** - **Done** (uncommitted): BoardPage keys the editor by boardId; the sync queue (new outbox.js) is reset on a board change and late acks are ignored; tests in outbox.test.js
  - Where: `client/src/pages/BoardPage.jsx:21, 79`; `client/src/features/board/useBoardSync.js:30-35, 114-117, 200-205`; `BoardEditor.jsx:270-276`; `NotificationsProvider.jsx:53`
  - Introduced: 704f1f3 / 903aaea / 1eb9b60
  - Problem: `/board/A` → `/board/B` (a notification's Open button, back/forward) keeps BoardPage and BoardEditor mounted. `pending`, `loaded`, `lastSent`, phase, meta, role and `fitted` all carry over. If A had unsent edits, `rejoin(B, pending)` merges them into B and sends them, which can copy private content into a shared board. B also shows A's title and role and is never fitted to its content.
  - Fix: `<BoardEditor key={boardId}>`, or key BoardPage by boardId. Reset the sync refs when boardId changes, and ignore late ack callbacks from the old board.
  - Confidence: Verified

- [x] **H4 · Importing a board file loses every picture in production** - **Done** (uncommitted): pictures are decoded from data URLs without fetch (boardFile.dataUrlToBlob), so the CSP no longer matters; tests in export-import.test.js
  - Where: `client/src/features/board/BoardEditor.jsx:431` (`fetch(dataUrl)`), `server/src/app.js:36-43` (CSP)
  - Introduced: 067a7d8
  - Problem: helmet's CSP sets no `connect-src`, so `fetch("data:…")` is blocked by `default-src 'self'`. The error is swallowed and every picture counts as missing. Vite's dev server sends no CSP, so it only breaks when deployed.
  - Fix: decode the data URL without `fetch` (`atob` → `Uint8Array` → `Blob`), or add `connect-src 'self' data:`.
  - Confidence: Reproduced in Chromium

- [x] **H5 · Clicking the canvas never takes focus away from inputs** - **Done** (uncommitted): pointer-down blurs the focused field; `isTypingTarget` only counts text-like inputs
  - Where: `client/src/features/board/BoardCanvas.jsx:518` (`onMouseDown preventDefault`), `:300-304`; `BoardEditor.jsx:67-68, 567`
  - Introduced: 704f1f3
  - Problem: because mousedown is prevented, the board title, frame Name field or color input keeps focus. Backspace meant for a selected shape deletes title characters, and those are saved on the next blur. Typing in a frame's Name field and then clicking another frame renames that frame. After a custom color pick, every shortcut stops working.
  - Fix: in handlePointerDown, blur `document.activeElement` whenever it isn't the canvas. Narrow `isTypingTarget` to text-like inputs.
  - Confidence: Verified

- [x] **H6 · A guest drawing over 2 MB can never be saved, and the person is stuck** - **Done** (uncommitted): a drawing too big for one request is uploaded in pieces (scratchImport.js: first part by POST, the rest over the socket, resumable), and a failed save offers Back to the drawing; tests in scratch.test.js
  - Where: `client/src/pages/DrawPage.jsx:61-75, 105-110`; `server/src/app.js:45` (`express.json({limit:"2mb"})`)
  - Introduced: 903aaea / 1eb9b60
  - Problem: the scratch board allows up to 5000 elements and about 5 MB of localStorage, but `ImportScratch` sends it all in one `POST /boards`. The server answers 413 and "Try again" fails every time. A signed-in person is always sent to `ImportScratch`, so they can't see or export the drawing again.
  - Fix: enforce the byte limit in the scratch editor, or upload in pieces over the socket. Let the person get back to the scratch editor when the import fails.
  - Confidence: Verified

- [x] **H7 · Once the guest's localStorage is full, later drawing is silently lost, and Save board uploads the old copy** - **Done** (uncommitted): the tab's live drawing is kept apart from localStorage and is what gets uploaded; a full browser keeps warning (every 20 s) and the status shows Not saved
  - Where: `client/src/features/board/scratch.js:26-33, 62-69`; `client/src/pages/DrawPage.jsx:61`
  - Introduced: 903aaea
  - Problem: after one "Save your board" toast, every failed write is silent. `ImportScratch` reads `readScratch()` from localStorage, not the live store.
  - Fix: pass the live elements to the import step (a module-level hand-off or sessionStorage), stop drawing or keep warning while storage is full.
  - Confidence: Verified

## Medium

### Security and auth

- [x] **M1 · Sessions can't be revoked** - **Done** (uncommitted): JWT carries tokenVersion, checked by requireAuth and socket auth; password change/reset bump it, return a fresh token and close the user's sockets; setting a first password and linking need a login under 15 min old
  - Where: `server/src/lib/tokens.js:4-10`, `server/src/middleware/auth.js:10`, `server/src/realtime/index.js:69`, `auth.controller.js:107-120, 179-191`
  - Introduced: 704f1f3
  - Problem: the JWT holds only `sub`. Password change, reset and logout leave every token valid for 7 days, and open sockets stay connected. A stolen token can link a provider, or set a first password on an OAuth-only account, without signing in again.
  - Fix: put `tokenVersion` on User and in the JWT, check it in `requireAuth` and socket auth, bump it on password change or reset, and disconnect `user:<id>` sockets. Require a fresh login before linking a provider or setting a first password.
  - Confidence: Verified

- [x] **M2 · Account-linking CSRF** - **Done** (uncommitted): link cookie set by the authenticated POST must match the ticket at the start of the flow
  - Where: `server/src/controllers/oauth.controller.js:137-176, 207-211`
  - Introduced: 9482d14
  - Problem: the link ticket is a bearer value in a GET URL and isn't tied to the browser that asked for it. An attacker sends their own link URL; the victim clicks it, picks their Google account, and the victim's Google id is attached to the attacker's account. The victim's next "Continue with Google" logs them into the attacker's account.
  - Fix: set the state cookie from the authenticated POST and require it in the callback, or make the ticket single-use and bound to that cookie.
  - Confidence: Verified

- [x] **M3 · The OAuth link ticket works as a full login token, and it travels in a URL** - **Done** (uncommitted): tokens now carry an aud (session / oauth-link / oauth-state), only session tokens log in, HS256 pinned; old tokens without aud still work
  - Where: `oauth.controller.js:139-142`, `middleware/auth.js:10`, `realtime/index.js:69`
  - Introduced: 9482d14
  - Problem: every JWT shares one secret, and `verifyToken` accepts any token with a `sub`. The `{purpose:"oauth-link"}` ticket passes `requireAuth`, and being in a query string it lands in logs and browser history.
  - Fix: add `typ`/`aud` claims and accept only session tokens for auth; pin `algorithms:["HS256"]`.
  - Confidence: Reproduced

- [x] **M4 · Reset and verification links can be pointed at another site through the Host header when APP_URL is unset** - **Done** (uncommitted): production refuses to start with email on and no APP_URL
  - Where: `server/src/lib/app-url.js:4, 11-15`; used at `auth.controller.js:62, 146, 167`
  - Introduced: 569fa83
  - Problem: the link base is built from `req.get("host")`. A forgot-password request with `Host: evil.example` sends the victim a genuine email whose link carries the reset token to evil.example.
  - Fix: require `APP_URL` in production whenever email is configured, or allow-list hosts.
  - Confidence: Verified (whether it's exploitable depends on the host)

- [x] **M5 · Without NODE_ENV=production, tokens are signed with a public default secret** - **Done** (uncommitted): built-in secret only for NODE_ENV development/test, 32-byte minimum otherwise, loud warning; npm run dev sets development
  - Where: `server/src/config/env.js:10-19, 31-32`
  - Introduced: 704f1f3
  - Problem: any start without `NODE_ENV=production` (Docker, a VPS, a hand-made Render service) silently uses `"local-development-secret"`, so anyone can forge a token for any user. The same flag also turns off `trust proxy`, the CORS lock-down and the email-link log redaction. In production a weak secret is accepted.
  - Fix: allow the fallback only in explicit dev/test, require at least 32 bytes, and log a loud warning.
  - Confidence: Verified

- [x] **M6 · The CSP blocks Google and GitHub profile photos in production** - **Done** (uncommitted): img-src allows Google and GitHub photo hosts; CSP header test
  - Where: `server/src/app.js:40` (`img-src 'self' data: blob:`)
  - Introduced: 9482d14 / 07ee635 (avatars added); a9ee98a (img-src rewritten without them)
  - Problem: `Avatar` quietly falls back to initials, so the README's "your photo appears on your avatar" never works when deployed.
  - Fix: add `https://*.googleusercontent.com https://avatars.githubusercontent.com` to `img-src`, and add a CSP header test.
  - Confidence: Verified

- [x] **M7 · The OAuth callback page always goes through /login with an error and loses `next`** - **Done** (uncommitted): adoption is tracked, so anonymous before adoption shows the loader instead of redirecting; failure goes to /login?error=incomplete
  - Where: `client/src/pages/OAuthCallbackPage.jsx:21-30`
  - Introduced: 07ee635
  - Problem: on the first render the status is still "anonymous", so `<Navigate to="/login?error=…">` runs before the parent effect calls `adoptToken`. The person sees a flash of "Sign-in didn't finish" and lands on /boards, losing deep links and the guest "save your drawing" flow.
  - Fix: adopt the token before the first render (state initialiser or layout effect), or only treat "anonymous" as a failure after adoption has been tried.
  - Confidence: Verified (from the component and react-router source)

- [x] **M8 · Removed collaborators keep receiving comment excerpts and current board titles** - **Done** (uncommitted): reply notifications go only to people who can still open the board; the list and unread count hide notifications about boards they can't open
  - Where: `server/src/controllers/thread.controller.js:81-88` (`notifyAbout`); `notification.controller.js:6-15`
  - Introduced: 9482d14
  - Problem: reply notifications go to every past author in the thread with no access check, and carry a 140-character excerpt. `listNotifications` shows the board's *current* title on old notifications.
  - Fix: filter recipients with `roleOf(board, id)`, and hide titles and excerpts for boards the user can no longer open.
  - Confidence: Reproduced

- [x] **M9 · One per-IP limiter covers every auth route, and `trust proxy = 1` may be wrong on Render** - **Done** (uncommitted): separate limiters per route, per-email limits on login and forgot-password, failed-only login counting, daily email cap, TRUST_PROXY setting; Render hop count still to be checked on the live service
  - Where: `server/src/routes/auth.routes.js:23-44`; `server/src/app.js:33`
  - Problem:
    - 30 actions per 15 minutes are shared across login, register, reset, verify and every OAuth start, so people behind one office or school NAT lock each other out.
    - There is no per-account login throttle.
    - One IP can request a reset every minute, which can exhaust the Brevo daily quota.
    - If Render adds more than one proxy hop, every user shares one bucket.
  - Fix: separate limiters per route; per-account or per-email limits on login and forgot-password; a daily email cap; check `req.ips` on Render once.
  - Confidence: Verified (limiter) / Plausible (proxy hops)

- [x] **M10 · OAuth can't work in the documented split deployment (VITE_API_URL + CLIENT_ORIGIN)** - **Done** (uncommitted): API_URL separated from APP_URL; redirects into the app use clientUrlFor
  - Where: `server/src/lib/app-url.js:4`; `oauth.controller.js:104, 181, 211, 215`
  - Problem: `appUrlFor` is used both for the provider redirect_uri (which must be the API host) and for the post-login redirect (which must be the client host).
  - Fix: separate `API_URL` from `APP_URL`, and use `clientUrlFor` for redirects into the app.
  - Confidence: Verified

### Sync and data integrity

- [x] **M11 · Elements past the 5,000 cap are acknowledged `ok:true` but silently dropped** - **Partly done**: client side done: the store refuses new elements past 5,000 (with a toast) before sending, and ack 'dropped' ids are removed locally. Server side is sync-server's - **Done** (uncommitted): ack carries dropped:[ids] for elements left out by the cap or refused (client check of the cap is editor-shell/canvas-store)
  - Where: `shared/src/board-merge.js:299-304`; `server/src/realtime/index.js:169-172`
  - Introduced: 2aa9493
  - Problem: the sender keeps seeing elements nobody else has, and they disappear on reload. The client only checks the cap on file import.
  - Fix: return `tooLarge` or `dropped:[ids]`, and check the cap on the client too.
  - Confidence: Reproduced

- [x] **M12 · The tombstone cap also trims memory; removals of made-up ids push real tombstones out, so deleted elements come back** - **Partly done**: client side done (client keeps at most 5000 tombstones, oldest dropped); server side is sync-server's - **Done** (uncommitted): server no longer makes tombstones for unknown ids (planOperation remember:false), saved cap raised to 5000 and applied only to the saved list, memory cap 50k, max 5000 entries per op
  - Where: `server/src/realtime/sessions.js:73, 101-114`; `shared/src/board-merge.js:224-230`; `client/src/features/board/store.js:77`
  - Introduced: 2aa9493
  - Problem: any editor, including an edit-link guest, can remove 2,000 fake ids and evict every real tombstone. Clearing a 3,000-element board loses 1,000 tombstones on the next save. Clients also keep every tombstone forever.
  - Fix: don't make tombstones for ids the board never had; apply the count cap only to the saved list; cap removals per op.
  - Confidence: Reproduced

- [x] **M13 · A forged `version = MAX_VERSION` freezes an element; a later restore writes invalid stamps** - **Partly done**: client side done (stamps never go past `MAX_VERSION`); server side is sync-server's - **Done** (uncommitted): server re-stamps versions more than 1,000,000 ahead of the board; restore/fresh stamps capped at MAX_VERSION
  - Where: `shared/src/board-merge.js:71-74` (`<= MAX_VERSION`); `element-rules.js:173`; `operations.js:402-408` (`restoreOver` +1000); `sessions.js:75-88`; `store.js:58-62`
  - Introduced: 11c53f5
  - Problem: the next edit would be MAX+1, which counts as invalid (0), so it loses while still being acked `ok:true`. Restore stamps at MAX+1000, also invalid, and the server and clients diverge.
  - Fix: limit incoming versions to `newest + bound` or re-stamp on the server; keep restore leads under the cap; use one validator for everything.
  - Confidence: Reproduced

- [x] **M14 · Deleted elements come back through in-progress drags, edit commits, and undo/redo of moves** - **Done** (uncommitted): gestures stop for elements that are gone; `commit`/`undo`/`redo` skip elements someone removed unless the step itself removed them
  - Where: `BoardCanvas.jsx:438, 449, 464`; `store.js:110-121` (`stamp()` treats a missing element as returning and stamps it above the tombstone); `BoardEditor.jsx:616` (`store.getElement(id) ?? element`)
  - Introduced: b632452 / 2aa9493 with gesture code from 704f1f3, ef32f3d, dcbd5da
  - Problem / repros:
    - A drags a shape while B deletes it: the next pointermove brings it back for everyone.
    - A is typing in a note while B deletes it or its frame: when A blurs, the note reappears.
    - B deletes a shape A had moved; A presses undo: the shape is back.
  - Fix: check `store.getElement(id)` before each `apply` in gestures and in commit, and cancel if it's gone. In undo/redo, skip elements that are tombstoned and weren't removed by that step.
  - Confidence: Reproduced

- [x] **M15 · Undo/redo of a delete overwrites other people's later edits to the connectors it released** - **Done** (uncommitted): history entries keep the state connectors were let go into (`undoBase`/`redoBase`) as the base for going back, so only the shape group is restored
  - Where: `client/src/features/board/store.js:198-205` (`attachingBack`), `:123-136` (`stamp()`)
  - Introduced: 64c0a8d / 4c6c378
  - Problem: the released connectors' `before` copies go into the undo step without a matching base, so `stamp()` re-stamps every group that differs. A deletes S (releasing arrow C), B relabels C and turns it red, A undoes: C's label and color go back to the old ones for everyone.
  - Fix: store `{before, after}` and use `after` as the base, or restore only the shape-group fields.
  - Confidence: Reproduced

- [x] **M16 · The server cleans elements but never sends the result back; long text retries forever** - **Partly done**: client side done: the ack's reason decides what happens (retry only noSession after re-joining, and rate; otherwise resync with a message), cleaned elements replace the author's copy (store.reconcile), editors have maxLength and commit cuts text like the server. Server side is sync-server's Editors (TextEditor.jsx, render-geometry): all three have `maxLength` and cut the value before committing (without leaving half an emoji). - **Done** (uncommitted): ack returns cleaned/dropped and a reason; client side (maxLength, retry policy) belongs to editor-shell
  - Where: `server/src/realtime/element-rules.js:79, 99, 112`; `useBoardSync.js:69-86`; `realtime/index.js:171` (`socket.to` skips the sender); TextEditor `NoteEditor` / `LabelEditor` (no `maxLength`)
  - Introduced: c2f91af / ef32f3d / dcbd5da
  - Problem: a text or note over 20,000 characters is refused (`ok:false`) and re-queued every 400 ms forever, visible only to its author. A label over 20k is cut on the server, but the author keeps the full text. Any other normalization diverges the same way.
  - Fix: `maxLength` in the editors and a cut before commit; send cleaned elements back in the ack; give `ok:false` a reason the client won't retry.
  - Confidence: Verified

- [x] **M17 · A malformed imported board file crashes the app (no ErrorBoundary), and the crash repeats on /draw** - **Done** (uncommitted): imports run through the shared element rules (bad elements are skipped and counted), placement is in try/catch, the saved scratch board is cleaned when read, and an ErrorBoundary wraps the app and the canvas
  - Where: `client/src/features/board/boardFile.js:299-302`; `BoardEditor.jsx:462` (`placeElements` outside try/catch); `renderer.js`; `scratch.js:57-65`
  - Introduced: 067a7d8
  - Problem: only `id` and `type` are checked. `{type:"pen"}` without points throws, `{type:"text", text:123}` throws, and a sticky without text throws during drawing. With no error boundary the page goes white, and on /draw the bad elements are saved to localStorage. On server boards the server drops them, so the importer's view diverges and the op retries forever.
  - Fix: share the server's element rules (move `element-rules.js` to `shared/`) and run imports through them; wrap the import in try/catch; add an ErrorBoundary around the canvas and the app.
  - Confidence: Reproduced (throws) / Plausible (white screen)

- [x] **M18 · A forged maximum stacking key breaks stacking for the whole board** - **Done** (uncommitted): isOrderKey refuses whole numbers over 13 digits; server key for a new element falls back to the top key if it could not be valid
  - Where: `shared/src/board-order.js` (`MAX_KEY_LENGTH`, `keyAbove`, `keyToMove`); `element-rules.js:168`; `operations.js:379-386`
  - Introduced: 2aa9493 / 1b9ff39
  - Problem: `"z" + "z"*26` passes `isOrderKey`. After about 365 new elements keys pass 100 characters; the server generates invalid keys, stacks diverge, new elements land mid-stack, and the layer buttons stop working board-wide.
  - Fix: refuse keys whose integer part is at the extremes, re-key on overflow, and validate keys the server generates.
  - Confidence: Reproduced

- [x] **M19 · Long pen strokes are re-sent whole every 40 ms; past 500 KB they fall into a "too large" resync loop** - **Done** (uncommitted): points rounded to 2 decimals, duplicates dropped, strokes split every 1000 points (canvas); now the flush delay grows with the longest queued stroke (outbox.flushDelay, up to +400 ms), so a growing stroke's traffic stays about constant
  - Where: `BoardCanvas.jsx:174-182, 438`; `useBoardSync.js:63-66, 93-95`; `server/src/realtime/operations.js:23`
  - Introduced: 704f1f3
  - Problem: every coalesced sample is kept as a full-precision double, and each flush re-sends the whole points array, so bandwidth grows O(n²). At about 12k points the server answers `tooLarge`, the client resyncs (which also hits C3) and the stroke is cut short, then the same thing repeats until pointerup. The scratch board has no cap, and `Math.min(...xs)` eventually throws.
  - Fix: round points to about 2 decimals, drop duplicates, cap points per stroke (start a new stroke at the cap), and send only new points or throttle.
  - Confidence: Verified

- [x] **M20 · Saves can overlap, and a closed session's retry can overwrite newer data** - **Done** (uncommitted): one save at a time per board; a closed or discarded session cancels its retry
  - Where: `server/src/realtime/sessions.js:255-278`
  - Introduced: 704f1f3
  - Problem: `markDirty` during a write schedules a second `updateOne` without waiting, so an older snapshot can land last. A failed save's retry timer survives `closeSession` and can later write the old session over a new one.
  - Fix: one save at a time per board, and cancel retries when the session closes.
  - Confidence: Plausible

- [x] **M21 · No rate limit on `board:op`, `cursor`, `viewport` or `viewport:request`** - **Done** (uncommitted): per-socket token buckets for board:op (reason rate), cursor, viewport, viewport:request
  - Where: `server/src/realtime/index.js:153-234`
  - Problem: any editor or guest can flood 3 MB ops. Each does O(n) work over a 5,000-element board and is broadcast to everyone.
  - Fix: per-socket rate and size limits.
  - Confidence: Plausible

- [x] **M22 · A version restore can be lost if someone opens the board at the same moment** - **Done** (uncommitted): replaceElements always goes through the open session (acquireSession/resetSession) and closes it again if nobody is on it
  - Where: `server/src/realtime/index.js:317-333` (`replaceElements`, no-session branch) with `board:join` at `:118-125`
  - Introduced: 9482d14
  - Problem: a join between the restore's read and its `updateOne` opens a session with the pre-restore elements, and the next save writes them back.
  - Fix: always restore through an open session (`resetSession`), or reload the session after the write.
  - Confidence: Plausible

- [x] **M23 · `POST /boards` skips the per-element and per-board byte limits** - **Done** (uncommitted): sanitizeElements enforces element and board byte limits (used by createBoard); strokes over 50,000 points are refused; saving a template runs the same sanitizeElements checks
  - Where: `server/src/controllers/board.controller.js:101`; `server/src/realtime/operations.js:47-59`
  - Introduced: 9482d14 / 74dd908
  - Problem: a 1.9 MB body with one 140k-point stroke is stored as a 5.2 MB element, which can then never be edited (`tooLarge`) and is copied into every version and template.
  - Fix: run the `elementBytes` / `MAX_BOARD_BYTES` checks in `createBoard` and for templates, and cap points in `cleanPoints`.
  - Confidence: Reproduced

- [x] **M24 · Concurrent invite or remove creates duplicate collaborators or returns a 500** - **Done** (uncommitted): invite is one atomic $addToSet and remove one $pull (second remove is a 404, not a 500); one notification per invite
  - Where: `server/src/controllers/board.controller.js:248-253, 273-274`
  - Introduced: 704f1f3
  - Problem: three simultaneous invites of the same email produce `['Ed','Ed','Ed']` and three notifications. Two simultaneous removes return `[200, 500]` (Mongoose `VersionError`).
  - Fix: invite with an atomic `updateOne({collaborators:{$ne:id}}, {$addToSet})`, remove with `$pull`, and map `VersionError` to 409.
  - Confidence: Reproduced

### Storage, performance and server load

- [x] **M25 · No per-account storage quota on the 512 MB database** - **Done** (uncommitted): per-owner board count (200) and byte (100 MB) quotas, 2 MB cap per template, templates listed as light previews, saved-version budget now counts the autosaves pruning always keeps, boards and invites rate-limited per user
  - Where: `board.controller.js:99-116`; `template.controller.js:16-46`; `services/versions.js:8-21`
  - Introduced: 9482d14 / 963cbd8
  - Problem: board creation is unlimited and not rate-limited. Each template can be a 12 MB board (30 allowed, so 360 MB per user). The 30 MB version "budget" is soft: about 78 MB is possible per board. `listTemplates` returns every template's full elements.
  - Fix: per-user byte and board quotas, a size cap per template, and list templates without their elements.
  - Confidence: Verified

- [x] **M26 · Every metadata, comment and version request loads the whole board** - **Done** (uncommitted): loadBoard selects -elements by default; elements load only via currentElements / { elements: true } (board GET, join, templates, versions)
  - Where: `server/src/services/boards.js:44-53` (`loadBoard` has no projection)
  - Introduced: 704f1f3
  - Problem: rename, star, invite, every thread and version route, and `board:join` pull up to 12 MB of elements just to check access.
  - Fix: select `-elements` by default and load elements only where they're needed.
  - Confidence: Verified

- [x] **M27 · Dashboard: list unpaginated; preview cache with no byte limit** - **Done** (uncommitted): previews cut text to 300 chars, drop sync stamps and the cache is bounded to 20 MB; the list now carries metadata only and previews load 24 at a time (GET /boards/previews) for the first 48 boards, with "Show more" (sort, search and section counts stay client-side over the full list, so behaviour is unchanged)
  - Where: `board.controller.js:38-61`; `server/src/services/previews.js:104-163`
  - Introduced: 21b4ec2 / d9c53f1
  - Problem: on a cold cache every listed board's full elements are streamed. Only pen strokes are thinned: text (up to 20k characters each) and sync metadata are sent whole. The cache holds 5,000 previews with no byte limit, which is risky on a 512 MB instance.
  - Fix: paginate; truncate text and strip metadata in previews; bound the cache by bytes, or store a preview when the board is saved.
  - Confidence: Verified

- [x] **M28 · Any account can fill the app-wide 300 MB of image space, and uploads have no rate limit** - **Done** (uncommitted): uploads are rate-limited per account (per board for guests, 30/min) and per network address (90/min, using TRUST_PROXY), accounts with an unconfirmed email get 20 MB instead of 100 MB once email is set up, and a warning is logged at 80% of total image space
  - Where: `server/src/services/images.js:129-138, 169-175`
  - Introduced: a9ee98a
  - Problem: three free accounts at 100 MB each block image uploads for everyone, and `board:image` can be sent back to back.
  - Fix: rate-limit per socket, IP and account; lower limits for new or unverified accounts; alert on total usage.
  - Confidence: Verified

- [x] **M29 · Uploads never check image dimensions (pixel bombs), and the small copy is supplied by the client** - **Done** (uncommitted): width/height read from the PNG/JPEG/GIF/WebP header; over 4096 px (or unreadable) is refused, a small copy over 512 px is dropped (the small copy is still client-made, but now checked)
  - Where: `server/src/services/images.js:149-158`; `server/src/realtime/index.js:91-95, 186-193`
  - Introduced: a9ee98a / d9c53f1
  - Problem: a 2 MB flat-color PNG can declare 30000×30000 pixels. Every viewer has to decode it, and the dashboard decodes the "small" copy.
  - Fix: read width and height from the header (PNG IHDR, JPEG SOFn, GIF, WebP) and reject anything over about 4096 px (about 512 px for the small copy), or make the small copy on the server.
  - Confidence: Plausible

- [x] **M30 · One global upload queue, with a full sweep in the request path** - **Done** (uncommitted): uploads queue per owner instead of globally, sweeps in the request path are debounced (30 s per scope), GridFS writes time out after 30 s
  - Where: `server/src/services/images.js:160-219`
  - Introduced: a9ee98a
  - Problem: `oneAtATime` covers the whole app, and each upload runs several aggregations. When a limit is hit, the sweep `$unwind`s every version of every board. One editor filling a board stalls uploads for everyone, and a hung GridFS write blocks the queue forever.
  - Fix: lock per owner or keep atomic counters; debounce sweeps and run them outside the request; add a write timeout.
  - Confidence: Plausible

- [x] **M31 · SVG export can produce a file that won't open** - **Done** (uncommitted): xml() strips control characters and lone surrogates
  - Where: `client/src/features/board/svgExport.js:22-23` (`xml()`)
  - Introduced: 067a7d8
  - Problem: control characters are kept. U+000B, which Word and PowerPoint put in pasted text, makes the SVG invalid XML.
  - Fix: strip `[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]` (or turn U+000B into a newline).
  - Confidence: Reproduced

### Editor, canvas, connectors and notes

- [x] **M32 · Elbow connectors route straight through both shapes in common layouts** - **Done** (uncommitted): elbow candidates now include lines just outside both shapes, and routes crossing a shape rank worst
  - Where: `client/src/features/board/routes.js:428-454` (`elbow`)
  - Introduced: dcbd5da
  - Problem: the only candidate middle lines are the midpoint and the min/max of the run-out points. Examples: A's right side to a B placed on A's left; right side to right side; top to bottom.
  - Fix: add candidates just outside both boxes (each box's min/max ± `ELBOW_GAP`), and rank routes that cross a box worse.
  - Confidence: Reproduced

- [x] **M33 · One long unbroken word in a sticky note can freeze every client** - **Done** (uncommitted): break points found by doubling then halving, long strings not cached, sizes that surely can't fit are skipped (20k word: 272k measures down to about 4k)
  - Where: `client/src/features/board/notes.js:540-545` (letter-by-letter break), cache at `:592-609`
  - Introduced: ef32f3d
  - Problem: quadratic re-measurement. A 20,000-character URL takes 272k measure calls, 71M characters and about 140 MB of cached strings, on every keystroke and on every client.
  - Fix: binary-search the break point, and don't cache character-level prefixes.
  - Confidence: Reproduced (counts)

- [x] **M34 · Text bounds measured before the web fonts load are cached forever** - **Done** (uncommitted): loadCanvasFonts also clears the bounds caches and where connector ends were drawn
  - Where: `elements.js:231-251` (`boundsCache`); `renderer.js:470-483` (font reset doesn't clear it); `BoardCanvas.jsx:98-117`
  - Introduced: 704f1f3
  - Problem: the fallback font's widths stick. Hit testing, the eraser, culling, frame membership, connector ends and the rotation centre are all off, and the selection box doesn't match the clickable area.
  - Fix: clear `boundsCache` and `turnedBoundsCache` in `loadCanvasFonts`.
  - Confidence: Verified

- [x] **M35 · Connection dots take clicks away from neighbouring elements** - **Done** (uncommitted): `dotGrab` honours a dot only when nothing else (bar a frame) is picked there
  - Where: `BoardCanvas.jsx:334-339`; `connectors.js:198-223`
  - Introduced: dcbd5da
  - Problem: `connectionUnder` runs before `pick()` and ignores stacking order. A caption just above a box can't be selected or dragged, and closely stacked notes start arrows instead of being picked.
  - Fix: only honour a dot when `pick()` finds nothing or finds that same shape.
  - Confidence: Reproduced

- [x] **M36 · Dragging a frame or group regenerates every Rough.js shape and pen outline on each pointermove** - **Done** (uncommitted): new drawCache.js keeps what was built per id and reuses it, drawn offset, for copies that are only moved (rectangles, ellipses, pen strokes); the renderer does this on its own, so BoardCanvas needed no edit
  - Where: `BoardCanvas.jsx:446-451`; `renderer.js:120-127, 306-311` (WeakMap caches keyed by element object)
  - Introduced: ef32f3d
  - Problem: each move step creates new objects, so every cache misses. Collaborators pay the same cost.
  - Fix: draw the group under a translated context while dragging, or cache drawables in local coordinates.
  - Confidence: Verified

- [x] **M37 · The whole editor re-renders on every remote cursor message and drag step; keyboard listeners are re-bound on every render** - **Done** (uncommitted): remote cursors live in an external store (cursors.js) that only RemoteCursors subscribes to; the key listeners are bound once and read state through a ref; BoardCanvas is memoised; stack moves are computed from deferred state; selected uses the store's id index
  - Where: `useBoardSync.js:151-159` (cursors state); `BoardEditor.jsx:526-602` (effect with no deps), `:331-337` (`stackMoves`)
  - Introduced: 704f1f3 / 903aaea / 1b9ff39
  - Problem: 5 peers at 20 Hz means about 100 full-tree renders a second. Each one removes and re-adds 3 window listeners, and each drag step runs `stackKey` 4× over every element.
  - Fix: keep cursors in an external store that only RemoteCursors subscribes to; memo BoardCanvas and the panels; bind keys once and read state through a ref; compute stack moves lazily.
  - Confidence: Verified

- [x] **M38 · A second pointer cancels the gesture, and pointer events aren't filtered by pointerId** - **Done** (uncommitted): gestures record their pointerId; palms and other pointers ignored, pinch needs two touches
  - Where: `BoardCanvas.jsx:288-298, 388-479`
  - Introduced: 704f1f3
  - Problem: a resting palm on a stylus device cancels the stroke and starts a pinch. Other pointers' moves and ups extend or end the current gesture.
  - Fix: record `pointerId`/`pointerType` on the gesture, pinch only with two touches, and ignore touch while a pen is down.
  - Confidence: Plausible

- [x] **M39 · IME Enter commits labels and comments mid-composition** - **Done** (uncommitted): MentionTextarea ignores Enter/Tab/Escape while composing, and so do the three inline editors in TextEditor.jsx (`isComposing` or keyCode 229)
  - Where: `TextEditor.jsx:180-183` (LabelEditor), `:41-44, :116-119` (Escape); `MentionTextarea.jsx:110, 121-124`
  - Introduced: dcbd5da / 704f1f3 / 903aaea
  - Problem: Japanese, Chinese and Korean users lose half-typed labels or post half-typed comments.
  - Fix: return early when `event.nativeEvent.isComposing` is true or keyCode is 229.
  - Confidence: Verified

- [x] **M40 · A curved connector's bounds come from its control points** - **Done** (uncommitted): bounds use the curve's real extremes (roots of its derivative)
  - Where: `client/src/features/board/elements.js:253-268`; used by `frameContents` (`:436-437`), the selection box and export
  - Introduced: dcbd5da
  - Problem: a curved arrow inside a frame doesn't count as inside it, so deleting or duplicating the frame leaves the arrow behind. Selection boxes and export margins are also oversized.
  - Fix: compute the curve's real bounds from where its derivative is zero on each axis.
  - Confidence: Reproduced

- [x] **M41 · Board shortcuts fire while the board menu is open** - **Done** (uncommitted): shortcuts are skipped when the event was already handled or a menu/dialog is open, and Space no longer blocks a focused button
  - Where: `BoardEditor.jsx:566-590`; `client/src/components/Menu.jsx:33-42`
  - Introduced: 704f1f3 / 903aaea
  - Problem: Arrow keys move the selected shape, Delete deletes it, letters switch tools, and Escape also deselects. Space calls preventDefault even on focused buttons, so it can't press them.
  - Fix: skip events where `event.defaultPrevented` is set or whose target is inside `[role=menu]`, `[role=dialog]` or a button.
  - Confidence: Verified

### Collaboration UI and app shell

- [x] **M42 · Two people following each other both zoom out without end** - **Done** (uncommitted): a view taken from the person you follow is not broadcast again, and following skips updates that change nothing (useFollow.followedViewport/sameView; follow.test.js)
  - Where: `client/src/features/board/useFollow.js:17-26`; `BoardEditor.jsx:214-217`
  - Introduced: 903aaea
  - Problem: a view received from the person you follow is re-broadcast; with different screen shapes the view grows on every round trip, down to MIN_ZOOM, with messages every 120 ms.
  - Fix: don't broadcast views that came from following, and skip updates when nothing changed.
  - Confidence: Verified

- [x] **M43 · Signed-in users get a new socket every time they enter or leave a board** - **Done** (uncommitted): SocketProvider depends on token and a needsSocket flag that stays true while signed in, so entering or leaving a board no longer reconnects
  - Where: `client/src/providers/SocketProvider.jsx:15-32`
  - Introduced: 07ee635
  - Problem: the effect depends on `onBoardPage`, so each change disconnects and reconnects. Notifications sent during the gap are lost (M47).
  - Fix: depend on `token` and on a `needsSocket` flag, and only rebuild the socket for guests.
  - Confidence: Verified

- [x] **M44 · Remote cursors ignore the color people choose in Settings** - **Done** (uncommitted): remote cursors use `personColor(peer)`, so the color chosen in Settings shows
  - Where: `client/src/features/board/RemoteCursors.jsx:13` (`colorFor(peer.userId)`); `personColor` in `lib/format.js:38` is never used
  - Introduced: 07ee635
  - Fix: `personColor(peer)`.
  - Confidence: Verified

- [x] **M45 · A half-written reply moves to the next comment thread you open** - **Done** (uncommitted): the open-thread popover is keyed by thread id, so a draft reply no longer moves to another thread
  - Where: `client/src/features/board/CommentsLayer.jsx:176, 243-263`
  - Introduced: 903aaea
  - Problem: Popover and Composer have no `key`, so A's draft and mentions are posted to thread B.
  - Fix: `<Popover key={active.id}>`.
  - Confidence: Verified

- [x] **M46 · Notifications: never shown as unread, no catch-up after reconnect, fetched and live lists race** - **Done** (uncommitted): items stay unread until the menu closes, lists are merged by id (`lib/notifications.js`), refetch on every socket `connect`, unread count derived from the items
  - Where: `client/src/components/NotificationsMenu.jsx:24-27, 63`; `client/src/providers/NotificationsProvider.jsx:28-58`
  - Introduced: 1eb9b60
  - Fix: mark items read when the menu closes; refetch on `connect`; merge lists by id.
  - Confidence: Verified / Plausible (race)

- [x] **M47 · A bad stored sort or view permanently white-screens /boards** - **Done** (uncommitted): `readStored` takes a validator (`isSort`, `isView`) and falls back to the default for any bad stored value
  - Where: `client/src/features/dashboard/useStoredState.js:4-12`; `DashboardPage.jsx:69, 155, 445, 481`
  - Introduced: 21b4ec2
  - Problem: valid JSON of the wrong shape (an old sort key, `"null"`) throws at render, on every reload.
  - Fix: pass a validator to `useStoredState` and fall back to the initial value.
  - Confidence: Verified

- [x] **M48 · The New board dialog downloads every template in full; deleting one has no confirmation and is invisible on touch** - **Done** (uncommitted): GET /templates returns a stored light preview and element count (old templates are backfilled on first list); the dialog draws that, deleting asks to confirm, and the button shows on touch screens
  - Where: `client/src/features/templates/NewBoardDialog.jsx:55-65, 108-121`; `server/src/controllers/template.controller.js:16-18`
  - Introduced: 1eb9b60
  - Fix: list templates as light previews and load the full template on create; confirm or offer undo on delete; show the button on `pointer:coarse`.
  - Confidence: Verified

- [x] **M49 · Everything ships in one 590 kB JS chunk** - **Done** (uncommitted): pages and the landing DemoBoard are `React.lazy`, react and socket.io split into vendor chunks; largest chunk is now 257.7 kB (was ~590 kB)
  - Where: `client/src/App.jsx` (all pages imported eagerly); `client/vite.config.js`
  - Introduced: 704f1f3
  - Fix: `React.lazy` BoardPage, DrawPage, DashboardPage, SettingsPage and the AuthPages behind Suspense; lazy-load DemoBoard.
  - Confidence: Verified

### Infra

- [x] **M50 · `engines` says Node 20.12+, but the dependencies need 22.22+** - **Done** (uncommitted): `engines` is `>=22.22` (react-router 8.4 needs it, per the lockfile), the README says so and `.nvmrc` pins 22.22; CI reads `.nvmrc`
  - Where: `package.json:11-13`; `README.md:76`
  - Introduced: 704f1f3
  - Problem: react-router 8.4 needs `>=22.22`, mongoose 9 / mongodb 7 need `>=20.19`, and vite 8 needs `^20.19 || >=22.12`.
  - Fix: set `engines` to `>=22.22`, update the README, and add `.nvmrc`.
  - Confidence: Verified (lockfile)

- [x] **M51 · CI's MongoDB binary cache does nothing; the binary is downloaded on every run** - **Done** (uncommitted): `MONGOMS_DISABLE_POSTINSTALL=1` stops the postinstall download, `MONGOMS_VERSION` is pinned and the cache key uses it
  - Where: `.github/workflows/ci.yml:22, 28-31`
  - Introduced: 74dd908
  - Problem: the `npm ci` postinstall downloads mongod into `node_modules/.cache` before the cache step, and the tests then use the copy in `~/.cache`.
  - Fix: set `MONGOMS_DISABLE_POSTINSTALL: 1` on `npm ci`, and key the cache on the MongoDB version.
  - Confidence: Plausible

### More medium items (smaller scope)

- [ ] **M52 · The invite endpoint reveals whether an account exists, and invites and comments can flood notifications.** `board.controller.js:232-247`. It returns 404, 409 or 201 with the person's name, with no rate limit, and invite/remove loops send repeated notifications. Fix: rate-limit invites, threads and board creation, and de-duplicate notifications. - **Not done** (account existence): invites, comments and board creation are rate-limited per user and repeat unread notifications are collapsed, but the invite endpoint still says whether an email has an account. Answering the same for an unknown email needs pending invites (kept by email, applied when that person signs up and verifies) plus a different invite UI, so the owner would no longer be told to ask them to sign up; that is a product decision
- [x] **M53 · The "Undo" button on the delete-frame and clear-board toasts undoes whatever was done last.** `BoardEditor.jsx:303-305, 651`. Fix: undo that specific history entry, or dismiss the toast on the next commit. - **Done** (uncommitted): the Undo toast for delete-frame and clear-board dismisses itself as soon as another step is made (store.historyMark; store.test.js)
- [x] **M54 · Notes and labels over 20,000 characters leave the author out of step with everyone else.** These are the client-side parts of M16 for notes and labels (`element-rules.js:79, 112`). - **Done** (uncommitted): the editors have maxLength = the server's 20,000, the commit cuts to the same limit, and the ack's cleaned elements replace the author's copy
- [x] **M55 · Image stream errors and aborts.** `image.routes.js:272-273`: `pipe` without `pipeline`, so an aborted download leaves its GridFS cursor open, and a late error calls `next` after headers were sent. Fix: `stream.pipeline` with a `res.headersSent` check. - **Done** (uncommitted): image download uses stream.pipeline, so an aborted download closes the GridFS cursor and a late error can't call next after headers
- [x] **M56 · Removing a collaborator with an invalid id returns 500 after the board was already saved.** `board.controller.js:263-277`. Fix: check `isValidObjectId` first and return 404. - **Done** (uncommitted): an invalid or unknown user id is a 404 before anything is saved
- [x] **M57 · Big changes sent in pieces are only partly undone on `tooLarge`.** `useBoardSync.js:56-67`; `store.js:305-321`. Piece 1 stays on the server while the toast says the change "was undone", and several `resync` calls run at once. Fix: one change id for all pieces, refused or committed together. - **Done** (uncommitted): pieces of a big change now carry one group id and are held by the server (operations.holdPiece, board:op group) until the last arrives, then taken in together; a refused or lost piece drops the whole group and the client sends it all again as a new group; tests in sync.test.js and outbox.test.js
- [ ] **M58 · Every op and drag step costs O(n) on both client and server.** `new Map(elements)` per op (`board-merge.js:204`), `operations.js:368`, `getElement` using `find` (`store.js:100, 228`), and `JSON.stringify` of all pending changes every 40 ms (`store.js:310`). Fix: index elements by id and size pending changes incrementally. - **Done** (uncommitted): client store finds elements by id through an index that planOperation now uses (index option) instead of building a Map per op; toOperations only measures when a rough estimate says it must. Server side is sync-server's. **Partly done** (second review): commitPlan now appends new top elements without re-sorting, but still copies the whole array per op (React needs a new array; true in-place updates would need a position index).

## Low

### Server and API

- [x] **L1** A template saved without a name fails when the board title is 61–80 characters (`template.controller.js:24-25`). - **Done** (uncommitted): a template named from a long board title is cut to 60 characters
- [x] **L2** The unread count includes notifications that are never listed; there is no paging past 30; deleting a thread leaves its notifications (`notification.controller.js:7-14`). - **Done** (uncommitted): unread and list use the same set (boards the person can open), the list pages with ?before= (30 at a time, `more` flag), and deleting a thread deletes its notifications
- [x] **L3** The version list stops at 100, but a board can keep 110 versions; the oldest named ones can't be restored or deleted (`version.controller.js:34`). - **Done** (uncommitted): the version list limit is the sum of the auto, restore and named caps
- [x] **L4** Version and template caps can be exceeded by concurrent requests, which check then insert (`version.controller.js:54-60`, `template.controller.js:39-43`). - **Done** (uncommitted): template and saved-version saves run one at a time per owner / board (keyedQueue), so concurrent requests can't pass the cap check together
- [x] **L5** Board purge isn't ordered, so a partial failure orphans versions and threads; the trash sweep can delete a board restored a moment earlier (`boards.js:76-85`, `trash.js:10-13`). Fix: delete dependents first, and gate on `deletedAt` at delete time. - **Done** (uncommitted): destroyBoard deletes dependents first and the board last, gated on the board still being trashed (and older than the sweep's cutoff)
- [x] **L6** Wrong input types are coerced: `{starred:"false"}` stars a board, a label `{a:1}` becomes "[object Object]", ±1e308 coordinates are accepted, and threads have no message cap, so the document can pass 16 MB (`board.controller.js`, `thread.controller.js`, `version.controller.js`). - **Done** (uncommitted): board and template titles, version labels and comment text must be strings, starred must be a boolean, comment positions are bounded, and a thread holds at most 200 messages
- [x] **L7** Membership edge cases: removing a non-member returns 200 and still saves; `starredBy` survives removal; `/collaborators/me` (leave) returns every member's email; sharing changes bump `updatedAt` (`board.controller.js:261-281`). - **Done** (uncommitted): removing a non-member is a 404, a removed person's star is dropped, leaving returns only what a visitor sees, and invites, removals and link changes no longer bump updatedAt
- [x] **L8** Templates drop images but keep connectors that point at them (`template.controller.js:29-30`). - **Done** (uncommitted): template arrows attached to a left-out picture are released from it (geometry kept)
- [x] **L9** The error handler turns 4xx errors (URIError, a bad Content-Encoding) into 500s with stack traces in the log, and ignores `res.headersSent` (`middleware/error-handler.js:9-24`). - **Done** (uncommitted): 4xx errors from other libraries pass through as 4xx without a stack; headersSent is respected
- [x] **L10** Duplicate-key races (double sign-up, simultaneous OAuth) return 500, and the email is logged (`auth.controller.js:54-58`, `oauth.controller.js:230-265`). Map error 11000 to 409. - **Done** (uncommitted): duplicate keys give 409 (register, OAuth, error handler) without logging the email
- [x] **L11** A numeric `JWT_EXPIRES_IN` such as `"3600"` is read as milliseconds (`config/env.js:32`). - **Done** (uncommitted): a numeric JWT_EXPIRES_IN means seconds
- [x] **L12** A failed email send deletes the previous link, then a retry gets "we just sent you one" (`services/account-emails.js:20-36`). - **Done** (uncommitted): the new link is created first and dropped if sending fails, the old one keeps working
- [x] **L13** Register waits on Brevo, and pure-JS bcryptjs at cost 12 takes about 270 ms of CPU per hash on the event loop (`auth.controller.js:60-66`, `user.model.js`). - **Done** (uncommitted): scrypt on the thread pool replaces bcryptjs (old hashes still verify and are upgraded at login); verification and reset emails are sent after the response
- [x] **L14** No length cap on email or name fields (`auth.controller.js:18-25`). - **Done** (uncommitted): email capped at 254 characters; name (60) and password (128) were already capped
- [ ] **L15** Accounts can be enumerated: the register 409, the login message "signs in with Google", and response timing (no bcrypt for unknown emails, and the forgot-password email is awaited). - **Partly done**: login says the same for every failure and spends the same time; forgot-password no longer awaits the mail. The register 409 remains (hiding it needs a verification-first sign-up)
- [x] **L16** Opening a verification link verifies at once, with no confirmation step (`AuthPages.jsx:359-366`). - **Done** (uncommitted): the verify page now asks for a click before using the link
- [x] **L17** The OAuth fallback name (the email's local part, up to 64 characters) isn't cut to 60, so sign-in fails (`oauth.controller.js:257`). - **Done** (uncommitted): fallback name cut to 60
- [x] **L18** OAuth `fetch` calls have no timeout (`oauth.controller.js:74-90`). - **Done** (uncommitted): OAuth fetches time out after 10 s
- [x] **L19** Shutdown has no deadline or error handling; there are no `unhandledRejection` / `uncaughtException` handlers, so a crash skips the flush (`index.js`). - **Done** (uncommitted): shutdown has a 20 s deadline and error handling; uncaughtException/unhandledRejection flush and exit
- [x] **L20** The password limit message says "72 characters" but counts bytes, so emoji passwords are refused with a confusing message (`auth.controller.js:36-38`). - **Done** (uncommitted): password limit is 128 characters, counted as characters
- [x] **L21** Images are served `public, max-age=31536000, immutable` with CORP cross-origin, so access can't be revoked and the docs overstate who gets image ids (`image.routes.js:264-271`, `docs/image-storage.md`). - **Done** (uncommitted): images are private, max-age 1 day; CORP is same-origin unless CLIENT_ORIGIN is set; docs/image-storage.md corrected
- [x] **L22** `putImage` is a two-part write that can orphan the main copy; `deleteImages` swallows errors (`image-storage.js:61-67`). - **Done** (uncommitted): putImage deletes the main copy if the small copy's write fails, and deleteImages logs failures instead of swallowing them
- [x] **L23** The SPA fallback serves index.html with 200 for missing `/assets/*.js`, fonts, robots.txt and favicon; `HEAD /` returns 404 (`app.js:72-75`). - **Done** (uncommitted): missing /assets, files with an extension and similar get 404; HEAD is served
- [x] **L24** A database blip turns `/health` to 503, which can make Render restart the instance mid-outage (`app.js:17-28`). - **Done** (uncommitted): C:/Program Files/Git/health answers 200 while the database is away, with status degraded
- [x] **L25** The immutable-cache check matches `/assets/` anywhere in the absolute file path (`app.js:66`). - **Done** (uncommitted): immutable only for files directly under client/dist/assets
- [x] **L26** No HTTP compression middleware, and Socket.IO `perMessageDeflate` is off, so multi-MB board joins go uncompressed. - **Done** (uncommitted): compression middleware added to app.js (new dependency compression) and Socket.IO perMessageDeflate enabled for messages over 4 KB
- [x] **L27** `measureOldVersions` measures `$$ROOT`, while new versions measure only `{elements}`, so budget sizes are inconsistent (`versions.js:41`). - **Done** (uncommitted): old versions are measured as { elements } the same way new ones are
- [x] **L28** `services/trash.js` imports `TRASH_DAYS` from a controller; `createThread` uses the raw body as the excerpt while replies collapse whitespace. - **Done** (uncommitted): TRASH_DAYS lives in services/trash.js, and createThread's excerpt is collapsed in notify() like replies
- [x] **L29** The server accepts a connector with `startId === endId`, which draws a zero-length or doubled-back line (`element-rules.js:73`). - **Done** (uncommitted): the second attachment of a connector with startId === endId is dropped

### Client: auth and settings

- [x] **L30** Auth isn't synced across tabs, and a late 401 from an old token logs out a newer session (`AuthProvider.jsx`, `lib/api.js:40`). - **Done** (uncommitted): tabs follow token changes through the storage event; a late 401 for an old token no longer logs out a newer login
- [x] **L31** Settings shows "current password isn't right" on the *New password* field (`SettingsPage.jsx` ~242). - **Done** (uncommitted): the current-password error shows on the Current password field
- [x] **L32** `?error=` and `?connected=` put attacker-chosen text into official alerts (`AuthPages.jsx:56`, `SettingsPage.jsx:269-274`). Pass codes instead of text. - **Done** (uncommitted): errors and ?connected come as codes and provider names, mapped to our own messages on the client

### Client: images and export

- [x] **L33** Every image load redraws every dashboard card (a global `imagesVersion`), and off-screen cards load too (`BoardPreview.jsx:16, 27-36`). - **Done** (uncommitted): previews redraw only when their own pictures load, and neither draw nor fetch pictures until near the viewport
- [x] **L34** Dropping more than 10 images: the toast says "3 of 15" and files 11+ are silently ignored (`BoardEditor.jsx:370-372`). - **Done** (uncommitted): a batch of more than 10 images now warns up front ('first 10 of 15') and the progress counts the batch
- [x] **L35** PNG export can exceed iOS Safari's ~16.7 MP canvas limit, `toBlob` returns null, and the error says "try again" (`exportImage.js:60-83`). - **Done** (uncommitted): the PNG export scale also keeps the canvas under 16 MP (exportSize.exportScale), and a null toBlob gives an ExportError that points to SVG instead of 'try again'
- [x] **L36** Import errors lose their real reason and call every dropped element a "picture"; there's no size cap on the imported file (`BoardEditor.jsx:428-470`). - **Done** (uncommitted): import keeps the real failure reason, counts unreadable elements apart from pictures, caps the file size (100 MB) and element count, and runs through the shared element rules
- [x] **L37** The client image cache is never cleared, and missing images are re-requested every 10 s (`images.js:123-175`). - **Done** (uncommitted): the client image cache keeps at most 300 pictures (least recently used dropped) and a missing picture is re-requested after 10 s, then 20 s, 40 s ... up to 5 min
- [x] **L38** Safari's WebP encode falls back to PNG, which makes photo uploads worse; HEIC, AVIF and BMP are refused instead of re-encoded (`images.js:53-76`). - **Done** (uncommitted): a browser that can't write WebP now gets JPEG for pictures with nothing see-through (PNG only when there is transparency); AVIF, BMP and HEIC are accepted and re-encoded
- [x] **L39** SVG export differs from the canvas: no note shadow, `href` without `xlink:href`, and fixed `label-gap-N` clip ids that clash when two SVGs share a page (`svgExport.js`). - **Done** (uncommitted): notes get a drop-shadow filter, `xlink:href` plus its namespace, and every id carries a per-export random prefix
- [x] **L40** `FONTS[element.font]` matches prototype keys such as `"constructor"`; use `Object.hasOwn` (`svgExport.js:38, 54`). - **Done** (uncommitted): new `fontKey()` in constants.js (Object.hasOwn) used by svgExport, elements, notes and TextEditor

### Client: editor, connectors and notes

- [x] **L41** Resizing a flat pen stroke slides it instead of scaling (`transform.js:143-153`). - **Done** (uncommitted): a flat stroke stays put along its flat side
- [x] **L42** The degenerate-shape threshold is in board units, so it depends on zoom; each click broadcasts a create and then a remove (`elements.js:538-542`). - **Done** (uncommitted): `isDegenerate` takes the zoom (3 screen px), and shapes are only made once dragged, so a click broadcasts nothing
- [x] **L43** Two pinch pointers starting at the same spot give a NaN zoom; `clamp(NaN)` returns NaN (`BoardCanvas.jsx:415`, `geometry.js:3`). - **Done** (uncommitted): `pinchViewport` guards a zero start distance; `clamp(NaN)` gives the minimum
- [x] **L44** Ctrl+wheel or a pinch over the toolbar or panels zooms the whole browser page. - **Done** (uncommitted): window wheel listener stops Ctrl+wheel zooming the page outside the canvas
- [x] **L45** A cancelled erase is still committed; Escape doesn't cancel a draw, move or resize in progress (`BoardCanvas.jsx:254-259`). - **Done** (uncommitted): cancelled erase is put back, Escape cancels draw/move/resize/erase
- [x] **L46** An outer frame drawn after an inner one hides the inner frame's page and border (`elements.js:395-403`). Draw frames by nesting depth or area. - **Done** (uncommitted): frames are drawn by nesting depth (inner after the frames around it), otherwise in stack order
- [x] **L47** A duplicated frame lands on its neighbours, including every Kanban and Retro column (`BoardEditor.jsx:313`, fixed `dx = width + 80`). - **Done** (uncommitted): a duplicated frame goes to the nearest free spot (right, below, left, above; placement.copyOffset) instead of a fixed distance; placement.test.js
- [x] **L48** Note wrapping splits emoji ZWJ sequences and can cut surrogate pairs; the server's `.slice` can too (`notes.js:540-544`). Use `Intl.Segmenter`. - **Done** (uncommitted): client wraps and shortens by grapheme (Intl.Segmenter, render-geometry); the server cuts text, labels, frame names and guest names with `cutText` (whole graphemes, never inside a surrogate pair or ZWJ emoji)
- [x] **L49** Frame names are re-measured letter by letter at every zoom step (`elements.js:146-176`). - **Done** (uncommitted): frame names are shortened by binary search (about 13 measures)
- [x] **L50** The eraser removes a frame but leaves its contents, while Delete removes both (`BoardCanvas.jsx:214-237`). - **Done** (uncommitted): the eraser takes a frame's contents along, as Delete does
- [x] **L51** Arrowheads are longer than an elbow's last run (`elements.js:188-189`). - **Done** (uncommitted): on a bent path an arrowhead is no longer than the straight run it sits on
- [x] **L52** The Flowchart template's "no" loop is three loose, unattached pieces; its description says "two endings" but there is one; template arrows lack `route`, `font` and `startHead` (`builtin.js:110-116, 176`). - **Done** (uncommitted): the "no" loop is one attached elbow arrow with a label; description fixed; template arrows set route, font and startHead
- [x] **L53** NoteEditor wraps differently from the canvas and hides the caret when text overflows; inline editors stay where the element was if someone moves it; `pathPolyline` re-samples on every hit test. - **Done** (uncommitted): NoteEditor breaks long words like the canvas and scrolls so the caret stays visible, the text and note editors follow the element if it is moved (BoardEditor passes the live one), `pathPolyline` is cached per path. Browsers can still break a line after a hyphen where the canvas does not
- [x] **L54** BoardTitle overwrites your in-progress text when someone else renames the board (`BoardEditor.jsx:91`). - **Done** (uncommitted): BoardTitle keeps what you are typing while someone else renames the board (and takes the new name once you leave the field)
- [x] **L55** `sendCursor` throttles only on the leading edge, so remote cursors stop short of where the pointer rested (`useBoardSync.js:245-253`). - **Done** (uncommitted): sendCursor throttles on both edges, so the last pointer position is always sent
- [x] **L56** After a reconnect, edits sent but not yet acked vanish for up to 10 s (`useBoardSync.js:83-85, 114-117`). - **Done** (uncommitted): on disconnect, sent-but-unconfirmed changes go back in the queue (outbox.requeueSent) and show on top of the rejoined board, instead of vanishing
- [x] **L57** The `saving` indicator reads a ref during render, so it's stale (`useBoardSync.js:256`). - **Done** (uncommitted): saving is state updated by the outbox, not a ref read during render
- [x] **L58** The `converted` map in `ink.js:57` grows with every custom color. - **Done** (uncommitted): the cache starts over at 500 colors
- [x] **L59** The shortcuts dialog and README don't match the code: C, Esc, Ctrl+Y, Backspace, Ctrl+Enter and Shift+Enter are missing; it shows edit shortcuts to viewers; README says text resizes "from any side" (corners only) and promises shortcuts "for every action" (no copy, paste or select-all); `navigator.platform` is deprecated. - **Done** (uncommitted): shortcuts dialog lists C, Esc, Ctrl+Y, Backspace, Ctrl+Enter and Shift+Enter, shows viewers only what looking needs, and reads the platform from userAgentData; README: text resizes from its corners, and the shortcut claim is narrowed
- [x] **L60** Accessibility: canvas elements can't be reached by keyboard; the `SyncStatus role="status"` announces on every 40 ms flush. - **Done** (uncommitted): SyncStatus no longer announces every Saving flush; the keyboard-reachable ElementList selects any element; the selection is announced (polite status region) and an off-screen selection is brought into view (placement.viewToReveal); arrow keys and Delete then work. Tab traversal of the canvas itself is not done: the list is the way in

### Client: collaboration UI

- [x] **L61** Share dialog: Leave and Remove take one click with no confirmation; member avatars ignore color and photo; the old error and input stay on reopen; Copy link copies `?thread=` (`ShareDialog.jsx`). - **Done** (uncommitted): Leave/Remove ask to confirm, member avatars show color and photo, dialog state resets on reopen, Copy link drops `?thread=`
- [x] **L62** Version history: the restorer sees two toasts; a failed preview spins forever; the list doesn't update live (`VersionHistory.jsx:52-69`). - **Done** (uncommitted): the restorer gets one toast (shared id with the sync toast), a failed preview shows Try again, the list refreshes on restore, tab focus and every 30 s
- [x] **L63** Mention matching treats "@Ann" inside "@Ann Lee" as a match, and the alternation isn't sorted longest-first (`MentionTextarea.jsx:59-63`, `CommentsLayer.jsx:19`). - **Done** (uncommitted): `findMentions` matches longest name first and only whole names, used for both the picked-mention check and the highlighting
- [x] **L64** Deleting a whole comment thread takes one click, with no confirmation or undo (`CommentsLayer.jsx:145-146, 257-260`). - **Done** (uncommitted): deleting a thread asks for confirmation first
- [x] **L65** Color contrast fails WCAG AA: white on #f08c00 is 2.5:1 and on dark-mode danger #ff7a70 is 2.5:1 (`lib/format.js:29`, `index.css:42`). - **Done** (uncommitted): people colors darkened to at least 4.5:1 with white text, and filled danger buttons/badges use a `--danger-solid` token in both themes
- [x] **L66** On phones the landing demo canvas (`touch-none`) blocks page scrolling (`DemoBoard.jsx:130`). - **Done** (uncommitted): the demo canvas uses `touch-pan-y` and ignores finger input, so touch scrolls the page (mouse and pen still draw)
- [x] **L67** Two `/draw` tabs overwrite each other's scratch board; a stale anonymous tab can cause a duplicate import (`scratch.js:56-84`). - **Done** (uncommitted): a storage event makes other /draw tabs show the newest drawing (and clear after an import), so tabs don't overwrite each other or import twice
- [x] **L68** Bulk Star rolls back incorrectly and is always labelled "Star" (`DashboardPage.jsx:117-126, 239-251`). - **Done** (uncommitted): bulk star rolls each failed board back to its own previous state and the button reads "Unstar" when all are starred
- [x] **L69** Accessibility of Menu and Dialog: focus isn't returned on close, no Home/End, a hard-coded `id="dialog-title"`, no `aria-describedby`, a drag that ends on the backdrop closes the dialog, the mention listbox lacks `aria-activedescendant`, and the comment popover doesn't take focus. - **Done** (uncommitted): Menu returns focus to its button and supports Home/End, Dialog uses `useId` ids, `aria-describedby`, and ignores drags that end on the backdrop, mention listbox has `aria-activedescendant`, comment popover takes focus
- [ ] **L70** Small inconsistencies: guests can use follow mode (the README says no); PresenceStack is hidden on phones; GuestIdentity keeps text after cancel; `timeAgo` never refreshes; `initials()` splits emoji; `theme-color` and the manifest color don't match the chosen theme; the `signedIn` prop of NewBoardDialog is always true. - **Partly done**: guests keep follow mode (README table updated instead), GuestIdentity resets its text on cancel, timeAgo refreshes every minute, initials() keeps emoji whole, theme-color follows the chosen theme, NewBoardDialog's signedIn prop is gone. Remaining: PresenceStack stays hidden on phones (the top-right bar has no room for it, and I can't judge a layout change without a device) and the static manifest color

### Infra, docs and tests

- [x] **L71** Stale docs: - **Done** (uncommitted): realtime-sync.md describes the stacking buttons and shortcuts; research-and-roadmap.md has the current op shape, save timing, test counts, no parity test and the shutdown behaviour as implemented; the README lists the real tests, project structure, `API_PROXY_TARGET`, `DEV_DB_PORT` and the `NODE_ENV` rules (it already had `NODE_ENV`)
  - `realtime-sync.md:53` says there is no stacking UI yet; it was added in 1b9ff39.
  - `research-and-roadmap.md` has the old op shape and "about once a second", says "119 tests", lists a parity test that was deleted, and claims shutdown "flushes everything first".
  - README: the test list is incomplete, the project structure is outdated, and `API_PROXY_TARGET`, `DEV_DB_PORT` and the load-bearing `NODE_ENV=production` are undocumented.
- [x] **L72** CI hygiene: `push` plus `pull_request` runs CI twice per PR; no `concurrency`/`cancel-in-progress`; no `permissions: contents: read`; actions `@v4`; no ESLint, audit or coverage step; no Dependabot. - **Done** (uncommitted): CI runs on pull requests and pushes to main, cancels superseded runs, has `permissions: contents: read`, Actions pinned to current releases by commit SHA, lint, `npm audit` and coverage steps, and Dependabot is set up for npm and Actions
- [ ] **L73** Keep-alive cron: GitHub schedules often run late; scheduled workflows are disabled after 60 days without repo activity; the URL is hard-coded; it costs about 744 of the 750 free Render hours; a database blip sends failure emails. - **Partly done**: the URL is a repository variable (`HEALTH_URL`, already), the run fails only after two retries 30 s apart, and the 60-day disable and the 744 of 750 Render hours are explained in the workflow file and the README. A cron can't be made punctual from inside the repo; an external pinger (UptimeRobot, cron-job.org) or a paid Render instance would remove both the lateness and the hours cost, which is an outside decision
- [x] **L74** Test environment leaks: `helpers.js` doesn't blank `APP_URL` or `CLIENT_ORIGIN`, so the README-recommended `.env` breaks a test, and `password-reset.test.js:108` asserts conditionally. - **Done** (uncommitted): `helpers.js` blanks `APP_URL`, `API_URL`, `CLIENT_ORIGIN`, `TRUST_PROXY`, `JWT_EXPIRES_IN` and the email variables; the password-reset link assertion is unconditional
- [ ] **L75** Coverage gaps: - **Partly done**: OAuth callback and linking (Google in auth-security.test.js, GitHub in oauth-github.test.js, with the provider's requests stubbed), shutdown order (shutdown.test.js), env validation (env.test.js) and CSP/static headers (auth-security.test.js) are tested; the negative assertions that waited with `settle(150)` now make a round trip on the socket (`roundTrip` in helpers.js) or force a save instead of sleeping, and `settle` is gone; `npm run coverage` prints coverage (`--experimental-test-coverage`). **Not done**: React component tests (no DOM test setup in the repo)
  - No tests for the OAuth callback and linking, shutdown order, env validation, or CSP and static headers.
  - No React or component tests at all.
  - 12 negative assertions rely on a fixed `settle(150)` wait.
  - No coverage reporting.
- [x] **L76** No linter: an unused `Avatar` import in `VersionHistory.jsx:5`, and a stray `eslint-disable` in `error-handler.js:8`. Add ESLint with `react-hooks`. - **Done** (uncommitted): ESLint 10 flat config (`eslint.config.mjs`: recommended rules plus `react-hooks` rules-of-hooks and exhaustive-deps) with `npm run lint`, run in CI; the `Avatar` import was already gone, the stray `eslint-disable` in error-handler.js is removed, and the few findings (useless regex escapes in vite.config.js, a regex with spaces in a test, a deliberate control-character regex in svgExport.js) are fixed or annotated. The plugin's newer React Compiler rules are left off on purpose
- [x] **L77** Constants that should be shared are copied between client and server (`SYNC_FORMAT`, `MAX_ELEMENTS_PER_BOARD`, image limits). Move them to `@inkboard/shared`. - **Done** (uncommitted): `SYNC_FORMAT`, `MAX_ELEMENTS_PER_BOARD` and the image byte and pixel limits live in `shared/src/limits.js` (`@inkboard/shared/limits`); the client constants and server operations/images import them (the client's upload ceiling is 90% of the shared image limit)
- [x] **L78** `dev-db.js` ignores a custom `DEV_DB_PORT` when no `MONGODB_URI` is set; production logs "API ready on http://localhost"; `verifyAccountsMadeByProviders` migration runs on every boot. - **Done** (uncommitted): the default `MONGODB_URI` follows `DEV_DB_PORT`; production logs `API ready on port N`; `verifyAccountsMadeByProviders` runs once (a record in the `migrations` collection) instead of scanning every account on each boot
- [ ] **L79** Code structure: `BoardEditor.jsx` (982 lines) should be split into useBoardShortcuts, useImageDrop/useImport, BoardMenu and ViewControls. The three inline editors repeat the same logic (a shared `useInlineEditor`). `renderer.js` uses module-level mutable state. - **Partly done**: BoardEditor.jsx went from 1,093 to about 600 lines: split into useBoardShortcuts (same keys.current ref pattern), useImageImport (add images, import board file, paste/drop), BoardMenu, ViewControls, BoardTitle, StatusPanels and domTargets; the three inline editors in TextEditor.jsx share useInlineEditor. Pure move, tests unchanged. Not done: renderer.js module-level state (ink, smallPictures, labelScale) is read by about 15 draw functions, so passing it as a context touches all of them and rendering has no DOM test to guard it

---

## Checked and found fine

- No NoSQL injection or mass assignment: fields are picked and `String()`-coerced.
- Thread and version lookups are scoped to their board.
- Templates and notifications are scoped to their owner.
- Access is checked on every socket event, and `syncAccess` updates roles live.
- Trashed boards are blocked over REST and socket.
- Emails stay hidden from non-members.
- Reset and verify secrets: 32 random bytes, SHA-256 hashed, single use, TTL index.
- OAuth `state` cookie and nonce are correct, and provider emails are accepted only when verified.
- `safeNext` blocks open redirects, and the token travels in the URL fragment.
- Image ids are validated; content type is taken from magic bytes; SVG uploads are refused; `nosniff` is set.
- SVG export escapes text, colors and names correctly.
- Prototype pollution is blocked by allow-listed `cleanElement`.
- Convergence holds under reordering and duplicated delivery.
- Hooks clean up all listeners.
- Render caches are WeakMap-based.
- No XSS sinks (`dangerouslySetInnerHTML`) anywhere.
- Every number in the docs matches the code (40 ms batching, 250 ms–5 s saves, quotas, the 30-day trash, the version budget).
