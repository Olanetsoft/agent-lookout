# The MCP server

`agent-lookout mcp` is a read-only [Model Context Protocol](https://modelcontextprotocol.io) server that an agent's app, such as Claude Code, starts and talks to over stdin and stdout, with no port. Each of its three tools, `list_sessions`, `sessions_needing_you` and `sources`, makes one `GET /api/sessions` to the Agent Lookout already running on this computer and answers from that snapshot, never with what a waiting session is asking, its last message or its token counts. `mcpServer.ts` builds the server and registers the tools, and `toolAnswers.ts` turns a snapshot into each answer.

[The MCP server](../../../docs/TOUR.md#the-mcp-server) in the tour says why it works this way, and [For your agents](../../../docs/GUIDE.md#for-your-agents) in the guide says how to add it to an app.
