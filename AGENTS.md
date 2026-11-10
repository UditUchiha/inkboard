# AGENTS.md: Inkboard

**This file is the single source of truth for how code is written in this repo.** `CLAUDE.md`
points here. If you change a convention, change it here and only here.

## Commands

```bash
npm run dev              # local MongoDB + API (5000) + Vite (5173)
npm test                 # every workspace's tests (node:test, real server, in-memory MongoDB)
npm run lint             # ESLint
npm run typecheck        # tsc in client, server, shared (and their tests)
npm run format           # Prettier (format:check only checks)
npm run check:structure  # the layout rules below (scripts/check-structure.ts)
npm run check            # format:check + lint + typecheck + check:structure. Must pass before a PR.
```

While iterating, run one test file (`node --import ./tests/setup.js --test tests/store.test.ts` in
`client/`, `node --test tests/<file>.test.ts` in `server/`), and the whole suite once at the end.

## Ground truth

- **TypeScript without a build step.** Node strips types from the server's `.ts` files and Vite does
  the same for the browser. Only erasable syntax: no `enum`, `namespace` or parameter properties
  (`erasableSyntaxOnly`). Server and shared imports carry the `.ts` extension; client imports don't.
- **`shared/` holds what both sides must agree on**: element types, validation (`element-rules.ts`),
  the merge rules (`board-merge.ts`, `text-merge.ts`), the socket and HTTP API types. Never copy one
  of these into client or server; import it from `@inkboard/shared/...`.
- **The server is a single instance.** Open boards live in memory (`server/src/realtime/sessions.ts`)
  and are saved shortly after each change. Don't add anything that assumes two instances.
- **React 19 without the React Compiler.** `useMemo`/`useCallback`/`memo` are fine where referential
  stability matters, with a reason. The board itself isn't React state: it lives in a store
  (`lib/sync/store.ts`) and is drawn on a canvas.
- **Tests run the real thing.** Server tests start the app against an in-memory MongoDB and talk to
  it over HTTP and Socket.IO; there are no mocks of our own code. Client tests cover logic that
  doesn't need a browser. A change in behaviour comes with a test.
- **AI runs in the browser with the person's own key** (`lib/ai/`). The server never sees it.

## Project structure

```
client/src/
├── pages/        # one per route: reads the URL, guards, renders a feature screen. Thin.
├── features/     # feature slices: board, dashboard, landing, templates
├── components/   # app-wide UI (Button, Dialog, Menu…). Knows nothing about any feature.
├── hooks/        # app-wide hooks
├── lib/          # app-wide helpers: the API client, session, formatting
└── providers/    # React context providers
server/src/       # layers: routes → controllers → services → models; realtime/ for Socket.IO
shared/src/       # code both sides import
```

### Feature anatomy

```
client/src/features/<feature>/
├── components/   # .tsx only
├── hooks/        # use*.ts only
├── constants/
├── types/
└── lib/          # pure helpers: no JSX, no React. Board groups them by domain:
                  # elements/, sync/, render/, files/, ai/, mermaid/
```

1. Nothing sits at a feature's root. No `index.ts` barrels; import the concrete file.
2. **Dependency direction:** `board` is the core feature and imports no other feature. Other features
   may import from `board`. App-wide folders (`components/`, `hooks/`, `lib/`, `providers/`) never
   import a feature. If two features need something that isn't board's, lift it to an app-wide folder.
3. **Size:** a `.tsx` file stays under **400 lines** (aim for 300), a `.ts` file under **600**
   (aim for 400). Past that, split by responsibility: extract a sub-component, a hook, or a `lib/`
   module. `check:structure` enforces it; files still over are listed in `SIZE_DEBT` and leave it in
   the change that splits them. Never add to that list.
4. **Server:** a new HTTP endpoint is a route + controller function + service; database access lives in
   services and models, never in routes. Socket event handlers live in `realtime/`, one file per area.

## Code conventions

### Comments

**Only where genuinely needed, and short.**

- Prefer a better name or a smaller function over a comment.
- **One line**, two if the reason really needs it. Never a paragraph. Longer explanations belong in
  `docs/`.
- Explain **why**, never **what**. `// reset on open` is noise; `// the parent only remounts on join,
so a reopen reuses this instance` earns its place.
- A workaround names what forces it (a browser bug, a library limit, a lint rule).
- No JSDoc prose on internal functions, no section banners, no changelog ("previously…", "this used
  to…"; git has that), no commented-out code, no `TODO` without a reason.

### Components

- Props are a named `interface <Component>Props` above the component.
- One responsibility per component. Order inside: hooks, derived values, handlers, render, `return`.
- `{cond && <X />}` when only one side renders; `cond ? <A /> : <B />` only when both do. No nested
  ternaries in JSX.
- No pass-through wrappers: a component or function that only forwards its arguments is inlined.

### Hooks

- A custom hook does one thing and lives in a `hooks/` folder, named `use*`.
- Dependency arrays are complete (`react-hooks/exhaustive-deps` is an error). Don't silence it without
  a one-line reason.
- An effect that subscribes, starts a timer, adds a listener or starts a request returns a cleanup.
- **Effects are for syncing with something outside React** (the socket, the canvas, the DOM, storage).
  Don't use one to derive state (compute it during render) or to respond to an event (do it in the
  handler). To reset state when a prop changes, remount with `key`, or adjust during render:

  ```tsx
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft("");
  }
  ```

- `useRef` is for values that must not re-render (timer ids, DOM nodes, the latest callback). Don't
  read `ref.current` during render to decide what to render.
- `react-hooks/set-state-in-effect`, `react-hooks/refs` and `react-hooks/purity` are errors. A rare
  deliberate exception gets `// eslint-disable-next-line <rule> -- <why>`.

### Values and types

- No `any`. Validate anything from outside (socket payloads, request bodies, stored JSON, an AI's
  answer) before trusting it; the server's guards are the model.
- A limit, duration or storage key shared by two files is a named constant; a limit both sides
  enforce lives in `shared/src/limits.ts`.
- No `console.log` in committed code (`console.warn`/`console.error` are fine on the server).

## Never do this

- Read, print or commit `.env` files or secret values.
- Change behaviour in a commit that moves or reformats files.
- Import across features against the dependency direction above, or add a barrel `index.ts`.
- Add a state-management, schema or test library without asking first.
- Add AI attribution (`Co-Authored-By`, "Generated with…") to commits or PR descriptions.

## Git

Branch from `main`, keep PRs to one concern, and run `npm run check` and `npm test` before opening
one. Commit messages: a short imperative subject, then a body saying why.
