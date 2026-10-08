# Claude Code adapter notes

These notes record the token counts Agent Lookout reads from a Claude Code transcript, where each comes from, and what breaks when Claude Code changes. The rest of the adapter is in [ARCHITECTURE.md](../ARCHITECTURE.md#the-claude-code-adapter), and the transcript lines it reads for what a session is asking and what it last said are in the comments of `src/collector/adapters/claude-code/transcript/lastAsk.ts` and `lastSaid.ts`.

Claude Code does not document its transcripts. What follows was seen in the transcripts of Claude Code 2.1.219, 2.1.289 and 2.1.293, from the field names and numbers alone, and none of it is promised. The code is `src/collector/adapters/claude-code/transcript/lastUsage.ts`.

## When they are read

Only with a session's last message, from the same last 256 KB of its transcript, when `GET /api/sessions/last-message` asks for it. No transcript is opened or read for the counts that would not be for the last message, no poll reads them, and they are never put on a session in `GET /api/sessions`. `AGENT_LOOKOUT_LAST_MESSAGE=off` or `AGENT_LOOKOUT_WAITING_TEXT=off` stops them with the last message.

## The lines

- Each block of an assistant reply, `thinking`, `text` or `tool_use`, is a line of its own with `"type":"assistant"`. The lines of one reply share its `message.id` and its `requestId`.
- Every assistant line carries `message.usage`, and every line of one reply carries the same numbers. So the newest line's numbers are the reply's, and nothing is summed.
- `message.usage` has four top-level counts: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` and `output_tokens`. `input_tokens` is only the part of the prompt that was neither read from a cache nor written to one.
- Beside them are nested objects, `output_tokens_details`, `server_tool_use` and `cache_creation`, and a `service_tier` string. None of these is read. No line seen had a `costUSD`, and none is ever read.

## What is kept

| Kept as  | From                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| `input`  | `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens` added |
| `cached` | `cache_read_input_tokens`                                                         |
| `output` | `output_tokens`, which includes thinking                                          |

The line read is the newest assistant line of the session's own. A subagent's line (`isSidechain: true`), a line Claude Code writes itself with the model `<synthetic>`, and an error of the API (`isApiErrorMessage: true`) are read past. No `<synthetic>` or `isApiErrorMessage` line was in the ends of the transcripts checked, so those two rules have not been checked against a transcript.

- A cache count that is left out counts as 0 in `input`, so a version without cache counts still has counts. When `cache_read_input_tokens` is left out, `cached` is left out too.
- A cache count that is there but is not a whole number, an `input_tokens` or `output_tokens` that is not one, or a whole prompt of 0 gives a dash, never an older reply's counts. The dash lasts until the next reply.
- An assistant line with no `message.usage` is read past, to the reply before it.
- When Claude Code compacts the conversation, it writes the summary as a user line marked `isCompactSummary: true`. Once that line is newer than the newest reply, Tokens is a dash until the next reply, since that reply was given a context that is no longer in use. The summary line was seen so in the transcripts of 2.1.239, 2.1.281 and 2.1.286.
- Only a line that names both `"assistant"` and `"usage"`, or names `"isCompactSummary"`, is parsed, and of those only an assistant line or a summary is taken, so a prompt or a reply that quotes such a line is never taken for one.

## What breaks when Claude Code changes

| Change                                                        | What you see                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `message.usage` moves, or its four counts are renamed         | Tokens is a dash in every Claude Code session's details                         |
| An assistant line is written without `message.usage`          | The counts of the reply before it show as the newest reply's                    |
| `input_tokens` comes to count the cached part too             | Tokens shows more input than the context in use                                 |
| The lines of one reply come to carry their own blocks' counts | Tokens shows only the newest block's counts, not the whole reply's              |
| A compacted summary is no longer marked `isCompactSummary`    | After a compaction, the counts of the reply before it show until the next reply |

To check a new Claude Code version, look at the field names and numbers alone of the assistant lines at the end of one transcript, never their text, and compare them with the lists above.
