use super::*;
use near_sdk::serde_json::json;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn dao() -> AccountId {
    acc("koperasi.sputnik-v2.testnet")
}
fn usdc() -> AccountId {
    acc("usdc.testnet")
}
fn agent() -> AccountId {
    acc("agent.koperasi.testnet")
}
fn steward() -> AccountId {
    acc("steward.testnet")
}
fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

fn as_(who: &AccountId, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("koperasi.testnet"))
        .predecessor_account_id(who.clone())
        .attached_deposit(deposit)
        .account_balance(near(100));
    testing_env!(b.build());
}

fn rule(c: u16, s: u16, j: u16) -> ShareRule {
    ShareRule { reserve_bps: c, savings_bps: s, points_bps: j }
}

fn setup() -> Koperasi {
    as_(&acc("deployer.testnet"), near(0));
    Koperasi::new(dao(), usdc(), agent(), near(1), rule(2000, 4000, 4000), H1.into(), "ipfs://v1".into())
}

/// alice, bob, carol become members: join + DAO added them to role `member`.
fn with_members(k: &mut Koperasi, names: &[&str]) {
    for n in names {
        as_(&acc(n), near(1));
        k.join();
        k.apply_membership(acc(n), true);
    }
}

fn policy(members: &[&str]) -> Value {
    json!({ "roles": [
        { "name": "all", "kind": "Everyone" },
        { "name": "council", "kind": { "Group": ["dao-admin.testnet"] } },
        { "name": "member", "kind": { "Group": members } }
    ]})
}

// ---------- membership ----------

#[test]
fn role_has_reads_sputnik_policy() {
    let p = policy(&["alice.testnet"]);
    assert!(role_has(&p, "member", &acc("alice.testnet")));
    assert!(!role_has(&p, "member", &acc("bob.testnet")));
    assert!(!role_has(&p, "member", &acc("dao-admin.testnet")), "council is not member");
    assert!(!role_has(&json!({}), "member", &acc("alice.testnet")));
}

#[test]
fn join_waits_for_the_dao_then_on_policy_admits() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(1));
    k.join();
    assert!(k.is_pending(acc("alice.testnet")));
    assert!(k.get_member(acc("alice.testnet")).is_none());

    as_(&acc("koperasi.testnet"), near(0));
    k.on_policy(acc("alice.testnet"), Ok(policy(&["alice.testnet"])));
    assert!(k.get_member(acc("alice.testnet")).is_some());
    assert!(!k.is_pending(acc("alice.testnet")));
}

#[test]
#[should_panic(expected = "could not read DAO policy")]
fn on_policy_failure_changes_nothing() {
    let mut k = setup();
    as_(&acc("koperasi.testnet"), near(0));
    k.on_policy(acc("alice.testnet"), Err(PromiseError::Failed));
}

#[test]
fn on_policy_admits_only_accounts_in_the_role() {
    let mut k = setup();
    for n in ["alice.testnet", "bob.testnet"] {
        as_(&acc(n), near(1));
        k.join();
    }
    as_(&acc("koperasi.testnet"), near(0));
    k.on_policy(acc("alice.testnet"), Ok(policy(&["alice.testnet"])));
    k.on_policy(acc("bob.testnet"), Ok(policy(&["alice.testnet"])));
    assert!(k.get_member(acc("alice.testnet")).is_some());
    assert!(k.get_member(acc("bob.testnet")).is_none());
    assert!(k.is_pending(acc("bob.testnet")), "bob still waits for a vote");
}

#[test]
fn removed_from_role_releases_member() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&acc("koperasi.testnet"), near(0));
    k.on_policy(acc("alice.testnet"), Ok(policy(&[])));
    assert!(k.get_member(acc("alice.testnet")).is_none());
    assert_eq!(k.get_info().members, 0);
}

#[test]
#[should_panic(expected = "attach at least the join deposit")]
fn join_needs_join_deposit() {
    let mut k = setup();
    as_(&acc("alice.testnet"), NearToken::from_millinear(500));
    k.join();
}

#[test]
#[should_panic(expected = "already joined")]
fn join_twice_fails() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&acc("alice.testnet"), near(1));
    k.join();
}

#[test]
fn cancel_join_waits_for_the_dao_before_removing_pending() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(1));
    k.join();
    let _ = k.cancel_join();
    assert!(k.is_pending(acc("alice.testnet")), "nothing changes until the DAO policy is read");
}

// ---------- members' vote ----------

#[test]
#[should_panic(expected = "only the DAO")]
fn only_dao_sets_config() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(0));
    k.set_config(2, H2.into(), "ipfs://v2".into(), None, 0);
}

#[test]
fn set_config_bumps_version_and_pays_points() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&dao(), near(0));
    k.set_config(2, H2.into(), "ipfs://v2".into(), Some(acc("alice.testnet")), 10);
    assert_eq!(k.get_config().hash, H2);
    assert_eq!(k.get_config_history(None, None).len(), 2);
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().points, 10);
}

#[test]
#[should_panic(expected = "version must increase")]
fn config_version_cannot_go_back() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_config(1, H2.into(), "x".into(), None, 0);
}

#[test]
#[should_panic(expected = "hash must be 64 lowercase hex chars")]
fn config_hash_is_validated() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_config(2, "ABC".into(), "x".into(), None, 0);
}

#[test]
#[should_panic(expected = "share_rule must add up to 10000 bps")]
fn share_rule_must_sum_to_10000() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_share_rule(rule(1000, 1000, 1000));
}

// ---------- the agent ----------

fn receipt(k: &mut Koperasi, job: &str, price: u128, hash: &str) {
    as_(&agent(), near(0));
    k.record_receipt(job.into(), U128(price), U128(120_000), hash.into(), "deadbeef".into(), None);
}

#[test]
fn receipt_records_the_running_config() {
    let mut k = setup();
    receipt(&mut k, "job-1", 5_000_000, H1);
    let r = &k.get_receipts(None, None)[0];
    assert_eq!(r.config_version, 1);
    assert_eq!(r.status, ReceiptStatus::Submitted);
}

#[test]
#[should_panic(expected = "config_mismatch")]
fn receipt_with_unapproved_config_is_refused() {
    let mut k = setup();
    receipt(&mut k, "job-1", 5_000_000, H2);
}

#[test]
#[should_panic(expected = "config_mismatch")]
fn old_config_is_refused_after_a_vote() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_config(2, H2.into(), "ipfs://v2".into(), None, 0);
    receipt(&mut k, "job-1", 5_000_000, H1);
}

#[test]
#[should_panic(expected = "only the agent")]
fn only_agent_records_receipts() {
    let mut k = setup();
    as_(&steward(), near(0));
    k.record_receipt("job-1".into(), U128(1), U128(1), H1.into(), "x".into(), None);
}

#[test]
#[should_panic(expected = "koperasi is paused")]
fn paused_agent_cannot_record() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.pause();
    receipt(&mut k, "job-1", 1, H1);
}

#[test]
#[should_panic(expected = "receipt exists")]
fn duplicate_receipt_fails() {
    let mut k = setup();
    receipt(&mut k, "job-1", 1, H1);
    receipt(&mut k, "job-1", 1, H1);
}

#[test]
fn receipt_status_flow() {
    let mut k = setup();
    receipt(&mut k, "job-1", 1, H1);
    k.update_receipt("job-1".into(), ReceiptStatus::Disputed);
    k.update_receipt("job-1".into(), ReceiptStatus::Paid);
    assert_eq!(k.get_receipts(None, None)[0].status, ReceiptStatus::Paid);
}

#[test]
#[should_panic(expected = "invalid status change")]
fn paid_receipt_cannot_be_refunded() {
    let mut k = setup();
    receipt(&mut k, "job-1", 1, H1);
    k.update_receipt("job-1".into(), ReceiptStatus::Paid);
    k.update_receipt("job-1".into(), ReceiptStatus::Refunded);
}

#[test]
#[should_panic(expected = "only the DAO or the steward")]
fn member_cannot_pause() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(0));
    k.pause();
}

#[test]
#[should_panic(expected = "only the DAO")]
fn steward_cannot_unpause() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_steward(Some(steward()));
    as_(&steward(), near(0));
    k.pause();
    k.unpause();
}

// ---------- steward and reconciliation ----------

#[test]
fn reconciliation_counts_paid_jobs_net_of_fee() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_steward(Some(steward()));
    receipt(&mut k, "job-1", 10_000_000, H1);
    receipt(&mut k, "job-2", 4_000_000, H1);
    k.update_receipt("job-1".into(), ReceiptStatus::Paid);
    k.update_receipt("job-2".into(), ReceiptStatus::Refunded);
    let r = k.get_audit();
    assert_eq!(r.expected.0, 9_500_000, "10 USDC minus 5% market fee; refunded job owes nothing");
    assert_eq!(r.owed.0, 9_500_000);

    as_(&usdc(), near(0));
    let _ = k.ft_on_transfer(steward(), U128(9_500_000), "earnings".into());
    let r = k.get_audit();
    assert_eq!(r.deposited.0, 9_500_000);
    assert_eq!(r.owed.0, 0);
}

#[test]
fn earnings_from_someone_else_are_returned() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_steward(Some(steward()));
    as_(&usdc(), near(0));
    match k.ft_on_transfer(acc("mallory.testnet"), U128(5), "earnings".into()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 5),
        _ => panic!("expected a value"),
    }
    assert_eq!(k.get_audit().deposited.0, 0);
}

#[test]
fn fake_token_is_returned() {
    let mut k = setup();
    as_(&acc("fake-usdc.testnet"), near(0));
    match k.ft_on_transfer(dao(), U128(5), "share".into()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 5),
        _ => panic!("expected a value"),
    }
    assert!(k.get_periods().is_empty());
}

#[test]
fn bond_and_slash() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_steward(Some(steward()));
    as_(&steward(), near(5));
    k.bond_steward();
    assert_eq!(k.get_info().steward_bond, near(5));
    as_(&dao(), near(0));
    assert_eq!(k.slash_steward(), near(5));
    assert!(k.get_info().steward_bond.is_zero());
}

#[test]
#[should_panic(expected = "only the steward")]
fn stranger_cannot_bond() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(5));
    k.bond_steward();
}

// ---------- profit share ----------

fn share(k: &mut Koperasi, amount: u128) {
    as_(&usdc(), near(0));
    let _ = k.ft_on_transfer(dao(), U128(amount), "share".into());
}

#[test]
fn share_splits_by_savings_and_points_and_nothing_is_lost() {
    let mut k = setup(); // 20% reserve, 40% savings, 40% points
    with_members(&mut k, &["alice.testnet", "bob.testnet", "carol.testnet"]);
    as_(&dao(), near(0));
    k.set_savings(vec![
        (acc("alice.testnet"), U128(near(300).as_yoctonear())),
        (acc("bob.testnet"), U128(near(100).as_yoctonear())),
    ]);
    k.award_points(acc("carol.testnet"), 30, "tool riset".into());
    k.award_points(acc("bob.testnet"), 10, "prompt".into());

    share(&mut k, 100_000_000); // 100 USDC
    let a = k.get_claimable(acc("alice.testnet")).0;
    let b = k.get_claimable(acc("bob.testnet")).0;
    let c = k.get_claimable(acc("carol.testnet")).0;
    assert_eq!(a, 30_000_000, "alice: 3/4 of the 40 USDC savings pool");
    assert_eq!(b, 10_000_000 + 10_000_000, "bob: 1/4 savings + 1/4 points");
    assert_eq!(c, 30_000_000, "carol: 3/4 of the 40 USDC points pool");
    let p = &k.get_periods()[0];
    assert_eq!(p.reserve.0, 20_000_000);
    assert_eq!(a + b + c + p.reserve.0, 100_000_000);
    assert_eq!(k.get_member(acc("carol.testnet")).unwrap().points, 0, "points resets each period");
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().savings.0, near(300).as_yoctonear(), "savings stays");
}

#[test]
fn share_rounding_goes_to_reserve() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet", "carol.testnet"]);
    as_(&dao(), near(0));
    for n in ["alice.testnet", "bob.testnet", "carol.testnet"] {
        k.award_points(acc(n), 1, "x".into());
    }
    share(&mut k, 10); // 4 units of points pool over 3 members
    let paid: u128 =
        ["alice.testnet", "bob.testnet", "carol.testnet"].iter().map(|n| k.get_claimable(acc(n)).0).sum();
    let p = &k.get_periods()[0];
    assert_eq!(paid + p.reserve.0, 10);
    assert_eq!(paid, 3);
}

#[test]
fn unused_pools_stay_in_the_dao() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    share(&mut k, 1_000);
    assert_eq!(k.get_claimable(acc("alice.testnet")).0, 0);
    assert_eq!(k.get_periods()[0].reserve.0, 1_000);
}

#[test]
fn share_from_a_non_dao_sender_is_returned() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&usdc(), near(0));
    match k.ft_on_transfer(acc("alice.testnet"), U128(1_000), "share".into()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 1_000),
        _ => panic!("expected a value"),
    }
}

#[test]
fn late_joiner_gets_only_later_periods() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&dao(), near(0));
    k.award_points(acc("alice.testnet"), 5, "x".into());
    share(&mut k, 1_000);
    with_members(&mut k, &["bob.testnet"]);
    assert_eq!(k.get_claimable(acc("bob.testnet")).0, 0);
}

#[test]
fn claim_failure_restores_balance() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&dao(), near(0));
    k.award_points(acc("alice.testnet"), 1, "x".into());
    share(&mut k, 1_000);
    as_(&acc("alice.testnet"), near(0));
    let _ = k.claim_share();
    assert_eq!(k.get_claimable(acc("alice.testnet")).0, 0, "no double claim while the transfer is in flight");
    as_(&acc("koperasi.testnet"), near(0));
    k.on_claimed(acc("alice.testnet"), U128(400), Err(PromiseError::Failed));
    assert_eq!(k.get_claimable(acc("alice.testnet")).0, 400);
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn claim_nothing_fails() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(0));
    let _ = k.claim_share();
}

#[test]
fn failed_forward_can_be_flushed() {
    let mut k = setup();
    as_(&acc("koperasi.testnet"), near(0));
    k.on_forwarded(U128(700), Err(PromiseError::Failed));
    assert_eq!(k.get_info().unforwarded.0, 700);
    as_(&acc("anyone.testnet"), near(0));
    k.flush_to_dao();
    assert_eq!(k.get_info().unforwarded.0, 0);
}

// ---------- cancel_join cannot keep a vote without a deposit ----------

#[test]
fn cancel_before_the_vote_refunds() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(1));
    k.join();
    let _ = k.cancel_join();
    as_(&acc("koperasi.testnet"), near(0));
    k.on_cancel_policy(acc("alice.testnet"), Ok(policy(&[])));
    assert!(!k.is_pending(acc("alice.testnet")));
    assert!(k.get_member(acc("alice.testnet")).is_none());
}

#[test]
fn cancel_after_the_vote_admits_instead_of_refunding() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(1));
    k.join();
    let _ = k.cancel_join();
    as_(&acc("koperasi.testnet"), near(0));
    k.on_cancel_policy(acc("alice.testnet"), Ok(policy(&["alice.testnet"])));
    let m = k.get_member(acc("alice.testnet")).expect("admitted");
    assert_eq!(m.join_deposit, near(1), "the deposit stays locked as a member's deposit");
    assert!(!k.is_pending(acc("alice.testnet")));
}

#[test]
#[should_panic(expected = "no pending join")]
fn cancel_without_a_request_fails() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(0));
    let _ = k.cancel_join();
}

#[test]
#[should_panic(expected = "could not read DAO policy")]
fn cancel_keeps_the_deposit_when_the_dao_cannot_be_read() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(1));
    k.join();
    as_(&acc("koperasi.testnet"), near(0));
    k.on_cancel_policy(acc("alice.testnet"), Err(PromiseError::Failed));
}

// ---------- savings from a real staking pool ----------

#[test]
fn staking_pool_is_set_by_the_dao_and_savings_follow_the_stake() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    assert_eq!(k.get_staking_pool(), None);
    as_(&dao(), near(0));
    k.set_staking_pool(Some(acc("pool.testnet")));
    assert_eq!(k.get_staking_pool(), Some(acc("pool.testnet")));
    as_(&acc("bob.testnet"), near(0));
    let _ = k.sync_savings(acc("alice.testnet"));
    as_(&acc("koperasi.testnet"), near(0));
    k.on_staked(acc("alice.testnet"), Ok(U128(7 * 10u128.pow(24))));
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().savings, U128(7 * 10u128.pow(24)));
    as_(&dao(), near(0));
    k.set_staking_pool(None);
    assert_eq!(k.get_staking_pool(), None);
}

#[test]
#[should_panic(expected = "only the DAO")]
fn only_the_dao_chooses_the_staking_pool() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(0));
    k.set_staking_pool(Some(acc("pool.testnet")));
}

#[test]
#[should_panic(expected = "the DAO has not chosen a staking pool")]
fn sync_savings_needs_a_pool() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    let _ = k.sync_savings(acc("alice.testnet"));
}

#[test]
#[should_panic(expected = "could not read the staking pool")]
fn savings_unchanged_when_the_pool_cannot_be_read() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&acc("koperasi.testnet"), near(0));
    k.on_staked(acc("alice.testnet"), Err(PromiseError::Failed));
}

// ---------- proofs and upgrades ----------

#[test]
fn receipt_keeps_the_inference_proof() {
    let mut k = setup();
    as_(&agent(), near(0));
    let proof = r#"{"inference_id":"abc","signer":"0x12"}"#;
    k.record_receipt("job-p".into(), U128(1), U128(1), H1.into(), "d".into(), Some(proof.into()));
    assert_eq!(k.get_proof("job-p".into()).as_deref(), Some(proof));
    assert_eq!(k.get_proof("other".into()), None);
}

#[test]
#[should_panic(expected = "proof too long")]
fn oversized_proof_is_refused() {
    let mut k = setup();
    as_(&agent(), near(0));
    k.record_receipt("job-p".into(), U128(1), U128(1), H1.into(), "d".into(), Some("x".repeat(1025)));
}

#[test]
#[should_panic(expected = "only the DAO")]
fn only_the_dao_upgrades_the_code() {
    let mut k = setup();
    as_(&steward(), near(0));
    let _ = k.upgrade(Base58CryptoHash::from([7u8; 32]));
}

#[test]
fn the_dao_upgrades_to_a_global_contract_hash() {
    let mut k = setup();
    as_(&dao(), near(0));
    let _ = k.upgrade(Base58CryptoHash::from([7u8; 32]));
}
