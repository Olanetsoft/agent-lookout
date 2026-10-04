import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { ApiHandler } from "@collector/handler";
import { createAppServer, listenOnLoopback, portAnswers, urlFor } from "@collector/hosts/server";
import { listen, request } from "@tests/support/http";
import { tempDir } from "@tests/support/tempFiles";

const SECRET = "secret-outside-dist";

/**
 * A folder laid out like a real checkout: a built `dist/` and, next to it, files
 * that must never be served.
 */
async function makeProject() {
  const root = await tempDir();
  const dist = path.join(root, "dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Agent Lookout</title>");
  await writeFile(path.join(dist, "assets", "index-abc123.js"), "console.log('dashboard');");
  await writeFile(path.join(dist, "assets", "index-abc123.css"), "body{margin:0}");
  await writeFile(path.join(dist, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: SECRET }));
  await writeFile(path.join(root, ".env"), `TOKEN=${SECRET}`);
  // A sibling whose name starts with the served folder's name.
  await mkdir(path.join(root, "dist-private"));
  await writeFile(path.join(root, "dist-private", "notes.txt"), SECRET);
  return { root, dist };
}

const api: ApiHandler = (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ from: "api" }));
};

async function serveProject() {
  const project = await makeProject();
  const port = await listen(createAppServer({ distDir: project.dist, api }));
  return { ...project, port };
}

describe("serving the dashboard", () => {
  test("/ is the page", async () => {
    const { port } = await serveProject();
    const response = await request(port, "/");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toContain("<title>Agent Lookout</title>");
  });

  test("assets are served with their types and may be kept for good", async () => {
    const { port } = await serveProject();

    const script = await request(port, "/assets/index-abc123.js");
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(script.body).toBe("console.log('dashboard');");

    const style = await request(port, "/assets/index-abc123.css?v=1");
    expect(style.status).toBe(200);
    expect(style.headers["content-type"]).toBe("text/css; charset=utf-8");

    const icon = await request(port, "/favicon.svg");
    expect(icon.headers["content-type"]).toBe("image/svg+xml");
    expect(icon.headers["cache-control"]).toBe("no-cache");
  });

  test("a path that is not a file is the page; a missing file is a 404", async () => {
    const { port } = await serveProject();

    const page = await request(port, "/sessions/anything");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>Agent Lookout</title>");

    const missing = await request(port, "/assets/missing.js");
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain("<title>");
  });

  test("HEAD sends the headers without the body; other methods are refused", async () => {
    const { port } = await serveProject();

    const head = await request(port, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);

    const post = await request(port, "/", { method: "POST" });
    expect(post.status).toBe(405);
  });

  test("/api/* goes to the collector's handler, not to the files", async () => {
    const { port } = await serveProject();
    const response = await request(port, "/api/sessions");
    expect(response.json()).toEqual({ from: "api" });
  });

  test("a request under another host name is refused, for the page as well", async () => {
    const { port } = await serveProject();
    const response = await request(port, "/", { headers: { Host: "evil.example" } });
    expect(response.status).toBe(403);
    expect(response.body).not.toContain("<title>");
  });

  test("when the dashboard has not been built, the page is a 404 and the API still answers", async () => {
    const empty = await tempDir();
    const port = await listen(createAppServer({ distDir: path.join(empty, "dist"), api }));
    expect((await request(port, "/")).status).toBe(404);
    expect((await request(port, "/api/health")).status).toBe(200);
  });
});

describe("what the browser is told to enforce", () => {
  const THEME_SCRIPT = '\n      document.documentElement.setAttribute("data-theme", "dark");\n    ';
  const pageWithInlineScript = `<!doctype html><title>Agent Lookout</title><script>${THEME_SCRIPT}</script><script type="module" crossorigin src="/assets/index-abc123.js"></script>`;
  const hashOf = (code: string) =>
    `'sha256-${createHash("sha256").update(code, "utf8").digest("base64")}'`;

  const directives = (policy: string | string[] | undefined) =>
    new Map(
      String(policy ?? "")
        .split("; ")
        .map((directive) => {
          const [name, ...values] = directive.split(" ");
          return [name as string, values];
        }),
    );

  test("the page may not be shown inside another site's frame", async () => {
    const { port } = await serveProject();
    const response = await request(port, "/");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(directives(response.headers["content-security-policy"]).get("frame-ancestors")).toEqual([
      "'none'",
    ]);
  });

  test("the page may load and call nothing but this server", async () => {
    const { port } = await serveProject();
    const policy = directives((await request(port, "/")).headers["content-security-policy"]);
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.get("font-src")).toEqual(["'self'"]);
    expect(policy.get("img-src")).toEqual(["'self'", "data:"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    // No directive names another host, a wildcard or a scheme that reaches the network.
    const sources = [...policy.values()].flat();
    expect(sources.filter((source) => /^https?:|^\*|^wss?:/.test(source))).toEqual([]);
  });

  test("inline scripts are refused, except the page's own, allowed by its exact text", async () => {
    const { port, dist } = await serveProject();
    await writeFile(path.join(dist, "index.html"), pageWithInlineScript);

    const policy = directives((await request(port, "/")).headers["content-security-policy"]);
    expect(policy.get("script-src")).toEqual(["'self'", hashOf(THEME_SCRIPT)]);
    expect(policy.get("script-src")).not.toContain("'unsafe-inline'");
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
  });

  test("the allowance follows the page: a rebuilt page with a different script gets a different hash", async () => {
    const { port, dist } = await serveProject();
    await writeFile(path.join(dist, "index.html"), pageWithInlineScript);
    const before = (await request(port, "/")).headers["content-security-policy"];
    await writeFile(
      path.join(dist, "index.html"),
      pageWithInlineScript.replace('"dark"', '"light"'),
    );
    const after = (await request(port, "/")).headers["content-security-policy"];
    expect(after).not.toBe(before);
    expect(after).toContain(hashOf(THEME_SCRIPT.replace('"dark"', '"light"')));
  });

  test("every other answer carries the same protection", async () => {
    const { port } = await serveProject();
    for (const target of ["/assets/index-abc123.js", "/favicon.svg", "/assets/missing.js"]) {
      const response = await request(port, target);
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["content-security-policy"]).toContain("script-src 'self';");
    }
    const refused = await request(port, "/", { method: "POST" });
    expect(refused.status).toBe(405);
    expect(refused.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("path traversal", () => {
  test.each([
    "/../package.json",
    "/../../package.json",
    "/assets/../../package.json",
    "/assets/../../.env",
    "/..%2fpackage.json",
    "/%2e%2e/package.json",
    "/%2e%2e%2fpackage.json",
    "/%2E%2E/%2E%2E/package.json",
    "/assets/..%2f..%2fpackage.json",
    "/..\\package.json",
    "/..%5cpackage.json",
    "/assets/..%5c..%5cpackage.json",
    "//../package.json",
    "/./../package.json",
    "/../dist-private/notes.txt",
    "/..%2fdist-private%2fnotes.txt",
    "/%2e%2e/dist-private/notes.txt",
    "/assets/../../../../../../../../etc/passwd",
    "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
    "/..%252fpackage.json",
    "/package.json%00.html",
    "/%00",
    "/%",
    "/%zz/../package.json",
  ])("%s serves nothing from outside dist", async (target) => {
    const { port } = await serveProject();
    const response = await request(port, target);
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain("root:");
    // Either refused outright, or answered with the dashboard's own page.
    if (response.status === 200) {
      expect(response.body).toContain("<title>Agent Lookout</title>");
    } else {
      expect([400, 404]).toContain(response.status);
    }
  });

  test("a link inside dist that points outside it is not followed", async () => {
    const { port, root, dist } = await serveProject();
    await symlink(path.join(root, "package.json"), path.join(dist, "leak.json"));
    await symlink(path.join(root, "dist-private"), path.join(dist, "private"));

    for (const target of ["/leak.json", "/private/notes.txt"]) {
      const response = await request(port, target);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain(SECRET);
    }
  });
});

describe("where it listens", () => {
  test("listenOnLoopback refuses any other address and leaves the server closed", async () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "localhost"]) {
      const server = createServer();
      await expect(listenOnLoopback(server, host, 0)).rejects.toThrow(
        /only listens on this machine/,
      );
      expect(server.listening).toBe(false);
    }
  });

  test("listenOnLoopback binds 127.0.0.1 and reports the address", async () => {
    const project = await makeProject();
    const server = createAppServer({ distDir: project.dist, api });
    const address = await listenOnLoopback(server, "127.0.0.1", 0);
    try {
      expect(address.address).toBe("127.0.0.1");
      expect(urlFor(address)).toBe(`http://127.0.0.1:${address.port}`);
      expect((await request(address.port, "/")).status).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("a port that is taken is an error the caller can explain", async () => {
    const first = createServer();
    const port = await listen(first);
    const second = createServer();
    await expect(listenOnLoopback(second, "127.0.0.1", port)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });

  test("a port another program answers on counts as taken, whatever address that program chose", async () => {
    // On macOS the system lets 127.0.0.1 be bound while another program holds the
    // same port on every address, so the check is made by knocking, not by binding.
    const other = createServer();
    const port = await listen(other);
    expect(await portAnswers("127.0.0.1", port)).toBe(true);

    other.closeAllConnections();
    await new Promise((resolve) => other.close(resolve));
    expect(await portAnswers("127.0.0.1", port)).toBe(false);
  });
});
