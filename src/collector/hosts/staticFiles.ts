import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/** Serves the built dashboard from one directory and nothing outside it. */
export type StaticHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
]);

/** A `<script>` block with code inside it, as opposed to one that names a file with `src`. */
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;

/**
 * The policy the browser is asked to enforce on the dashboard.
 *
 * It turns two of the app's promises into something the browser checks:
 *
 * - Nothing leaves the machine. Scripts, styles, fonts and images load only
 *   from this server, and the page may only connect back to it. A change that
 *   pulled in a remote script or font, or called another host, would be blocked
 *   and would show up in the console at once.
 * - Nobody else can drive the dashboard. `frame-ancestors 'none'` stops another
 *   site showing the page inside a frame and luring clicks onto it.
 *
 * The page has one script written into the HTML itself, the one that sets the
 * theme before first paint. Inline scripts are otherwise refused, so that one is
 * allowed by the hash of its exact text, worked out from the page as it is
 * served. Styles are allowed inline because components set them at run time.
 */
export function contentSecurityPolicy(html?: string): string {
  const hashes: string[] = [];
  if (html !== undefined) {
    for (const match of html.matchAll(INLINE_SCRIPT)) {
      const code = match[1] ?? "";
      if (code.trim() === "") continue;
      hashes.push(`'sha256-${createHash("sha256").update(code, "utf8").digest("base64")}'`);
    }
  }
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers every answer from the static handler carries. */
function protectiveHeaders(html?: string): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": contentSecurityPolicy(html),
    // The older way to refuse framing, for browsers that predate frame-ancestors.
    "X-Frame-Options": "DENY",
  };
}

/**
 * Turns a request path into a file path inside `rootDir`, or null when the path
 * is malformed or would land outside it.
 *
 * The path is decoded once, then resolved, then checked against the root. The
 * check is on the resolved path, so `..` segments are caught however they were
 * written: plainly, percent-encoded, or mixed with backslashes.
 */
export function resolveInside(rootDir: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  // A backslash is a separator on Windows and never needed in a dashboard URL.
  if (decoded.includes("\\")) return null;

  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, `.${path.sep}${decoded}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

function sendText(res: ServerResponse, status: number, message: string, headers = {}): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...protectiveHeaders(),
    ...headers,
  });
  res.end(message);
}

export function createStaticHandler(distDir: string): StaticHandler {
  const root = path.resolve(distDir);
  const indexFile = path.join(root, "index.html");

  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "Only GET requests are answered here.", { Allow: "GET, HEAD" });
      return;
    }

    const requestPath = (req.url ?? "/").split(/[?#]/, 1)[0] ?? "/";
    const resolved = resolveInside(root, requestPath);
    if (resolved === null) {
      sendText(res, 400, "That address could not be read.");
      return;
    }

    let file: string | null = null;
    if (resolved !== root && (await isFile(resolved))) {
      file = resolved;
    } else if (path.extname(resolved) === "") {
      // The dashboard is one page. Any path that is not a file is that page.
      file = (await isFile(indexFile)) ? indexFile : null;
    }
    if (file === null) {
      sendText(res, 404, "There is nothing at that address.");
      return;
    }

    let body: Buffer;
    try {
      // A link inside the folder that points outside it is followed by the
      // filesystem, not by the path check above, so the real location is checked too.
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
      if (!realFile.startsWith(realRoot + path.sep)) {
        sendText(res, 404, "There is nothing at that address.");
        return;
      }
      body = await readFile(realFile);
    } catch {
      sendText(res, 404, "There is nothing at that address.");
      return;
    }

    // Vite names everything under assets/ after its content, so those files can
    // be kept for good. The page itself is always checked again.
    const isHashedAsset = path.relative(root, file).split(path.sep)[0] === "assets";
    const extension = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES.get(extension) ?? "application/octet-stream",
      "Content-Length": body.byteLength,
      "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      ...protectiveHeaders(extension === ".html" ? body.toString("utf8") : undefined),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}
