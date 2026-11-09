//! Integration ("fork") test against the sponsor protocol: a local NEAR sandbox node runs the real Sputnik DAO v2 code,
//! byte for byte the code of the showcase DAO on testnet (`tests/res/sputnik_dao_v2.wasm`, pulled with `view_code`
//! from `koperasi-mw4i2iwk.sputnik-v2.testnet`, code hash ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq), next to this
//! contract's wasm. It runs the main flow through the DAO for real: membership read from the DAO policy, the trust rule
//! and budget voted by the members, and a task paid from the DAO treasury by a Transfer proposal the contract files and
//! approves in its own role `tasks`.
//!
//! The sandbox binary runs on Linux and macOS only; CI runs this test (`.github/workflows/tests.yml`, job `contract`).
//! Locally: `cargo near build non-reproducible-wasm` then `cargo test --test sputnik_sandbox`.
#![cfg(not(windows))]

use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{json, Value};
use std::sync::Arc;

const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";

struct Chain {
    _sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
}

impl Chain {
    async fn account(&self, sandbox: &near_sandbox::Sandbox, name: &str, near: u128) -> testresult::TestResult<AccountId> {
        let id: AccountId = name.parse()?;
        sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(near)).send().await?;
        Ok(id)
    }

    async fn call(&self, who: &AccountId, contract: &AccountId, method: &str, args: Value, deposit: NearToken, tgas: u64) -> bool {
        near_api::Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(tgas))
            .with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net)
            .await
            .map(|r| r.is_success())
            .unwrap_or(false)
    }

    async fn view(&self, contract: &AccountId, method: &str, args: Value) -> Value {
        near_api::Contract(contract.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await
            .unwrap()
            .data
    }

    async fn balance(&self, who: &AccountId) -> u128 {
        near_api::Tokens::account(who.clone()).near_balance().fetch_from(&self.net).await.unwrap().total.as_yoctonear()
    }
}

#[tokio::test]
async fn a_task_is_paid_from_the_real_sputnik_treasury_through_the_contracts_role() -> testresult::TestResult<()> {
    // the same nearcore line as testnet (2.14): near-sdk 5.30 links host functions older sandboxes do not have
    let sandbox = near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let c = Chain { _sandbox: sandbox, net, signer };
    let sb = &c._sandbox;

    let alice = c.account(sb, "alice.sandbox", 20).await?;
    let bob = c.account(sb, "bob.sandbox", 20).await?;
    let carol = c.account(sb, "carol.sandbox", 5).await?;
    let koperasi = c.account(sb, "koperasi.sandbox", 20).await?;
    let dao = c.account(sb, "dao.sandbox", 30).await?;

    // the real Sputnik code, with Koperasi's policy: members alice and bob, one member one vote, and role `tasks`
    // that lets the contract only add and approve transfer proposals
    let vote_all = json!(["*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize", "*:AddProposal"]);
    let policy = json!({
        "roles": [
            { "name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {} },
            { "name": "member", "kind": { "Group": [alice, bob] }, "permissions": vote_all, "vote_policy": {} },
            { "name": "tasks", "kind": { "Group": [koperasi] }, "permissions": ["transfer:AddProposal", "transfer:VoteApprove"], "vote_policy": {} },
        ],
        "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
        "proposal_bond": NearToken::from_millinear(100).as_yoctonear().to_string(),
        "proposal_period": (7u64 * 24 * 3600 * 1_000_000_000).to_string(),
        "bounty_bond": NearToken::from_millinear(100).as_yoctonear().to_string(),
        "bounty_forgiveness_period": (24u64 * 3600 * 1_000_000_000).to_string(),
    });
    near_api::Contract::deploy(dao.clone())
        .use_code(std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/res/sputnik_dao_v2.wasm"))?)
        .with_init_call("new", json!({ "config": { "name": "koperasi", "purpose": "sandbox", "metadata": "" }, "policy": policy }))?
        .with_signer(c.signer.clone())
        .send_to(&c.net)
        .await?
        .assert_success();

    let wasm = std::env::var("KOPERASI_WASM").unwrap_or(concat!(env!("CARGO_MANIFEST_DIR"), "/target/near/koperasi.wasm").into());
    near_api::Contract::deploy(koperasi.clone())
        .use_code(std::fs::read(wasm)?)
        .with_init_call("new", json!({
            "dao_id": dao, "usdc_id": "usdc.sandbox", "agent_id": "agent.sandbox",
            "join_deposit": NearToken::from_millinear(500).as_yoctonear().to_string(),
            "share_rule": { "reserve_bps": 2000, "savings_bps": 4000, "points_bps": 4000 },
            "config_hash": H1, "config_uri": "ipfs://v1",
        }))?
        .with_signer(c.signer.clone())
        .send_to(&c.net)
        .await?
        .assert_success();

    // membership: the contract reads the DAO policy
    for m in [&alice, &bob] {
        assert!(c.call(m, &koperasi, "join", json!({}), NearToken::from_millinear(500), 30).await);
        assert!(c.call(m, &koperasi, "sync_member", json!({ "account_id": m }), NearToken::from_yoctonear(0), 60).await);
    }
    assert_eq!(c.view(&koperasi, "get_info", json!({})).await["members"], 2);

    // the members vote the trust rule and a 1 NEAR budget (a FunctionCall proposal, both vote)
    let near = |milli: u128| NearToken::from_millinear(milli).as_yoctonear().to_string();
    let rule = json!({ "rule": { "auto_max": near(100), "one_vote_max": near(500), "trusted_after": 1, "poster_daily_auto": near(200), "points": 5 } });
    let action = |m: &str, a: &Value| json!({ "method_name": m, "args": Base64VecU8::from(a.to_string().into_bytes()), "deposit": "0", "gas": "20000000000000" });
    let kind = json!({ "FunctionCall": { "receiver_id": koperasi, "actions": [action("set_trust", &rule), action("set_task_budget", &json!({ "amount": near(1000) }))] } });
    assert!(c.call(&alice, &dao, "add_proposal", json!({ "proposal": { "description": "rule and budget", "kind": kind } }), NearToken::from_millinear(100), 100).await);
    for m in [&alice, &bob] {
        c.call(m, &dao, "act_proposal", json!({ "id": 0, "action": "VoteApprove", "proposal": kind }), NearToken::from_yoctonear(0), 200).await;
    }
    assert_eq!(c.view(&dao, "get_proposal", json!({ "id": 0 })).await["status"], "Approved");
    assert_eq!(c.view(&koperasi, "get_board", json!({})).await["budget"], near(1000));

    // a task: alice posts, carol (new, untrusted) delivers, alice accepts, bob approves → the contract files a Transfer
    // proposal in the DAO and approves it in its role; the money leaves the DAO treasury for carol
    assert!(c.call(&alice, &koperasi, "post_task", json!({ "description": "translate the by-laws", "amount": near(200) }), NearToken::from_millinear(10), 30).await);
    assert!(c.call(&carol, &koperasi, "claim_task", json!({ "id": 0 }), NearToken::from_yoctonear(0), 30).await);
    assert!(c.call(&carol, &koperasi, "submit_task", json!({ "id": 0, "deliverable": "https://example.org/id.md" }), NearToken::from_yoctonear(0), 30).await);
    assert!(c.call(&alice, &koperasi, "accept_task", json!({ "id": 0 }), NearToken::from_yoctonear(0), 200).await);
    assert_eq!(c.view(&koperasi, "get_tasks", json!({})).await[0]["status"], "NeedsApproval");
    let (dao_before, carol_before) = (c.balance(&dao).await, c.balance(&carol).await);
    assert!(c.call(&bob, &koperasi, "approve_task", json!({ "id": 0 }), NearToken::from_yoctonear(0), 300).await);

    let task = &c.view(&koperasi, "get_tasks", json!({})).await[0];
    assert_eq!(task["status"], "Paid", "{task}");
    let pid = c.view(&koperasi, "get_payout_proposal", json!({ "id": 0 })).await;
    let p = c.view(&dao, "get_proposal", json!({ "id": pid })).await;
    assert_eq!(p["status"], "Approved");
    assert_eq!(p["proposer"], koperasi.as_str());
    assert_eq!(p["kind"]["Transfer"]["receiver_id"], carol.as_str());
    assert_eq!(c.balance(&carol).await - carol_before, NearToken::from_millinear(200).as_yoctonear());
    // the treasury paid 0.2 NEAR; the contract's 0.1 NEAR bond came back to the contract, not from the treasury
    assert!(dao_before - c.balance(&dao).await >= NearToken::from_millinear(200).as_yoctonear());
    assert_eq!(c.view(&koperasi, "get_board", json!({})).await["budget"], near(800));
    assert_eq!(c.view(&koperasi, "get_record", json!({ "account_id": carol })).await["refs"], json!(["task:0"]));
    Ok(())
}
