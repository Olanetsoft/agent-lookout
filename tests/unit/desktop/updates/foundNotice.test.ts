import { describe, expect, test } from "vitest";

import { foundNotice } from "@desktop/updates/foundNotice";

describe("the notification of a version the daily check found", () => {
  test("names the version and says it is being downloaded", () => {
    expect(foundNotice("0.2.1", null)).toEqual({
      title: "Agent Lookout 0.2.1 is available",
      body: "Agent Lookout is downloading it. Settings will offer Install and Restart.",
    });
  });

  test("where it cannot be installed, sends the person to Settings to see how", () => {
    expect(foundNotice("0.2.1", "translocated")).toEqual({
      title: "Agent Lookout 0.2.1 is available",
      body: "Open Settings to see how to install it.",
    });
  });
});
