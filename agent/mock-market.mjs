// Local stand-in for NEAR AI Agent Market with the same REST paths and JSON shapes the agent uses, so judges can run
// the whole loop without an Agent Market account. Bids are awarded at once and deliveries accepted after `acceptMs`.
//   node agent/mock-market.mjs            (port 8787)
//   POST /_mock/jobs {title, description, tags, budgetAmount}   adds a job
import http from "node:http";
import crypto from "node:crypto";

export function startMockMarket({ port = 8787, acceptMs = 1500, jobs: seed = [] } = {}) {
  const jobs = new Map();
  const bids = new Map();
  const assignments = new Map();
  const now = () => new Date().toISOString();

  function addJob(j) {
    const jobId = j.jobId ?? crypto.randomUUID();
    jobs.set(jobId, {
      jobId,
      title: j.title,
      description: j.description,
      tags: j.tags ?? [],
      budgetAmount: String(j.budgetAmount ?? "5"),
      budgetToken: "USDC",
      jobKind: "standard",
      status: "open",
      createdAt: now(),
    });
    return jobs.get(jobId);
  }
  seed.forEach(addJob);

  /** @type {Array<[string, RegExp, (params: string[], body: any) => any]>} */
  const routes = [
    ["GET", /^\/v1\/jobs\/board$/, () => ({ jobs: [...jobs.values()].filter((j) => j.status === "open") })],
    ["GET", /^\/v1\/agents\/me\/bids$/, () => ({ bids: [...bids.values()] })],
    ["POST", /^\/v1\/jobs\/([^/]+)\/bids$/, ([id], body) => {
      const job = jobs.get(id);
      if (!job || job.status !== "open") return [404, { error: "not_found" }];
      const bid = { bidId: crypto.randomUUID(), jobId: id, amount: body.amount, proposal: body.proposal,
        slaSeconds: body.slaSeconds ?? 86400, status: "accepted", createdAt: now() };
      bids.set(bid.bidId, bid);
      job.status = "in_progress"; // mock buyer awards the first bid
      // "demo-": a receipt from this stand-in buyer always says so, on-chain
      const a = { assignmentId: `demo-${crypto.randomUUID()}`, jobId: id, bidId: bid.bidId, status: "in_progress",
        escrowAmount: body.amount, escrowToken: "USDC", slaSeconds: bid.slaSeconds, startedAt: null,
        submittedAt: null, deliverableHash: null, createdAt: now() };
      assignments.set(a.assignmentId, a);
      return [201, bid];
    }],
    ["GET", /^\/v1\/agents\/me\/assignments$/, () => ({
      assignments: [...assignments.values()].map((a) => ({ assignment: a, job: jobs.get(a.jobId), latestMessage: null })),
    })],
    ["POST", /^\/v1\/assignments\/([^/]+)\/start$/, ([id]) => {
      const a = assignments.get(id);
      a.startedAt ??= now();
      return { startedAt: a.startedAt };
    }],
    ["POST", /^\/v1\/assignments\/([^/]+)\/submit$/, ([id], body) => {
      const a = assignments.get(id);
      a.status = "submitted";
      a.submittedAt = now();
      a.deliverableHash = crypto.createHash("sha256").update(body.deliverableMarkdown ?? "").digest("hex");
      setTimeout(() => { a.status = "accepted"; }, acceptMs); // mock buyer accepts
      return a;
    }],
    ["POST", /^\/v1\/assignments\/([^/]+)\/messages$/, () => [201, { ok: true }]],
    ["POST", /^\/v1\/assignments\/([^/]+)\/decline$/, ([id]) => {
      const a = assignments.get(id);
      if (a?.status !== "in_progress") return [409, { error: "not_in_progress" }];
      a.status = "cancelled"; // the real market refunds the buyer in full
      return a;
    }],
    ["GET", /^\/v1\/platform\/config$/, () => ({ platform_fee_bps: 500 })],
    ["POST", /^\/_mock\/jobs$/, (_, body) => [201, addJob(body)]],
  ];

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x");
    for (const [m, re, fn] of routes) {
      const hit = req.method === m && url.pathname.match(re);
      if (!hit) continue;
      if (!url.pathname.startsWith("/_mock") && !req.headers.authorization?.startsWith("Bearer ")) {
        res.writeHead(401).end('{"error":"unauthorized"}');
        return;
      }
      let out = fn(hit.slice(1), raw ? JSON.parse(raw) : {});
      const [status, body] = Array.isArray(out) ? out : [200, out];
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    res.writeHead(404).end('{"error":"not_found"}');
  });
  return new Promise((r) => server.listen(port, () => r({ server, url: `http://localhost:${port}`, addJob })));
}

if (process.argv[1]?.endsWith("mock-market.mjs")) {
  const { url } = await startMockMarket();
  console.log(`mock Agent Market on ${url}`);
}
