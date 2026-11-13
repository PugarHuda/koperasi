// Runs inside an OutLayer worker (Intel TDX). Input: {"contract", "rpc", "page"}; the RPC must be one of NEAR's own
// (a caller-chosen RPC could claim any hash and get a signed "match"); the page may be anything, since the file is
// judged only against the hash from the chain, and both are named in the signed output. It reads the by-laws the members voted
// (`get_config` on the contract: version, sha256, uri), downloads that file from the page, hashes it and says whether
// they match. The worker signs the output, and OutLayer returns it on-chain to the caller's transaction.
//
// With a `job` in the input ({id, tags, price_usdc}), the program also judges the job by the by-laws it just matched:
// the job's tags must meet `job_filter.tags_any` and its price `job_filter.min_price_usdc`. So the transaction proves
// not only "these are the voted by-laws" but "this job is one the voted by-laws let the agent take"; the receipt names
// the job and `npm run verify` checks the two agree.
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use wasi_http_client::Client;

#[derive(Deserialize)]
struct Job {
    id: String,
    tags: Vec<String>,
    price_usdc: f64,
}

#[derive(Deserialize)]
struct Input {
    contract: String,
    rpc: String,
    page: String,
    job: Option<Job>,
}

/// `job_filter` from the by-laws (tags_any, min_price_usdc). A line reader, not YAML: the file's bytes were just
/// matched to the voted hash, and these two keys are written one per line in every version so far.
fn job_filter(bylaws: &str) -> Result<(Vec<String>, f64), String> {
    let mut lines = bylaws.lines().skip_while(|l| l.trim_end() != "job_filter:").skip(1).take_while(|l| l.starts_with("  "));
    let (mut tags, mut min) = (None, None);
    for l in lines.by_ref() {
        let l = l.trim();
        if let Some(v) = l.strip_prefix("tags_any:") {
            let v = v.trim().trim_start_matches('[').trim_end_matches(']');
            tags = Some(v.split(',').map(|t| t.trim().trim_matches('"').to_lowercase()).filter(|t| !t.is_empty()).collect());
        } else if let Some(v) = l.strip_prefix("min_price_usdc:") {
            min = v.trim().parse::<f64>().ok();
        }
    }
    Ok((tags.ok_or("by-laws: no job_filter.tags_any")?, min.ok_or("by-laws: no job_filter.min_price_usdc")?))
}

/// The by-laws' verdict on a job: (allowed, reason).
fn judge(job: &Job, tags: &[String], min: f64) -> (bool, String) {
    if !job.tags.iter().any(|t| tags.contains(&t.to_lowercase())) {
        return (false, format!("no tag among {}", tags.join(", ")));
    }
    if !(job.price_usdc >= min) {
        return (false, format!("price {} is under the {} USDC minimum", job.price_usdc, min));
    }
    (true, "the job's tags and price meet job_filter".into())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// NEAR RPCs the program trusts to report the voted hash (testnet and mainnet).
const RPCS: [&str; 4] = ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org", "https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"];

fn run() -> Result<Value, String> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let input: Input = serde_json::from_str(&raw).map_err(|e| format!("input: {e}"))?;
    if !RPCS.contains(&input.rpc.as_str()) {
        return Err(format!("untrusted rpc {}: use one of {}", input.rpc, RPCS.join(", ")));
    }
    let client = Client::new();

    // what the members voted, straight from the chain ({} as base64 is "e30=")
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "query", "params": {
        "request_type": "call_function", "finality": "final", "account_id": input.contract,
        "method_name": "get_config", "args_base64": "e30=" } }).to_string();
    let res = client.post(&input.rpc).header("content-type", "application/json").body(body.as_bytes())
        .send().map_err(|e| format!("rpc: {e}"))?;
    let rpc: Value = serde_json::from_slice(&res.body().map_err(|e| format!("rpc: {e}"))?).map_err(|e| format!("rpc json: {e}"))?;
    let bytes: Vec<u8> = rpc["result"]["result"].as_array().ok_or("rpc: no result")?
        .iter().map(|v| v.as_u64().unwrap_or(0) as u8).collect();
    let config: Value = serde_json::from_slice(&bytes).map_err(|e| format!("get_config: {e}"))?;
    let voted = config["hash"].as_str().ok_or("get_config: no hash")?.to_string();
    let uri = config["uri"].as_str().ok_or("get_config: no uri")?.to_string();
    // only a relative path inside the page: the by-laws are served next to it
    if uri.contains("..") || uri.starts_with('/') || uri.contains("://") {
        return Err(format!("refusing uri {uri}"));
    }

    let url = format!("{}/{}", input.page.trim_end_matches('/'), uri);
    let res = client.get(&url).send().map_err(|e| format!("by-laws: {e}"))?;
    if res.status() != 200 {
        return Err(format!("by-laws: HTTP {}", res.status()));
    }
    let file = res.body().map_err(|e| format!("by-laws: {e}"))?;
    let got = hex(&Sha256::digest(&file));
    // a job is judged only by by-laws that match the vote
    let job = match (&input.job, got == voted) {
        (Some(j), true) => {
            let (tags, min) = job_filter(&String::from_utf8_lossy(&file))?;
            let (allowed, reason) = judge(j, &tags, min);
            json!({ "id": j.id, "tags": j.tags, "price_usdc": j.price_usdc, "allowed": allowed, "reason": reason })
        }
        (Some(j), false) => json!({ "id": j.id, "allowed": false, "reason": "the by-laws file does not match the vote" }),
        (None, _) => Value::Null,
    };
    Ok(json!({
        "contract": input.contract, "rpc": input.rpc, "page": input.page, "version": config["version"], "uri": uri, "url": url,
        "voted_sha256": voted, "file_sha256": got, "match": got == voted, "job": job,
    }))
}

fn main() {
    let out = run().unwrap_or_else(|e| json!({ "match": false, "error": e }));
    print!("{out}");
    io::stdout().flush().ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    const V4: &str = include_str!("../../../web/config/config.v4.yaml");

    #[test]
    fn reads_job_filter_and_judges_jobs() {
        let (tags, min) = job_filter(V4).unwrap();
        assert!(tags.contains(&"research".to_string()) && min == 2.0);
        let job = |t: &str, p: f64| Job { id: "j".into(), tags: vec![t.into()], price_usdc: p };
        assert!(judge(&job("Research", 3.0), &tags, min).0);
        assert!(!judge(&job("memes", 3.0), &tags, min).0);
        assert!(!judge(&job("research", 1.5), &tags, min).0);
        assert!(!judge(&job("research", f64::NAN), &tags, min).0);
        assert!(job_filter("version: 1\n").is_err());
    }
}
