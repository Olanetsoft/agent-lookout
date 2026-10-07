import { expect, test } from "vitest";

import { childEnvironment } from "@collector/processes/childEnvironment";

test("leaves out Agent Lookout's own settings, the secrets among them, and keeps the rest", () => {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/example",
    AGENT_LOOKOUT_SMTP_URL: "smtps://demo:secret@mail.example.com",
    AGENT_LOOKOUT_WEBHOOK_URL: "https://hooks.example.com/services/demo",
    AGENT_LOOKOUT_NTFY_TOKEN: "tk_demo",
    AGENT_LOOKOUT_PUSHOVER_TOKEN: "demo-token",
    AGENT_LOOKOUT_PORT: "4777",
    NOT_AGENT_LOOKOUT_SETTING: "kept",
  };
  expect(childEnvironment(env)).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/example",
    NOT_AGENT_LOOKOUT_SETTING: "kept",
  });
  // The environment it was handed is left as it was.
  expect(env.AGENT_LOOKOUT_SMTP_URL).toBe("smtps://demo:secret@mail.example.com");
});

test("leaves them out whatever their case, as Windows names variables", () => {
  expect(
    childEnvironment({
      agent_lookout_smtp_url: "x",
      Agent_Lookout_Ntfy_Url: "y",
      Path: "C:\\Windows",
    }),
  ).toEqual({
    Path: "C:\\Windows",
  });
});
