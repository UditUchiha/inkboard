import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.ts";
import * as publicApi from "../services/public-api.ts";

// The MCP server (Model Context Protocol, https://modelcontextprotocol.io): AI assistants use the boards through the
// same actions as the public API (see services/public-api.ts and docs/api.md), with the same API tokens. It speaks
// the protocol's Streamable HTTP transport without sessions: each POST is one JSON-RPC message, answered with JSON.
// It has tools and nothing else, which is all the protocol asks of a server that offers only tools.

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const ELEMENTS_HELP =
  "Elements: every one has `id` and `type`. rectangle, ellipse, sticky (`text`, `fill`), frame (`name`) and image are " +
  "`x`, `y`, `width`, `height`. text is `x`, `y`, `text`, `fontSize`. line and arrow are `x1`, `y1`, `x2`, `y2`, or " +
  "`from` and `to` (ids of the elements their ends attach to), with an optional `text` label and `route` (straight, " +
  "curved, elbow). pen is `points` [[x, y], …]. Colors are hex (`stroke`, `fill`), fonts hand, sans or code. " +
  "Coordinates are board units; y grows downwards.";

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write: boolean;
  run: (userId: string, input: Record<string, unknown>) => Promise<unknown>;
};

const boardId = { type: "string", description: "The board's id, from list_boards." };

const TOOLS: Tool[] = [
  {
    name: "list_boards",
    description: "Lists the boards the user owns or was invited to, most recently changed first.",
    inputSchema: { type: "object", properties: {} },
    write: false,
    run: (userId) => publicApi.listBoards(userId),
  },
  {
    name: "read_board",
    description: `Reads a board: its title, the user's role on it, and all its elements. ${ELEMENTS_HELP}`,
    inputSchema: { type: "object", properties: { board_id: boardId }, required: ["board_id"] },
    write: false,
    run: (userId, input) => publicApi.readBoard(userId, String(input.board_id)),
  },
  {
    name: "create_board",
    description: "Makes a new, empty board the user owns, and returns its id.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    write: true,
    run: (userId, input) => publicApi.createBoard(userId, input.title),
  },
  {
    name: "add_or_update_elements",
    description:
      "Adds elements to a board, or changes ones it has: send an existing element's `id` with only the fields to " +
      `change. Everyone with the board open sees it at once. Give ids to new elements you'll refer to (an arrow's ` +
      `\`from\` and \`to\`). At most 500 at once. ${ELEMENTS_HELP}`,
    inputSchema: {
      type: "object",
      properties: {
        board_id: boardId,
        elements: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["board_id", "elements"],
    },
    write: true,
    run: (userId, input) => publicApi.writeElements(userId, String(input.board_id), input.elements),
  },
  {
    name: "delete_elements",
    description: "Removes elements from a board by id. Removing a frame doesn't remove what's in it.",
    inputSchema: {
      type: "object",
      properties: { board_id: boardId, ids: { type: "array", items: { type: "string" } } },
      required: ["board_id", "ids"],
    },
    write: true,
    run: (userId, input) => publicApi.removeElements(userId, String(input.board_id), input.ids),
  },
];

const describe = ({ name, description, inputSchema, write }: Tool) => ({
  name,
  description,
  inputSchema,
  annotations: { readOnlyHint: !write, destructiveHint: name === "delete_elements" },
});

type Message = { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: Record<string, unknown> };

const result = (id: Message["id"], value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: Message["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

// What a tool call answers: its result as JSON text, or why it failed, which the assistant reads and can act on.
async function callTool(req: Request, params: Record<string, unknown> | undefined) {
  const tool = TOOLS.find(({ name }) => name === params?.name);
  if (!tool) return null;
  const input = (params?.arguments ?? {}) as Record<string, unknown>;
  try {
    if (tool.write && req.apiScope !== "write") {
      throw new HttpError(403, "This token can only read boards. Make one that can change them in Settings.");
    }
    const output = await tool.run(req.userId!, input); // requireApiToken has set it
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
}

/** POST /mcp: one JSON-RPC message. Notifications and replies to the server get 202 and no body. */
export async function handleMcp(req: Request, res: Response) {
  const message = req.body as Message | undefined;
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    return res.status(400).json(failure(null, -32600, "Send one JSON-RPC 2.0 message."));
  }
  if (typeof message.method !== "string") return res.status(202).end(); // a reply, to nothing this server asked
  if (message.id === undefined) return res.status(202).end(); // a notification
  const { id, method, params } = message;

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked as string) ? asked : PROTOCOL_VERSIONS[0];
      return res.json(
        result(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "inkboard", version: "1.0.0" },
          instructions:
            "Inkboard is a collaborative whiteboard. Use list_boards to find a board, read_board to see what's on it, " +
            "and add_or_update_elements to draw on it; people with the board open see changes as they happen.",
        }),
      );
    }
    case "ping":
      return res.json(result(id, {}));
    case "tools/list":
      return res.json(result(id, { tools: TOOLS.map(describe) }));
    case "tools/call": {
      const called = await callTool(req, params);
      return res.json(called ? result(id, called) : failure(id, -32602, `There's no tool called ${params?.name}.`));
    }
    default:
      return res.json(failure(id, -32601, `This server doesn't do ${method}.`));
  }
}

/** Other methods on /mcp: there are no server-sent streams or sessions to open or end. */
export function mcpMethodNotAllowed(req: Request, res: Response) {
  res.set("Allow", "POST").status(405).json({ error: "Use POST." });
}
