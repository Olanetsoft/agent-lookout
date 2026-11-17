// Test fixtures only. Every id, name, path and word here is invented and
// generic. A session file follows the shape Unreal Agent's source writes at
// v0.3.1 (`harness/sessionstore/localfile/codec.go` and the types it
// encodes), field by field in the order Go declares them, as written up in
// docs/adapters/unreal-agent.md, and nothing in it is copied from a real
// machine: Unreal Agent was not run to make it. Product code never imports
// this file.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const SESSIONS_DIR = `${HOME}/.local/state/unreal-agent/sessions`;

/** Midday UTC on 17 November 2026. */
export const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The folder the fixture's sessions run their commands in. */
export const PROJECT = `${HOME}/work/demo-project`;

export const STARTED_AT = NOW - HOUR;

/** A generic UUID, as Go's `uuid` package writes one, lowercase. */
export const uuidOf = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-c3d4-4e5f-8a9b-${n.toString(16).padStart(12, "0")}`;

export const SESSION_ID = uuidOf(1, 1);

/** Words written where a message, a reply, a reason or a command's output goes. None may leave the file. */
export const PRIVATE_WORDS = "placeholder words that must never leave the session file";

/** Written where a command or a tool's arguments go. */
export const PRIVATE_ARGUMENTS = "placeholder arguments that must never leave the session file";

/** Written where an ID can be anything: a runner's message ID, a provider's call or reply ID. */
export const PRIVATE_ID = "call.Private.1 placeholder";

/** A session file's path. */
export const sessionPath = (id: string = SESSION_ID, dir: string = SESSIONS_DIR) =>
  `${dir}/${id}.session.jsonl`;

/**
 * A time as Go's encoder writes a `time.Time` in UTC: RFC 3339, with the
 * fraction's trailing zeros cut, and none when it is whole. `nanos`, nine
 * digits, takes the fraction's place.
 */
export function goTime(at: number, nanos?: string): string {
  const iso = new Date(at).toISOString();
  const whole = iso.slice(0, 19);
  const fraction = (nanos ?? iso.slice(20, 23)).replace(/0+$/, "");
  return `${whole}${fraction === "" ? "" : `.${fraction}`}Z`;
}

/** One record's line, `{"type":…,"data":…}`, with its newline. */
export const record = (type: string, data: unknown) => `${JSON.stringify({ type, data })}\n`;

/** The first line, `{"type":"session","data":{"Version":2,"Session":{"ID":…,"CreatedAt":…}}}`. */
export const headerLine = (id: string = SESSION_ID, at: number = STARTED_AT, version = 2) =>
  record("session", { Version: version, Session: { ID: id, CreatedAt: goTime(at) } });

const base64 = (text: string) => Buffer.from(text).toString("base64");

/** A shell command's state, in `ShellState`'s order (shell.go:50-70), with its output once it ended. */
export function shellState(
  options: {
    directory?: string;
    command?: string;
    shell?: string;
    operationId?: string;
    sessionId?: string;
    ended?: boolean;
  } = {},
) {
  const base = `${SESSIONS_DIR}/operations/${options.sessionId ?? SESSION_ID}`;
  const op = options.operationId ?? uuidOf(5, 1);
  const ended = options.ended ?? false;
  return {
    Input: {
      Command: options.command ?? PRIVATE_ARGUMENTS,
      Shell: options.shell ?? "/bin/zsh",
      Directory: options.directory ?? PROJECT,
    },
    BaseDirectory: base,
    Phase: ended ? "" : "process",
    ProcessGroupID: ended ? 0 : 4242,
    PendingExitCode: null,
    OutSize: ended ? 57 : 0,
    ErrSize: 0,
    InlineOut: ended ? base64(PRIVATE_WORDS) : "",
    InlineErr: ended ? base64(PRIVATE_WORDS) : "",
    InlineOutTail: "",
    InlineErrTail: "",
    Result: ended
      ? { Out: PRIVATE_WORDS, Err: PRIVATE_WORDS, OutSize: 57, ErrSize: 57, ExitCode: 0 }
      : null,
    TerminalError: "",
    ErrorTruncated: false,
    OutTruncated: true,
    ErrTruncated: true,
    OutPath: `${base}/${op}/out`,
    ErrPath: `${base}/${op}/err`,
  };
}

/** A command, in `Operation`'s order (operation.go:39-47). */
export interface Operation {
  MaxOutputLength?: number;
  ID: string;
  Type: string;
  Version: number;
  Status: string;
  State?: unknown;
}

export function operationOf(fields: Operation): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  if (fields.MaxOutputLength !== undefined && fields.MaxOutputLength !== 0) {
    value.MaxOutputLength = fields.MaxOutputLength;
  }
  value.ID = fields.ID;
  value.Type = fields.Type;
  value.Version = fields.Version;
  value.Status = fields.Status;
  if (fields.State !== undefined) value.State = fields.State;
  return value;
}

/** A shell command, as Bash starts one, ready or in a later state. */
export function shellOperation(
  id: string,
  status: string,
  state: Record<string, unknown> = shellState({ operationId: id }),
): Operation {
  return {
    MaxOutputLength: 40_000,
    ID: id,
    Type: "shell",
    Version: 3,
    Status: status,
    State: state,
  };
}

/** A command's newest state, its own line. */
export const operationLine = (fields: Operation) =>
  record("operation", { Operation: operationOf(fields) });

export interface ReplyOptions {
  stop?: string;
  failure?: { Code: string; Message: string } | null;
  /** The tool calls the reply asks for, by call ID. */
  calls?: string[];
  responseId?: string;
  /** Output text, in place of the usual words, as for a reply many bytes long. */
  text?: string;
}

/**
 * A session file, item by item, numbered as Unreal Agent numbers them. Each
 * method adds one line, and `text()` is the whole file.
 */
export class SessionLines {
  private readonly lines: string[] = [];
  private sequence = 0;
  private turnCount = 0;
  private lastTurn = "";

  constructor(
    readonly id: string = SESSION_ID,
    createdAt: number = STARTED_AT,
    options: { header?: boolean; firstSequence?: number } = {},
  ) {
    if (options.header ?? true) this.lines.push(headerLine(id, createdAt));
    this.sequence = (options.firstSequence ?? 1) - 1;
  }

  /** The number the next item gets. */
  get next(): number {
    return this.sequence + 1;
  }

  /** The newest turn's ID. */
  get turnId(): string {
    return this.lastTurn;
  }

  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  /** An item, `{"type":"item","data":{"Item":{"Sequence":…,"RecordedAt":…,"Kind":…,"Data":…}[,"Operations":…]}}`. */
  item(at: number, kind: string, data: unknown, operations?: unknown[]): this {
    this.sequence += 1;
    const item = { Sequence: this.sequence, RecordedAt: goTime(at), Kind: kind, Data: data };
    this.lines.push(
      record(
        "item",
        operations === undefined ? { Item: item } : { Item: item, Operations: operations },
      ),
    );
    return this;
  }

  /** What a launch writes first (TUI run.go:213-224, runner run.go:369-385). */
  settings(at: number): this {
    return this.item(at, "input", {
      ID: uuidOf(2, this.next),
      Kind: "control",
      Payload: {
        Mode: "settings",
        Reason: "",
        Parameters: { Model: "demo-model", CompactionThreshold: 200000, ReasoningEffort: "high" },
      },
    });
  }

  /** A message the person sent. Its payload is the text, as a JSON string. */
  message(at: number, id: string = uuidOf(2, this.next)): this {
    return this.item(at, "input", { ID: id, Kind: "external", Payload: PRIVATE_WORDS });
  }

  control(at: number, mode: string, reason = ""): this {
    return this.item(at, "input", {
      ID: uuidOf(2, this.next),
      Kind: "control",
      Payload: { Mode: mode, Reason: reason },
    });
  }

  /** What a runner writes as it starts (run.go:404). */
  whenIdle(at: number): this {
    return this.control(at, "when_idle");
  }

  /** What the terminal app writes as it quits (runcontrol/stop.go:18). */
  hard(at: number): this {
    return this.control(at, "hard", "Unreal Agent exited");
  }

  /** What the coordinator writes while it waits on commands (loop.go:288-310). */
  heartbeat(at: number): this {
    return this.control(
      at,
      "heartbeat",
      `Heartbeat: waited 600 seconds for tool calls.\nRunning: [{"Arguments":"${PRIVATE_ARGUMENTS}"}]`,
    );
  }

  turn(at: number, type: "regular" | "compaction" = "regular"): this {
    this.turnCount += 1;
    const id = uuidOf(3, this.turnCount);
    const previous = this.lastTurn;
    this.lastTurn = id;
    return this.item(at, "turn", { ID: id, PreviousTurnID: previous, Type: type });
  }

  /** The model's reply to the newest turn, or to `turnId`. */
  reply(at: number, options: ReplyOptions = {}, turnId: string = this.lastTurn): this {
    const output: unknown[] = [
      {
        ProviderID: "msg-1",
        Type: "message",
        Data: { Role: "assistant", Text: options.text ?? PRIVATE_WORDS, Phase: "final" },
      },
      {
        ProviderID: "rs-1",
        Type: "provider",
        Data: {
          Type: "reasoning",
          Raw: { encrypted: PRIVATE_WORDS },
          Display: { Kind: "reasoning", Text: PRIVATE_WORDS },
        },
      },
    ];
    for (const call of options.calls ?? []) {
      output.push({
        ProviderID: call,
        Type: "tool_call",
        Data: { CallID: call, Name: "Bash", Arguments: `{"command":"${PRIVATE_ARGUMENTS}"}` },
      });
    }
    return this.item(at, "model_response", {
      TurnID: turnId,
      Response: {
        ID: options.responseId ?? PRIVATE_ID,
        Stop: options.stop ?? "complete",
        Output: output,
        Usage: {
          InputTokens: 1200,
          CachedInputTokens: 0,
          CacheWriteInputTokens: 0,
          OutputTokens: 80,
          ReasoningTokens: 20,
          Raw: { provider_total: 1280 },
        },
        Failure: options.failure ?? null,
      },
    });
  }

  /** A tool call's first status, with the commands it starts as `ready` (loop.go:813-861). */
  created(at: number, callId: string, operations: Operation[]): this {
    return this.item(
      at,
      "tool_call_status",
      {
        TurnID: this.lastTurn,
        CallID: callId,
        Status: { Error: "", WaitingFor: operations.map((op) => op.ID) },
      },
      operations.map(operationOf),
    );
  }

  /** A tool call's second status, once all its commands ended (loop.go:863-900). */
  completed(at: number, callId: string, operations: Operation[], turnId = this.lastTurn): this {
    return this.item(
      at,
      "tool_call_status",
      {
        TurnID: turnId,
        CallID: callId,
        Status: { Error: "", WaitingFor: operations.map((op) => op.ID) },
      },
      operations.map(operationOf),
    );
  }

  /** A tool call that failed at once, with an error and no command (state.go:228-236). */
  error(at: number, callId: string, truncated = false): this {
    const status: Record<string, unknown> = { Error: PRIVATE_WORDS };
    if (truncated) status.ErrorTruncated = true;
    return this.item(at, "tool_call_status", {
      TurnID: this.lastTurn,
      CallID: callId,
      Status: status,
    });
  }

  operation(fields: Operation): this {
    return this.raw(operationLine(fields));
  }

  fork(at: number, parent = uuidOf(1, 9)): this {
    return this.item(at, "fork", { ParentID: parent, PreviousTurnID: this.lastTurn });
  }

  text(): string {
    return this.lines.join("");
  }
}

/**
 * A whole tool call: the reply that asks for it, its first status, its
 * command's lines and its second status. Returns the command's ID.
 */
export function shellCall(
  lines: SessionLines,
  at: number,
  n: number,
  options: { directory?: string; end?: boolean } = {},
): string {
  const call = `call_${n}`;
  const op = uuidOf(5, n);
  const state = (ended: boolean) =>
    shellState({ operationId: op, sessionId: lines.id, directory: options.directory, ended });
  lines.reply(at, { calls: [call] });
  lines.created(at, call, [shellOperation(op, "ready", state(false))]);
  lines.operation(shellOperation(op, "awaiting", state(false)));
  if (options.end ?? true) {
    lines.operation(shellOperation(op, "completed", state(true)));
    lines.completed(at + SECOND, call, [shellOperation(op, "completed", state(true))]);
  }
  return op;
}

/**
 * A session of the terminal app that ran one command and now waits: its
 * settings, a message, a turn whose reply ran a command, and the turn that
 * answered once it ended.
 */
export function idleSession(id: string = SESSION_ID, at: number = STARTED_AT): SessionLines {
  const lines = new SessionLines(id, at);
  lines
    .settings(at + SECOND)
    .message(at + 2 * SECOND)
    .turn(at + 2 * SECOND);
  shellCall(lines, at + 5 * SECOND, 1);
  lines.turn(at + 7 * SECOND).reply(at + 9 * SECOND);
  return lines;
}
