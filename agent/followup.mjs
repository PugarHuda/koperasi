// The agent acts on what the members answered to a poll it opened itself (contract 0.3.8, agent_open_poll).
//
// It asks the members a technical question from its own record (scripts/v038.mjs poll: "keep the model, or try a
// cheaper one?"). When that poll is closed:
// - the members kept the current way: the agent notes it and does nothing more;
// - they chose to try a cheaper model: the agent writes the next by-laws with that one change (config/config.vN.yaml,
//   also served at web/config/) and opens a second poll that carries the file's hash ("keep vM" or "adopt vN"), signed
//   by its key and submitted by a relayer. If the members adopt it, anyone files it as a DAO proposal
//   (poll_to_proposal) and the members vote it into force, as by-laws v11 went (#152). The agent never changes its own
//   by-laws: it only puts the change to the members.
// The decision is a pure function (followup) so it is tested without the chain (tests/unit/followup.test.mjs).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { KeyPair } from "near-api-js";
import { ROOT, account, callRaw, sha256, view } from "../scripts/lib.mjs";
import { loadApprovedConfig } from "./runtime.mjs";

// ponytail: one cheaper model the agent may propose, the one by-laws v2 ran on; a list voted in the by-laws when there are more
export const CHEAPER = "z-ai/glm-5.3-flash";

/**
 * What to do about one of the agent's own polls: "wait" (still open), "kept" (the members kept the current way),
 * "propose" (they chose the cheaper model and the by-laws still run another), "done" (already acted on).
 * @param {{ id: number, closed: boolean, result: number|null, options: string[], bylaws?: any }} poll
 * @param {{ model: string }} config @param {Set<number>} acted
 */
export function followup(poll, config, acted) {
  if (acted.has(poll.id)) return "done";
  if (!poll.closed) return "wait";
  if (poll.bylaws?.some(Boolean)) return "kept"; // a poll that already carried by-laws is followed by poll_to_proposal, not here
  const chosen = poll.result === null || poll.result === undefined ? "" : String(poll.options[poll.result] ?? "");
  return /cheaper/i.test(chosen) && config.model !== CHEAPER ? "propose" : "kept";
}

/** The by-laws text with the model swapped and the version bumped; throws if the file has no model line. */
export function cheaperBylaws(yaml, version, from) {
  if (!/^model:\s*".*"$/m.test(yaml)) throw new Error("no model line in the by-laws");
  return yaml.replace(/^# By-laws v\d+[^\n]*\n/, `# By-laws v${version}, written by the co-op's agent after the members chose a cheaper model in its poll #${from}\n`)
    .replace(/^version:\s*\d+/m, `version: ${version}`)
    .replace(/^model:\s*".*"$/m, `model: "${CHEAPER}"`);
}

/** The signed text agent_open_poll checks: the content hash covers the question, the options and the by-laws refs. */
export function pollMessage(contract, nonce, hours, question, options, bylaws, reason) {
  const content = crypto.createHash("sha256").update(JSON.stringify({ question, options, bylaws })).digest("hex");
  return `koperasi-agent-poll/1 ${contract} #${nonce} ${hours} ${content}\n${reason}`;
}

export async function maybeFollowup({ dep, log = console.log, state, save, relayer = `kop-relayer-${dep.tag}.testnet` }) {
  const K = dep.contract;
  const acted = new Set(state.followedPolls ?? []);
  const { config, text: yaml } = await loadApprovedConfig(dep);
  const mine = await view(K, "get_agent_polls").catch(() => []);
  for (const a of mine) {
    const poll = await view(K, "get_poll", { id: a.id });
    if (!poll) continue;
    const what = followup(poll, config, acted);
    if (what === "wait" || what === "done") continue;
    if (what === "kept") {
      log(`poll #${poll.id}: the members chose "${poll.options[poll.result] ?? "nothing"}"; nothing to change`);
    } else {
      const { version } = await view(K, "get_config");
      const next = version + 1, body = cheaperBylaws(yaml, next, poll.id), uri = `config/config.v${next}.yaml`;
      for (const f of [uri, `web/${uri}`]) fs.writeFileSync(path.join(ROOT, f), body);
      const hash = sha256(Buffer.from(body));
      const question = `The members chose to try a cheaper model in poll #${poll.id}: adopt by-laws v${next} (${CHEAPER})?`;
      const options = [`keep v${version}`, `adopt v${next}: ${CHEAPER}`];
      const bylaws = [null, { version: next, hash, uri }];
      const reason = `Poll #${poll.id} chose "${poll.options[poll.result]}". v${next} changes only the model; everything else is v${version}.`;
      const args = { question, options, hours: 24, bylaws, reason };
      const msg = await view(K, "get_agent_poll_message", { question, options, hours: 24, bylaws, reason });
      const nonce = msg.match(/^koperasi-agent-poll\/1 \S+ #(\d+) /)?.[1];
      // sign only the poll built here: an RPC could hand back another message for the agent's key to sign
      if (msg !== pollMessage(K, nonce, 24, question, options, bylaws, reason)) throw new Error("the poll message from RPC is not the one built here: not signed");
      const { private_key } = JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", `${dep.agent}.json`), "utf8"));
      const signature = Buffer.from(KeyPair.fromString(private_key).sign(Buffer.from(msg)).signature).toString("base64");
      const r = await callRaw(account(relayer), K, "agent_open_poll", { ...args, signature }, { deposit: 2n * 10n ** 22n, tgas: 100 });
      log(`poll #${poll.id} chose a cheaper model: the agent wrote by-laws v${next} and put them to the members (${r.transaction.hash})`);
    }
    acted.add(poll.id);
    state.followedPolls = [...acted];
    save(state);
  }
}
