# Inkboard

A real-time collaborative whiteboard. Sketch with hand-drawn shapes, invite people by email, and watch everyone's cursors and strokes appear live.

**Live demo: [inkboard-b9k8.onrender.com](https://inkboard-b9k8.onrender.com)**

![Inkboard board with a collaborator's cursor](docs/screenshots/board.png)

## Features

- **Live collaboration**: strokes stream to everyone on the board as they're drawn, with named cursors and a presence list.
- **Drawing tools**: pen (pressure-sensitive with a stylus), rectangle, ellipse, arrow, line, text, eraser, plus select-and-move.
- **Hand-drawn or clean**: shapes are rendered with Rough.js. Switch any of them between a sketchy and a crisp look.
- **Infinite canvas**: pan with the hand tool, space-drag or the scroll wheel. Zoom with Ctrl/⌘ + wheel, trackpad pinch or two fingers.
- **Per-person undo and redo**: undoing your own change never wipes out what collaborators drew in the meantime.
- **Sharing with levels**: invite people by email to edit, remove them, or leave a board. The owner can also let *anyone with the link* view or edit the board, with no account needed. Viewers can pan and zoom but not change anything, and nobody outside the invite list sees invitees' email addresses. Access is checked on every request and socket event, and changes apply live to people who already have the board open.
- **Boards dashboard**: live thumbnails, search, filters for owned and shared boards, rename and delete.
- **Works offline briefly**: edits made while disconnected are queued and synced after reconnecting.
- **Light and dark themes**: dark mode turns the graph paper into a blueprint.
- **Keyboard shortcuts** for every tool and action (press <kbd>?</kbd> on a board), and export to PNG.

| Dashboard | Dark mode |
| --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) | ![Dark mode](docs/screenshots/board-dark.png) |

## Guests and accounts

Nobody has to sign up to try Inkboard. Guests draw first; accounts keep, share and collaborate.

| | Guest | Account |
| --- | --- | --- |
| Draw on a board | Yes, on a scratch board kept in the browser (`/draw`) | Yes, saved to the cloud |
| Open a shared link | View, or edit if the owner allows it, under a name they pick | Yes |
| Export to PNG | Yes | Yes |
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

Every change to a board is an **operation**: `{ upsert: Element[], remove: id[] }`. Elements are small, immutable JSON objects (a shape's corners, a stroke's points, a text's content), so the same operation can be applied identically on every client and on the server.

1. The client applies an operation locally, then batches operations every 40 ms and sends them over Socket.IO.
2. The server checks that the socket has joined that board, applies the operation to an in-memory copy, and broadcasts it to everyone else in the room.
3. Changes are written to MongoDB at most once per second, and flushed when the last person leaves or the server shuts down.

Undo history stores the inverse operation for only the elements you changed, which is why undo is safe with several people drawing at once.

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
| `npm run build` | Builds the client into `client/dist` |
| `npm start` | Runs the production server, which also serves the built client |

## Environment variables

Server (`server/.env`, see [`server/.env.example`](server/.env.example)):

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | In production | MongoDB connection string |
| `JWT_SECRET` | In production | Long random string used to sign login tokens |
| `JWT_EXPIRES_IN` | No | Login lifetime, default `7d` |
| `PORT` | No | API port, default `5000` |
| `CLIENT_ORIGIN` | No | Allowed origins when the client is hosted on a different domain |
| `APP_URL` | No | Public address of the app, used for sign-in redirects. Defaults to the address each request arrives on |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | No | Turns on "Continue with Google" |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | No | Turns on "Continue with GitHub" |

Client (`client/.env`): `VITE_API_URL` is only needed if the client and API are deployed separately.

### Sign in with Google or GitHub

The buttons only appear for providers that have both variables set. Create an OAuth app with each provider and give it this callback URL (replace the host with yours; locally the API is on port 5000, or use the Vite address `http://localhost:5173` since it proxies `/api`):

| Provider | Where to create it | Callback URL |
| --- | --- | --- |
| Google | Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application) | `https://your-app.example/api/auth/oauth/google/callback` |
| GitHub | GitHub → Settings → Developer settings → OAuth Apps | `https://your-app.example/api/auth/oauth/github/callback` |

Then set the client ID and secret as environment variables (on Render, in the service's Environment tab). Signing in with a provider never merges into an existing password account on its own: if the email already has an account, the person is asked to log in and connect the provider from Settings.

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
server/                 Express + Socket.IO API
  src/controllers/      REST handlers for auth and boards
  src/realtime/         Socket events, live board sessions, operations
  src/models/           Mongoose schemas
render.yaml             One-click deploy configuration
.github/workflows/      Keep-alive cron for the free hosting plan
```
