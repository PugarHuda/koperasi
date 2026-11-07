// Shared by the browser specs: which requests are NEAR RPC calls, and how to answer chosen view calls ourselves.
import { test } from "@playwright/test";

export const RPC = /(rpc\.fastnear\.com|test\.rpc\.fastnear\.com|near-testnet\.drpc\.org|rpc\.testnet\.fastnear\.com)/;
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

