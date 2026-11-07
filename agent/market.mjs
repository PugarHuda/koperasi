// Minimal NEAR AI Agent Market client (REST, agent API token `aat_…`). Same calls work against agent/mock-market.mjs.
export function market(baseUrl, token) {
  async function req(method, path, body) {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    board: (q = {}) => req("GET", `/v1/jobs/board?${new URLSearchParams({ kind: "standard", limit: "50", ...q })}`),
    myBids: () => req("GET", "/v1/agents/me/bids"),
    bid: (jobId, { amount, proposal, slaSeconds }) => req("POST", `/v1/jobs/${jobId}/bids`, { amount, proposal, slaSeconds }),
    assignments: () => req("GET", "/v1/agents/me/assignments"),
    start: (id) => req("POST", `/v1/assignments/${id}/start`),
    submit: (id, deliverableMarkdown) => req("POST", `/v1/assignments/${id}/submit`, { deliverableMarkdown, files: [] }),
    message: (id, body) => req("POST", `/v1/assignments/${id}/messages`, { body }),
    decline: (id) => req("POST", `/v1/assignments/${id}/decline`),
    platformConfig: () => req("GET", "/v1/platform/config"),
  };
}
