// Shared by the browser specs: which requests are NEAR RPC calls, and how to answer chosen view calls ourselves.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "@playwright/test";

export const RPC = /(rpc\.fastnear\.com|test\.rpc\.fastnear\.com|near-testnet\.drpc\.org|rpc\.testnet\.fastnear\.com|rpc\.testnet\.near\.org)/;

// Six browser profiles from one runner hit the public RPCs' per-IP limit (429) and tests failed at random. A read the
// chain answered is kept for the rest of the run and answered from here, so each distinct read reaches the network
// about once. Routes a test sets on its page (answerViews, an RPC that is down) come first, as page routes do.
// It is kept on disk, shared by every worker of the run (they are the runner's children): a worker that starts after a
// failure, or for the next profile, starts warm. Cold, Firefox needed more than the 30 s an assertion waits to fill the
// page, so one failure restarted the worker cold and every Firefox test failed.
// ponytail: never expires within a run (~1 h; the specs only read); one folder per run left in the temp dir.
const DIR = join(tmpdir(), `koperasi-rpc-${process.ppid}`);
mkdirSync(DIR, { recursive: true });
const file = (key) => join(DIR, createHash("sha1").update(key).digest("hex"));
const recall = (key) => { try { return JSON.parse(readFileSync(file(key), "utf8")); } catch { return undefined; } };
const keep = (key, json) => {
  const f = file(key);
  writeFileSync(`${f}.${process.pid}`, JSON.stringify(json));
  renameSync(`${f}.${process.pid}`, f); // whole or absent for the other workers
};
// the chain's own answer is the same on every RPC and every ask (as web/near.js judges it): a result, a contract's refusal
const settled = (json) => json?.result || /UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CONTRACT_EXECUTION_ERROR/.test(JSON.stringify(json?.error ?? ""));
/** The page's own testnet RPCs (web/near.js), tried in turn when one is rate-limited. */
const MIRRORS = ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com"];
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route(RPC, async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.fallback();
      const { id, ...rest } = req.postDataJSON?.() ?? {};
      const key = JSON.stringify(rest);
      const known = recall(key);
      if (known) {
        return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ ...known, id }) });
      }
      // a rate-limited answer (HTTP 429, or fastnear's JSON-RPC error -429 with HTTP 200) is retried on the other RPCs,
      // then once more after a pause: the page's own fallback would see the same limit from this runner's one IP
      let res;
      for (const [k, url] of [req.url(), ...MIRRORS.filter((u) => !req.url().startsWith(u)), ...MIRRORS].entries()) {
        if (k === MIRRORS.length) await new Promise((ok) => setTimeout(ok, 2000));
        try { res = await route.fetch({ url, timeout: 8000 }); } catch { res = null; continue; }
        const json = res.ok() ? await res.json().catch(() => null) : null;
        if (res.status() === 429 || json?.error?.code === -429 || /rate limit/i.test(JSON.stringify(json?.error ?? ""))) continue;
        if (settled(json)) keep(key, json);
        break;
      }
      if (!res) return route.abort("timedout").catch(() => {});
      // the page may have stopped waiting meanwhile
      return route.fulfill({ response: res }).catch(() => {});
    });
    await use(context);
  },
});
export const local = (testInfo) => /localhost|127\.0\.0\.1/.test(testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "");
export const onlyLocal = (testInfo) => test.skip(!local(testInfo), "?as= previews run on localhost only");

/**
 * Answer chosen view calls with our own JSON; pass every other RPC call through to the real network.
 * `fake` maps a contract method name to the value the RPC should return.
 */
export async function answerViews(page, fake) {
  await page.route(RPC, async (route) => {
    const body = route.request().postDataJSON?.() ?? {};
    const method = body?.params?.method_name;
    if (method && method in fake) {
      const bytes = [...Buffer.from(JSON.stringify(fake[method]))];
      return route.fulfill({ contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: bytes, logs: [], block_height: 1, block_hash: "x" } }) });
    }
    return route.fallback();
  });
}

