// Runs inside an OutLayer worker (Intel TDX). Input: {"contract", "rpc", "page"}. It reads the by-laws the members voted
// (`get_config` on the contract: version, sha256, uri), downloads that file from the page, hashes it and says whether
// they match. The worker signs the output, and OutLayer returns it on-chain to the caller's transaction.
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use wasi_http_client::Client;

#[derive(Deserialize)]
struct Input {
    contract: String,
    rpc: String,
    page: String,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn run() -> Result<Value, String> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let input: Input = serde_json::from_str(&raw).map_err(|e| format!("input: {e}"))?;
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
    let got = hex(&Sha256::digest(res.body().map_err(|e| format!("by-laws: {e}"))?));
    Ok(json!({
        "contract": input.contract, "version": config["version"], "uri": uri, "url": url,
        "voted_sha256": voted, "file_sha256": got, "match": got == voted,
    }))
}

fn main() {
    let out = run().unwrap_or_else(|e| json!({ "match": false, "error": e }));
    print!("{out}");
    io::stdout().flush().ok();
}
