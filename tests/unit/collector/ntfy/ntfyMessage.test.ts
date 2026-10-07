import { describe, expect, test } from "vitest";

import { ntfyBody } from "@collector/ntfy/ntfyMessage";
import type { PhoneKind } from "@collector/outbound/phoneMessage";

const message = (kind: PhoneKind) => ({
  kind,
  title: "checkout-flow is waiting",
  message: "4m 12s",
});

describe("ntfyBody", () => {
  test("is the topic, the title and the lines, a priority and a tag, in that order, and nothing else", () => {
    const body = ntfyBody("agent-lookout-3f9c", message("needs-you"));
    expect(body).toEqual({
      topic: "agent-lookout-3f9c",
      title: "checkout-flow is waiting",
      message: "4m 12s",
      priority: 4,
      tags: ["hourglass"],
    });
    expect(Object.keys(body)).toEqual(["topic", "title", "message", "priority", "tags"]);
  });

  test.each<[PhoneKind, number, string[] | undefined]>([
    ["needs-you", 4, ["hourglass"]],
    ["reminder", 4, ["hourglass"]],
    ["test", 4, ["hourglass"]],
    ["finished", 3, ["white_check_mark"]],
    ["failed", 3, ["x"]],
    ["ended", 3, ["stop_sign"]],
    ["quiet-summary", 3, undefined],
  ])("a push of %s has priority %i and its tag", (kind, priority, tags) => {
    const body = ntfyBody("t", message(kind));
    expect(body.priority).toBe(priority);
    expect(body.tags).toEqual(tags);
    // Never a link, an action, an attachment or Markdown.
    for (const field of ["click", "actions", "attach", "markdown", "icon", "cache", "firebase"]) {
      expect(body).not.toHaveProperty(field);
    }
  });
});
