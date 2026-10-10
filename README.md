# Inkboard

A real-time collaborative whiteboard. Sketch with hand-drawn shapes, invite people by email, and watch everyone's cursors and strokes appear live.

**Live demo: [inkboard-b9k8.onrender.com](https://inkboard-b9k8.onrender.com)**

![Inkboard board with a collaborator's cursor](docs/screenshots/board.png)

## Features

- **Live collaboration**: strokes stream to everyone on the board as they're drawn, with named cursors and a presence list.
- **Drawing tools**: pen (pressure-sensitive with a stylus), rectangle, ellipse, arrow, line, text, eraser, plus select-and-move. Selected shapes and strokes can be resized from any side or corner (text from its corners) and turned with the handle above them (hold Shift to keep proportions or snap to 15° steps). Lines and arrows have a handle on each end.
- **Hand-drawn or clean**: shapes are rendered with Rough.js. Switch any of them between a sketchy and a crisp look.
- **Infinite canvas**: pan with the hand tool, space-drag or the scroll wheel. Zoom with Ctrl/⌘ + wheel, trackpad pinch or two fingers.
- **Per-person undo and redo**: undoing your own change never wipes out what collaborators drew in the meantime.
- **Sharing with levels**: invite people by email to edit, remove them, or leave a board. The owner can also let *anyone with the link* view or edit the board, with no account needed. Viewers can pan and zoom but not change anything, and nobody outside the invite list sees invitees' email addresses. Access is checked on every request and socket event, and changes apply live to people who already have the board open.
- **Boards dashboard**: live thumbnails, search, filters for owned and shared boards, rename and delete.
- **Works offline briefly**: edits made while disconnected are queued and synced after reconnecting.
- **Light and dark themes**: dark mode turns the graph paper into a blueprint.
- **Connectors**: draw an arrow or line from one shape, note, picture or text to another and it stays attached, following them as they move, resize or turn, on everyone's screen. Hover a shape for its connection dots and drag from one to draw an arrow out of that side; drop an end on a dot to pin it there, or on the shape to let it find the nearest side. Lines are straight, curved or elbowed (right angles only), arrows can have heads at both ends, and double-clicking one (or Enter) types a label on it. Drag an end onto another shape to reconnect it, or off to let go.
- **Sticky notes and frames**: notes (<kbd>S</kbd>) in six colors, whose writing wraps and shrinks to fit. Frames (<kbd>F</kbd>) are named white pages that hold whatever lies inside them: moving, copying or deleting a frame does the same to its contents. The Kanban and Retrospective templates are built from them.
- **Images**: add pictures with the toolbar button (or <kbd>I</kbd>), by pasting, or by dropping files onto the board. They are shrunk in the browser, stored in MongoDB (GridFS), and resize and turn like any shape. Accounts, invited editors and guests with an edit link can add them; see [docs/image-storage.md](docs/image-storage.md) for limits and how to move storage to Cloudflare R2 or Cloudinary.
- **Keyboard shortcuts** for every tool and for the common actions: undo and redo, duplicate, delete, nudge, stacking order, zoom and fit (press <kbd>?</kbd> on a board for the list; there is no copy, paste or select-all of board elements yet), export to PNG or SVG, and board files (`.inkboard.json`, pictures included) to export and import again.

| Dashboard | Dark mode |
| --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) | ![Dark mode](docs/screenshots/board-dark.png) |

## Guests and accounts

Nobody has to sign up to try Inkboard. Guests draw first; accounts keep, share and collaborate.

| | Guest | Account |
| --- | --- | --- |
| Draw on a board | Yes, on a scratch board kept in the browser (`/draw`) | Yes, saved to the cloud |
| Open a shared link | View, or edit if the owner allows it, under a name they pick | Yes |
| Export to PNG or SVG, export and import board files | Yes (board-file pictures need an account) | Yes |
| Add images | Only on a shared board with an edit link | Yes |
| Several boards, dashboard, other devices | No | Yes |
| Invite people, set link access | No | Yes |
| Version history, templates, comments | No | Yes |
| Follow someone's view | Yes, on a shared board | Yes |

A guest's scratch board lives in `localStorage` only, so it never reaches the database. **Save board** takes them through sign-up, and the drawing becomes their first real board. Google and GitHub sign-in are offered when the server is configured for them (see below).

Account features:

- **Version history**: boards are checkpointed automatically as people work. Name a version, preview an old one and restore it for everyone. The board as it was is saved first, so a restore can be undone.
- **Comments and mentions**: pin a thread to any spot on the board, `@mention` a member and resolve threads. Mentions and replies arrive as live notifications.
- **Follow mode**: click someone's avatar and your view tracks theirs until you pan or zoom.
- **Templates**: start from a built-in kanban, flowchart, retrospective, SWOT or brainstorm board, or save any board as a template of your own.
- **Stars and trash**: star boards, and deleted boards stay in a trash for 30 days before they are removed for good.
- **Profile**: your name, color and photo appear on your cursor and avatar. Connect or disconnect Google and GitHub, or set a password for an account that signed up through one of them.

## Tech stack

| Layer | Tools |
| --- | --- |
| Client | React 19, React Router, Vite, Tailwind CSS 4, Rough.js, perfect-freehand, Socket.IO client |
| Server | Node.js, Express 5, Socket.IO, Mongoose, JSON Web Tokens, scrypt password hashing |
| Database | MongoDB (MongoDB Atlas in production) |

## How real-time sync works

Every change to a board is an **operation**: `{ upsert: Element[], remove: Removal[] }`. Elements are small, immutable JSON objects (a shape's corners, a stroke's points, a text's content).

1. The client applies an operation locally, then batches operations every 40 ms and sends them over Socket.IO.
2. The server checks that the socket has joined that board, merges the operation into an in-memory copy, and passes what changed to everyone else in the room.
3. Changes are written to MongoDB within a quarter of a second for a small board, and flushed when the last person leaves or the server shuts down.

Changes can cross on the way, so boards merge them as a **CRDT**: each group of an element's properties (its shape, its color, its text, …) carries a stamp, the newest wins group by group, removed elements leave tombstones, and each element has a stacking key. The browser and the server share these rules (`shared/`), so everyone ends up with the same board whatever order changes arrive in, and a move and a recolor made at the same moment are both kept. See [docs/realtime-sync.md](docs/realtime-sync.md).

Undo history stores the inverse operation for only the elements you changed, and undo only reverts the properties the step changed, which is why undo is safe with several people drawing at once.

## Getting started

You need [Node.js](https://nodejs.org) 22.22 or newer (`.nvmrc` pins 22.22 for nvm and fnm; react-router 8 needs it).

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

`npm run dev` starts three processes: a local MongoDB, the API on port 5000, and the Vite dev server on port 5173. The local database needs no installation or account. It downloads MongoDB the first time it starts, which can take a few minutes, and keeps its data in `server/.data`.

To use your own database instead, such as a free MongoDB Atlas cluster, copy `server/.env.example` to `server/.env` and set `MONGODB_URI`. If another MongoDB already uses port 27017, set `DEV_DB_PORT` (in `server/.env` or the environment) and both the local database and the API's default connection follow it.

The Vite dev server proxies `/api` and the WebSocket to the API at `http://localhost:5000`. If the API runs elsewhere (another `PORT`, say), start the client with `API_PROXY_TARGET` set to its address, for example `API_PROXY_TARGET=http://localhost:5001 npm run dev -w client`.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the local database, API and client with live reload |
| `npm test` | Runs the client, server and shared tests (see below) |
| `npm run coverage` | Runs the same tests and prints a line, branch and function coverage table for each package |
| `npm run lint` | Checks the code with ESLint (unused and undefined names, React hooks rules) |
| `npm run build` | Builds the client into `client/dist` |
| `npm start` | Runs the production server, which also serves the built client. Set `NODE_ENV=production`, `MONGODB_URI` and `JWT_SECRET` first (see the environment variables below); only `npm run dev` supplies development defaults |
| `npm run format` | Formats the code with Prettier (`npm run format:check` only checks) |

### Tests

`npm test` runs every package's tests with Node's built-in test runner, so there is nothing extra to install.

- **Server (`server/tests`)** starts the real app on a free port against a throwaway in-memory MongoDB, then drives it over REST and Socket.IO. It covers sign-up and login (rate limits, password hashing, login tokens and ending sessions), Google and GitHub sign-in and linking against a stand-in provider, email verification and password reset, who can open and edit a board (owner, invited editor, link viewer, link contributor, guest) including changes that apply live to people already on the board, the dashboard (link-opened boards, archive, stars, trash and its 30-day sweep, board previews), live sync and saving (element rules, size and rate limits, changes sent in pieces, joining and leaving races), shutting down without losing unsaved changes, reading the environment variables, the content security policy and static files, image upload and the rules around it, version history, comments, notifications and templates. A convergence test plays three people editing with the real browser store and server rules, with messages delivered in random order, and expects every screen to match the server. The first run downloads a MongoDB binary, which can take a minute.
- **Client (`client/tests`)** covers the logic that doesn't need a browser: the undo and redo store, the outbox that queues and retries changes, connectors, sticky notes and frames, the resize and turn maths, dark-mode ink, how pictures are sized and placed, the drag draw cache, board export and import, following someone's view, the guest scratch board, sign-in error handling, and the dashboard's section and sort rules. There are no component tests (nothing renders React in a DOM yet).
- **Shared (`shared/tests`)** checks the stacking order and the merge rules, including that the same changes give the same board in whatever order they arrive.

Tests that check something did *not* happen (nobody else received a refused change, say) don't sleep: they make one more round trip on the same socket, which the server answers after everything it sent before, then look.

GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`: formatting, lint, a dependency audit, the tests with coverage, and the production build. It caches the MongoDB binary and cancels a run that a newer push replaces. Dependabot (`.github/dependabot.yml`) opens weekly pull requests for npm packages and pinned Actions.

### Linting

`npm run lint` runs ESLint (`eslint.config.mjs`): its recommended rules, which catch unused and undefined names, plus the React hooks rules for `client/src`. It is not a style guide; Prettier owns formatting.

### Formatting

Code, styles and config are formatted with Prettier (`.prettierrc.json`, 120 columns); Markdown is laid out by hand. Run `npm run format` before committing, or turn on format-on-save in your editor. The commit that first formatted everything is listed in `.git-blame-ignore-revs`; run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` looks past it.

## Environment variables

Server (`server/.env`, see [`server/.env.example`](server/.env.example)):

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | In production | MongoDB connection string |
| `NODE_ENV` | In production | `production` when deployed. Only `development` and `test` may use the built-in signing secret (`npm run dev` sets `development`); any other start needs `JWT_SECRET`, and `production` also turns on proxy trust and the CORS lock-down |
| `JWT_SECRET` | Unless `NODE_ENV` is `development` or `test` | Random string of at least 32 characters used to sign login tokens. A shorter one stops the server from starting: replace it (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`), which logs everyone out once |
| `JWT_EXPIRES_IN` | No | Login lifetime, default `7d`. A bare number means seconds (`3600`); or use a unit (`12h`) |
| `TRUST_PROXY` | No | How many proxies sit in front of the server, for rate limits that count per address. Default `1` in production (right for Render), off otherwise |
| `PORT` | No | API port, default `5000` |
| `DEV_DB_PORT` | No | Port of the local database that `npm run dev` starts, default `27017`. When `MONGODB_URI` is unset, the API connects to it |
| `CLIENT_ORIGIN` | No | Allowed origins when the client is hosted on a different domain |
| `APP_URL` | In production with email | Where people open the app, used for redirects after sign-in and links in emails. Without it, sign-in redirects use the address each request arrives on (so a custom domain works), and links in emails use that address too, which is only safe without email (a request can claim any `Host`). So in production with email on and no `APP_URL`, the server won't start, except on Render without `CLIENT_ORIGIN`, where email links fall back to the service's own address (`RENDER_EXTERNAL_URL`) and the server warns; set `APP_URL` if people use a custom domain |
| `API_URL` | No | Public address of the API, which Google and GitHub send people back to. Only set it when it differs from `APP_URL` (client and API on different addresses; then also set `CLIENT_ORIGIN` and the client's `VITE_API_URL`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | No | Turns on "Continue with Google" |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | No | Turns on "Continue with GitHub" |
| `BREVO_API_KEY`, `EMAIL_FROM` | No | Turns on email verification and password reset (see below) |
| `EMAIL_FROM_NAME` | No | Name emails come from, default `Inkboard` |
| `EMAIL_DAILY_LIMIT` | No | Most emails this server sends a day, default `250` (Brevo's free plan stops at 300). 40% of it is kept for password resets, so a flood of sign-ups can't stop them. Counted in memory by each server process, from 0 at every restart |

Client (`client/.env`): `VITE_API_URL` is only needed if the client and API are deployed separately. `API_PROXY_TARGET` (read from the environment by the Vite dev server, default `http://localhost:5000`) says where `npm run dev` forwards `/api` and the WebSocket.

### Sign in with Google or GitHub

The buttons only appear for providers that have both variables set. Create an OAuth app with each provider and give it this callback URL (replace the host with yours; locally the API is on port 5000, or use the Vite address `http://localhost:5173` since it proxies `/api`):

| Provider | Where to create it | Callback URL |
| --- | --- | --- |
| Google | Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application) | `https://your-app.example/api/auth/oauth/google/callback` |
| GitHub | GitHub → Settings → Developer settings → OAuth Apps | `https://your-app.example/api/auth/oauth/github/callback` |

Then set the client ID and secret as environment variables (on Render, in the service's Environment tab). Signing in with a provider never merges into an existing password account on its own: if the email already has an account, the person is asked to log in and connect the provider from Settings.

### Emails: verifying addresses and resetting passwords

These are **off until email is set up**: with `BREVO_API_KEY` and `EMAIL_FROM` empty, invites work for any account, and there's no verify banner or "Forgot password?" link. Setting both turns everything below on, with no other change.

New accounts get a link to verify their email, which works for the person logged in to that account (the link asks them to log in first). Until they use it they can use the app, but nobody can invite them to a board by email (so nobody can claim someone else's address and receive their invites). "Forgot password?" on the login page emails a link to choose a new password, which also verifies the address. Accounts made with Google or GitHub count as verified.

Emails go through [Brevo](https://www.brevo.com)'s API (free: 300 a day), because Render's free plan blocks SMTP. To set it up:

1. Create a free Brevo account.
2. Open **Settings** (your account name at the top right) → **Senders, Domains, IPs → Senders**, click **Add a sender** with the address emails should come from (your Gmail works), and confirm it with the code Brevo sends.
3. In **Settings → SMTP & API → API Keys**, generate an API key (it's shown once; it starts with `xkeysib-`).
4. On Render (Environment tab), set `BREVO_API_KEY` and `EMAIL_FROM` (the sender from step 2). Links in emails point to `APP_URL`, which on Render falls back to the service's address (e.g. `https://inkboard-b9k8.onrender.com`, with a warning in the log); set it if people use a custom domain. Anywhere else, set `APP_URL` too, or the server won't start.

Without your own domain, some emails may land in spam, so the app tells people to check there. Adding a domain to Brevo later (it gives you DNS records to add) fixes that, and nothing in the app changes.

## Deployment

The repository includes a [Render](https://render.com) Blueprint (`render.yaml`) that deploys the app as a single web service. The server hosts the API, the WebSocket connection and the built client.

1. Create a free cluster on [MongoDB Atlas](https://www.mongodb.com/atlas). Add a database user, allow access from anywhere (`0.0.0.0/0`), and copy the connection string.
2. Push this repository to GitHub.
3. In Render, choose **New → Blueprint** and select the repository.
4. Paste the Atlas connection string when asked for `MONGODB_URI`. `JWT_SECRET` is generated for you. Leave `APP_URL` empty unless the app will have a custom domain (then enter it, e.g. `https://inkboard.example.com`).

### Health check and keep-alive

`GET /health` returns the server and database status, with HTTP 503 if the database is unreachable. Render uses it as the service's health check.

Render's free plan puts a service to sleep after 15 minutes without traffic. The [Keep alive](.github/workflows/keep-alive.yml) GitHub Actions workflow pings `/health` every 10 minutes to prevent that. For a different deployment, set a repository variable named `HEALTH_URL`. A run only fails (and emails you) when the ping still fails after two retries.

Things to know about it: GitHub runs scheduled workflows late when it is busy, so the service can nap now and then; GitHub disables scheduled workflows after 60 days without repository activity (push a commit or re-enable it in the Actions tab); and keeping a free service awake all month uses about 744 of Render's 750 free instance hours, leaving no room for a second free service.

## Project structure

```
client/                 React app (client/tests: node:test, no browser)
  src/components/       Shared UI: buttons, dialogs, menus, error boundary
  src/features/board/   Canvas, drawing engine, tools, store, sync and outbox
  src/features/dashboard/ Board list, cards, sections and search
  src/features/landing/ Interactive demo on the home page
  src/features/templates/ Built-in templates and the new-board dialog
  src/lib/              API client, formatting, guest identity, notifications
  src/pages/            Landing, auth, dashboard, settings and board pages
  src/providers/        Auth, theme, socket and notification context
shared/                 Rules the browser and server share: merging changes, stacking order,
                        element validation, size limits
server/                 Express + Socket.IO API
  src/config/           Environment variables and the database connection
  src/controllers/      REST handlers: auth, OAuth, boards, comments, versions, templates
  src/middleware/       Auth, rate limits, error handling
  src/realtime/         Socket events, live board sessions, operations, rate limits
  src/models/           Mongoose schemas
  src/services/         Saving boards, images, email, previews, trash, versions
  scripts/              Local development database and environment
render.yaml             One-click deploy configuration
eslint.config.mjs       Lint rules (`npm run lint`)
.nvmrc                  Node version for nvm and fnm
.github/                CI, the keep-alive cron for the free hosting plan, Dependabot
```
