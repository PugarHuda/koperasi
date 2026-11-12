// Shared by the browser specs: which requests are NEAR RPC calls, and how to answer chosen view calls ourselves.
import { test as base } from "@playwright/test";

export const RPC = /(rpc\.fastnear\.com|test\.rpc\.fastnear\.com|near-testnet\.drpc\.org|rpc\.testnet\.fastnear\.com)/;

// Six browser profiles from one runner hit the public RPCs' per-IP limit (429) and tests failed at random. A read the
// chain answered is kept for the rest of the worker and answered from here, so each distinct read reaches the network
// about once. Routes a test sets on its page (answerViews, an RPC that is down) come first, as page routes do.
// ponytail: per-worker, never expires; a run is ~40 min and the specs only read, so state drift is not a concern.
const answered = new Map();
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route(RPC, async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.fallback();
      const { id, ...rest } = req.postDataJSON?.() ?? {};
      const key = JSON.stringify(rest);
      if (answered.has(key)) {
        return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ ...answered.get(key), id }) });
      }
      let res;
      // the page gives up on an RPC after 8 s and asks the next one: so does this, instead of route.fetch's 30 s
      try { res = await route.fetch({ timeout: 8000 }); } catch { return route.abort("timedout").catch(() => {}); }
      const json = res.ok() ? await res.json().catch(() => null) : null;
      if (json?.result && !json.error && !json.result.error) answered.set(key, json);
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

