# Inkboard

A real-time collaborative whiteboard. Sketch with hand-drawn shapes, invite people by email, and watch everyone's cursors and strokes appear live.

**Live demo: [inkboard-b9k8.onrender.com](https://inkboard-b9k8.onrender.com)**

![Inkboard board with a collaborator's cursor](docs/screenshots/board.png)

## Features

- **Live collaboration**: strokes stream to everyone on the board as they're drawn, with named cursors and a presence list.
- **Drawing tools**: pen (pressure-sensitive with a stylus), rectangle, ellipse, arrow, line, text, eraser, plus select-and-move. Selected shapes, strokes and text can be resized from any side or corner and turned with the handle above them (hold Shift to keep proportions or snap to 15° steps). Lines and arrows have a handle on each end.
- **Hand-drawn or clean**: shapes are rendered with Rough.js. Switch any of them between a sketchy and a crisp look.
- **Infinite canvas**: pan with the hand tool, space-drag or the scroll wheel. Zoom with Ctrl/⌘ + wheel, trackpad pinch or two fingers.
- **Per-person undo and redo**: undoing your own change never wipes out what collaborators drew in the meantime.
- **Sharing with levels**: invite people by email to edit, remove them, or leave a board. The owner can also let *anyone with the link* view or edit the board, with no account needed. Viewers can pan and zoom but not change anything, and nobody outside the invite list sees invitees' email addresses. Access is checked on every request and socket event, and changes apply live to people who already have the board open.
- **Boards dashboard**: live thumbnails, search, filters for owned and shared boards, rename and delete.
- **Works offline briefly**: edits made while disconnected are queued and synced after reconnecting.
- **Light and dark themes**: dark mode turns the graph paper into a blueprint.
- **Connectors**: draw an arrow or line from one shape, note, picture or text to another and it stays attached, following them as they move, resize or turn, on everyone's screen. Drag an end onto another shape to reconnect it, or off to let go.
- **Sticky notes and frames**: notes (<kbd>S</kbd>) in six colors, whose writing wraps and shrinks to fit. Frames (<kbd>F</kbd>) are named white pages that hold whatever lies inside them: moving, copying or deleting a frame does the same to its contents. The Kanban and Retrospective templates are built from them.
- **Images**: add pictures with the toolbar button (or <kbd>I</kbd>), by pasting, or by dropping files onto the board. They are shrunk in the browser, stored in MongoDB (GridFS), and resize and turn like any shape. Accounts, invited editors and guests with an edit link can add them; see [docs/image-storage.md](docs/image-storage.md) for limits and how to move storage to Cloudflare R2 or Cloudinary.
- **Keyboard shortcuts** for every tool and action (press <kbd>?</kbd> on a board), export to PNG or SVG, and board files (`.inkboard.json`, pictures included) to export and import again.

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
| Version history, templates, comments, follow mode | No | Yes |

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
| Server | Node.js, Express 5, Socket.IO, Mongoose, JSON Web Tokens, bcrypt |
| Database | MongoDB (MongoDB Atlas in production) |

## How real-time sync works

Every change to a board is an **operation**: `{ upsert: Element[], remove: Removal[] }`. Elements are small, immutable JSON objects (a shape's corners, a stroke's points, a text's content).

1. The client applies an operation locally, then batches operations every 40 ms and sends them over Socket.IO.
2. The server checks that the socket has joined that board, merges the operation into an in-memory copy, and passes what changed to everyone else in the room.
3. Changes are written to MongoDB within a quarter of a second for a small board, and flushed when the last person leaves or the server shuts down.

Changes can cross on the way, so boards merge them as a **CRDT**: each group of an element's properties (its shape, its color, its text, …) carries a stamp, the newest wins group by group, removed elements leave tombstones, and each element has a stacking key. The browser and the server share these rules (`shared/`), so everyone ends up with the same board whatever order changes arrive in, and a move and a recolor made at the same moment are both kept. See [docs/realtime-sync.md](docs/realtime-sync.md).

Undo history stores the inverse operation for only the elements you changed, and undo only reverts the properties the step changed, which is why undo is safe with several people drawing at once.

## Getting started

You need [Node.js](https://nodejs.org) 20.12 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

`npm run dev` starts three processes: a local MongoDB, the API on port 5000, and the Vite dev server on port 5173. The local database needs no installation or account. It downloads MongoDB the first time it starts, which can take a few minutes, and keeps its data in `server/.data`.

To use your own database instead, such as a free MongoDB Atlas cluster, copy `server/.env.example` to `server/.env` and set `MONGODB_URI`.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the local database, API and client with live reload |
| `npm test` | Runs the client and server tests (see below) |
| `npm run build` | Builds the client into `client/dist` |
| `npm start` | Runs the production server, which also serves the built client |
| `npm run format` | Formats the code with Prettier (`npm run format:check` only checks) |

### Tests

`npm test` runs every package's tests with Node's built-in test runner, so there is nothing extra to install.

- **Server (`server/tests`)** starts the real app on a free port against a throwaway in-memory MongoDB, then drives it over REST and Socket.IO. It covers sign-up and login, who can open and edit a board (owner, invited editor, link viewer, link contributor, guest) including changes that apply live to people already on the board, the dashboard (link-opened boards, archive, stars, trash and its 30-day sweep), live sync and saving, size limits, image upload and the rules around it, version history, comments, notifications and templates. The first run downloads a MongoDB binary, which can take a minute.
- **Client (`client/tests`)** covers the undo and redo store, the dashboard's section and sort rules, the resize and turn maths, and how pictures are sized and placed.
- **Shared (`shared/tests`)** checks the stacking order and the merge rules, including that the same changes give the same board in whatever order they arrive. A server test plays three people editing with the real browser store and server rules, with messages delivered in random order, and expects every screen to match the server.

GitHub Actions checks the formatting and runs the tests and the build on every push and pull request (`.github/workflows/ci.yml`).

### Formatting

Code, styles and config are formatted with Prettier (`.prettierrc.json`, 120 columns); Markdown is laid out by hand. Run `npm run format` before committing, or turn on format-on-save in your editor. The commit that first formatted everything is listed in `.git-blame-ignore-revs`; run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` looks past it.

## Environment variables

Server (`server/.env`, see [`server/.env.example`](server/.env.example)):

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | In production | MongoDB connection string |
| `JWT_SECRET` | In production | Long random string used to sign login tokens |
| `JWT_EXPIRES_IN` | No | Login lifetime, default `7d` |
| `PORT` | No | API port, default `5000` |
| `CLIENT_ORIGIN` | No | Allowed origins when the client is hosted on a different domain |
| `APP_URL` | No | Public address of the app, used for sign-in redirects and links in emails. Defaults to the address each request arrives on |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | No | Turns on "Continue with Google" |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | No | Turns on "Continue with GitHub" |
| `BREVO_API_KEY`, `EMAIL_FROM` | No | Turns on email verification and password reset (see below) |
| `EMAIL_FROM_NAME` | No | Name emails come from, default `Inkboard` |

Client (`client/.env`): `VITE_API_URL` is only needed if the client and API are deployed separately.

### Sign in with Google or GitHub

The buttons only appear for providers that have both variables set. Create an OAuth app with each provider and give it this callback URL (replace the host with yours; locally the API is on port 5000, or use the Vite address `http://localhost:5173` since it proxies `/api`):

| Provider | Where to create it | Callback URL |
| --- | --- | --- |
| Google | Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application) | `https://your-app.example/api/auth/oauth/google/callback` |
| GitHub | GitHub → Settings → Developer settings → OAuth Apps | `https://your-app.example/api/auth/oauth/github/callback` |

Then set the client ID and secret as environment variables (on Render, in the service's Environment tab). Signing in with a provider never merges into an existing password account on its own: if the email already has an account, the person is asked to log in and connect the provider from Settings.

### Emails: verifying addresses and resetting passwords

These are **off until email is set up**: with `BREVO_API_KEY` and `EMAIL_FROM` empty, invites work for any account, and there's no verify banner or "Forgot password?" link. Setting both turns everything below on, with no other change.

New accounts get a link to verify their email. Until they click it they can use the app, but nobody can invite them to a board by email (so nobody can claim someone else's address and receive their invites). "Forgot password?" on the login page emails a link to choose a new password, which also verifies the address. Accounts made with Google or GitHub count as verified.

Emails go through [Brevo](https://www.brevo.com)'s API (free: 300 a day), because Render's free plan blocks SMTP. To set it up:

1. Create a free Brevo account.
2. Open **Settings** (your account name at the top right) → **Senders, Domains, IPs → Senders**, click **Add a sender** with the address emails should come from (your Gmail works), and confirm it with the code Brevo sends.
3. In **Settings → SMTP & API → API Keys**, generate an API key (it's shown once; it starts with `xkeysib-`).
4. On Render (Environment tab), set `BREVO_API_KEY`, `EMAIL_FROM` (the sender from step 2), and `APP_URL` (e.g. `https://inkboard-b9k8.onrender.com`) so links in emails point to the app.

Without your own domain, some emails may land in spam, so the app tells people to check there. Adding a domain to Brevo later (it gives you DNS records to add) fixes that, and nothing in the app changes.

## Deployment

The repository includes a [Render](https://render.com) Blueprint (`render.yaml`) that deploys the app as a single web service. The server hosts the API, the WebSocket connection and the built client.

1. Create a free cluster on [MongoDB Atlas](https://www.mongodb.com/atlas). Add a database user, allow access from anywhere (`0.0.0.0/0`), and copy the connection string.
2. Push this repository to GitHub.
3. In Render, choose **New → Blueprint** and select the repository.
4. Paste the Atlas connection string when asked for `MONGODB_URI`. `JWT_SECRET` is generated for you.

### Health check and keep-alive

`GET /health` returns the server and database status, with HTTP 503 if the database is unreachable. Render uses it as the service's health check.

Render's free plan puts a service to sleep after 15 minutes without traffic. The [Keep alive](.github/workflows/keep-alive.yml) GitHub Actions workflow pings `/health` every 10 minutes to prevent that. For a different deployment, set a repository variable named `HEALTH_URL`.

## Project structure

```
client/                 React app
  src/features/board/   Canvas, drawing engine, tools, sync
  src/features/landing/ Interactive demo on the home page
  src/pages/            Landing, auth, dashboard and board pages
  src/providers/        Auth, theme and socket context
shared/                 Rules the browser and server share: merging changes, stacking order
server/                 Express + Socket.IO API
  src/controllers/      REST handlers for auth and boards
  src/realtime/         Socket events, live board sessions, operations
  src/models/           Mongoose schemas
render.yaml             One-click deploy configuration
.github/workflows/      Keep-alive cron for the free hosting plan
```
