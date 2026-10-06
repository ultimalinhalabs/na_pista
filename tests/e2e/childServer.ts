import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * Runs the real `src/server.ts` in a SEPARATE process, with environment
 * overrides, and stops it explicitly.
 *
 * Why (F29A closure): suites that make Na Pista's own database unreachable
 * used to run the app in the test process. Since F29A the request touches
 * that dead database first (credential lookup), and on Windows the test
 * runner's `--test-force-exit` then races libuv's native socket teardown →
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`
 * after every assertion had already passed. Running the server out of
 * process keeps those dead-database handles out of the test process
 * entirely, so the forced exit has nothing to race. Same pattern as
 * tests/e2e/platform-credentials-runtime.test.ts.
 */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export async function startChildServer(env: Record<string, string> = {}) {
  const port = await freePort();
  const output: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => output.push(String(d)));
  child.stderr!.on("data", (d) => output.push(String(d)));

  const base = `http://127.0.0.1:${port}/v1`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try {
      up = (await fetch(`${base}/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!up) {
    child.kill();
    throw new Error("Na Pista child server did not start");
  }

  return {
    base,
    output: () => output.join(""),
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}
