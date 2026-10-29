import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Two distinct https origins, so specs can cover same-site and cross-origin behavior. ADR 0017. */
export const FIXTURE_A = "https://localhost:4510";
export const FIXTURE_B = "https://localhost:4511";

const SITES_DIR = resolve("tests/e2e/sites");
const PORTS = [4510, 4511];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** A throwaway self-signed certificate, valid one day, generated per run and never committed. */
async function makeCertificate(dir: string) {
  const keyFile = join(dir, "key.pem");
  const certFile = join(dir, "cert.pem");
  try {
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-keyout",
      keyFile,
      "-out",
      certFile,
    ]);
  } catch (e) {
    throw new Error(
      `e2e fixture servers need the openssl CLI to create a self-signed certificate: ${String(e)}`,
      { cause: e },
    );
  }
  return { key: await readFile(keyFile), cert: await readFile(certFile) };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "localhost", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

/**
 * Pages live under `/billpay/` (the e2e profiles' path prefix); `/account` and `/lookalike` are
 * outside it.
 */
const BILLPAY = /^\/billpay(?=\/)/;

/**
 * URL path to a file under `SITES_DIR`: the `/billpay` segment is dropped and an extensionless
 * path gets `.html` (`/billpay/twins` and `/account` are `twins.html` and `account.html`; a
 * relative `twins.js` on that page is `/billpay/twins.js`, so `twins.js`). Null when the path
 * leaves `SITES_DIR`.
 */
function fileFor(pathname: string): string | null {
  let rel = normalize(pathname.replace(BILLPAY, ""));
  if (rel !== sep && rel !== "/" && extname(rel) === "") rel += ".html";
  const file = resolve(SITES_DIR, "." + rel);
  return file === SITES_DIR || file.startsWith(SITES_DIR + sep) ? file : null;
}

/**
 * One page at several paths, the way an SPA server answers every route with its shell: the SPA
 * rewrite fixture at its mixed-case path, at that path in lowercase, and at the lowercase route its
 * script rewrites to (ADR 0034).
 */
const ALIASES: Record<string, string> = {
  "/BillPay/SpaRewrite": "/billpay/spa-rewrite",
  "/billpay/sparewrite": "/billpay/spa-rewrite",
  "/billpay/spa-rewrite-search": "/billpay/spa-rewrite",
};

const MAX_BODY = 64 * 1024;

/** The urlencoded body of a POST (at most 64 KiB), or null for any other method. */
async function postedFields(
  req: IncomingMessage,
): Promise<Map<string, string> | null> {
  if (req.method !== "POST") return null;
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > MAX_BODY) throw new Error("body too large");
  }
  return new Map(new URLSearchParams(body));
}

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * Server-side rendering for HTML fixtures: `{{name}}` becomes the escaped posted value of `name`
 * (empty on GET), the way a server framework re-renders a form after failed validation. A POST
 * without an `authorize` field fails validation: `{{error}}` becomes the error text.
 */
function render(html: string, posted: Map<string, string> | null): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key === "error") {
      return posted !== null && !posted.has("authorize")
        ? "Please authorize the payment."
        : "";
    }
    return escapeHtml(posted?.get(key) ?? "");
  });
}

/**
 * Multi-page wizards: a POST to a key that passes validation (it has `authorize`) is answered
 * `303 See Other` to the next step, so the next step is a new document at its own path and the
 * history entry is a GET (browser Back returns to the step-1 GET, not to a POST).
 */
const NEXT_STEP: Record<string, string> = {
  "/billpay/post-wizard": "/billpay/post-wizard-2",
};

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url ?? "/", "https://localhost").pathname,
    );
    const routed = Object.hasOwn(ALIASES, pathname)
      ? ALIASES[pathname]!
      : pathname;
    let file = fileFor(routed);
    if (file === null) {
      res.writeHead(403).end();
      return;
    }
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const posted = await postedFields(req);
    const next = Object.hasOwn(NEXT_STEP, pathname)
      ? NEXT_STEP[pathname]
      : undefined;
    if (posted?.has("authorize") && next !== undefined) {
      res.writeHead(303, { location: next, "cache-control": "no-store" }).end();
      return;
    }
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const headers = { "content-type": type, "cache-control": "no-store" };
    if (extname(file) === ".html") {
      const html = render(await readFile(file, "utf8"), posted);
      res.writeHead(200, headers).end(html);
      return;
    }
    if (posted !== null) {
      res.writeHead(405).end();
      return;
    }
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
}

/** Serves `tests/e2e/sites/` over https on both fixture ports. */
export async function startFixtureServers(): Promise<{
  close(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "refill-e2e-cert-"));
  const servers: Server[] = [];
  const close = async () => {
    await Promise.all(
      servers.map((s) => new Promise<void>((done) => s.close(() => done()))),
    );
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const tls = await makeCertificate(dir);
    for (const port of PORTS) {
      const server = createServer(tls, (req, res) => {
        void serve(req, res);
      });
      servers.push(server);
      await listen(server, port);
    }
  } catch (e) {
    await close();
    throw e;
  }
  return { close };
}
