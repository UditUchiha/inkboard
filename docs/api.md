# Inkboard API

A small HTTP API for reading and changing your boards from scripts and tools. Changes made through it go through the same checks as changes made in the app, and show up straight away for everyone who has the board open.

## Tokens

Make a token in **Settings → API tokens**. Each one either:

- **reads boards**, or
- **reads and changes boards**.

A token can do on each board what you can do there. On a board shared with you by a view link, it can only read, whatever kind of token it is. Copy the token when you make it: it's shown only once. Delete it in Settings to stop it working.

Send it with every request:

```
Authorization: Bearer ink_…
```

Tokens work only for this API (and the MCP server), not for the rest of the app. Each person can make 120 calls a minute.

## Endpoints

All paths start with `/api/v1`. Bodies are JSON.

| Method and path | Token | What it does |
| --- | --- | --- |
| `GET /boards` | read | Your boards (owned or invited to), most recently changed first: `{ boards: [{ id, title, role, updatedAt }] }` |
| `POST /boards` | change | Makes an empty board you own. Body: `{ title }`. Answers `201 { board: { id, title, role } }` |
| `GET /boards/:id` | read | `{ board: { id, title, role, elements } }`, with the elements in the form below |
| `POST /boards/:id/elements` | change | Adds or changes elements. Body: `{ elements: [...] }` (at most 500). Answers `{ elements, dropped }`: the elements as the board now has them, and the ids of new ones it had no room for |
| `DELETE /boards/:id/elements` | change | Removes elements. Body: `{ ids: [...] }`. Answers `{ removed }`. Ids the board doesn't have are ignored. Removing a frame doesn't remove what's in it |

Errors answer with a status and `{ error: "a sentence saying what's wrong" }`.

## Elements

Every element has an `id` and a `type`. When you add one, the `id` is optional; one is made if you leave it out.

To change an element, send its `id` with just the fields to change. Its `type` can't change.

| Type | Where it is | Its own fields |
| --- | --- | --- |
| `rectangle`, `ellipse`, `triangle`, `diamond` | `x`, `y`, `width`, `height` (a triangle points up from its base along the bottom, a diamond has its corners at the middles of the sides) | `stroke`, `fill` (or `null`), `strokeWidth`, `sketchy`, `angle` |
| `sticky` | `x`, `y`, `width`, `height` | `text`, `fill`, `font`, `angle` |
| `frame` | `x`, `y`, `width`, `height` | `name` |
| `text` | `x`, `y` (its top left) | `text` (required), `fontSize`, `font`, `stroke`, `angle` |
| `line`, `arrow` | `x1`, `y1`, `x2`, `y2`, or `from` and `to` | `from`, `to` (ids of what each end is attached to), `text` (a label), `route` (`straight`, `curved`, `elbow`), `startHead` (arrows), `stroke`, `strokeWidth` |
| `pen` | `points`: `[[x, y], …]` | `stroke`, `penSize` |
| `image` | `x`, `y`, `width`, `height` | `alt`. Pictures can be read and moved but not uploaded through the API |

Other rules:

- **Colors** are hex, like `#e03131`.
- **Fonts** are `hand`, `sans` or `code`.
- **Equations:** a `text` that is all LaTeX between `$$` signs, like `$$\frac{a}{b}$$`, is drawn as a typeset equation. It's stored and returned as written.
- **Lines and arrows** need either both ends' coordinates or what they're attached to. An attached end is drawn at the edge of its shape, wherever the coordinates say.
- **Stacking:** new elements go on top.

## Example

```sh
TOKEN=ink_…
BOARD=$(curl -s -X POST https://your-inkboard/api/v1/boards \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Plan"}' | jq -r .board.id)

curl -s -X POST https://your-inkboard/api/v1/boards/$BOARD/elements \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"elements":[
        {"id":"idea","type":"sticky","x":0,"y":0,"width":200,"height":200,"text":"Ship it"},
        {"id":"done","type":"rectangle","x":400,"y":50,"width":160,"height":100},
        {"type":"arrow","from":"idea","to":"done"}
      ]}'
```

## MCP server

AI assistants can use your boards through the MCP server at `/mcp`, with the same tokens. It uses MCP's Streamable HTTP transport. Its tools are:

- `list_boards`
- `read_board`
- `create_board`
- `add_or_update_elements` (elements in the form above)
- `delete_elements`

A token that only reads can't run the last three.

Claude Code:

```sh
claude mcp add --transport http inkboard https://your-inkboard/mcp --header "Authorization: Bearer ink_…"
```

Clients that take a URL and headers in their settings (Cursor's `mcp.json`, say):

```json
{ "mcpServers": { "inkboard": { "url": "https://your-inkboard/mcp", "headers": { "Authorization": "Bearer ink_…" } } } }
```

Clients that only start local servers (Claude Desktop's config file) can go through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "inkboard": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-inkboard/mcp", "--header", "Authorization: Bearer ink_…"]
    }
  }
}
```

