import { describe, expect, test } from "vitest";

import { contentSecurityPolicy, resolveInside } from "@collector/hosts/staticFiles";

describe("what the browser is told to enforce", () => {
  test("a page with no inline script allows none", () => {
    expect(contentSecurityPolicy("<!doctype html><title>Agent Lookout</title>")).toContain(
      "script-src 'self';",
    );
    expect(
      contentSecurityPolicy('<script type="module" src="/assets/a.js"></script><script></script>'),
    ).toContain("script-src 'self';");
  });
});

describe("path traversal", () => {
  test("resolveInside keeps every path under the root", () => {
    const root = "/srv/app/dist";
    expect(resolveInside(root, "/")).toBe(root);
    expect(resolveInside(root, "/index.html")).toBe("/srv/app/dist/index.html");
    expect(resolveInside(root, "/assets/a.js")).toBe("/srv/app/dist/assets/a.js");
    expect(resolveInside(root, "/assets/../index.html")).toBe("/srv/app/dist/index.html");
    expect(resolveInside(root, "/a%20b.txt")).toBe("/srv/app/dist/a b.txt");

    expect(resolveInside(root, "/../package.json")).toBeNull();
    expect(resolveInside(root, "/%2e%2e/package.json")).toBeNull();
    expect(resolveInside(root, "/..%2f..%2fetc%2fpasswd")).toBeNull();
    expect(resolveInside(root, "/../dist-private/notes.txt")).toBeNull();
    expect(resolveInside(root, "/..")).toBeNull();
    expect(resolveInside(root, "/..\\..\\etc")).toBeNull();
    expect(resolveInside(root, "/file%00.txt")).toBeNull();
    expect(resolveInside(root, "/%")).toBeNull();
    // Decoded once only: this is a file with a percent sign in its name.
    expect(resolveInside(root, "/..%252fpackage.json")).toBe("/srv/app/dist/..%2fpackage.json");
  });
});
