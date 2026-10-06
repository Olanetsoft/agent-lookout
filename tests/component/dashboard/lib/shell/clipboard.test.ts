import { afterEach, expect, test, vi } from "vitest";

import { copyText } from "@dashboard/lib/shell/clipboard";

// The browser's clipboard is stood in for in every test, so no test writes to
// the clipboard of the computer it runs on.

afterEach(() => {
  vi.restoreAllMocks();
  // Back to the browser's own, after a test that took it away.
  Reflect.deleteProperty(navigator, "clipboard");
});

test("writes the text with the browser's clipboard, exactly as given, and never reads it", async () => {
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const read = vi.spyOn(navigator.clipboard, "readText");
  const text =
    "cd '/Users/example/My  Projects/it'\\''s' && claude --resume 00000000-0000-4000-8000-000000000001";

  expect(await copyText(text)).toBe("copied");
  expect(write).toHaveBeenCalledExactlyOnceWith(text);
  expect(read).not.toHaveBeenCalled();
});

test("a write the browser refuses is refused, and nothing is thrown", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("Write permission denied.", "NotAllowedError"),
  );
  expect(await copyText("claude --resume")).toBe("refused");
});

test("a browser with no clipboard to write to is refused", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  expect(await copyText("claude --resume")).toBe("refused");

  Object.defineProperty(navigator, "clipboard", { value: {}, configurable: true });
  expect(await copyText("claude --resume")).toBe("refused");
});

test("a clipboard that throws rather than rejects is refused too", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => {
    throw new TypeError("Illegal invocation");
  });
  expect(await copyText("claude --resume")).toBe("refused");
});
