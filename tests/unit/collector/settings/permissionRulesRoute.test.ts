import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import { actionRefusalFor } from "@collector/handler";
import {
  createPermissionRulesRoute,
  MAX_PERMISSION_RULES_BODY_BYTES,
  permissionRulesRefusalFor,
} from "@collector/settings/permissionRulesRoute";
import type { PermissionRulesChange } from "@collector/settings/collectorSettings";
import type { SettingsWrite } from "@collector/settings/settingsFile";
import type { PermissionRule } from "@core/permission-rules/permissionRules";
import type { RulesChangeResult } from "@core/permission-rules/rulesChange";

/** The headers the dashboard's own page sends. Node gives header names in lower case. */
const FROM_THE_PAGE = {
  host: "127.0.0.1:4777",
  origin: "http://127.0.0.1:4777",
  "sec-fetch-site": "same-origin",
  "x-agent-lookout-action": "permission-rules",
  "content-type": "application/json",
  "content-length": "100",
};

function head(
  headers: Record<string, string | string[] | undefined> = {},
  method = "POST",
): Pick<IncomingMessage, "method" | "headers"> {
  return { method, headers: { ...FROM_THE_PAGE, ...headers } };
}

const status = (req: Pick<IncomingMessage, "method" | "headers">) =>
  permissionRulesRefusalFor(req)?.status;

const ADD = { add: { decision: "allow", tool: "Bash", command: "npm test:*" } };

/** A request with a body, as Node hands one over. A header set to undefined is not sent. */
function request(
  options: { headers?: Record<string, string | undefined>; body?: string } = {},
): IncomingMessage {
  const text = options.body ?? JSON.stringify(ADD);
  const body = Readable.from(text === "" ? [] : [Buffer.from(text)]);
  const headers = Object.fromEntries(
    Object.entries({
      ...FROM_THE_PAGE,
      "content-length": String(Buffer.byteLength(text)),
      ...options.headers,
    }).filter(([, value]) => value !== undefined),
  );
  return Object.assign(body, { method: "POST", headers }) as unknown as IncomingMessage;
}

const A: PermissionRule = {
  id: "aaaaaaaaaaaa",
  decision: "deny",
  tool: "Bash",
  command: "rm:*",
};

/** The route over rules held in memory, which save, or not, as the test says. */
function routeOver(rules: PermissionRule[] = [], saved: SettingsWrite = { ok: true }) {
  let held = rules;
  /** Each list the route asked to save. */
  const saves: (readonly PermissionRule[])[] = [];
  const settings = {
    changePermissionRules: vi.fn(
      (change: (rules: readonly PermissionRule[]) => RulesChangeResult): PermissionRulesChange => {
        const made = change(held);
        if (!made.ok || !made.changed) return made;
        saves.push(made.rules);
        if (!saved.ok) return { ok: false, reason: "not-saved", problem: saved.problem };
        held = [...made.rules];
        return made;
      },
    ),
  };
  return {
    route: createPermissionRulesRoute({ settings, newId: () => "dddddddddddd" }),
    settings,
    held: () => held,
    saves,
  };
}

describe("permissionRulesRefusalFor, the checks of every route that acts, with its own action", () => {
  test("a POST from the dashboard's own page may proceed", () => {
    expect(permissionRulesRefusalFor(head())).toBeNull();
    expect(permissionRulesRefusalFor(head({ origin: "http://localhost:5173" }))).toBeNull();
    expect(permissionRulesRefusalFor(head({ "sec-fetch-site": undefined }))).toBeNull();
  });

  test("its action opens no other route, and no other route's opens it", () => {
    expect(actionRefusalFor(head(), "time-rules", MAX_PERMISSION_RULES_BODY_BYTES)?.status).toBe(
      403,
    );
    expect(status(head({ "x-agent-lookout-action": "time-rules" }))).toBe(403);
    expect(status(head({ "x-agent-lookout-action": "answer" }))).toBe(403);
  });

  test.each(["GET", "PUT", "DELETE", "OPTIONS"])("a %s is refused with 405", (method) => {
    expect(status(head({}, method))).toBe(405);
  });

  test.each([undefined, "https://evil.example", "http://localhost.evil.example", "null"])(
    "an Origin of %j is refused",
    (origin) => {
      expect(status(head({ origin }))).toBe(403);
    },
  );

  test.each(["cross-site", "same-site", "none"])("a request marked %s is refused", (site) => {
    expect(status(head({ "sec-fetch-site": site }))).toBe(403);
  });

  test("a body sent as anything but JSON is refused with 415, and a large one with 413", () => {
    expect(status(head({ "content-type": "text/plain" }))).toBe(415);
    expect(status(head({ "content-length": String(MAX_PERMISSION_RULES_BODY_BYTES + 1) }))).toBe(
      413,
    );
  });
});

describe("POST /api/settings/permission-rules", () => {
  test("adds a rule once the list is saved, and answers with the list in force", async () => {
    const { route, saves } = routeOver([A]);
    const added = { id: "dddddddddddd", ...ADD.add };
    expect(await route(request())).toEqual({
      status: 200,
      body: { ok: true, permissionRules: [A, added] },
    });
    expect(saves).toEqual([[A, added]]);
  });

  test("moves, edits and removes a rule by its id", async () => {
    const { route, held } = routeOver([A]);
    await route(request());
    await route(request({ body: JSON.stringify({ move: { id: "dddddddddddd", to: "up" } }) }));
    expect(held().map((rule) => rule.id)).toEqual(["dddddddddddd", "aaaaaaaaaaaa"]);
    await route(
      request({
        body: JSON.stringify({ edit: { id: "aaaaaaaaaaaa", decision: "ask", tool: "Read" } }),
      }),
    );
    expect(held()[1]).toEqual({ id: "aaaaaaaaaaaa", decision: "ask", tool: "Read" });
    await route(request({ body: JSON.stringify({ remove: { id: "dddddddddddd" } }) }));
    expect(held()).toEqual([{ id: "aaaaaaaaaaaa", decision: "ask", tool: "Read" }]);
  });

  test("a move that changes nothing answers with the list, and writes nothing", async () => {
    const { route, saves } = routeOver([A]);
    const answer = await route(
      request({ body: JSON.stringify({ move: { id: "aaaaaaaaaaaa", to: "up" } }) }),
    );
    expect(answer).toEqual({ status: 200, body: { ok: true, permissionRules: [A] } });
    expect(saves).toEqual([]);
  });

  test("a refused request changes nothing and its body is never read", async () => {
    const { route, settings } = routeOver();
    const req = request({ headers: { origin: "https://evil.example" } });
    const read = vi.spyOn(req, "on");
    expect((await route(req)).status).toBe(403);
    expect(read.mock.calls.map(([event]) => event)).not.toContain("data");
    expect(settings.changePermissionRules).not.toHaveBeenCalled();
  });

  test.each<[string, unknown]>([
    ["not JSON", "allow Bash"],
    ["the whole list", { permissionRules: [A] }],
    ["two changes at once", { ...ADD, remove: { id: "aaaaaaaaaaaa" } }],
    ["an id given for a new rule", { add: { id: "x", decision: "deny", tool: "Read" } }],
    ["allow for every tool", { add: { decision: "allow", tool: "*" } }],
    ["allow for every command", { add: { decision: "allow", tool: "Bash" } }],
    ["allow for an edit", { add: { decision: "allow", tool: "Write" } }],
    [
      "allow for a line of two commands",
      { add: { decision: "allow", tool: "Bash", command: "npm test && rm" } },
    ],
    ["a command for another tool", { add: { decision: "deny", tool: "Read", command: "cat" } }],
    [
      "a tool written as Claude Code writes a rule",
      { add: { decision: "deny", tool: "Bash(rm:*)" } },
    ],
    ["a field of another kind", { add: { decision: "deny", tool: "Read", path: "/etc" } }],
  ])("%s is refused whole, with the sentence that says why", async (_, body) => {
    const { route, settings } = routeOver([A]);
    const answer = await route(
      request({ body: typeof body === "string" ? body : JSON.stringify(body) }),
    );
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ reason: "invalid", error: expect.any(String) });
    expect(settings.changePermissionRules).not.toHaveBeenCalled();
  });

  test.each([
    { add: { decision: "allow", tool: "Bash", command: "curl:*" } },
    { add: { decision: "allow", tool: "Bash", command: "/usr/bin/CURL -s 127.0.0.1:4777" } },
    { add: { decision: "allow", tool: "Bash", command: "python -m pytest" } },
    { add: { decision: "allow", tool: "Bash", command: "python3.12:*" } },
    { add: { decision: "allow", tool: "Bash", command: "node build.js" } },
    { edit: { id: "aaaaaaaaaaaa", decision: "allow", tool: "Bash", command: "wget:*" } },
  ])(
    "an allow rule for a program that sends requests or runs code, %j, is refused with 400 and the sentence that says why, and nothing is saved",
    async (body) => {
      const { route, settings, held } = routeOver([A]);
      const answer = await route(request({ body: JSON.stringify(body) }));
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({
        reason: "invalid",
        error: expect.stringMatching(
          /can send requests, or run code that does, so an allow rule for it would let Claude Code reach Agent Lookout on this computer and add a rule or answer its own prompts without asking you\. Answer such commands by hand, or allow a script the project owns, such as \.\/scripts\/test\.sh, knowing Claude can edit it\./,
        ),
      });
      expect(settings.changePermissionRules).not.toHaveBeenCalled();
      expect(held()).toEqual([A]);
    },
  );

  test("a deny or an ask rule for such a program is taken, and so is an allow rule for a script the project owns", async () => {
    for (const add of [
      { decision: "deny", tool: "Bash", command: "curl:*" },
      { decision: "ask", tool: "Bash", command: "python:*" },
      { decision: "allow", tool: "Bash", command: "./scripts/test.sh" },
    ]) {
      const { route, held } = routeOver();
      expect((await route(request({ body: JSON.stringify({ add }) }))).status).toBe(200);
      expect(held()).toEqual([{ id: "dddddddddddd", ...add }]);
    }
  });

  test("a rule the list does not hold, a rule it holds already, and a full list are refused", async () => {
    const { route } = routeOver([A]);
    expect(
      await route(request({ body: JSON.stringify({ remove: { id: "eeeeeeeeeeee" } }) })),
    ).toMatchObject({ status: 404, body: { reason: "no-rule" } });
    expect(
      await route(
        request({
          body: JSON.stringify({ add: { decision: "deny", tool: "Bash", command: "rm:*" } }),
        }),
      ),
    ).toMatchObject({ status: 409, body: { reason: "duplicate" } });

    const full = Array.from({ length: 100 }, (_, index): PermissionRule => ({
      id: `r${index}`,
      decision: "deny",
      tool: "Bash",
      command: `rm${index}`,
    }));
    expect(await routeOver(full).route(request())).toMatchObject({
      status: 409,
      body: { reason: "full" },
    });
  });

  test("a body larger than the limit is cut off and refused", async () => {
    const { route, settings } = routeOver();
    const big = JSON.stringify({ add: { ...ADD.add, padding: "x".repeat(2_000) } });
    const answer = await route(request({ body: big, headers: { "content-length": undefined } }));
    expect(answer.status).toBe(413);
    expect(settings.changePermissionRules).not.toHaveBeenCalled();
  });

  test("rules that cannot be saved are not in force, and the answer says why", async () => {
    const problem =
      "~/.agent-lookout/settings.json could not be written, so the change was not saved.";
    const { route, held } = routeOver([], { ok: false, problem });
    expect(await route(request())).toEqual({
      status: 500,
      body: { error: problem, reason: "not-saved" },
    });
    expect(held()).toEqual([]);
  });
});
