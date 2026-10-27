import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
        void (async () => {
          try {
            const pathname = decodeURIComponent(
              new URL(req.url ?? "/", "https://localhost").pathname,
            );
            let file = resolve(SITES_DIR, "." + normalize(pathname));
            if (file !== SITES_DIR && !file.startsWith(SITES_DIR + sep)) {
              res.writeHead(403).end();
              return;
            }
            if ((await stat(file)).isDirectory())
              file = join(file, "index.html");
            res.writeHead(200, {
              "content-type":
                TYPES[extname(file)] ?? "application/octet-stream",
              "cache-control": "no-store",
            });
            createReadStream(file).pipe(res);
          } catch {
            res.writeHead(404).end();
          }
        })();
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
