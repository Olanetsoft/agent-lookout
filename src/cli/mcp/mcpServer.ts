// `agent-lookout mcp`: a Model Context Protocol server for an agent that keeps
// track of the person's other agents. The app that runs the agent starts it and
// speaks to it over its stdin and stdout, so it listens on no port. Each tool
// call reads `/api/sessions` from the Agent Lookout already running on this
// machine, exactly as `agent-lookout status` does: from a loopback address
// only, with no `Origin` and no notifications header. No tool acts.
//
// stdout carries the protocol and nothing else. `agentLookout.ts` loads this
// file only for this command, so `status` never loads the protocol's library.

import type { Readable, Writable } from "node:stream";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { readAppVersion } from "../../collector/version.ts";
import { STATUS_ORDER } from "../../core/sessions/sorting.ts";
import { findSnapshot, type Addresses, type Reading } from "../localServer.ts";
import {
  INSTRUCTIONS,
  listSessions,
  sessionsNeedingYou,
  sourceList,
  TOOLS,
  type ToolSnapshot,
} from "./toolAnswers.ts";

export interface McpServerOptions {
  /** Where Agent Lookout is asked, in order, as `addressesToTry` gave them. */
  addresses: Addresses;
  read: (address: string) => Promise<Reading>;
  now: () => number;
  stdin: Readable;
  stdout: Writable;
}

/** Every tool only reads this machine's Agent Lookout, and asking twice changes nothing. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Serves the tools until the client closes stdin. Resolves then, once the
 * server has closed. A tool whose Agent Lookout cannot be reached answers with
 * an error that says so and how to start it, and the server goes on serving.
 */
export async function serveMcp(options: McpServerOptions): Promise<void> {
  const server = new McpServer(
    { name: "agent-lookout", version: readAppVersion() },
    { instructions: INSTRUCTIONS },
  );

  /** Reads Agent Lookout once and answers with what `build` makes of it, as JSON. */
  async function answer(
    build: (snapshot: ToolSnapshot, now: number) => object,
  ): Promise<CallToolResult> {
    const found = await findSnapshot(options.addresses, options.read);
    if (found.kind === "failed") {
      return { isError: true, content: [{ type: "text", text: found.message }] };
    }
    const result = build(found.snapshot, options.now());
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as Record<string, unknown>,
    };
  }

  server.registerTool(
    "list_sessions",
    {
      ...TOOLS.list_sessions,
      inputSchema: {
        status: z
          .enum(STATUS_ORDER)
          .optional()
          .describe("List only the sessions with this status. Left out, every session is listed."),
      },
      annotations: READ_ONLY,
    },
    ({ status }) => answer((snapshot, now) => listSessions(snapshot, now, status ?? null)),
  );
  server.registerTool(
    "sessions_needing_you",
    { ...TOOLS.sessions_needing_you, annotations: READ_ONLY },
    () => answer(sessionsNeedingYou),
  );
  server.registerTool("sources", { ...TOOLS.sources, annotations: READ_ONLY }, () =>
    answer(sourceList),
  );

  const { stdin, stdout } = options;
  const ended = new Promise<void>((resolve) => {
    stdin.once("end", resolve);
    stdin.once("close", resolve);
  });
  await server.connect(new StdioServerTransport(stdin, stdout));
  await ended;
  await server.close();
}
