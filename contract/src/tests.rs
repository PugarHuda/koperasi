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
    assert_eq!(k.get_member(acc("carol.testnet")).unwrap().points, 15, "points halve each period");
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
    assert_eq!(k.get_pending_savings(acc("alice.testnet")).unwrap().0, U128(7 * 10u128.pow(24)), "counts after 7 days (S12)");
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

// ---------- moving to another USDC contract ----------

#[test]
#[should_panic(expected = "only the DAO")]
fn only_the_dao_moves_the_token() {
    let mut k = setup();
    as_(&steward(), near(0));
    k.set_usdc(acc("circle-usdc.testnet"));
}

#[test]
fn the_dao_moves_the_token_and_only_the_new_one_counts() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_usdc(acc("circle-usdc.testnet"));
    assert_eq!(k.get_info().usdc_id, acc("circle-usdc.testnet"));
    // the old token is now a stranger: its transfers are returned
    as_(&usdc(), near(0));
    let back = k.ft_on_transfer(dao(), U128(5), "share".into());
    assert!(matches!(back, PromiseOrValue::Value(U128(5))));
}

#[test]
#[should_panic(expected = "profit shares are still to be claimed")]
fn the_token_cannot_move_while_shares_are_unclaimed() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&dao(), near(0));
    k.award_points(acc("alice.testnet"), 1, "x".into());
    share(&mut k, 1_000_000);
    as_(&dao(), near(0));
    k.set_usdc(acc("circle-usdc.testnet"));
}

#[test]
#[should_panic(expected = "profit shares are still to be claimed")]
fn a_former_members_unclaimed_share_also_blocks_the_move() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&dao(), near(0));
    k.award_points(acc("alice.testnet"), 1, "x".into());
    share(&mut k, 1_000_000);
    k.apply_membership(acc("alice.testnet"), false); // removed by the DAO, share still unclaimed
    as_(&dao(), near(0));
    k.set_usdc(acc("circle-usdc.testnet"));
}

#[test]
#[should_panic(expected = "a USDC transfer is still in flight")]
fn the_token_cannot_move_while_a_claim_is_in_flight() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&dao(), near(0));
    k.award_points(acc("alice.testnet"), 1, "x".into());
    share(&mut k, 1_000_000);
    as_(&acc("alice.testnet"), near(0));
    let _ = k.claim_share(); // owed is now 0, but the transfer has not come back
    as_(&dao(), near(0));
    k.set_usdc(acc("circle-usdc.testnet"));
}

#[test]
fn the_ledger_follows_shares_claims_and_failed_claims() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&dao(), near(0));
    k.award_points(acc("alice.testnet"), 1, "x".into());
    share(&mut k, 1_000_000);
    // the reserve is on its way to the DAO
    let (owed, reserve) = k.get_ledger().unwrap();
    assert!(owed.0 > 0 && reserve.0 > 0);
    assert_eq!(owed.0 + reserve.0, 1_000_000);
    as_(&acc("koperasi.testnet"), near(0));
    k.on_forwarded(reserve, Ok(()));
    assert_eq!(k.get_ledger().unwrap(), (owed, U128(0)));
    as_(&acc("alice.testnet"), near(0));
    let _ = k.claim_share();
    assert_eq!(k.get_ledger().unwrap(), (U128(0), owed));
    // the transfer fails: the share is owed again and nothing is in flight
    as_(&acc("koperasi.testnet"), near(0));
    k.on_claimed(acc("alice.testnet"), owed, Err(PromiseError::Failed));
    assert_eq!(k.get_ledger().unwrap(), (owed, U128(0)));
}

#[test]
fn an_older_coop_starts_its_ledger_once_by_vote() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&dao(), near(0));
    k.award_points(acc("alice.testnet"), 1, "x".into());
    share(&mut k, 1_000_000);
    let owed = k.get_ledger().unwrap().0;
    // simulate a co-op from before the counters (its reserve transfer long since done)
    env::storage_remove(KEY_OWED_SHARES);
    env::storage_remove(KEY_IN_FLIGHT);
    assert_eq!(k.get_ledger(), None);
    as_(&dao(), near(0));
    k.init_ledger();
    assert_eq!(k.get_ledger().unwrap(), (owed, U128(0)));
}

#[test]
#[should_panic(expected = "ledger already started")]
fn the_ledger_starts_only_once() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.init_ledger();
}

// ---------- tasks with earned trust ----------

const MILLI: u128 = 1_000_000_000_000_000_000_000;
const DAY: u64 = 86_400_000_000_000;

fn me() -> AccountId {
    acc("koperasi.testnet")
}

fn trust(trusted_after: u32) -> TrustRule {
    TrustRule {
        auto_max: U128(100 * MILLI),
        one_vote_max: U128(500 * MILLI),
        trusted_after,
        poster_daily_auto: U128(200 * MILLI),
        points: 5,
    }
}

/// alice and bob are members; the members let the contract pay 1 NEAR from the treasury: no vote ≤ 0.1 NEAR once
/// trusted by 1 source, ≤ 0.2 NEAR a day per poster; one vote ≤ 0.5 NEAR; 5 points per finished task.
fn board() -> Koperasi {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    as_(&dao(), near(0));
    k.set_trust(trust(1));
    k.set_task_budget(U128(1000 * MILLI));
    k
}

/// `poster` posts, `worker` takes and delivers, `poster` accepts. Returns the id and whether it paid with no vote.
fn deliver_by(k: &mut Koperasi, poster: &str, worker: &str, amount: u128) -> (u32, bool) {
    as_(&acc(poster), TASK_FEE);
    let id = k.post_task("translate the by-laws".into(), U128(amount));
    as_(&acc(worker), near(0));
    k.claim_task(id);
    k.submit_task(id, "https://example.org/by-laws-id.md".into());
    as_(&acc(poster), near(0));
    (id, k.accept_task(id))
}

fn deliver(k: &mut Koperasi, amount: u128) -> (u32, bool) {
    deliver_by(k, "alice.testnet", "carol.testnet", amount)
}

/// Sputnik answers: the Transfer proposal got id `100 + id`, and after the contract's vote it reads `status`.
fn dao_says(k: &mut Koperasi, id: u32, status: &str) {
    as_(&me(), near(0));
    let _ = k.on_payout_proposed(id, Ok(100 + id as u64));
    k.on_payout_checked(id, true, Ok(json!({ "status": status })));
}

fn approve(k: &mut Koperasi, id: u32) {
    as_(&me(), near(0));
    k.on_approve_policy(id, acc("bob.testnet"), Ok(policy(&["alice.testnet", "bob.testnet"])));
}

#[test]
fn a_newcomer_needs_one_other_member_then_earns_trust_and_is_paid_from_the_treasury_by_a_dao_proposal() {
    let mut k = board();
    let (id, at_once) = deliver(&mut k, 50 * MILLI);
    assert!(!at_once, "no track record yet");
    assert_eq!(k.get_tasks(None, None)[0].status, TaskStatus::NeedsApproval);
    approve(&mut k, id);
    assert_eq!(k.get_tasks(None, None)[0].status, TaskStatus::Paying);
    assert_eq!(k.get_board().budget.0, 950 * MILLI);
    dao_says(&mut k, id, "Approved");
    let t = &k.get_tasks(None, None)[0];
    assert_eq!((t.status, t.approved_by.clone()), (TaskStatus::Paid, Some(acc("bob.testnet"))));
    assert_eq!(k.get_payout_proposal(id), Some(100));
    let r = k.get_record(acc("carol.testnet")).unwrap();
    assert_eq!((r.done, r.earned.0, r.refs.clone()), (1, 50 * MILLI, vec!["task:0".to_string()]));
    assert_eq!(k.get_trust_sources(acc("carol.testnet")), 1);

    // alice alone cannot vouch for carol and then pay her herself with no vote
    assert!(!deliver(&mut k, 10 * MILLI).1, "carol's only source is alice, the poster");
    // trusted by alice: a small task from bob is paid when bob accepts, with no vote
    let (id, at_once) = deliver_by(&mut k, "bob.testnet", "carol.testnet", 80 * MILLI);
    assert!(at_once);
    assert_eq!(k.get_tasks(None, None)[2].approved_by, None);
    dao_says(&mut k, id, "Approved");
    assert_eq!(k.get_record(acc("carol.testnet")).unwrap().refs, vec!["task:0", "task:2"]);
    assert_eq!(k.get_board().budget.0, 870 * MILLI);
    assert_eq!(k.get_contributors().len(), 1);
}

#[test]
fn two_friends_cannot_make_each_other_trusted_trust_needs_different_posters() {
    let mut k = board();
    as_(&dao(), near(0));
    k.set_trust(trust(2));
    for _ in 0..2 {
        let (id, at_once) = deliver(&mut k, 50 * MILLI);
        assert!(!at_once, "only alice ever posted for carol: one source");
        approve(&mut k, id);
        dao_says(&mut k, id, "Approved");
    }
    assert_eq!((k.get_record(acc("carol.testnet")).unwrap().done, k.get_trust_sources(acc("carol.testnet"))), (2, 1));
    // a task from bob is a second source
    let (id, at_once) = deliver_by(&mut k, "bob.testnet", "carol.testnet", 50 * MILLI);
    assert!(!at_once);
    as_(&me(), near(0));
    k.on_approve_policy(id, acc("alice.testnet"), Ok(policy(&["alice.testnet", "bob.testnet"])));
    dao_says(&mut k, id, "Approved");
    assert_eq!(k.get_trust_sources(acc("carol.testnet")), 2);
    // alice's own payout needs two sources besides alice: bob is one
    assert!(!deliver(&mut k, 50 * MILLI).1, "a poster never vouches for their own no-vote payout");
}

#[test]
fn a_poster_pays_with_no_vote_only_up_to_the_daily_limit() {
    let mut k = board();
    let (id, _) = deliver_by(&mut k, "bob.testnet", "carol.testnet", 50 * MILLI); // bob vouches for carol
    as_(&me(), near(0));
    k.on_approve_policy(id, acc("alice.testnet"), Ok(policy(&["alice.testnet", "bob.testnet"])));
    dao_says(&mut k, id, "Approved");
    assert!(deliver(&mut k, 100 * MILLI).1);
    assert!(deliver(&mut k, 100 * MILLI).1, "200 of 200 today");
    assert!(!deliver(&mut k, 10 * MILLI).1, "over alice's 0.2 NEAR today: one other member must approve");
    // the next day the limit starts again
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(acc("alice.testnet")).attached_deposit(TASK_FEE).block_timestamp(DAY);
    testing_env!(b.build());
    let id = k.post_task("t".into(), U128(MILLI));
    b.predecessor_account_id(acc("carol.testnet")).attached_deposit(near(0));
    testing_env!(b.build());
    k.claim_task(id);
    k.submit_task(id, "w".into());
    b.predecessor_account_id(acc("alice.testnet"));
    testing_env!(b.build());
    assert!(k.accept_task(id));
}

#[test]
fn a_member_who_finishes_a_task_earns_contribution_points_for_the_profit_share() {
    let mut k = board();
    let (id, _) = deliver_by(&mut k, "alice.testnet", "bob.testnet", 50 * MILLI);
    as_(&me(), near(0));
    k.on_approve_policy(id, acc("dave.testnet"), Ok(policy(&["alice.testnet", "bob.testnet", "dave.testnet"])));
    assert_eq!(k.get_member(acc("bob.testnet")).unwrap().points, 0, "nothing before the DAO pays");
    dao_says(&mut k, id, "Approved");
    assert_eq!(k.get_member(acc("bob.testnet")).unwrap().points, 0, "0.05 of 0.5 NEAR earns 5 × 0.1 = 0 points");
    // a task posted before the members lowered one_vote_max still earns at most `points`
    let (big, _) = deliver_by(&mut k, "alice.testnet", "bob.testnet", 500 * MILLI);
    as_(&dao(), near(0));
    k.set_trust(TrustRule { auto_max: U128(MILLI), one_vote_max: U128(MILLI), ..trust(1) });
    as_(&me(), near(0));
    k.on_approve_policy(big, acc("dave.testnet"), Ok(policy(&["alice.testnet", "bob.testnet", "dave.testnet"])));
    dao_says(&mut k, big, "Approved");
    assert_eq!(k.get_member(acc("bob.testnet")).unwrap().points, 5, "clamped to points");
    as_(&dao(), near(0));
    k.set_trust(trust(1));
    k.set_task_budget(U128(1000 * MILLI));
    let base = 5;
    // points follow the pay: a 0.5 NEAR task earns the full 5, a 0.2 NEAR task 2
    for (amount, total) in [(500, base + 5), (200, base + 7)] {
        let (id, _) = deliver_by(&mut k, "alice.testnet", "bob.testnet", amount * MILLI);
        as_(&me(), near(0));
        k.on_approve_policy(id, acc("dave.testnet"), Ok(policy(&["alice.testnet", "bob.testnet", "dave.testnet"])));
        dao_says(&mut k, id, "Approved");
        assert_eq!(k.get_member(acc("bob.testnet")).unwrap().points, total);
    }
    // a non-member contributor gets the record, not points (and nothing panics)
    let (id, _) = deliver(&mut k, 50 * MILLI);
    approve(&mut k, id);
    dao_says(&mut k, id, "Approved");
    assert_eq!(k.get_record(acc("carol.testnet")).unwrap().done, 1);
}

#[test]
fn a_payout_the_dao_did_not_make_goes_back_to_the_budget_earns_nothing_and_is_not_filed_again() {
    let mut k = board();
    for status in ["Rejected", "Removed", "Failed", "Expired"] {
        let (id, _) = deliver(&mut k, 50 * MILLI);
        approve(&mut k, id);
        dao_says(&mut k, id, status);
        assert_eq!(k.get_board().budget.0, 1000 * MILLI, "{status}");
        assert_eq!(k.get_tasks(None, None)[id as usize].status, TaskStatus::Cancelled, "the members said no: no retry");
        assert_eq!(k.get_payout_proposal(id), Some(100 + id as u64), "the proposal stays named");
        assert!(k.get_record(acc("carol.testnet")).is_none());
    }
    // approved, but Sputnik's transfer bounced (it leaves the proposal Approved): not paid
    let (id, _) = deliver(&mut k, 50 * MILLI);
    approve(&mut k, id);
    as_(&me(), near(0));
    let _ = k.on_payout_proposed(id, Ok(100 + id as u64));
    k.on_payout_checked(id, false, Ok(json!({ "status": "Approved" })));
    assert_eq!((k.get_tasks(None, None)[id as usize].status, k.get_board().budget.0), (TaskStatus::Cancelled, 1000 * MILLI));
    assert!(k.get_record(acc("carol.testnet")).is_none());
    // Sputnik refused the proposal itself (e.g. the bond): same
    let (id, _) = deliver(&mut k, 50 * MILLI);
    approve(&mut k, id);
    as_(&me(), near(0));
    let _ = k.on_payout_proposed(id, Err(PromiseError::Failed));
    assert_eq!((k.get_tasks(None, None)[id as usize].status, k.get_board().budget.0), (TaskStatus::Submitted, 1000 * MILLI));
}

#[test]
fn a_payout_still_open_in_the_dao_waits_and_settles_once() {
    let mut k = board();
    let (id, _) = deliver(&mut k, 50 * MILLI);
    approve(&mut k, id);
    // while the contract's own vote and check run, nobody can settle in between
    as_(&me(), near(0));
    let _ = k.on_payout_proposed(id, Ok(100 + id as u64));
    as_(&acc("anyone.testnet"), near(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = k.settle_task(id); })).is_err());
    as_(&me(), near(0));
    k.on_payout_checked(id, true, Ok(json!({ "status": "InProgress" }))); // e.g. the `tasks` role is missing
    assert_eq!(k.get_tasks(None, None)[0].status, TaskStatus::Paying);
    assert_eq!(k.get_board().budget.0, 950 * MILLI);
    as_(&acc("anyone.testnet"), near(0));
    let _ = k.settle_task(id);
    as_(&me(), near(0));
    k.on_payout_checked(id, true, Ok(json!({ "status": "Approved" })));
    assert_eq!(k.get_tasks(None, None)[0].status, TaskStatus::Paid);
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.on_payout_checked(id, true, Ok(json!({ "status": "Approved" })))));
    assert!(again.is_err(), "counted once");
    assert_eq!(k.get_record(acc("carol.testnet")).unwrap().done, 1);
}

#[test]
fn a_payout_whose_callback_failed_is_unstuck_after_an_hour_without_paying_twice_or_counting_a_bounce() {
    let at = |who: &AccountId, ns: u64| {
        let mut b = VMContextBuilder::new();
        b.current_account_id(me()).predecessor_account_id(who.clone()).block_timestamp(ns);
        testing_env!(b.build());
    };
    let anyone = acc("anyone.testnet");
    let settle = |k: &mut Koperasi, id| std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = k.settle_task(id); })).is_ok();
    // the `moved` argument settle_task hands to on_payout_checked
    let moved_arg = || near_sdk::test_utils::get_created_receipts().iter().flat_map(|r| r.actions.clone()).find_map(|a| match a {
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"on_payout_checked" =>
            near_sdk::serde_json::from_slice::<Value>(&args).ok().map(|v| v["moved"].as_bool().unwrap()),
        _ => None,
    });
    let status = |k: &Koperasi, id: u32| k.get_tasks(None, None)[id as usize].status;
    let mut k = board();
    let mut ids = vec![];
    for filed in [false, true, true, true] {
        let (id, _) = deliver(&mut k, 50 * MILLI);
        approve(&mut k, id);
        if filed {
            as_(&me(), near(0));
            let _ = k.on_payout_proposed(id, Ok(100 + id as u64));
        }
        ids.push(id);
    }
    let [a, b, c, d] = ids[..] else { unreachable!() };
    // b's transfer bounced and on_payout_voted wrote that down; then its check ran out of gas
    env::storage_write(format!("moved:{b}").as_bytes(), &[0]);
    assert_eq!(k.get_board().budget.0, 800 * MILLI);
    at(&anyone, 3_600_000_000_000);
    assert!(!settle(&mut k, a), "not before an hour");
    at(&anyone, 3_600_000_000_001);
    // a: nothing on record, though a proposal may have been filed: cancelled, so the contract never files it again
    assert!(settle(&mut k, a));
    assert_eq!((status(&k, a), k.get_board().budget.0), (TaskStatus::Cancelled, 850 * MILLI));
    // b: the bounce on record is what settles it
    assert!(settle(&mut k, b));
    assert_eq!(moved_arg(), Some(false));
    as_(&me(), near(0));
    k.on_payout_checked(b, false, Ok(json!({ "status": "Approved" })));
    assert_eq!(status(&k, b), TaskStatus::Cancelled);
    // c: the result was never read: not anyone, only the members
    at(&anyone, 3_600_000_000_001);
    assert!(!settle(&mut k, c));
    at(&dao(), 3_600_000_000_001);
    assert!(settle(&mut k, c));
    assert_eq!(moved_arg(), Some(true));
    as_(&me(), near(0));
    k.on_payout_checked(c, true, Ok(json!({ "status": "Approved" })));
    assert_eq!(status(&k, c), TaskStatus::Paid);
    // d: the members cancel it instead; the poster cannot
    at(&acc("alice.testnet"), 3_600_000_000_001);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.cancel_task(d))).is_err());
    at(&dao(), 3_600_000_000_001);
    k.cancel_task(d);
    assert_eq!((status(&k, d), k.get_board().budget.0), (TaskStatus::Cancelled, 950 * MILLI));
}

#[test]
fn a_bounce_on_record_still_counts_after_an_unreadable_proposal() {
    let mut k = board();
    let (id, _) = deliver(&mut k, 50 * MILLI);
    approve(&mut k, id);
    as_(&me(), near(0));
    let _ = k.on_payout_proposed(id, Ok(100 + id as u64));
    // on_payout_voted saw the transfer bounce; then get_proposal failed, so the check waits
    env::storage_write(format!("moved:{id}").as_bytes(), &[0]);
    k.on_payout_checked(id, false, Err(PromiseError::Failed));
    assert_eq!(k.get_tasks(None, None)[id as usize].status, TaskStatus::Paying);
    as_(&acc("anyone.testnet"), near(0));
    let _ = k.settle_task(id);
    let moved = near_sdk::test_utils::get_created_receipts().iter().flat_map(|r| r.actions.clone()).find_map(|a| match a {
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"on_payout_checked" =>
            near_sdk::serde_json::from_slice::<Value>(&args).ok().map(|v| v["moved"].as_bool().unwrap()),
        _ => None,
    });
    assert_eq!(moved, Some(false), "the bounce is not forgotten");
}

#[test]
fn a_failed_contract_vote_then_a_vote_by_hand_counts_as_paid() {
    let mut k = board();
    let (id, _) = deliver(&mut k, 50 * MILLI);
    approve(&mut k, id);
    as_(&me(), near(0));
    let _ = k.on_payout_proposed(id, Ok(100 + id as u64));
    // act_proposal failed (e.g. the role is missing): recorded as "failed", the proposal is still InProgress
    env::storage_write(format!("moved:{id}").as_bytes(), &[0]);
    k.on_payout_checked(id, false, Ok(json!({ "status": "InProgress" })));
    // the members approve it by hand; anyone settles
    as_(&acc("anyone.testnet"), near(0));
    let _ = k.settle_task(id);
    let moved = near_sdk::test_utils::get_created_receipts().iter().flat_map(|r| r.actions.clone()).find_map(|a| match a {
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"on_payout_checked" =>
            near_sdk::serde_json::from_slice::<Value>(&args).ok().map(|v| v["moved"].as_bool().unwrap()),
        _ => None,
    });
    assert_eq!(moved, Some(true));
}

#[test]
fn a_trusted_contributor_still_needs_a_vote_above_auto_max() {
    let mut k = board();
    let (id, _) = deliver(&mut k, 50 * MILLI);
    approve(&mut k, id);
    dao_says(&mut k, id, "Approved");
    let (_, at_once) = deliver(&mut k, 150 * MILLI);
    assert!(!at_once);
}

#[test]
#[should_panic(expected = "make it a DAO bounty proposal")]
fn a_large_task_is_a_dao_proposal_not_a_task() {
    let mut k = board();
    deliver(&mut k, 501 * MILLI);
}

#[test]
#[should_panic(expected = "the poster and the contributor cannot approve")]
fn the_poster_cannot_approve_their_own_payout() {
    let mut k = board();
    let (id, _) = deliver(&mut k, 50 * MILLI);
    as_(&acc("alice.testnet"), near(0));
    let _ = k.approve_task(id);
}

#[test]
#[should_panic(expected = "only a member of the DAO approves")]
fn a_non_member_cannot_approve() {
    let mut k = board();
    let (id, _) = deliver(&mut k, 50 * MILLI);
    as_(&me(), near(0));
    k.on_approve_policy(id, acc("dave.testnet"), Ok(policy(&["alice.testnet", "bob.testnet"])));
}

#[test]
#[should_panic(expected = "only members post tasks")]
fn only_members_post() {
    let mut k = board();
    as_(&acc("carol.testnet"), TASK_FEE);
    k.post_task("x".into(), U128(1));
}

#[test]
#[should_panic(expected = "the task budget is too low")]
fn payouts_stop_at_the_budget_the_members_voted() {
    let mut k = board();
    as_(&dao(), near(0));
    k.set_task_budget(U128(10 * MILLI));
    let (id, _) = deliver(&mut k, 50 * MILLI);
    approve(&mut k, id);
}

#[test]
fn the_flow_refuses_out_of_turn_steps() {
    let mut k = board();
    as_(&acc("alice.testnet"), TASK_FEE);
    let id = k.post_task("t".into(), U128(MILLI));
    for (who, step) in [
        ("alice.testnet", "claim own"),
        ("carol.testnet", "submit unclaimed"),
        ("bob.testnet", "accept as non-poster"),
        ("carol.testnet", "set rule"),
        ("carol.testnet", "budget"),
        ("carol.testnet", "settle unpaid"),
    ] {
        as_(&acc(who), near(0));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match step {
            "claim own" => k.claim_task(id),
            "submit unclaimed" => k.submit_task(id, "x".into()),
            "accept as non-poster" => {
                k.accept_task(id);
            }
            "set rule" => k.set_trust(trust(1)),
            "budget" => k.set_task_budget(U128(1)),
            _ => {
                let _ = k.settle_task(id);
            }
        }));
        assert!(r.is_err(), "{step} should fail");
    }
}

#[test]
fn cancelling_is_for_the_poster_before_delivery_and_for_the_dao_until_paid() {
    let mut k = board();
    let (id, _) = deliver(&mut k, 50 * MILLI);
    as_(&acc("alice.testnet"), near(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.cancel_task(id))).is_err());
    as_(&dao(), near(0));
    k.cancel_task(id);
    assert_eq!(k.get_tasks(None, None)[0].status, TaskStatus::Cancelled);
}

#[test]
fn an_approved_dao_bounty_counts_once_on_the_receivers_record() {
    let mut k = board();
    let done = json!({ "status": "Approved", "kind": { "BountyDone": { "bounty_id": 0, "receiver_id": "carol.testnet" } } });
    as_(&me(), near(0));
    k.on_dao_proposal(7, Ok(done.clone()));
    let r = k.get_record(acc("carol.testnet")).unwrap();
    assert_eq!((r.done, r.refs.clone()), (1, vec!["dao-proposal:7".to_string()]));
    for p in [done, json!({ "status": "InProgress", "kind": { "BountyDone": { "bounty_id": 0, "receiver_id": "carol.testnet" } } }),
        json!({ "status": "Approved", "kind": { "Transfer": { "receiver_id": "carol.testnet" } } })] {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.on_dao_proposal(if p["status"] == "Approved" && p["kind"]["BountyDone"].is_object() { 7 } else { 8 }, Ok(p.clone()))));
        assert!(r.is_err());
    }
    // trusted through the DAO bounty (the DAO is a source): a small task is paid on acceptance
    assert!(deliver(&mut k, 50 * MILLI).1);
    // a member paid a DAO bounty earns the voted points too
    as_(&me(), near(0));
    k.on_dao_proposal(9, Ok(json!({ "status": "Approved", "kind": { "BountyDone": { "bounty_id": 1, "receiver_id": "bob.testnet" } } })));
    assert_eq!(k.get_member(acc("bob.testnet")).unwrap().points, 5);
}

#[test]
#[should_panic(expected = "the poster is no longer a member")]
fn a_poster_the_members_removed_cannot_pay_on_trust() {
    let mut k = board();
    as_(&me(), near(0));
    k.on_dao_proposal(7, Ok(json!({ "status": "Approved", "kind": { "BountyDone": { "bounty_id": 0, "receiver_id": "carol.testnet" } } })));
    as_(&acc("alice.testnet"), TASK_FEE);
    let id = k.post_task("t".into(), U128(MILLI));
    as_(&acc("carol.testnet"), near(0));
    k.claim_task(id);
    k.submit_task(id, "w".into());
    k.apply_membership(acc("alice.testnet"), false); // the DAO removed alice, and the contract synced it
    as_(&acc("alice.testnet"), near(0));
    k.accept_task(id);
}

#[test]
#[should_panic(expected = "trust is earned")]
fn trust_needs_at_least_one_finished_task() {
    let mut k = board();
    as_(&dao(), near(0));
    k.set_trust(TrustRule { trusted_after: 0, ..trust(1) });
}

// ---------- events (NEP-297) ----------

fn events() -> Vec<Value> {
    near_sdk::test_utils::get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str(j).unwrap())
        .collect()
}

#[test]
fn state_changes_emit_nep297_events() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(1));
    k.join();
    let e = events();
    assert_eq!(e[0]["standard"], "koperasi");
    assert_eq!(e[0]["version"], "1.0.0");
    assert_eq!(e[0]["event"], "join_requested");
    let data = |e: &Value| if e["data"].is_array() { e["data"][0].clone() } else { e["data"].clone() };
    assert_eq!(data(&e[0])["account_id"], "alice.testnet");
    k.apply_membership(acc("alice.testnet"), true);
    assert_eq!(events().last().unwrap()["event"], "member_added");

    as_(&usdc(), near(0));
    let _ = k.ft_on_transfer(dao(), U128(1_000), "share".into());
    let share = events().into_iter().find(|e| e["event"] == "share_distributed").expect("share event");
    assert_eq!(data(&share)["amount"], "1000");

    let mut k = board();
    let (id, _) = deliver(&mut k, 50 * MILLI);
    approve(&mut k, id);
    assert!(events().iter().any(|e| e["event"] == "task_approved"));
    dao_says(&mut k, id, "Approved"); // a new testing_env: only this step's logs remain
    let names: Vec<String> = events().iter().map(|e| e["event"].as_str().unwrap().to_string()).collect();
    for want in ["payout_filed", "task_paid", "record_credited"] {
        assert!(names.iter().any(|n| n == want), "{want} missing from {names:?}");
    }
}

// ---------- fuzz and invariants (proptest) ----------

mod props {
    use super::*;
    use proptest::prelude::*;

    /// Every case starts from empty storage (the mocked chain keeps it between cases otherwise).
    fn fresh() {
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    }

    fn member(i: usize) -> String {
        format!("m{i}.testnet")
    }

    /// Members with random savings (milli-NEAR) and points.
    fn coop(savings: &[u64], points: &[u64]) -> Koperasi {
        let mut k = setup();
        let names: Vec<String> = (0..savings.len()).map(member).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        with_members(&mut k, &refs);
        as_(&dao(), near(0));
        k.set_savings(names.iter().zip(savings).map(|(n, s)| (acc(n), U128(*s as u128 * SAVINGS_UNIT))).collect());
        for (n, p) in names.iter().zip(points) {
            if *p > 0 {
                k.award_points(acc(n), *p, "fuzz".into());
            }
        }
        k
    }

    fn owed(k: &Koperasi, n: usize) -> u128 {
        (0..n).map(|i| k.get_claimable(acc(&member(i))).0).sum()
    }

    /// (reserve, savings, points) in bps, adding up to 10000.
    fn valid_rule() -> impl Strategy<Value = (u16, u16, u16)> {
        (0u16..=10_000).prop_flat_map(|a| (Just(a), 0u16..=(10_000 - a))).prop_map(|(a, b)| (a, b, 10_000 - a - b))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(96))]

        /// Fuzz: any members, savings, points, rule and amount. Nothing is lost or created: the shares credited plus
        /// the reserve equal the amount, and the reserve is at least the rule's reserve.
        #[test]
        fn a_profit_share_never_loses_or_creates_money(
            data in prop::collection::vec((0u64..1_000_000_000_000, 0u64..1_000_000), 1..8),
            (r, sv, pt) in valid_rule(),
            amount in 0u128..1_000_000_000_000_000,
        ) {
            fresh();
            let rule = rule(r, sv, pt);
            let (savings, points): (Vec<u64>, Vec<u64>) = data.into_iter().unzip();
            let mut k = coop(&savings, &points);
            as_(&dao(), near(0));
            k.set_share_rule(rule.clone());
            as_(&usdc(), near(0));
            let _ = k.ft_on_transfer(dao(), U128(amount), "share".into());
            let reserve = k.get_periods()[0].reserve.0;
            prop_assert_eq!(owed(&k, savings.len()) + reserve, amount);
            prop_assert!(reserve >= amount * rule.reserve_bps as u128 / BPS);
            prop_assert_eq!(k.get_ledger().unwrap().0 .0, owed(&k, savings.len()));
        }

        /// Fuzz: a share rule is accepted exactly when it adds up to 10000 bps.
        #[test]
        fn a_share_rule_is_accepted_iff_it_adds_up(a in 0u16..=u16::MAX, b in 0u16..=u16::MAX, c in 0u16..=u16::MAX) {
            fresh();
            let mut k = setup();
            as_(&dao(), near(0));
            let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.set_share_rule(rule(a, b, c)))).is_ok();
            prop_assert_eq!(ok, a as u32 + b as u32 + c as u32 == 10_000);
        }

        /// Fuzz addresses: any valid account can join, be admitted by the DAO, and leave with its deposit.
        #[test]
        fn any_account_can_join_and_leave(name in "[a-z0-9]{2,20}([_-][a-z0-9]{1,8})?(\\.[a-z0-9]{1,12}([_-][a-z0-9]{1,6})?)?\\.testnet") {
            fresh();
            let mut k = setup();
            let who = acc(&name);
            as_(&who, near(3));
            k.join();
            prop_assert!(k.is_pending(who.clone()));
            k.apply_membership(who.clone(), true);
            prop_assert!(k.get_member(who.clone()).is_some());
            k.apply_membership(who.clone(), false);
            prop_assert!(k.get_member(who).is_none());
            prop_assert_eq!(k.get_info().members, 0);
        }

        /// Fuzz: the by-laws hash must be 64 lowercase hex characters, nothing else.
        #[test]
        fn only_a_sha256_hex_is_a_valid_hash(h in "[0-9a-fA-Fg-z]{0,70}") {
            let want = h.len() == 64 && h.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
            prop_assert_eq!(valid_hash(&h), want);
        }

        /// Fuzz: whatever the task's pay and the rule, a member never earns more than the rule's points for a task.
        #[test]
        fn task_points_never_exceed_the_rule(amount in 1u128..=500, one_vote in 1u128..=500, points in 0u64..10_000) {
            fresh();
            let mut k = board();
            with_members(&mut k, &["carol.testnet"]);
            let (id, paid) = deliver(&mut k, amount * MILLI); // alice posts, carol (a member) works, bob approves
            if !paid {
                approve(&mut k, id);
            }
            as_(&dao(), near(0));
            k.set_trust(TrustRule { one_vote_max: U128(one_vote * MILLI), auto_max: U128(0), points, ..trust(1) });
            let before = k.get_member(acc("carol.testnet")).unwrap().points;
            dao_says(&mut k, id, "Approved");
            let earned = k.get_member(acc("carol.testnet")).unwrap().points - before;
            prop_assert!(earned <= points);
            prop_assert_eq!(earned as u128, (points as u128 * amount / one_vote).min(points as u128));
            prop_assert_eq!(k.get_tasks(None, None)[id as usize].status, TaskStatus::Paid);
        }

        /// Invariant over random sequences of shares, claims (succeeding or failing), points and savings:
        /// the ledger's owed counter always equals the shares waiting, nothing stays in flight once callbacks ran,
        /// and every unit shared is either claimed, waiting, or back in the DAO as reserve.
        #[test]
        fn the_share_ledger_always_balances(ops in prop::collection::vec((0u8..4, 0usize..4, 0u128..10_000_000, any::<bool>()), 1..40)) {
            fresh();
            let n = 4;
            let mut k = coop(&[1, 2, 3, 4], &[0, 0, 0, 0]);
            let (mut shared, mut claimed, mut reserves) = (0u128, 0u128, 0u128);
            for (op, i, x, ok) in ops {
                let who = acc(&member(i));
                match op {
                    0 => {
                        as_(&usdc(), near(0));
                        let _ = k.ft_on_transfer(dao(), U128(x), "share".into());
                        shared += x;
                        let reserve = k.get_periods().last().unwrap().reserve;
                        reserves += reserve.0;
                        if reserve.0 > 0 {
                            // the reserve's transfer to the DAO comes back
                            as_(&me(), near(0));
                            k.on_forwarded(reserve, Ok(()));
                        }
                    }
                    1 if k.get_claimable(who.clone()).0 > 0 => {
                        let amount = k.get_claimable(who.clone());
                        as_(&who, near(0));
                        let _ = k.claim_share();
                        as_(&me(), near(0));
                        k.on_claimed(who, amount, if ok { Ok(()) } else { Err(PromiseError::Failed) });
                        if ok {
                            claimed += amount.0;
                        }
                    }
                    2 => {
                        as_(&dao(), near(0));
                        k.award_points(who, (x % 100) as u64, "fuzz".into());
                    }
                    3 => {
                        as_(&dao(), near(0));
                        k.set_savings(vec![(who, U128((x % 1000) * SAVINGS_UNIT))]);
                    }
                    _ => {}
                }
                let (owed_counter, in_flight) = k.get_ledger().unwrap();
                prop_assert_eq!(owed_counter.0, owed(&k, n));
                prop_assert_eq!(in_flight.0, 0);
                prop_assert_eq!(claimed + owed(&k, n) + reserves, shared);
            }
        }

        /// Invariant over random task payouts and DAO outcomes: the budget left plus everything paying or paid is
        /// always the budget the members voted, and nothing is paid twice.
        #[test]
        fn the_task_budget_always_balances(ops in prop::collection::vec((1u128..=300, 0u8..4), 1..12)) {
            fresh();
            let mut k = board();
            let voted = k.get_board().budget.0;
            for (amount, outcome) in ops {
                if amount * MILLI > k.get_board().budget.0 {
                    continue;
                }
                let (id, paid) = deliver(&mut k, amount * MILLI);
                if !paid {
                    approve(&mut k, id);
                }
                as_(&me(), near(0));
                match outcome {
                    0 => dao_says(&mut k, id, "Approved"),
                    1 => dao_says(&mut k, id, "Rejected"),
                    2 => dao_says(&mut k, id, "InProgress"),
                    _ => { let _ = k.on_payout_proposed(id, Err(PromiseError::Failed)); }
                }
                let out: u128 = k.get_tasks(None, None).iter()
                    .filter(|t| matches!(t.status, TaskStatus::Paying | TaskStatus::Paid))
                    .map(|t| t.amount.0).sum();
                prop_assert_eq!(k.get_board().budget.0 + out, voted);
                let paid_refs = k.get_record(acc("carol.testnet")).map_or(0, |r| r.refs.len());
                let paid_tasks = k.get_tasks(None, None).iter().filter(|t| t.status == TaskStatus::Paid).count();
                prop_assert_eq!(paid_refs, paid_tasks);
            }
        }
    }
}

// ---------- coverage of the remaining entry points ----------

#[test]
fn a_contributor_can_hand_a_task_back_and_only_they_can() {
    let mut k = board();
    as_(&acc("alice.testnet"), TASK_FEE);
    let id = k.post_task("t".into(), U128(MILLI));
    as_(&acc("carol.testnet"), near(0));
    k.claim_task(id);
    as_(&acc("bob.testnet"), near(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.give_up_task(id))).is_err(), "not bob's task");
    as_(&acc("carol.testnet"), near(0));
    k.give_up_task(id);
    let t = &k.get_tasks(None, None)[id as usize];
    assert_eq!((t.status, t.contributor.clone()), (TaskStatus::Open, None));
}

#[test]
fn entry_points_that_read_the_dao_start_a_cross_contract_call() {
    let mut k = board();
    let (id, _) = deliver(&mut k, 50 * MILLI);
    as_(&acc("bob.testnet"), near(0));
    let _ = k.approve_task(id);
    let _ = k.sync_member(acc("alice.testnet"));
    let _ = k.credit_dao_bounty(7);
    let calls: Vec<String> = near_sdk::test_utils::get_created_receipts().iter().flat_map(|r| r.actions.clone()).filter_map(|a| match a {
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } => Some(String::from_utf8(method_name).unwrap()),
        _ => None,
    }).collect();
    for m in ["get_policy", "on_approve_policy", "on_policy", "get_proposal", "on_dao_proposal"] {
        assert!(calls.iter().any(|c| c == m), "{m} missing from {calls:?}");
    }
}

#[test]
fn the_transfers_result_is_recorded_before_the_proposal_is_read() {
    use near_sdk::PromiseResult;
    for (result, want) in [(PromiseResult::Successful(vec![]), 1u8), (PromiseResult::Failed, 0u8)] {
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
        let mut k = board();
        let (id, _) = deliver(&mut k, 50 * MILLI);
        approve(&mut k, id);
        as_(&me(), near(0));
        let _ = k.on_payout_proposed(id, Ok(100 + id as u64));
        let mut b = VMContextBuilder::new();
        b.current_account_id(me()).predecessor_account_id(me());
        testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![result]);
        let _ = k.on_payout_voted(id, 100 + id as u64);
        assert_eq!(env::storage_read(format!("moved:{id}").as_bytes()), Some(vec![want]));
    }
}

#[test]
fn the_dao_sets_the_agent_and_a_new_steward_gets_the_old_bond_back() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_agent(acc("agent2.testnet"));
    assert_eq!(k.get_info().agent_id, acc("agent2.testnet"));
    k.set_steward(Some(steward()));
    as_(&steward(), near(2));
    k.bond_steward();
    assert_eq!(k.get_info().steward_bond, near(2));
    as_(&dao(), near(0));
    k.set_steward(Some(acc("steward2.testnet")));
    assert_eq!(k.get_info().steward_bond, near(0));
    let refund = near_sdk::test_utils::get_created_receipts().into_iter().find(|r| r.receiver_id == steward());
    assert!(refund.is_some(), "the old steward's 2 NEAR bond goes back");
}

#[test]
fn members_are_read_a_page_at_a_time() {
    let mut k = setup();
    with_members(&mut k, &["a1.testnet", "a2.testnet", "a3.testnet"]);
    assert_eq!(k.get_members(None, None).len(), 3);
    assert_eq!(k.get_members(Some(1), Some(1)).len(), 1);
    assert_eq!(k.get_members(Some(3), None).len(), 0);
}

/// Security PoC S12 (known issue, docs/reports/05-security.md): savings are the stake read at the last sync, so a member
/// who stakes a large amount just before a profit share, syncs, and unstakes after takes most of the savings pool.
/// The cost is only the stake's lock-up (unstaking takes about 4 epochs). Fixing it (count a raise only after a delay)
/// needs an upgrade by vote; this test shows the current behaviour and flips when the fix lands.
fn at(who: &AccountId, ns: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(who.clone()).account_balance(near(100)).block_timestamp(ns);
    testing_env!(b.build());
}

/// S12 (was a PoC that paid mallory 99% of the savings pool): a stake increase counts only after 7 days.
#[test]
fn s12_a_stake_just_before_a_share_does_not_count_yet() {
    let mut k = setup(); // 20% reserve, 40% savings, 40% points
    with_members(&mut k, &["alice.testnet", "mallory.testnet"]);
    as_(&dao(), near(0));
    k.set_staking_pool(Some(acc("pool.testnet")));
    let staked = |k: &mut Koperasi, who: &str, n: u128, ns: u64| {
        at(&me(), ns);
        k.on_staked(acc(who), Ok(U128(n * 10u128.pow(24))));
    };
    staked(&mut k, "alice.testnet", 100, 0); // alice saves 100 NEAR
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().savings.0, 0, "an increase waits");
    assert_eq!(k.get_pending_savings(acc("alice.testnet")), Some((U128(100 * 10u128.pow(24)), U64(7 * DAY), U64(0))));
    for d in 1..=7 {
        staked(&mut k, "alice.testnet", 100, d * DAY); // read every day (the keeper), still there a week later: it counts
    }
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().savings.0, 100 * 10u128.pow(24));
    // mallory stakes 9 900 NEAR and syncs, unstakes, and comes back the day before the share without syncing again
    staked(&mut k, "mallory.testnet", 9_900, DAY);
    at(&usdc(), 30 * DAY);
    let _ = k.ft_on_transfer(dao(), U128(100_000_000), "share".into()); // 100 USDC: 40 USDC savings pool
    assert_eq!(k.get_claimable(acc("alice.testnet")).0, 40_000_000, "alice's 100 NEAR, read twice a week apart: all the pool");
    assert_eq!(k.get_claimable(acc("mallory.testnet")).0, 0, "mallory's 9 900 counts only if a fresh reading shows it");
    assert_eq!(k.get_pending_savings(acc("alice.testnet")), None);
    // a decrease counts at once and drops the wait
    staked(&mut k, "mallory.testnet", 0, 30 * DAY + 1);
    assert_eq!(k.get_pending_savings(acc("mallory.testnet")), None);
    staked(&mut k, "alice.testnet", 40, 30 * DAY + 2);
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().savings.0, 40 * 10u128.pow(24));
}

/// S12's ceiling (was: only two readings, so a stake that left and came back between them counted): a gap of more
/// than a day between readings restarts the wait.
#[test]
fn a_stake_that_was_not_read_for_more_than_a_day_waits_again() {
    let mut k = setup();
    with_members(&mut k, &["mallory.testnet"]);
    let staked = |k: &mut Koperasi, ns: u64| {
        at(&me(), ns);
        k.on_staked(acc("mallory.testnet"), Ok(U128(9_900 * 10u128.pow(24))));
    };
    // mallory stakes and syncs on day 0, unstakes on day 1 (nobody reads), restakes and syncs on day 7
    staked(&mut k, 0);
    staked(&mut k, 7 * DAY);
    assert_eq!(k.get_member(acc("mallory.testnet")).unwrap().savings.0, 0, "a week between two readings is not a week staked");
    assert_eq!(k.get_pending_savings(acc("mallory.testnet")), Some((U128(9_900 * 10u128.pow(24)), U64(14 * DAY), U64(7 * DAY))));
    // read at most a day apart, the wait runs (24 h + 1 ns: below, it restarts)
    for d in 8..=13 {
        staked(&mut k, d * DAY);
    }
    staked(&mut k, 14 * DAY); // exactly a day after the last reading: still unbroken
    assert_eq!(k.get_member(acc("mallory.testnet")).unwrap().savings.0, 9_900 * 10u128.pow(24));
    let mut k = setup();
    with_members(&mut k, &["mallory.testnet"]);
    staked(&mut k, 0);
    staked(&mut k, DAY + 1);
    assert_eq!(k.get_pending_savings(acc("mallory.testnet")).unwrap().1, U64(DAY + 1 + 7 * DAY), "restarted");
}

#[test]
fn what_counts_is_the_least_stake_every_reading_of_the_wait_showed() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    let staked = |k: &mut Koperasi, n: u128, ns: u64| {
        at(&me(), ns);
        k.on_staked(acc("alice.testnet"), Ok(U128(n * 10u128.pow(24))));
    };
    for d in 0..6 {
        staked(&mut k, 1, d * DAY);
    }
    staked(&mut k, 500, 6 * DAY); // a top-up a day before the first counts does not ride along with it
    staked(&mut k, 500, 7 * DAY);
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().savings.0, 10u128.pow(24), "only the 1 NEAR every reading showed");
    for d in 8..=14 {
        staked(&mut k, 300, d * DAY); // the top-up waits its own 7 days; 300 is what stayed of it
    }
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().savings.0, 10u128.pow(24));
    staked(&mut k, 300, 15 * DAY);
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().savings.0, 300 * 10u128.pow(24));
    // a members' vote counts at once
    staked(&mut k, 900, 14 * DAY);
    as_(&dao(), near(0));
    k.set_savings(vec![(acc("alice.testnet"), U128(5))]);
    assert_eq!(k.get_pending_savings(acc("alice.testnet")), None);
}

// ---------- points decay, reserve floor, overdue steward ----------

#[test]
fn points_halve_at_each_share_so_the_next_share_still_pays_contribution() {
    let mut k = setup(); // 20% reserve, 40% savings, 40% points
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    as_(&dao(), near(0));
    k.award_points(acc("alice.testnet"), 9, "x".into());
    share(&mut k, 100);
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().points, 4, "9 → 4 (floored)");
    share(&mut k, 100); // no new work since: the points pool still pays alice, it does not fall to the reserve
    assert_eq!(k.get_claimable(acc("alice.testnet")).0, 40 + 40);
    assert_eq!(k.get_periods()[1].reserve.0, 20 + 40, "nobody saved: only the reserve and the savings pool stay");
    for _ in 0..3 {
        share(&mut k, 100);
    }
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().points, 0, "old work fades out");
}

fn me_(ns: u64) {
    at(&me(), ns);
}

#[test]
fn a_share_under_the_reserve_floor_goes_back_whole() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    as_(&dao(), near(0));
    k.award_points(acc("alice.testnet"), 1, "x".into());
    k.set_reserve_floor(U128(50_000_000));
    assert_eq!(k.get_reserve_floor().0, 50_000_000);
    as_(&usdc(), near(0));
    assert!(matches!(k.ft_on_transfer(dao(), U128(10_000_000), "share".into()), PromiseOrValue::Promise(_)), "reads the DAO first");
    me_(0);
    assert_eq!(k.on_dao_balance(U128(10_000_000), Ok(U128(49_999_999))).0, 10_000_000, "below the floor: all of it back");
    assert_eq!(k.on_dao_balance(U128(10_000_000), Err(PromiseError::Failed)).0, 10_000_000, "unreadable: back, not split");
    assert!(k.get_periods().is_empty() && k.get_claimable(acc("alice.testnet")).0 == 0);
    assert_eq!(k.on_dao_balance(U128(10_000_000), Ok(U128(50_000_000))).0, 0, "at the floor: split");
    assert_eq!(k.get_periods().len(), 1);
    as_(&dao(), near(0));
    k.set_reserve_floor(U128(0));
    as_(&usdc(), near(0));
    assert!(matches!(k.ft_on_transfer(dao(), U128(10), "share".into()), PromiseOrValue::Value(U128(0))), "no floor: split at once");
}

#[test]
#[should_panic(expected = "only the DAO")]
fn only_the_dao_sets_the_reserve_floor() {
    let mut k = setup();
    as_(&acc("alice.testnet"), near(0));
    k.set_reserve_floor(U128(1));
}

/// A steward with a 5 NEAR bond and one paid 10 USDC job on day 1.
fn owing_steward() -> Koperasi {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_steward(Some(steward()));
    as_(&steward(), near(5));
    k.bond_steward();
    receipt(&mut k, "job-1", 10_000_000, H1);
    at(&agent(), DAY);
    k.update_receipt("job-1".into(), ReceiptStatus::Paid);
    k
}

#[test]
fn anyone_slashes_a_steward_who_kept_a_paid_job_past_the_grace_period() {
    let mut k = owing_steward();
    at(&acc("anyone.testnet"), 8 * DAY);
    assert_eq!(k.get_overdue().0, 0, "exactly 7 days: still within the grace period");
    at(&acc("anyone.testnet"), 8 * DAY + 1);
    assert_eq!(k.get_overdue().0, 9_500_000, "10 USDC net of the 5% fee");
    assert_eq!(k.slash_overdue(), near(5));
    assert!(k.get_info().steward_bond.is_zero());
}

#[test]
#[should_panic(expected = "nothing is overdue")]
fn no_slash_inside_the_grace_period() {
    let mut k = owing_steward();
    at(&acc("anyone.testnet"), 8 * DAY);
    k.slash_overdue();
}

#[test]
#[should_panic(expected = "nothing is overdue")]
fn a_deposit_that_covers_the_job_prevents_the_slash() {
    let mut k = owing_steward();
    at(&usdc(), 2 * DAY);
    let _ = k.ft_on_transfer(steward(), U128(9_500_000), "earnings".into());
    at(&acc("anyone.testnet"), 30 * DAY);
    k.slash_overdue();
}

#[test]
fn a_steward_who_passes_each_job_on_in_time_is_not_slashed_while_newer_jobs_keep_the_audit_red() {
    let mut k = owing_steward(); // job-1 paid on day 1
    at(&usdc(), 6 * DAY);
    let _ = k.ft_on_transfer(steward(), U128(9_500_000), "earnings".into()); // job-1 passed on within its 7 days
    receipt(&mut k, "job-2", 10_000_000, H1);
    at(&agent(), 7 * DAY);
    k.update_receipt("job-2".into(), ReceiptStatus::Paid);
    at(&acc("anyone.testnet"), 8 * DAY + 1);
    assert!(k.get_audit().owed.0 > 0, "the audit is red (job-2)");
    assert_eq!(k.get_overdue().0, 0, "but job-2 is still within its grace period");
    at(&acc("anyone.testnet"), 14 * DAY + 1);
    assert_eq!(k.get_overdue().0, 9_500_000);
}

#[test]
fn replacing_a_steward_who_still_owes_sends_their_bond_to_the_dao_and_the_new_one_starts_clean() {
    let mut k = owing_steward();
    at(&dao(), 2 * DAY);
    k.set_steward(Some(acc("new-steward.testnet")));
    assert!(near_sdk::test_utils::get_logs().iter().any(|l| l.contains("\"steward_slashed\"")), "not refunded to a defaulter");
    at(&acc("anyone.testnet"), 30 * DAY);
    assert_eq!(k.get_overdue().0, 0, "the new steward does not answer for the old one's job");
}

#[test]
fn a_steward_who_owes_nothing_gets_the_bond_back_when_replaced() {
    let mut k = owing_steward();
    at(&usdc(), 2 * DAY);
    let _ = k.ft_on_transfer(steward(), U128(9_500_000), "earnings".into());
    at(&dao(), 3 * DAY);
    k.set_steward(Some(acc("new-steward.testnet")));
    assert!(near_sdk::test_utils::get_logs().iter().any(|l| l.contains("\"bond_returned\":\"5000000000000000000000000\"")));
}

#[test]
#[should_panic(expected = "nothing is overdue")]
fn no_slash_for_a_steward_appointed_before_this_code() {
    let mut k = owing_steward();
    env::storage_remove(b"steward_from"); // as on a co-op upgraded to this code: the old debt had no 7-day rule
    at(&acc("anyone.testnet"), 30 * DAY);
    k.slash_overdue();
}

#[test]
fn a_steward_appointed_before_this_code_gets_the_bond_back_as_before() {
    let mut k = owing_steward();
    env::storage_remove(b"steward_paid");
    at(&dao(), 2 * DAY);
    k.set_steward(Some(acc("new-steward.testnet")));
    assert!(near_sdk::test_utils::get_logs().iter().any(|l| l.contains("\"bond_returned\":\"5000000000000000000000000\"")));
}

#[test]
fn staking_rewards_do_not_restart_the_wait() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    for d in 0..=7u64 {
        at(&me(), d * DAY);
        k.on_staked(acc("alice.testnet"), Ok(U128(10u128.pow(24) + d as u128 * 1_000))); // a little more each epoch
    }
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().savings.0, 10u128.pow(24), "the first reading's stake counts");
}

// ---------- commons: pledges, the court, standing, the steward's term ----------

fn at_paying(who: &AccountId, ns: u64, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(who.clone()).attached_deposit(deposit)
        .account_balance(near(100)).block_timestamp(ns).random_seed([7; 32]);
    testing_env!(b.build());
}

fn logs_have(s: &str) -> bool {
    near_sdk::test_utils::get_logs().iter().any(|l| l.contains(s))
}

fn fails(f: impl FnOnce()) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

#[test]
fn a_kept_pledge_earns_the_issuer_points_and_standing() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    at(&acc("alice.testnet"), DAY);
    let id = k.pledge("review one pull request".into(), 2);
    at(&acc("bob.testnet"), DAY);
    let c = k.redeem_pledge(id);
    k.settle_pledge(c, true);
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().points, 0, "reputation only, never profit-share points");
    let (s, good) = k.get_standing(acc("alice.testnet"));
    assert_eq!((s.pledges_honored, good), (1, true));
    assert_eq!(k.get_pledges(None, None)[0].called, 1);
}

#[test]
#[should_panic(expected = "your own pledge")]
fn nobody_calls_in_their_own_pledge() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    at(&acc("alice.testnet"), DAY);
    let id = k.pledge("one design review".into(), 1);
    k.redeem_pledge(id);
}

#[test]
#[should_panic(expected = "only a member")]
fn only_members_pledge() {
    let mut k = setup();
    at(&acc("outsider.testnet"), DAY);
    k.pledge("anything".into(), 1);
}

#[test]
#[should_panic(expected = "every unit")]
fn a_pledge_is_called_in_at_most_units_times() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    at(&acc("alice.testnet"), DAY);
    let id = k.pledge("one translation".into(), 1);
    at(&acc("bob.testnet"), DAY);
    k.redeem_pledge(id);
    k.redeem_pledge(id);
}

#[test]
fn a_pledge_is_broken_only_after_14_days_and_only_by_its_holder() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet", "carol.testnet"]);
    at(&acc("alice.testnet"), DAY);
    let id = k.pledge("one review".into(), 1);
    at(&acc("bob.testnet"), DAY);
    let c = k.redeem_pledge(id);
    at(&acc("bob.testnet"), 14 * DAY);
    assert!(fails(|| k.settle_pledge(c, false)), "too early");
    at(&acc("carol.testnet"), 16 * DAY);
    assert!(fails(|| k.settle_pledge(c, true)), "not the holder");
    at(&acc("bob.testnet"), 15 * DAY);
    k.settle_pledge(c, false);
    let (s, good) = k.get_standing(acc("alice.testnet"));
    assert_eq!((s.pledges_broken, good), (1, false));
    assert_eq!(k.get_member(acc("alice.testnet")).unwrap().points, 0);
}

const JURY: [&str; 5] = ["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet", "erin.testnet"];

/// Six members (frank takes buyers' cases), a steward, and one 10 USDC job the buyer disputed and the market paid.
fn court() -> Koperasi {
    let mut k = setup();
    with_members(&mut k, &JURY);
    with_members(&mut k, &["frank.testnet"]);
    as_(&dao(), near(0));
    k.set_steward(Some(steward()));
    receipt(&mut k, "job-1", 10_000_000, H1);
    at(&agent(), DAY);
    k.update_receipt("job-1".into(), ReceiptStatus::Disputed);
    k.update_receipt("job-1".into(), ReceiptStatus::Paid);
    k
}

fn open(k: &mut Koperasi, claimant: &str, ns: u64) -> u32 {
    at_paying(&acc(claimant), ns, COURT_BOND);
    k.open_case("job-1".into(), acc("buyer.testnet"), U128(4_000_000), "the report missed half the brief".into())
}

#[test]
fn the_jury_upholds_a_dispute_and_the_contract_files_the_refund() {
    let mut k = court();
    let id = open(&mut k, "frank.testnet", 2 * DAY);
    let c = k.get_cases(None, None)[0].clone();
    let mut j = c.jurors.clone();
    j.sort();
    j.dedup();
    assert_eq!(j.len(), JURORS, "three different jurors");
    assert!(c.jurors.iter().all(|x| JURY.contains(&x.as_str())), "only members, never the steward or the claimant");
    for juror in c.jurors.iter().take(2) {
        at(juror, 2 * DAY + 1);
        k.rule_case(id, true);
    }
    assert!(logs_have("\"case_closed\"") && logs_have("\"upheld\":true"));
    assert_eq!(k.get_cases(None, None)[0].status, CaseStatus::Upheld);
    for juror in c.jurors.iter().take(2) {
        assert_eq!(k.get_member(juror.clone()).unwrap().points, JUROR_POINTS);
        assert_eq!(k.get_standing(juror.clone()).0.juries_served, 1);
    }
    assert_eq!(k.get_standing(c.jurors[2].clone()).0.juries_missed, 0, "closed early: the third juror missed nothing");
    at(&me(), 2 * DAY + 2);
    let _ = k.on_refund_filed(id, Ok(70));
    assert_eq!(k.get_cases(None, None)[0].refund_proposal, Some(70));
}

#[test]
fn a_dispute_nobody_upholds_is_dismissed_after_3_days_and_silent_jurors_lose_standing() {
    let mut k = court();
    let id = open(&mut k, "frank.testnet", 2 * DAY);
    let jurors = k.get_cases(None, None)[0].jurors.clone();
    at(&jurors[0], 3 * DAY);
    k.rule_case(id, false);
    assert_eq!(k.get_member(jurors[0].clone()).unwrap().points, 0);
    at(&acc("anyone.testnet"), 4 * DAY);
    assert!(fails(|| k.close_case(id)), "jurors have 3 days");
    at(&acc("anyone.testnet"), 5 * DAY);
    k.close_case(id);
    assert_eq!(k.get_cases(None, None)[0].status, CaseStatus::Dismissed);
    for j in &jurors[1..] {
        let (s, good) = k.get_standing(j.clone());
        assert_eq!((s.juries_missed, good), (1, false));
    }
    assert!(k.get_standing(jurors[0].clone()).1);
}

#[test]
fn a_juror_out_of_good_standing_is_not_drawn() {
    let mut k = court();
    commons::mark(&acc("alice.testnet"), |s| s.pledges_broken += 1);
    commons::mark(&acc("bob.testnet"), |s| s.slashed += 1);
    open(&mut k, "frank.testnet", 2 * DAY);
    let mut j: Vec<String> = k.get_cases(None, None)[0].jurors.iter().map(|a| a.to_string()).collect();
    j.sort();
    assert_eq!(j, ["carol.testnet", "dave.testnet", "erin.testnet"]);
}

#[test]
#[should_panic(expected = "fewer than 3 members")]
fn no_court_without_three_eligible_jurors() {
    let mut k = court();
    for m in ["alice.testnet", "bob.testnet", "carol.testnet"] {
        commons::mark(&acc(m), |s| s.juries_missed += 1);
    }
    commons::mark(&acc("dave.testnet"), |s| s.juries_missed += 1);
    open(&mut k, "frank.testnet", 2 * DAY); // only erin is left
}

#[test]
#[should_panic(expected = "a case for this job is open")]
fn one_open_case_per_job() {
    let mut k = court();
    open(&mut k, "frank.testnet", 2 * DAY);
    open(&mut k, "frank.testnet", 2 * DAY);
}

#[test]
fn a_rejected_case_closes_the_job_and_a_lone_ruling_earns_no_points() {
    let mut k = court();
    let id = open(&mut k, "frank.testnet", 2 * DAY);
    let jurors = k.get_cases(None, None)[0].jurors.clone();
    for j in jurors.iter().take(2) {
        at(j, 2 * DAY + 1);
        k.rule_case(id, false);
    }
    assert!(logs_have("\"upheld\":false"));
    assert_eq!(k.get_member(jurors[0].clone()).unwrap().points, JUROR_POINTS, "a verdict earns points");
    assert!(fails(|| { open(&mut k, "frank.testnet", 6 * DAY); }), "frank does not get a second jury");
    // a bogus case does not block the real one: another member can still bring it, once
    let id = open(&mut k, "erin.testnet", 6 * DAY);
    for j in k.get_cases(None, None)[1].jurors.clone().iter().take(2) {
        at(j, 6 * DAY + 1);
        k.rule_case(id, true);
    }
    assert_eq!(k.get_cases(None, None)[1].status, CaseStatus::Upheld);
    assert!(fails(|| { open(&mut k, "dave.testnet", 9 * DAY); }), "refunded once");
}

#[test]
#[should_panic(expected = "two cases")]
fn a_job_has_at_most_two_cases() {
    let mut k = court();
    for (n, who) in ["frank.testnet", "erin.testnet"].iter().enumerate() {
        let id = open(&mut k, who, (2 + n as u64) * DAY);
        for j in k.get_cases(None, None)[n].jurors.clone().iter().take(2) {
            at(j, (2 + n as u64) * DAY + 1);
            k.rule_case(id, false);
        }
    }
    open(&mut k, "dave.testnet", 20 * DAY);
}

#[test]
#[should_panic(expected = "ruled for the agent")]
fn a_job_still_disputed_on_the_market_is_not_taken_to_court() {
    let mut k = setup();
    with_members(&mut k, &JURY);
    with_members(&mut k, &["frank.testnet"]);
    receipt(&mut k, "job-1", 10_000_000, H1);
    at(&agent(), DAY);
    k.update_receipt("job-1".into(), ReceiptStatus::Disputed);
    open(&mut k, "frank.testnet", 2 * DAY);
}

#[test]
#[should_panic(expected = "only a member")]
fn an_outsider_cannot_open_a_case() {
    let mut k = court();
    open(&mut k, "buyer.testnet", 2 * DAY);
}

#[test]
#[should_panic(expected = "disputed on the market")]
fn only_a_job_the_buyer_disputed_goes_to_court() {
    let mut k = court();
    receipt(&mut k, "job-2", 10_000_000, H1);
    at(&agent(), DAY);
    k.update_receipt("job-2".into(), ReceiptStatus::Paid);
    at_paying(&acc("frank.testnet"), 2 * DAY, COURT_BOND);
    k.open_case("job-2".into(), acc("buyer.testnet"), U128(1), "x".into());
}

#[test]
fn a_case_nobody_ruled_on_is_dismissed_after_3_days() {
    let mut k = court();
    let id = open(&mut k, "frank.testnet", 2 * DAY);
    at(&acc("anyone.testnet"), 5 * DAY);
    k.close_case(id);
    assert_eq!(k.get_cases(None, None)[0].status, CaseStatus::Dismissed, "one uphold, or none, never refunds");
}

#[test]
#[should_panic(expected = "at most the job")]
fn a_refund_is_at_most_the_price() {
    let mut k = court();
    at_paying(&acc("frank.testnet"), 2 * DAY, COURT_BOND);
    k.open_case("job-1".into(), acc("buyer.testnet"), U128(10_000_001), "x".into());
}

#[test]
#[should_panic(expected = "court bond")]
fn a_dispute_needs_the_bond() {
    let mut k = court();
    at_paying(&acc("frank.testnet"), 2 * DAY, NearToken::from_millinear(499));
    k.open_case("job-1".into(), acc("buyer.testnet"), U128(1), "x".into());
}

#[test]
#[should_panic(expected = "only a juror")]
fn only_jurors_rule() {
    let mut k = court();
    let id = open(&mut k, "frank.testnet", 2 * DAY);
    at(&acc("frank.testnet"), 2 * DAY);
    k.rule_case(id, true);
}

#[test]
fn a_steward_term_runs_out_and_anyone_ends_it_with_the_bond_returned() {
    let mut k = setup();
    as_(&dao(), near(0));
    k.set_steward(Some(steward()));
    k.set_steward_term(30);
    as_(&steward(), near(2));
    k.bond_steward();
    let (days, ends) = k.get_steward_term();
    assert_eq!((days, ends.unwrap().0), (30, 30 * DAY));
    at(&acc("anyone.testnet"), 30 * DAY - 1);
    assert!(fails(|| k.end_steward_term()), "not yet");
    at(&acc("anyone.testnet"), 30 * DAY);
    k.end_steward_term();
    assert!(k.get_info().steward.is_none());
    assert!(logs_have("\"steward_term_ended\"") && logs_have("\"bond_returned\":\"2000000000000000000000000\""));
    assert_eq!(k.get_steward_term().1, None);
}

#[test]
fn a_slashed_steward_is_out_of_good_standing() {
    let mut k = owing_steward();
    at(&acc("anyone.testnet"), 9 * DAY);
    k.slash_overdue();
    let (s, good) = k.get_standing(steward());
    assert_eq!((s.slashed, good), (1, false));
}
