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
/// `at`, attaching the pledge fee (pledges and claims pay for their storage).
fn paying(who: &AccountId, ns: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(who.clone()).account_balance(near(100)).block_timestamp(ns)
        .attached_deposit(commons::PLEDGE_FEE);
    testing_env!(b.build());
}

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
    paying(&acc("alice.testnet"), DAY);
    let id = k.pledge("review one pull request".into(), 2);
    paying(&acc("bob.testnet"), DAY);
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
    paying(&acc("alice.testnet"), DAY);
    let id = k.pledge("one design review".into(), 1);
    k.redeem_pledge(id);
}

#[test]
#[should_panic(expected = "only a member")]
fn only_members_pledge() {
    let mut k = setup();
    paying(&acc("outsider.testnet"), DAY);
    k.pledge("anything".into(), 1);
}

#[test]
#[should_panic(expected = "every unit")]
fn a_pledge_is_called_in_at_most_units_times() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    paying(&acc("alice.testnet"), DAY);
    let id = k.pledge("one translation".into(), 1);
    paying(&acc("bob.testnet"), DAY);
    k.redeem_pledge(id);
    k.redeem_pledge(id);
}

#[test]
fn a_pledge_is_broken_only_after_14_days_and_only_by_its_holder() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet", "carol.testnet"]);
    paying(&acc("alice.testnet"), DAY);
    let id = k.pledge("one review".into(), 1);
    paying(&acc("bob.testnet"), DAY);
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
#[should_panic(expected = "pledge's storage")]
fn a_pledge_pays_for_its_storage() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    at(&acc("alice.testnet"), DAY);
    k.pledge("one review".into(), 1);
}

#[test]
#[should_panic(expected = "claim's storage")]
fn calling_in_a_pledge_pays_for_the_claim() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    paying(&acc("alice.testnet"), DAY);
    let id = k.pledge("one review".into(), 1);
    at(&acc("bob.testnet"), DAY);
    k.redeem_pledge(id);
}

/// Security review 12 Nov (S3): a term that ends just after a paid job must not slash an honest steward; they get the
/// same 7 days as `slash_overdue` gives, after the term, and are slashed only if they still owe then.
#[test]
fn a_term_ending_just_after_a_paid_job_gives_the_steward_seven_days() {
    let mut k = owing_steward(); // a 10 USDC job paid at day 1, nothing passed on
    as_(&dao(), near(0));
    k.set_steward_term(1);
    let ends = k.get_steward_term().1.unwrap().0;
    at(&acc("anyone.testnet"), ends);
    assert!(fails(|| k.end_steward_term()), "the steward still has days to pass the earnings on");
    at(&acc("anyone.testnet"), ends + 7 * DAY);
    k.end_steward_term();
    assert!(logs_have("\"steward_slashed\""), "still owing after the grace: slashed");
    assert!(k.get_info().steward.is_none());
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

// ---------- the veto window on payouts paid on trust ----------

/// carol is trusted by alice (task #0 approved by bob); the members vote a 30-minute veto window.
fn trusted_with_veto() -> Koperasi {
    let mut k = board();
    let (id, _) = deliver(&mut k, 50 * MILLI);
    approve(&mut k, id);
    dao_says(&mut k, id, "Approved");
    as_(&dao(), near(0));
    k.set_veto_window(30);
    k
}
const MIN: u64 = 60_000_000_000;

#[test]
fn a_payout_on_trust_waits_out_the_veto_window_then_anyone_releases_it() {
    let mut k = trusted_with_veto();
    assert_eq!(k.get_board().veto_minutes, 30);
    let (id, on_trust) = deliver_by(&mut k, "bob.testnet", "carol.testnet", 80 * MILLI);
    assert!(on_trust);
    assert_eq!(k.get_tasks(None, None)[id as usize].status, TaskStatus::Held);
    assert_eq!(k.get_board().budget.0, 950 * MILLI, "nothing leaves the budget while held");
    assert_eq!(k.get_task_due(id), Some(U64(30 * MIN)));
    at(&acc("stranger.testnet"), 30 * MIN);
    k.release_task(id);
    assert_eq!(k.get_tasks(None, None)[id as usize].status, TaskStatus::Paying);
    assert_eq!(k.get_board().budget.0, 870 * MILLI);
    assert_eq!(k.get_task_due(id), None);
    dao_says(&mut k, id, "Approved");
    assert_eq!(k.get_tasks(None, None)[id as usize].approved_by, None, "paid on trust, no vote");
}

#[test]
#[should_panic(expected = "the veto window is still open")]
fn a_held_payout_cannot_be_released_early() {
    let mut k = trusted_with_veto();
    let (id, _) = deliver_by(&mut k, "bob.testnet", "carol.testnet", 80 * MILLI);
    at(&acc("carol.testnet"), 30 * MIN - 1);
    k.release_task(id);
}

#[test]
fn a_members_veto_sends_the_payout_to_one_other_members_vote() {
    let mut k = trusted_with_veto();
    let (id, _) = deliver_by(&mut k, "bob.testnet", "carol.testnet", 80 * MILLI);
    as_(&acc("alice.testnet"), near(0));
    k.veto_task(id);
    assert_eq!(k.get_tasks(None, None)[id as usize].status, TaskStatus::NeedsApproval);
    assert_eq!(k.get_task_due(id), None);
    // the window passing no longer pays it
    at(&acc("carol.testnet"), DAY);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.release_task(id))).is_err());
    as_(&me(), near(0));
    k.on_approve_policy(id, acc("alice.testnet"), Ok(policy(&["alice.testnet", "bob.testnet"])));
    dao_says(&mut k, id, "Approved");
    assert_eq!(k.get_tasks(None, None)[id as usize].approved_by, Some(acc("alice.testnet")));
}

#[test]
fn only_a_member_other_than_the_contributor_vetoes() {
    let mut k = trusted_with_veto();
    with_members(&mut k, &["carol.testnet"]);
    let (id, _) = deliver_by(&mut k, "bob.testnet", "carol.testnet", 80 * MILLI);
    for who in ["stranger.testnet", "carol.testnet"] {
        as_(&acc(who), near(0));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.veto_task(id))).is_err(), "{who}");
    }
    assert_eq!(k.get_tasks(None, None)[id as usize].status, TaskStatus::Held);
}

#[test]
fn the_dao_can_cancel_a_held_payout_and_only_the_dao_sets_the_window() {
    let mut k = trusted_with_veto();
    let (id, _) = deliver_by(&mut k, "bob.testnet", "carol.testnet", 80 * MILLI);
    as_(&dao(), near(0));
    k.cancel_task(id);
    assert_eq!(k.get_tasks(None, None)[id as usize].status, TaskStatus::Cancelled);
    assert_eq!(k.get_board().budget.0, 950 * MILLI);
    as_(&acc("alice.testnet"), near(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.set_veto_window(0))).is_err());
    as_(&dao(), near(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.set_veto_window(MAX_VETO_MINUTES + 1))).is_err());
    k.set_veto_window(0);
    let (id, _) = deliver_by(&mut k, "bob.testnet", "carol.testnet", 80 * MILLI);
    assert_eq!(k.get_tasks(None, None)[id as usize].status, TaskStatus::Paying, "no window: paid at once, as before");
}

// ---------- appeal to the members (0.2.7) ----------

/// A case two jurors dismissed, opened by frank on day 2.
fn dismissed() -> (Koperasi, u32) {
    let mut k = court();
    let id = open(&mut k, "frank.testnet", 2 * DAY);
    for j in k.get_cases(None, None)[0].jurors.clone().iter().take(2) {
        at(j, 2 * DAY + 1);
        k.rule_case(id, false);
    }
    (k, id)
}

fn appeal(k: &mut Koperasi, id: u32, who: &str, ns: u64) {
    at_paying(&acc(who), ns, APPEAL_BOND);
    let _ = k.appeal_case(id);
}

fn members_decide(k: &mut Koperasi, id: u32, status: &str) {
    at(&me(), 7 * DAY);
    k.on_appeal_read(id, Ok(json!({ "status": status })));
}

#[test]
fn the_members_overturn_a_dismissed_case_on_appeal_and_the_bond_comes_back() {
    let (mut k, id) = dismissed();
    appeal(&mut k, id, "frank.testnet", 4 * DAY);
    at(&me(), 4 * DAY + 1);
    k.on_appeal_filed(id, Ok(81));
    assert!(logs_have("\"case_appealed\"") && logs_have("\"proposal_id\":81"));
    assert_eq!(k.get_appeal(id).unwrap().proposal, Some(81));
    assert!(fails(|| { open(&mut k, "erin.testnet", 5 * DAY); }), "no second case while the members vote");
    members_decide(&mut k, id, "Approved");
    let a = k.get_appeal(id).unwrap();
    assert_eq!(a.status, CaseStatus::Upheld);
    assert!(logs_have("\"appeal_settled\"") && logs_have("\"upheld\":true"));
    assert!(fails(|| { open(&mut k, "erin.testnet", 8 * DAY); }), "refunded once, by the members");
    assert!(fails(|| members_decide(&mut k, id, "Approved")), "settled once");
}

#[test]
fn the_members_confirm_the_jury_and_the_job_is_open_to_its_second_case() {
    let (mut k, id) = dismissed();
    appeal(&mut k, id, "frank.testnet", 4 * DAY);
    at(&me(), 4 * DAY + 1);
    k.on_appeal_filed(id, Ok(82));
    at(&me(), 6 * DAY);
    assert!(fails(|| k.on_appeal_read(id, Ok(json!({ "status": "InProgress" })))), "not decided yet");
    members_decide(&mut k, id, "Rejected");
    assert_eq!(k.get_appeal(id).unwrap().status, CaseStatus::Dismissed);
    open(&mut k, "erin.testnet", 8 * DAY);
}

#[test]
fn an_appeal_that_could_not_be_filed_returns_the_bond_and_frees_the_job() {
    let (mut k, id) = dismissed();
    appeal(&mut k, id, "frank.testnet", 4 * DAY);
    at(&me(), 4 * DAY + 1);
    k.on_appeal_filed(id, Err(PromiseError::Failed));
    assert!(k.get_appeal(id).is_none());
    appeal(&mut k, id, "frank.testnet", 5 * DAY);
}

#[test]
fn only_the_claimant_appeals_only_a_ruled_dismissal_with_the_bond_within_7_days() {
    let (mut k, id) = dismissed();
    assert!(fails(|| appeal(&mut k, id, "erin.testnet", 4 * DAY)), "only the claimant");
    assert!(fails(|| { at_paying(&acc("frank.testnet"), 4 * DAY, COURT_BOND); let _ = k.appeal_case(id); }), "the 1 NEAR bond");
    assert!(fails(|| appeal(&mut k, id, "frank.testnet", 2 * DAY + 10 * DAY)), "7 days after the jury's 3");
    appeal(&mut k, id, "frank.testnet", 11 * DAY);
    assert!(fails(|| appeal(&mut k, id, "frank.testnet", 11 * DAY + 1)), "once");
}

#[test]
fn a_case_nobody_ruled_on_is_not_appealed() {
    let mut k = court();
    let id = open(&mut k, "frank.testnet", 2 * DAY);
    at(&acc("anyone.testnet"), 5 * DAY);
    k.close_case(id);
    assert!(fails(|| appeal(&mut k, id, "frank.testnet", 6 * DAY)), "nobody ruled: the second case is the remedy");
}

#[test]
#[should_panic(expected = "only a dismissed case")]
fn an_upheld_case_is_not_appealed() {
    let mut k = court();
    let id = open(&mut k, "frank.testnet", 2 * DAY);
    for j in k.get_cases(None, None)[0].jurors.clone().iter().take(2) {
        at(j, 2 * DAY + 1);
        k.rule_case(id, true);
    }
    appeal(&mut k, id, "frank.testnet", 3 * DAY);
}

// ---------- payout routes and the work-record token (0.2.7) ----------

#[test]
fn a_member_routes_payouts_to_an_evm_address_and_back_to_near() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    let addr = "0x00000000000000000000000000000000000000ab";
    at(&acc("alice.testnet"), DAY);
    k.set_payout_route("base".into(), Some(addr.into()));
    assert!(logs_have("\"payout_route_set\""));
    assert_eq!(k.get_payout_routes(), vec![(acc("alice.testnet"), "base".to_string(), addr.to_string())]);
    k.set_payout_route("arb".into(), Some(addr.into()));
    assert_eq!(k.get_payout_routes().len(), 1, "one route per member");
    k.set_payout_route("near".into(), None);
    assert!(k.get_payout_routes().is_empty());
    assert!(fails(|| k.set_payout_route("sol".into(), Some(addr.into()))), "only chains the wallet can withdraw to");
    assert!(fails(|| k.set_payout_route("base".into(), Some("0xABC".into()))), "a 0x address");
    assert!(fails(|| k.set_payout_route("base".into(), Some(addr.to_uppercase().replace("0X", "0x")))), "lowercase");
    assert!(fails(|| { at(&acc("stranger.testnet"), DAY); k.set_payout_route("base".into(), Some(addr.into())); }), "members only");
    // a member who leaves has no route
    at(&bob(), DAY);
    k.set_payout_route("eth".into(), Some(addr.into()));
    as_(&dao(), near(0));
    k.apply_membership(bob(), false);
    assert!(k.get_payout_routes().is_empty());
}

fn bob() -> AccountId {
    acc("bob.testnet")
}

#[test]
fn a_work_record_is_a_token_read_live_and_never_transferred() {
    let mut k = court();
    let (_, id) = (0, open(&mut k, "frank.testnet", 2 * DAY));
    let jurors = k.get_cases(None, None)[0].jurors.clone();
    for j in jurors.iter().take(2) {
        at(j, 2 * DAY + 1);
        k.rule_case(id, true);
    }
    let juror = jurors[0].clone();
    assert!(fails(|| { at(&juror, 3 * DAY); k.mint_work_record(); }), "pays for its storage");
    at_paying(&juror, 3 * DAY, commons::PLEDGE_FEE);
    k.mint_work_record();
    assert!(logs_have("\"standard\":\"nep171\"") && logs_have("\"nft_mint\""));
    assert!(fails(|| { at_paying(&juror, 3 * DAY, commons::PLEDGE_FEE); k.mint_work_record(); }), "once");
    assert!(fails(|| { at_paying(&acc("nobody.testnet"), 3 * DAY, commons::PLEDGE_FEE); k.mint_work_record(); }), "no record, no token");
    let t = k.nft_token(juror.to_string()).unwrap();
    assert_eq!(t["owner_id"], juror.to_string());
    let extra: Value = near_sdk::serde_json::from_str(t["metadata"]["extra"].as_str().unwrap()).unwrap();
    assert_eq!(extra["standing"]["juries_served"], 1);
    assert!(t["metadata"]["media"].as_str().unwrap().starts_with("data:image/svg+xml;base64,"));
    // live: a missed jury later shows on the same token
    commons::mark(&juror, |s| s.juries_missed += 1);
    let t = k.nft_token(juror.to_string()).unwrap();
    assert!(t["metadata"]["description"].as_str().unwrap().contains("not in good standing"));
    assert_eq!(k.nft_total_supply(), U128(1));
    assert_eq!(k.nft_tokens_for_owner(juror.clone(), None, None).len(), 1);
    assert_eq!(k.nft_supply_for_owner(acc("alice.testnet")).0 + k.nft_supply_for_owner(juror.clone()).0, 1 + (juror.as_str() == "alice.testnet") as u128);
    assert!(fails(|| { at_paying(&juror, 4 * DAY, NearToken::from_yoctonear(1)); k.nft_transfer(acc("buyer.testnet"), juror.to_string(), None, None); }));
    at(&juror, 4 * DAY);
    k.burn_work_record();
    assert!(logs_have("\"nft_burn\"") && k.nft_token(juror.to_string()).is_none());
}

/// The passport: a sister co-op's work record, read by a cross-contract call, counts as one more trust source here.
#[test]
fn a_sister_coops_work_record_counts_as_one_trust_source_and_a_stale_one_is_removed() {
    let mut k = setup();
    let sister = acc("koperasi-sister.testnet");
    let frank = acc("frank.testnet");
    let token = |owner: &str, done: u32, good: bool| Some(near_sdk::serde_json::json!({ "owner_id": owner, "metadata": {
        "extra": near_sdk::serde_json::json!({ "done": done, "earned": "5", "good_standing": good }).to_string() } }));
    assert!(fails(|| { as_(&acc("alice.testnet"), near(0)); k.set_sister_coops(vec![sister.clone()]); }), "only the DAO");
    assert!(fails(|| { as_(&dao(), near(0)); k.set_sister_coops(vec![me()]); }), "not itself");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone()]);
    assert!(logs_have("sister_coops_set"));
    at_paying(&acc("anyone.testnet"), DAY, commons::PLEDGE_FEE);
    assert!(fails(|| { let _ = k.stamp_passport(frank.clone(), acc("koperasi-fake.testnet")); }), "only a recognised co-op");
    let _ = k.stamp_passport(frank.clone(), sister.clone());
    as_(&me(), near(0));
    // someone else's token, no finished work, or out of good standing: no stamp
    assert!(!k.on_token_read(frank.clone(), sister.clone(), acc("anyone.testnet"), Ok(token("mallory.testnet", 3, true))));
    assert!(!k.on_token_read(frank.clone(), sister.clone(), acc("anyone.testnet"), Ok(token("frank.testnet", 0, true))));
    assert!(!k.on_token_read(frank.clone(), sister.clone(), acc("anyone.testnet"), Ok(token("frank.testnet", 3, false))));
    assert_eq!(k.get_trust_sources(frank.clone()), 0);
    assert!(k.on_token_read(frank.clone(), sister.clone(), acc("anyone.testnet"), Ok(token("frank.testnet", 3, true))));
    assert!(logs_have("passport_stamped"));
    assert_eq!(k.get_trust_sources(frank.clone()), 1);
    // read again: still one stamp per co-op
    assert!(k.on_token_read(frank.clone(), sister.clone(), acc("anyone.testnet"), Ok(token("frank.testnet", 4, true))));
    assert_eq!(k.get_passport(frank.clone()).len(), 1);
    assert_eq!(k.get_passport(frank.clone())[0].done, 4);
    // a failed read changes nothing; a read that no longer holds removes the stamp
    assert!(!k.on_token_read(frank.clone(), sister.clone(), acc("anyone.testnet"), Err(near_sdk::PromiseError::Failed)));
    assert_eq!(k.get_trust_sources(frank.clone()), 1);
    assert!(!k.on_token_read(frank.clone(), sister.clone(), acc("anyone.testnet"), Ok(None)));
    assert_eq!(k.get_trust_sources(frank.clone()), 0);
    // a co-op the members drop stops counting
    assert!(k.on_token_read(frank.clone(), sister.clone(), acc("anyone.testnet"), Ok(token("frank.testnet", 4, true))));
    as_(&dao(), near(0));
    k.set_sister_coops(vec![]);
    assert_eq!(k.get_trust_sources(frank.clone()), 0);
    assert_eq!(k.get_passport(frank).len(), 1, "kept, but it does not count");
}

/// Both sides are heard: the claimant and the steward file evidence while the case is open, three pieces each.
#[test]
fn the_claimant_and_the_steward_file_evidence_while_the_case_is_open() {
    let mut k = court();
    let id = open(&mut k, "frank.testnet", 2 * DAY);
    let frank = acc("frank.testnet");
    assert!(fails(|| { at(&frank, 2 * DAY); k.add_evidence(id, "brief vs report".into()); }), "pays for its storage");
    assert!(fails(|| { at_paying(&acc("alice.testnet"), 2 * DAY, commons::PLEDGE_FEE); k.add_evidence(id, "x".into()); }), "a third party");
    assert!(fails(|| { at_paying(&frank, 2 * DAY, commons::PLEDGE_FEE); k.add_evidence(id, " ".into()); }), "empty");
    for n in 0..3 {
        at_paying(&frank, 2 * DAY, commons::PLEDGE_FEE);
        k.add_evidence(id, format!("sha256 of the brief and the report, part {n}"));
    }
    assert!(logs_have("evidence_filed"));
    assert!(fails(|| { at_paying(&frank, 2 * DAY, commons::PLEDGE_FEE); k.add_evidence(id, "a fourth".into()); }), "three each");
    at_paying(&steward(), 2 * DAY, commons::PLEDGE_FEE);
    k.add_evidence(id, "the market's own ruling: https://market.near.ai/jobs/job-1".into());
    let e = k.get_evidence(id);
    assert_eq!(e.len(), 4);
    assert_eq!(e[3].0, steward());
    // closed: nothing more
    at(&acc("anyone.testnet"), 2 * DAY + 3 * DAY);
    k.close_case(id);
    assert!(fails(|| { at_paying(&steward(), 6 * DAY, commons::PLEDGE_FEE); k.add_evidence(id, "late".into()); }));
}

/// Mandatory dues (0.2.9): paid into the DAO treasury, arrears first; 7 days behind and a member is out of good standing.
#[test]
fn a_member_behind_on_dues_loses_good_standing_until_they_pay_the_arrears() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    let alice = acc("alice.testnet");
    assert!(k.get_standing(alice.clone()).1, "no dues voted: good");
    assert!(fails(|| { at(&alice, DAY); k.set_dues(U128(MILLI), 30); }), "only the DAO");
    at(&dao(), DAY);
    k.set_dues(U128(100 * MILLI), 30);
    assert!(logs_have("dues_set"));
    // due from the vote, with 7 days' grace
    at(&alice, DAY + 7 * DAY);
    assert!(k.get_standing(alice.clone()).1);
    at(&alice, DAY + 8 * DAY);
    assert!(!k.get_standing(alice.clone()).1, "8 days behind");
    assert!(fails(|| { at_paying(&alice, 9 * DAY, NearToken::from_millinear(50)); k.pay_dues(); }), "less than one period");
    assert!(fails(|| { at_paying(&acc("outsider.testnet"), 9 * DAY, NearToken::from_millinear(100)); k.pay_dues(); }), "members only");
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(alice.clone()).account_balance(near(100)).block_timestamp(9 * DAY)
        .attached_deposit(NearToken::from_millinear(250));
    testing_env!(b.build());
    let until = k.pay_dues();
    assert_eq!(until.0, DAY + 2 * 30 * DAY, "two whole periods from the vote, the change returned");
    assert!(logs_have("dues_paid"));
    assert!(k.get_standing(alice.clone()).1);
    assert_eq!(k.get_dues_status(alice.clone()), Some((until, true)));
    // the members turn dues off: everyone is fine again
    at(&acc("bob.testnet"), 100 * DAY);
    assert!(!k.get_standing(acc("bob.testnet")).1);
    at(&dao(), 100 * DAY);
    k.set_dues(U128(0), 0);
    assert!(k.get_standing(acc("bob.testnet")).1);
    // voted on again later: alice's old record (paid to day 61) does not make her owe for the time without dues
    at(&dao(), 200 * DAY);
    k.set_dues(U128(100 * MILLI), 30);
    at(&alice, 203 * DAY);
    assert!(k.get_standing(alice.clone()).1);
    assert_eq!(k.get_dues_status(alice.clone()).unwrap().0, U64(200 * DAY));
}

/// The annual members' meeting (0.2.9): members set the agenda, the DAO records the approved report once a year.
#[test]
fn members_set_the_agenda_and_the_dao_records_the_approved_report_once_a_year() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    let alice = acc("alice.testnet");
    assert!(fails(|| { at_paying(&acc("outsider.testnet"), DAY, commons::PLEDGE_FEE); k.propose_agenda(2026, "x".into()); }));
    for n in 0..3 {
        at_paying(&alice, DAY, commons::PLEDGE_FEE);
        k.propose_agenda(2026, format!("item {n}"));
    }
    assert!(fails(|| { at_paying(&alice, DAY, commons::PLEDGE_FEE); k.propose_agenda(2026, "a fourth".into()); }), "three each");
    assert_eq!(k.get_agenda(2026).len(), 3);
    let h = "ab".repeat(32);
    assert!(fails(|| { at(&alice, DAY); k.record_annual_meeting(2026, h.clone(), h.clone()); }), "only the DAO");
    assert!(fails(|| { at(&dao(), DAY); k.record_annual_meeting(2026, "AB".repeat(32), h.clone()); }), "lowercase hex");
    at(&dao(), DAY);
    k.record_annual_meeting(2026, h.clone(), h.clone());
    assert!(logs_have("annual_meeting_held"));
    assert!(fails(|| { at(&dao(), DAY); k.record_annual_meeting(2026, h.clone(), h.clone()); }), "once a year");
    assert!(fails(|| { at_paying(&alice, DAY, commons::PLEDGE_FEE); k.propose_agenda(2026, "late".into()); }), "the meeting is held");
    assert_eq!(k.get_annual_meetings()[0].year, 2026);
}

/// The agent as a defendant (0.2.9): an upheld case is a strike; 3 in 90 days suspend it until the members reinstate it.
#[test]
fn upheld_cases_strike_the_agent_and_three_suspend_it_until_the_members_reinstate_it() {
    let mut k = court();
    let id = open(&mut k, "frank.testnet", 2 * DAY);
    let jurors = k.get_cases(None, None)[0].jurors.clone();
    for j in jurors.iter().take(2) {
        at(j, 2 * DAY + 1);
        k.rule_case(id, true);
    }
    assert!(logs_have("agent_struck"));
    assert_eq!(k.get_agent_standing().strikes.len(), 1);
    meeting::strike(id); // the same case never counts twice
    assert_eq!(k.get_agent_standing().strikes.len(), 1);
    at(&agent(), 3 * DAY);
    meeting::strike(90);
    meeting::strike(91);
    assert!(k.get_agent_standing().suspended);
    assert!(fails(|| { as_(&agent(), near(0)); k.record_receipt("job-9".into(), U128(1), U128(0), H1.into(), "00".into(), None); }), "suspended");
    assert!(fails(|| { at(&acc("alice.testnet"), 4 * DAY); k.reinstate_agent(); }), "only the DAO");
    at(&dao(), 4 * DAY);
    k.reinstate_agent();
    assert!(!k.get_agent_standing().suspended && k.get_agent_standing().strikes.is_empty());
    receipt(&mut k, "job-9", 1, H1);
    // strikes older than 90 days stop counting
    at(&agent(), 5 * DAY);
    meeting::strike(92);
    at(&agent(), 5 * DAY + meeting::STRIKE_DAYS * DAY + 1);
    assert!(k.get_agent_standing().strikes.is_empty());
}

/// 0.3.0: the education and social funds are paid from every profit share's reserve part, never more than it.
#[test]
fn the_funds_the_members_voted_are_paid_from_each_shares_reserve() {
    let mut k = setup(); // 20% reserve
    with_members(&mut k, &["alice.testnet"]);
    let fund = |name: &str, bps: u16, to: &str| lending::ShareFund { name: name.into(), bps, to: acc(to) };
    assert!(fails(|| { as_(&acc("alice.testnet"), near(0)); k.set_share_funds(vec![fund("education", 500, "edu.testnet")]); }), "only the DAO");
    assert!(fails(|| { as_(&dao(), near(0)); k.set_share_funds(vec![fund("education", 1500, "edu.testnet"), fund("social", 600, "soc.testnet")]); }), "within the reserve");
    as_(&dao(), near(0));
    k.set_share_funds(vec![fund("education", 500, "edu.testnet"), fund("social", 250, "soc.testnet")]);
    as_(&usdc(), near(0));
    let _ = k.ft_on_transfer(dao(), U128(1_000_000), "share".into());
    assert!(logs_have("\"fund_paid\"") && logs_have("\"amount\":\"50000\"") && logs_have("\"amount\":\"25000\""));
    assert_eq!(k.get_share_funds().len(), 2);
}

/// 0.3.0: a guarantor answers for the account they guaranteed (tanggung renteng), until the members clear it.
#[test]
fn a_guarantor_loses_good_standing_when_the_guaranteed_account_falls() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet"]);
    let (alice, bob, carol) = (acc("alice.testnet"), acc("bob.testnet"), acc("carol.testnet"));
    assert!(fails(|| { at_paying(&alice, DAY, commons::PLEDGE_FEE); k.guarantee(alice.clone()); }), "not yourself");
    assert!(fails(|| { at(&alice, DAY); k.guarantee(bob.clone()); }), "pays for storage");
    at_paying(&alice, DAY, commons::PLEDGE_FEE);
    k.guarantee(bob.clone());
    at_paying(&carol, DAY, commons::PLEDGE_FEE);
    k.guarantee(bob.clone());
    assert!(fails(|| { at_paying(&alice, DAY, commons::PLEDGE_FEE); k.guarantee(bob.clone()); }), "once each");
    assert_eq!(k.get_guarantors(bob.clone()).len(), 2);
    assert!(k.get_standing(alice.clone()).1);
    commons::mark(&bob, |s| s.pledges_broken += 1); // bob breaks a pledge
    assert!(logs_have("guarantee_called"));
    assert!(!k.get_standing(alice.clone()).1 && !k.get_standing(carol.clone()).1, "both guarantors answer");
    commons::mark(&bob, |s| s.pledges_broken += 1); // already fallen: no second mark
    assert_eq!(k.get_guarantee_failures(alice.clone()), 1);
    assert!(fails(|| { at(&alice, DAY); k.clear_guarantee_failures(alice.clone()); }), "only the DAO");
    as_(&dao(), near(0));
    k.clear_guarantee_failures(alice.clone());
    assert!(k.get_standing(alice.clone()).1);
    at(&carol, DAY);
    k.withdraw_guarantee(bob.clone());
    assert_eq!(k.get_guarantors(bob), vec![alice]);
}

/// 0.3.0: savings and loans: a guaranteed member borrows from the fund the members voted, repays with interest into
/// the treasury, and the fund revolves; a loan left late marks the borrower and the guarantor.
#[test]
fn a_member_borrows_from_the_voted_fund_repays_with_interest_and_a_late_loan_marks_the_guarantor() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    let (alice, bob) = (acc("alice.testnet"), acc("bob.testnet"));
    let rule = lending::LoanRule { max_loan: U128(near(1).as_yoctonear()), rate_bps: 200, term_days: 30 };
    assert!(fails(|| { at(&bob, DAY); let _ = k.request_loan(U128(near(1).as_yoctonear())); }), "no loans voted");
    as_(&dao(), near(0));
    k.set_loan_rule(rule.clone(), U128(near(2).as_yoctonear()));
    assert!(fails(|| { at(&bob, DAY); let _ = k.request_loan(U128(near(1).as_yoctonear())); }), "needs a guarantor");
    at_paying(&alice, DAY, commons::PLEDGE_FEE);
    k.guarantee(bob.clone());
    assert!(fails(|| { at(&bob, DAY); let _ = k.request_loan(U128(near(1).as_yoctonear())); }), "0.3.2: 2 of 10 (one guarantor) allows 0.2 NEAR");
    commons::mark(&bob, |s| s.pledges_honored += 8); // bob's record: 8 pledges kept, so 10 of 10 with alice
    assert_eq!(k.get_credit(bob.clone()), (10, U128(near(1).as_yoctonear())));
    assert!(fails(|| { at(&bob, DAY); let _ = k.request_loan(U128(near(2).as_yoctonear())); }), "at most the largest loan");
    assert!(fails(|| { at(&acc("outsider.testnet"), DAY); let _ = k.request_loan(U128(1)); }), "members only");
    at(&bob, DAY);
    let _ = k.request_loan(U128(near(1).as_yoctonear()));
    assert!(logs_have("loan_requested"));
    assert_eq!(k.get_loan_rule().unwrap().1, U128(near(1).as_yoctonear()), "the fund lent 1 of 2");
    assert!(fails(|| { at(&bob, DAY); let _ = k.request_loan(U128(1)); }), "one loan at a time");
    assert!(fails(|| { at(&alice, DAY); k.withdraw_guarantee(bob.clone()); }), "not while the loan is open");
    at(&me(), DAY);
    let _ = k.on_loan_filed(bob.clone(), Value::Null, Ok(55));
    assert_eq!(k.get_loan(bob.clone()).unwrap().proposal, Some(55));
    // repaid with 2% interest: the principal goes back to the fund
    assert!(fails(|| { at_paying(&bob, 2 * DAY, near(1)); k.repay_loan(); }), "principal plus interest");
    at_paying(&bob, 2 * DAY, NearToken::from_millinear(1020));
    k.repay_loan();
    assert_eq!(k.get_loan(bob.clone()).unwrap().status, lending::LoanStatus::Repaid);
    assert_eq!(k.get_loan_rule().unwrap().1, U128(near(2).as_yoctonear()));
    // a second loan, left late: anyone calls it after the term and 7 days; bob and alice lose good standing
    at(&bob, 3 * DAY);
    let _ = k.request_loan(U128(near(1).as_yoctonear()));
    assert!(fails(|| { at(&acc("anyone.testnet"), 3 * DAY + 30 * DAY); k.call_loan_late(bob.clone()); }), "not late yet");
    at(&acc("anyone.testnet"), 3 * DAY + 38 * DAY);
    k.call_loan_late(bob.clone());
    assert!(!k.get_standing(bob.clone()).1 && !k.get_standing(alice.clone()).1);
    // a filed loan that the DAO did not take is undone
    at(&me(), 50 * DAY);
}

/// 0.3.1: the members vote a further agent and its tags; it records receipts under the same rules, and only the agent
/// that recorded a receipt updates it.
#[test]
fn a_further_agent_the_members_voted_records_its_own_receipts() {
    let mut k = setup();
    let tr = acc("translator.testnet");
    let skill = |a: &AccountId, tags: &[&str]| lending::AgentSkill { account: a.clone(), tags: tags.iter().map(|t| t.to_string()).collect() };
    assert!(fails(|| { as_(&tr, near(0)); k.record_receipt("t-1".into(), U128(1), U128(0), H1.into(), "00".into(), None); }), "not voted yet");
    assert!(fails(|| { as_(&acc("alice.testnet"), near(0)); k.set_agents(vec![skill(&tr, &["translation"])]); }), "only the DAO");
    assert!(fails(|| { as_(&dao(), near(0)); k.set_agents(vec![skill(&tr, &["Translation"])]); }), "lowercase tags");
    assert!(fails(|| { as_(&dao(), near(0)); k.set_agents(vec![skill(&agent(), &["translation"])]); }), "not the founding agent");
    as_(&dao(), near(0));
    k.set_agents(vec![skill(&tr, &["translation", "localization"])]);
    assert_eq!(k.get_agents().len(), 2);
    as_(&tr, near(0));
    k.record_receipt("t-1".into(), U128(1), U128(0), H1.into(), "00".into(), None);
    assert_eq!(k.get_receipt_agent("t-1".into()), tr);
    receipt(&mut k, "j-1", 1, H1);
    assert_eq!(k.get_receipt_agent("j-1".into()), agent());
    assert!(fails(|| { as_(&agent(), near(0)); k.update_receipt("t-1".into(), ReceiptStatus::Paid); }), "another agent's receipt");
    as_(&tr, near(0));
    k.update_receipt("t-1".into(), ReceiptStatus::Paid);
    // voted out: it records no more
    as_(&dao(), near(0));
    k.set_agents(vec![]);
    assert!(fails(|| { as_(&tr, near(0)); k.record_receipt("t-2".into(), U128(1), U128(0), H1.into(), "00".into(), None); }));
}

/// 0.3.2 (automated review A1): a further agent's paid jobs never make the steward owe, so they cannot make the bond
/// slashable; the founding agent's still do.
#[test]
fn a_further_agents_paid_jobs_do_not_count_toward_what_the_steward_owes() {
    let mut k = owing_steward(); // job-1 by the founding agent, paid on day 1: 9.5 USDC owed after the grace
    let tr = acc("translator.testnet");
    as_(&dao(), near(0));
    k.set_agents(vec![lending::AgentSkill { account: tr.clone(), tags: vec!["translation".into()] }]);
    as_(&tr, near(0));
    k.record_receipt("t-1".into(), U128(50_000_000), U128(0), H1.into(), "00".into(), None);
    at(&tr, DAY);
    k.update_receipt("t-1".into(), ReceiptStatus::Paid);
    at(&acc("anyone.testnet"), 9 * DAY);
    assert_eq!(k.get_overdue().0, 9_500_000, "only job-1; the translator's 50 USDC job is not the steward's to pass on");
}

/// 0.3.2: the risk fund. A fund whose account is the contract stays here; the agent saves a voted share of each
/// earnings deposit into it; a case upheld against its job is refunded from it at once, with no proposal.
#[test]
fn the_risk_fund_fills_from_shares_and_the_agents_earnings_and_refunds_an_upheld_case_at_once() {
    let mut k = court();
    as_(&dao(), near(0));
    k.set_share_funds(vec![lending::ShareFund { name: "risk".into(), bps: 1000, to: me() }]);
    assert!(fails(|| { as_(&dao(), near(0)); k.set_agent_saves(2500); }), "at most 20%");
    k.set_agent_saves(1000);
    as_(&usdc(), near(0));
    let _ = k.ft_on_transfer(dao(), U128(2_000_000), "share".into()); // 10% of 2 USDC
    assert_eq!(k.get_risk_fund().0, U128(200_000));
    as_(&usdc(), near(0));
    let _ = k.ft_on_transfer(steward(), U128(3_000_000), "earnings".into()); // the agent saves 10% of 3 USDC
    assert!(logs_have("\"agent_saved\""));
    assert_eq!(k.get_risk_fund().0, U128(500_000));
    assert_eq!(k.get_audit().deposited, U128(3_000_000), "the whole deposit counts as passed on");
    // a 0.4 USDC case upheld: paid from the fund, no DAO proposal
    let id = {
        at_paying(&acc("frank.testnet"), 2 * DAY, COURT_BOND);
        k.open_case("job-1".into(), acc("buyer.testnet"), U128(400_000), "half the brief was missing".into())
    };
    for j in k.get_cases(None, None)[0].jurors.clone().iter().take(2) {
        at(j, 2 * DAY + 1);
        k.rule_case(id, true);
    }
    assert!(logs_have("refund_from_risk_fund"));
    assert_eq!(k.get_risk_fund().0, U128(100_000));
    assert_eq!(k.get_agent_standing().strikes.len(), 1, "still a strike against the agent");
    // a bounced refund goes back to the fund
    at(&me(), 3 * DAY);
    k.on_risk_refund(id, U128(400_000), Err(near_sdk::PromiseError::Failed));
    assert_eq!(k.get_risk_fund().0, U128(500_000));
}

/// 0.3.2: a further agent can run its own by-laws, voted by the members; its receipts must carry that hash.
#[test]
fn a_further_agent_runs_the_by_laws_the_members_voted_for_it() {
    let mut k = setup();
    let tr = acc("translator.testnet");
    let own = "ab".repeat(32);
    assert!(fails(|| { as_(&dao(), near(0)); k.set_agent_config(tr.clone(), 1, own.clone(), "config/translator/config.v1.yaml".into()); }), "not an agent yet");
    as_(&dao(), near(0));
    k.set_agents(vec![lending::AgentSkill { account: tr.clone(), tags: vec!["translation".into()] }]);
    k.set_agent_config(tr.clone(), 1, own.clone(), "config/translator/config.v1.yaml".into());
    assert_eq!(k.get_agent_config(tr.clone()).unwrap().hash, own);
    assert!(fails(|| { as_(&tr, near(0)); k.record_receipt("t-1".into(), U128(1), U128(0), H1.into(), "00".into(), None); }), "the co-op's by-laws are not its own");
    as_(&tr, near(0));
    k.record_receipt("t-1".into(), U128(1), U128(0), own.clone(), "00".into(), None);
    assert_eq!(k.get_receipts(None, None)[0].config_version, 1);
    receipt(&mut k, "j-1", 1, H1); // the founding agent still runs the co-op's
}


/// 0.3.2: a reputation dividend, by credit score, out of each profit share's reserve part; and the member card shows
/// the credit score, dues and loan.
#[test]
fn a_reputation_dividend_follows_credit_scores_and_the_card_shows_them() {
    let mut k = setup(); // 20% reserve
    with_members(&mut k, &["alice.testnet", "bob.testnet", "carol.testnet"]);
    let (alice, bob, carol) = (acc("alice.testnet"), acc("bob.testnet"), acc("carol.testnet"));
    assert!(fails(|| { as_(&dao(), near(0)); k.set_reputation_share(2500); }), "within the reserve");
    commons::mark(&carol, |s| { s.pledges_honored += 9; s.pledges_broken += 1 }); // out of good standing: no dividend
    as_(&dao(), near(0));
    k.set_reputation_share(1000); // 10% of each share
    commons::mark(&alice, |s| s.pledges_honored += 3); // alice 3 of 10
    commons::mark(&bob, |s| s.pledges_honored += 1); // bob 1 of 10
    as_(&usdc(), near(0));
    let _ = k.ft_on_transfer(dao(), U128(4_000_000), "share".into()); // reputation pool: 0.4 USDC, 3:1
    assert!(logs_have("reputation_dividend"));
    assert_eq!(k.get_claimable(alice.clone()).0, 300_000);
    assert_eq!(k.get_claimable(bob.clone()).0, 100_000);
    assert_eq!(k.get_claimable(carol.clone()).0, 0);
    // the card: credit and dues on the token, live
    at_paying(&alice, DAY, commons::PLEDGE_FEE);
    k.mint_work_record();
    let t = k.nft_token(alice.to_string()).unwrap();
    let extra: Value = near_sdk::serde_json::from_str(t["metadata"]["extra"].as_str().unwrap()).unwrap();
    assert_eq!(extra["credit"]["score"], 3);
    assert!(t["metadata"]["description"].as_str().unwrap().contains("credit 3/10"));
}

/// 0.3.2: the agent puts new by-laws to the members from its record; the contract files the proposal, never votes it,
/// and lets the agent do so once a week.
#[test]
fn the_agent_proposes_new_by_laws_and_only_the_members_decide() {
    let mut k = setup();
    let propose = |k: &mut Koperasi, v: u32| { let _ = k.agent_propose_bylaws(v, if v == 2 { H2 } else { H1 }.into(), "config/config.v2.yaml".into(), "refunds are rare: raise the price".into(), None); };
    assert!(fails(|| { at(&acc("alice.testnet"), DAY); propose(&mut k, 2); }), "the agent only");
    assert!(fails(|| { at(&agent(), DAY); propose(&mut k, 3); }), "the next version only");
    assert!(fails(|| { at(&agent(), DAY); let _ = k.agent_propose_bylaws(2, H2.into(), "u".into(), " ".into(), None); }), "a reason");
    assert!(k.get_agent_proposals().is_empty());
    at(&agent(), DAY);
    propose(&mut k, 2);
    assert!(fails(|| { at(&agent(), 2 * DAY); propose(&mut k, 2); }), "once a week");
    at(&me(), DAY);
    k.on_agent_proposed(Ok(77));
    assert!(logs_have("agent_proposed"));
    let p = &k.get_agent_proposals()[0];
    assert_eq!((p.version, p.proposal), (2, Some(77)));
    assert_eq!(k.get_config().version, 1, "nothing changes until the members vote");
    // what the filed proposal calls once the members approve it: the agent named as contributor, no points
    as_(&dao(), near(0));
    k.set_config(2, H2.into(), "config/config.v2.yaml".into(), Some(agent()), 0);
    assert_eq!(k.get_config().contributor, Some(agent()));
    assert!(fails(|| { as_(&dao(), near(0)); k.set_config(3, H1.into(), "x".into(), Some(agent()), 5); }), "points only for members");
    // a filing that failed is forgotten, so the agent can try again
    at(&agent(), 9 * DAY);
    propose(&mut k, 3);
    at(&me(), 9 * DAY);
    k.on_agent_proposed(Err(PromiseError::Failed));
    assert_eq!(k.get_agent_proposals().len(), 1);
}

/// 0.3.2: the agent's key opens only its receipts, so anyone may submit its proposal with its signature, checked against
/// the key it last signed a receipt with.
#[test]
fn anyone_may_submit_the_agents_signed_proposal() {
    use ed25519_dalek::{Signer, SigningKey};
    let mut k = setup();
    let sk = SigningKey::from_bytes(&[9; 32]);
    let pk: Vec<u8> = [vec![0u8], sk.verifying_key().to_bytes().to_vec()].concat();
    let relayer = acc("relayer.testnet");
    let (uri, why) = ("config/config.v2.yaml", "price up: no refunds in 20 jobs");
    let sig = |sk: &SigningKey| { let m = meeting::agent_proposal_message(&me(), 0, 2, H2, uri, why);
        near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, sk.sign(m.as_bytes()).to_bytes()) };
    let submit = |k: &mut Koperasi, s: Option<String>| { let _ = k.agent_propose_bylaws(2, H2.into(), uri.into(), why.into(), s); };
    assert!(fails(|| { at(&relayer, DAY); submit(&mut k, Some(sig(&sk))); }), "no receipt signed yet: no key known");
    // the agent signs a receipt with that key: the contract keeps it
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(agent()).signer_account_id(agent())
        .signer_account_pk(pk.clone().try_into().unwrap()).block_timestamp(DAY);
    testing_env!(b.build());
    k.record_receipt("j-pk".into(), U128(1), U128(0), H1.into(), "00".into(), None);
    assert!(fails(|| { at(&relayer, DAY); submit(&mut k, Some(sig(&SigningKey::from_bytes(&[8; 32])))); }), "another key");
    assert!(fails(|| { at(&relayer, DAY); submit(&mut k, None); }), "no signature");
    assert!(fails(|| { at(&relayer, DAY); let _ = k.agent_propose_bylaws(2, H2.into(), uri.into(), "price down".into(), Some(sig(&sk))); }), "the reason is signed too");
    at(&relayer, DAY);
    submit(&mut k, Some(sig(&sk)));
    assert_eq!(k.get_agent_proposals().len(), 1);
    // a signature counts once: replayed a week later, it signs nonce 0, not 1; even after a failed filing
    k.on_agent_proposed(Err(PromiseError::Failed));
    assert!(fails(|| { at(&relayer, 9 * DAY); submit(&mut k, Some(sig(&sk))); }), "replayed");
    assert!(fails(|| { at(&agent(), 9 * DAY); let _ = k.agent_propose_bylaws(2, H2.into(), "a b".into(), why.into(), None); }), "a uri without spaces");
    // nor once the members appoint another agent, nor while the co-op is paused
    as_(&dao(), near(0));
    k.set_agent(acc("agent2.testnet"));
    as_(&dao(), near(0));
    k.set_agent(agent()); // appointed again: its key from before does not count until it signs a receipt again
    assert!(fails(|| { at(&relayer, 9 * DAY); let _ = k.agent_propose_bylaws(2, H2.into(), uri.into(), why.into(), Some(sig(&sk))); }), "an earlier agent's key");
    as_(&dao(), near(0));
    k.pause();
    assert!(fails(|| { at(&acc("agent2.testnet"), 9 * DAY); let _ = k.agent_propose_bylaws(2, H2.into(), uri.into(), why.into(), None); }), "paused");
}

/// 0.3.3: the agent as a member: a voted share of every profit share goes into the risk fund, halved per live strike,
/// nothing while suspended.
#[test]
fn the_agent_gets_a_share_of_the_surplus_by_its_standing() {
    let mut k = setup(); // 20% reserve
    with_members(&mut k, &["alice.testnet"]);
    assert!(fails(|| { as_(&dao(), near(0)); k.set_agent_share(2500); }), "within the reserve");
    as_(&dao(), near(0));
    k.set_agent_share(1000);
    assert_eq!(k.get_agent_member().standing_bps, 10_000);
    as_(&usdc(), near(0));
    let _ = k.ft_on_transfer(dao(), U128(4_000_000), "share".into());
    assert!(logs_have("agent_share"));
    assert_eq!(k.get_risk_fund().0 .0, 400_000);
    meeting::strike(1);
    assert_eq!(k.get_agent_member().standing_bps, 5_000, "one strike halves it");
    as_(&usdc(), near(0));
    let _ = k.ft_on_transfer(dao(), U128(4_000_000), "share".into());
    assert_eq!(k.get_risk_fund().0 .0, 600_000);
    meeting::strike(2);
    meeting::strike(3);
    assert_eq!(k.get_agent_member().standing_bps, 0, "suspended: nothing");
    assert_eq!(k.get_agent_member().shu_total.0, 600_000);
}

/// 0.3.3: a federation's resolution binds the code: only its DAO sets the ceiling, loans above it are refused.
#[test]
fn the_federations_loan_ceiling_binds_the_members_loan_rule() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    let fed = acc("kop-federation.sputnik-v2.testnet");
    let rule = |bps: u16, days: u32| lending::LoanRule { max_loan: U128(near(1).as_yoctonear()), rate_bps: bps, term_days: days };
    assert!(fails(|| { as_(&fed, near(0)); k.set_federation_rules(200, 30); }), "no federation named yet");
    as_(&dao(), near(0));
    k.set_federation(Some(fed.clone()));
    assert!(fails(|| { as_(&dao(), near(0)); k.set_federation_rules(200, 30); }), "the co-op cannot set its own ceiling");
    as_(&fed, near(0));
    k.set_federation_rules(200, 30);
    assert!(logs_have("federation_rules_set"));
    assert!(fails(|| { as_(&dao(), near(0)); k.set_loan_rule(rule(300, 30), U128(0)); }), "rate above the ceiling");
    assert!(fails(|| { as_(&dao(), near(0)); k.set_loan_rule(rule(200, 60), U128(0)); }), "term above the ceiling");
    as_(&dao(), near(0));
    k.set_loan_rule(rule(200, 30), U128(near(2).as_yoctonear()));
    // the federation lowers it: the old rule lends nothing until the members lower theirs
    as_(&fed, near(0));
    k.set_federation_rules(100, 30);
    let bob = acc("bob.testnet");
    at_paying(&acc("alice.testnet"), DAY, commons::PLEDGE_FEE);
    k.guarantee(bob.clone());
    commons::mark(&bob, |s| s.pledges_honored += 8);
    assert!(fails(|| { at(&bob, DAY); let _ = k.request_loan(U128(near(1).as_yoctonear() / 10)); }), "rule above the new ceiling");
    // leaving the federation is the members' vote
    as_(&dao(), near(0));
    k.set_federation(None);
    at(&bob, DAY);
    let _ = k.request_loan(U128(near(1).as_yoctonear() / 10));
}

/// 0.3.3: a late loan is told to the sister co-ops; there the borrower's credit is 0 until it is repaid here.
#[test]
fn a_late_loan_is_told_to_the_sister_coops_and_lifted_when_repaid() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    let (alice, bob) = (acc("alice.testnet"), acc("bob.testnet"));
    let sister = acc("koperasi-sister.testnet");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone()]);
    // received from a sister
    assert!(fails(|| { as_(&acc("koperasi-fake.testnet"), near(0)); k.note_late_elsewhere(bob.clone(), true); }), "only a sister");
    commons::mark(&bob, |s| s.pledges_honored += 5);
    as_(&sister, near(0));
    k.note_late_elsewhere(bob.clone(), true);
    assert!(logs_have("late_elsewhere"));
    assert_eq!(k.get_credit(bob.clone()).0, 0);
    as_(&dao(), near(0));
    k.set_loan_rule(lending::LoanRule { max_loan: U128(near(1).as_yoctonear()), rate_bps: 200, term_days: 1 }, U128(near(2).as_yoctonear()));
    at_paying(&alice, DAY, commons::PLEDGE_FEE);
    k.guarantee(bob.clone());
    assert!(fails(|| { at(&bob, DAY); let _ = k.request_loan(U128(1)); }), "late at a sister");
    assert!(fails(|| { as_(&acc("koperasi-other.testnet"), near(0)); k.note_late_elsewhere(bob.clone(), false); }));
    // a second sister notes it too; the first lifting its note does not lift the second's
    let sister2 = acc("koperasi-sister2.testnet");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone(), sister2.clone()]);
    as_(&sister2, near(0));
    k.note_late_elsewhere(bob.clone(), true);
    as_(&sister, near(0));
    k.note_late_elsewhere(bob.clone(), false);
    assert_eq!(k.get_credit(bob.clone()).0, 0, "still late at the second");
    as_(&sister2, near(0));
    k.note_late_elsewhere(bob.clone(), false);
    assert_eq!(k.get_credit(bob.clone()).0, 7, "5 pledges and alice");
    // sent: alice borrows here, is called late; every sister is told, and told again when she repays
    commons::mark(&alice, |s| s.pledges_honored += 5);
    at_paying(&bob, DAY, commons::PLEDGE_FEE);
    k.guarantee(alice.clone());
    at(&alice, DAY);
    let _ = k.request_loan(U128(near(1).as_yoctonear() / 10));
    at(&me(), DAY);
    let _ = k.on_loan_filed(alice.clone(), Value::Null, Ok(5));
    at(&acc("anyone.testnet"), 10 * DAY);
    k.call_loan_late(alice.clone());
    let told = |late: bool| near_sdk::test_utils::get_created_receipts().iter().filter(|r| r.receiver_id == sister)
        .flat_map(|r| r.actions.clone()).any(|a| matches!(a, near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. }
            if method_name == b"note_late_elsewhere" && near_sdk::serde_json::from_slice::<Value>(&args).unwrap()["late"] == late));
    assert!(told(true), "the sister is told");
    at_paying(&alice, 11 * DAY, NearToken::from_millinear(102));
    k.repay_loan();
    assert!(told(false), "and told again when it is repaid");
}

/// 0.3.3: work stamped from a sister co-op counts toward credit here.
#[test]
fn credit_counts_work_stamped_from_a_sister_coop() {
    let mut k = setup();
    with_members(&mut k, &["frank.testnet"]);
    let (sister, frank) = (acc("koperasi-sister.testnet"), acc("frank.testnet"));
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone()]);
    assert_eq!(k.get_credit(frank.clone()).0, 0);
    as_(&me(), near(0));
    let token = near_sdk::serde_json::json!({ "owner_id": "frank.testnet", "metadata": {
        "extra": near_sdk::serde_json::json!({ "done": 4, "earned": "5", "good_standing": true }).to_string() } });
    assert!(k.on_token_read(frank.clone(), sister.clone(), acc("anyone.testnet"), Ok(Some(token))));
    assert_eq!(k.get_credit(frank.clone()).0, 4);
    at(&frank, 31 * DAY);
    assert_eq!(k.get_credit(frank.clone()).0, 0, "a stamp older than 30 days stops counting until it is read again");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![]);
    assert_eq!(k.get_credit(frank.clone()).0, 0, "a co-op the members dropped stops counting");
}

/// 0.3.3: the reputation dividend's weight is new work since the last dividend plus half the last weight (no cap).
#[test]
fn reputation_weights_decay_and_never_saturate() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    let (alice, bob) = (acc("alice.testnet"), acc("bob.testnet"));
    as_(&dao(), near(0));
    k.set_reputation_share(1000);
    commons::mark(&alice, |s| s.pledges_honored += 30); // past the old cap of 10
    commons::mark(&bob, |s| s.pledges_honored += 10);
    let w = |k: &Koperasi, a: &AccountId| k.get_reputation_weights().iter().find(|(x, _)| x == a).map_or(0, |(_, w)| w.0);
    assert_eq!((w(&k, &alice), w(&k, &bob)), (3000, 1000), "x100, no court record: factor 1");
    as_(&usdc(), near(0));
    let _ = k.ft_on_transfer(dao(), U128(4_000_000), "share".into());
    assert_eq!(k.get_claimable(alice.clone()).0, 300_000, "3:1 of 0.4 USDC");
    // then bob works more: new work counts in full, old weight halves
    commons::mark(&bob, |s| s.pledges_honored += 20);
    assert_eq!((w(&k, &alice), w(&k, &bob)), (1500, 2500));
}

/// 0.3.3: the members set how often the agent may propose.
#[test]
fn the_members_set_how_often_the_agent_proposes() {
    let mut k = setup();
    assert_eq!(k.get_agent_propose_every(), 7);
    as_(&dao(), near(0));
    k.set_agent_propose_every(1);
    at(&agent(), DAY);
    let _ = k.agent_propose_bylaws(2, H2.into(), "u".into(), "r".into(), None);
    assert!(fails(|| { at(&agent(), DAY + DAY / 2); let _ = k.agent_propose_bylaws(2, H2.into(), "u".into(), "r".into(), None); }));
    at(&agent(), 2 * DAY);
    let _ = k.agent_propose_bylaws(2, H2.into(), "u".into(), "r".into(), None);
    assert!(fails(|| { as_(&dao(), near(0)); k.set_agent_propose_every(31); }));
}

/// 0.3.4: an agent the members mark TEE-only records receipts only while the registry they named says it is attested.
#[test]
fn a_tee_only_agent_records_only_while_attested() {
    let mut k = setup();
    let worker = acc("7f9c2ba4e88f827d616045507605853ed73b8093f6efbc88eb1d6eacbf7f0b0a");
    let registry = acc("kop-tee.testnet");
    as_(&dao(), near(0));
    k.set_agents(vec![lending::AgentSkill { account: worker.clone(), tags: vec!["translation".into()] }]);
    as_(&dao(), near(0));
    k.set_agent_tee(worker.clone(), true);
    let rec = |k: &mut Koperasi, id: &str| k.record_receipt(id.into(), U128(1), U128(0), H1.into(), "00".into(), None);
    assert!(fails(|| { at(&worker, DAY); rec(&mut k, "t-1"); }), "not attested yet");
    assert!(fails(|| { as_(&registry, near(0)); k.note_attested(worker.clone(), U64(10 * DAY), "ab".into()); }), "no registry named");
    as_(&dao(), near(0));
    k.set_tee_registry(Some(registry.clone()));
    assert!(fails(|| { as_(&acc("mallory.testnet"), near(0)); k.note_attested(worker.clone(), U64(10 * DAY), "ab".into()); }), "only the registry");
    as_(&registry, near(0));
    k.note_attested(worker.clone(), U64(10 * DAY), "ab".into());
    assert!(logs_have("agent_attested"));
    at(&worker, DAY);
    rec(&mut k, "t-1");
    as_(&dao(), near(0));
    k.revoke_attestation(worker.clone());
    assert!(fails(|| { at(&worker, 2 * DAY); rec(&mut k, "t-2"); }), "revoked by the members");
    assert!(fails(|| { as_(&registry, near(0)); k.note_attested(worker.clone(), U64(10 * DAY), "ab".into()); }), "no way back by registering again");
    as_(&dao(), near(0));
    k.set_agent_tee(worker.clone(), true); // the members let it back in
    as_(&registry, near(0));
    k.note_attested(worker.clone(), U64(10 * DAY), "ab".into());
    assert!(fails(|| { at(&worker, 11 * DAY); rec(&mut k, "t-2"); }), "the attestation expired");
    // an agent not marked TEE-only is unaffected; unmarking lifts the rule
    at(&agent(), 11 * DAY);
    rec(&mut k, "t-3");
    as_(&dao(), near(0));
    k.set_agent_tee(worker.clone(), false);
    at(&worker, 11 * DAY);
    rec(&mut k, "t-4");
}

/// 0.3.4: the reputation weight is multiplied by how a member's judgments held up in court.
#[test]
fn reputation_weighs_how_judgments_held_up_in_court() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet"]);
    let (alice, bob) = (acc("alice.testnet"), acc("bob.testnet"));
    commons::mark(&alice, |s| s.pledges_honored += 10);
    commons::mark(&bob, |s| s.pledges_honored += 10);
    let w = |k: &Koperasi, a: &AccountId| k.get_reputation_weights().iter().find(|(x, _)| x == a).map_or(0, |(_, w)| w.0);
    assert_eq!(w(&k, &alice), w(&k, &bob));
    // a case alice brought is upheld, with bob on the jury against the outcome
    let case = commons::Case { id: 0, job_id: "j".into(), claimant: alice.clone(), refund_to: acc("buyer.testnet"), amount: U128(1),
        reason: "r".into(), jurors: vec![bob.clone()], votes: vec![(bob.clone(), false)], opened: U64(0), status: commons::CaseStatus::Upheld,
        refund_proposal: None };
    commons::put_case(&case);
    // alice: 1 good of 1 -> 3/2; bob: 1 bad of 1 -> 2/3
    assert_eq!((w(&k, &alice), w(&k, &bob)), (1500, 666));
}

/// 0.3.5: counters for the reputation factor, kept as tasks are handed back, vetoed and paid.
#[test]
fn task_quality_counts_hand_backs_vetoes_and_paid_tasks() {
    let mut k = trusted_with_veto(); // carol: task #0 paid
    let carol = acc("carol.testnet");
    assert_eq!(k.get_task_quality(carol.clone()), solidarity::TaskQuality { paid: 1, handed_back: 0, vetoed: 0 });
    // carol takes a task and hands it back
    as_(&acc("alice.testnet"), TASK_FEE);
    let id = k.post_task("fix the minutes".into(), U128(10 * MILLI));
    as_(&carol, near(0));
    k.claim_task(id);
    k.give_up_task(id);
    // a payout of hers on trust, vetoed by alice
    let (id, _) = deliver_by(&mut k, "bob.testnet", "carol.testnet", 80 * MILLI);
    as_(&acc("alice.testnet"), near(0));
    k.veto_task(id);
    assert_eq!(k.get_task_quality(carol.clone()).vetoed, 0, "a veto counts only if the payout is then cancelled");
    as_(&dao(), near(0));
    k.cancel_task(id);
    assert_eq!(k.get_task_quality(carol.clone()), solidarity::TaskQuality { paid: 1, handed_back: 1, vetoed: 1 });
    assert_eq!(k.get_task_quality(acc("alice.testnet")), solidarity::TaskQuality::default(), "the vetoer is not counted");
    // as a member, her weight: 1 task done, good 1, bad 2 -> x (1+2)/(2+2)
    with_members(&mut k, &["carol.testnet"]);
    let w = k.get_reputation_weights().iter().find(|(x, _)| *x == carol).map_or(0, |(_, w)| w.0);
    assert_eq!(w, 100 * 3 / 4);
}

/// 0.3.5: the factor (good + 2) / (bad + 2) counts task quality with the court record.
#[test]
fn reputation_weighs_task_quality() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    let (alice, bob) = (acc("alice.testnet"), acc("bob.testnet"));
    commons::mark(&alice, |s| s.pledges_honored += 10);
    commons::mark(&bob, |s| s.pledges_honored += 10);
    solidarity::note_task(&alice, |q| q.paid += 2); // 4/2
    solidarity::note_task(&bob, |q| { q.handed_back += 1; q.vetoed += 1 }); // 2/4
    let w = |k: &Koperasi, a: &AccountId| k.get_reputation_weights().iter().find(|(x, _)| x == a).map_or(0, |(_, w)| w.0);
    assert_eq!((w(&k, &alice), w(&k, &bob)), (2000, 500));
    // with the court record: a case bob brought, upheld -> bob good 1, bad 2: 3/4
    commons::put_case(&commons::Case { id: 0, job_id: "j".into(), claimant: bob.clone(), refund_to: acc("buyer.testnet"), amount: U128(1),
        reason: "r".into(), jurors: vec![], votes: vec![], opened: U64(0), status: commons::CaseStatus::Upheld, refund_proposal: None });
    assert_eq!(w(&k, &bob), 750);
}

/// 0.3.5: the agent passes a job to a sister co-op; anyone may submit its signature, once.
#[test]
fn the_agent_refers_jobs_to_sister_coops() {
    use ed25519_dalek::{Signer, SigningKey};
    let mut k = setup();
    let sister = acc("kop-two.testnet");
    let relayer = acc("relayer.testnet");
    let refer = |k: &mut Koperasi, coop: &AccountId, sig: Option<String>| k.post_referral("j-77".into(), coop.clone(), U128(5_000_000), "needs Javanese".into(), sig);
    assert!(fails(|| { at(&agent(), DAY); refer(&mut k, &sister, None); }), "not a sister yet");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone()]);
    assert!(fails(|| { at(&agent(), DAY); refer(&mut k, &acc("stranger-coop.testnet"), None); }), "only a sister co-op");
    assert!(fails(|| { at(&agent(), DAY); let _ = k.post_referral("j 1".into(), sister.clone(), U128(1), "r".into(), None); }), "a job_id without spaces");
    assert!(fails(|| { at(&relayer, DAY); refer(&mut k, &sister, None); }), "not the agent");
    at(&agent(), DAY);
    assert_eq!(refer(&mut k, &sister, None), 0);
    assert!(logs_have("job_referred"));
    // the signed path: the agent's key is kept when it signs a receipt
    let sk = SigningKey::from_bytes(&[7; 32]);
    let pk: Vec<u8> = [vec![0u8], sk.verifying_key().to_bytes().to_vec()].concat();
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(agent()).signer_account_id(agent())
        .signer_account_pk(pk.try_into().unwrap()).block_timestamp(DAY);
    testing_env!(b.build());
    k.record_receipt("j-pk".into(), U128(1), U128(0), H1.into(), "00".into(), None);
    let msg = k.get_referral_message("j-77".into(), sister.clone(), U128(5_000_000), "needs Javanese".into());
    assert_eq!(msg, solidarity::referral_message(&me(), 1, "j-77", &sister, 5_000_000, "needs Javanese"), "nonce 1: the direct post used 0");
    let sign = |m: &str| near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, sk.sign(m.as_bytes()).to_bytes());
    assert!(fails(|| { at(&relayer, DAY); let _ = k.post_referral("j-77".into(), sister.clone(), U128(9_000_000), "needs Javanese".into(), Some(sign(&msg))); }), "the budget is signed");
    at(&relayer, DAY);
    assert_eq!(refer(&mut k, &sister, Some(sign(&msg))), 1);
    assert!(fails(|| { at(&relayer, DAY); refer(&mut k, &sister, Some(sign(&msg))); }), "replayed");
    let r = k.get_referrals(None, None);
    assert_eq!((r.len(), r[1].job_id.as_str(), r[1].budget_usdc.0), (2, "j-77", 5_000_000));
    // bounded: only the last 200 are kept
    for _ in 0..199 {
        at(&agent(), DAY);
        refer(&mut k, &sister, None);
    }
    let r = k.get_referrals(None, Some(500));
    assert_eq!((r.len(), r[0].id, r[199].id), (200, 1, 200));
    assert_eq!(k.get_referrals(Some(150), Some(10)).len(), 10);
    // paused: refused
    as_(&dao(), near(0));
    k.pause();
    assert!(fails(|| { at(&agent(), DAY); refer(&mut k, &sister, None); }), "paused");
}

// ---------- 0.3.6 part A ----------

fn ref_board(id: u32, job: &str, to: &AccountId) -> Vec<solidarity::Referral> {
    vec![solidarity::Referral { id, job_id: job.into(), to_coop: to.clone(), budget_usdc: U128(5_000_000), reason: "r".into(), at: U64(DAY) }]
}

/// 0.3.6: the agent accepts a sister co-op's referral, read from the sister's own board; once; bounded; linked to the receipt.
#[test]
fn the_agent_accepts_a_sister_coops_referral_read_from_its_board() {
    use ed25519_dalek::{Signer, SigningKey};
    let mut k = setup();
    let sister = acc("kop-two.testnet");
    let relayer = acc("relayer.testnet");
    assert!(fails(|| { at(&agent(), DAY); let _ = k.accept_referral(sister.clone(), 0, None); }), "not a sister yet");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone()]);
    assert!(fails(|| { at(&relayer, DAY); let _ = k.accept_referral(sister.clone(), 0, None); }), "not the agent");
    at(&agent(), DAY);
    let _ = k.accept_referral(sister.clone(), 0, None);
    assert_eq!(k.get_accept_message(sister.clone(), 0), referrals::accept_message(&me(), 1, &sister, 0), "the direct call used nonce 0");
    // the callback: only the contract itself, and only what the sister's board holds for this co-op
    assert!(fails(|| { at(&me(), DAY); k.on_referral_read(sister.clone(), 0, Err(PromiseError::Failed)); }), "board unreadable");
    assert!(fails(|| { at(&me(), DAY); k.on_referral_read(sister.clone(), 0, Ok(vec![])); }), "no such referral");
    assert!(fails(|| { at(&me(), DAY); k.on_referral_read(sister.clone(), 0, Ok(ref_board(3, "j-1", &me()))); }), "the board's oldest, not this id");
    assert!(fails(|| { at(&me(), DAY); k.on_referral_read(sister.clone(), 0, Ok(ref_board(0, "j-1", &acc("kop-three.testnet")))); }), "for another co-op");
    assert!(fails(|| { at(&me(), DAY); k.on_referral_read(sister.clone(), 0, Ok(ref_board(0, &"x".repeat(129), &me()))); }), "bad job_id");
    at(&me(), DAY);
    assert_eq!(k.on_referral_read(sister.clone(), 0, Ok(ref_board(0, "j-1", &me()))), 0);
    assert!(logs_have("referral_accepted") && logs_have("\"from_coop\":\"kop-two.testnet\""));
    let a = k.get_referral_for_job("j-1".into()).unwrap();
    assert_eq!((a.from_coop.clone(), a.referral_id, a.budget_usdc.0), (sister.clone(), 0, 5_000_000));
    // refused twice: the same referral (at the call and in the callback), or the same job from another referral
    assert!(fails(|| { at(&agent(), DAY); let _ = k.accept_referral(sister.clone(), 0, None); }), "already accepted");
    assert!(fails(|| { at(&me(), DAY); k.on_referral_read(sister.clone(), 0, Ok(ref_board(0, "j-1", &me()))); }), "already accepted (callback)");
    assert!(fails(|| { at(&me(), DAY); k.on_referral_read(sister.clone(), 1, Ok(ref_board(1, "j-1", &me()))); }), "the same job twice");
    // a receipt for that job shows where it came from
    assert!(k.get_receipt_with_referral("j-1".into()).is_none(), "no receipt yet");
    receipt(&mut k, "j-1", 5_000_000, H1);
    let (r, link) = k.get_receipt_with_referral("j-1".into()).unwrap();
    assert_eq!((r.job_id.as_str(), link.unwrap().referral_id), ("j-1", 0));
    receipt(&mut k, "j-own", 1, H1);
    assert!(k.get_receipt_with_referral("j-own".into()).unwrap().1.is_none(), "its own job: no referral");
    // the signed path, once
    let sk = SigningKey::from_bytes(&[7; 32]);
    let pk: Vec<u8> = [vec![0u8], sk.verifying_key().to_bytes().to_vec()].concat();
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(agent()).signer_account_id(agent())
        .signer_account_pk(pk.try_into().unwrap()).block_timestamp(DAY);
    testing_env!(b.build());
    k.record_receipt("j-pk".into(), U128(1), U128(0), H1.into(), "00".into(), None);
    let sign = |m: &str| near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, sk.sign(m.as_bytes()).to_bytes());
    let msg = k.get_accept_message(sister.clone(), 1);
    assert!(fails(|| { at(&relayer, DAY); let _ = k.accept_referral(sister.clone(), 2, Some(sign(&msg))); }), "the id is signed");
    at(&relayer, DAY);
    let _ = k.accept_referral(sister.clone(), 1, Some(sign(&msg)));
    assert!(fails(|| { at(&relayer, DAY); let _ = k.accept_referral(sister.clone(), 1, Some(sign(&msg))); }), "replayed");
    // suspended or paused: refused
    meeting::strike(1);
    meeting::strike(2);
    meeting::strike(3);
    assert!(fails(|| { at(&agent(), DAY); let _ = k.accept_referral(sister.clone(), 5, None); }), "suspended");
    at(&dao(), DAY);
    k.reinstate_agent();
    as_(&dao(), near(0));
    k.pause();
    assert!(fails(|| { at(&agent(), DAY); let _ = k.accept_referral(sister.clone(), 5, None); }), "paused");
    assert!(fails(|| { at(&me(), DAY); k.on_referral_read(sister.clone(), 5, Ok(ref_board(5, "j-5", &me()))); }), "paused (callback)");
    as_(&dao(), near(0));
    k.unpause();
    // bounded: the last 200 kept, the oldest's links go with it
    for i in 1..=200u32 {
        at(&me(), DAY);
        k.on_referral_read(sister.clone(), i, Ok(ref_board(i, &format!("j-b{i}"), &me())));
    }
    let all = k.get_accepted_referrals(None, Some(500));
    assert_eq!((all.len(), all[0].id, all[199].id), (200, 1, 200));
    assert!(k.get_referral_for_job("j-1".into()).is_none(), "the oldest left, with its job link");
    assert!(k.get_referral_for_job("j-b200".into()).is_some());
    assert_eq!(k.get_accepted_referrals(Some(150), Some(10)).len(), 10);
}

/// 0.3.6: a suspended agent files a recovery plan; the members approve it; its standing ramps from 25% back.
#[test]
fn an_approved_recovery_plan_reinstates_the_agent_and_its_standing_ramps_back() {
    let mut k = setup();
    let h = "ab".repeat(32);
    assert!(fails(|| { at(&agent(), DAY); k.propose_recovery("ipfs://plan".into(), h.clone()); }), "not suspended");
    assert!(fails(|| { at(&dao(), DAY); k.approve_recovery(h.clone()); }), "no plan on file");
    at(&agent(), DAY);
    meeting::strike(1);
    meeting::strike(2);
    meeting::strike(3);
    assert_eq!(k.get_agent_member().standing_bps, 0);
    assert!(fails(|| { at(&acc("alice.testnet"), DAY); k.propose_recovery("ipfs://plan".into(), h.clone()); }), "only the agent or steward");
    assert!(fails(|| { at(&agent(), DAY); k.propose_recovery("ipfs://plan".into(), "AB".repeat(32)); }), "lowercase hex");
    assert!(fails(|| { at(&agent(), DAY); k.propose_recovery("ipfs://a plan".into(), h.clone()); }), "uri without spaces");
    as_(&dao(), near(0));
    k.pause();
    assert!(fails(|| { at(&agent(), DAY); k.propose_recovery("ipfs://plan".into(), h.clone()); }), "paused");
    as_(&dao(), near(0));
    k.unpause();
    // the steward files for the agent (its key may only record receipts); a later filing replaces one not yet approved
    as_(&dao(), near(0));
    k.set_steward(Some(steward()));
    at(&steward(), DAY);
    k.propose_recovery("ipfs://plan-1".into(), "cd".repeat(32));
    at(&agent(), DAY);
    k.propose_recovery("ipfs://plan".into(), h.clone());
    assert!(logs_have("recovery_proposed"));
    assert_eq!(k.get_recovery().0.unwrap().proposed_by, agent());
    assert!(fails(|| { at(&acc("alice.testnet"), 2 * DAY); k.approve_recovery(h.clone()); }), "only the DAO");
    assert!(fails(|| { at(&dao(), 2 * DAY); k.approve_recovery("cd".repeat(32)); }), "a vote on another plan");
    assert!(fails(|| { at(&acc("alice.testnet"), DAY); k.set_recovery_days(10); }), "only the DAO");
    assert!(fails(|| { at(&dao(), DAY); k.set_recovery_days(366); }), "at most a year");
    assert_eq!(k.get_recovery_days(), 30);
    at(&dao(), 2 * DAY);
    k.approve_recovery(h.clone());
    assert!(logs_have("recovery_approved") && logs_have("agent_reinstated"));
    assert!(fails(|| { at(&dao(), 2 * DAY); k.approve_recovery(h.clone()); }), "once");
    assert!(!k.get_agent_standing().suspended);
    receipt(&mut k, "j-back", 1, H1); // it works again
    // the ramp: 25% at once, halfway at 15 days, all of it at 30
    at(&agent(), 2 * DAY);
    assert_eq!(k.get_agent_member().standing_bps, 2_500);
    at(&agent(), 17 * DAY);
    assert_eq!(k.get_agent_member().standing_bps, 6_250);
    assert_eq!(k.get_recovery().1, 6_250);
    meeting::strike(4); // a strike during the ramp halves the ramped value
    assert_eq!(k.get_agent_member().standing_bps, 3_125);
    // the share paid uses it
    with_members(&mut k, &["alice.testnet"]);
    as_(&dao(), near(0));
    k.set_agent_share(1000);
    let mut c = VMContextBuilder::new();
    c.current_account_id(me()).predecessor_account_id(usdc()).block_timestamp(17 * DAY);
    testing_env!(c.build());
    let _ = k.ft_on_transfer(dao(), U128(4_000_000), "share".into());
    assert_eq!(k.get_agent_member().shu_total.0, 400_000 * 3_125 / 10_000);
    at(&agent(), 32 * DAY);
    assert_eq!(k.get_agent_member().standing_bps, 5_000, "ramp done: the strike-scaled value");
}

/// 0.3.6: a new suspension during the ramp cancels it; the old reinstatement still works without a plan.
#[test]
fn a_suspension_during_the_ramp_cancels_it_and_plain_reinstatement_still_works() {
    let mut k = setup();
    let h = "ab".repeat(32);
    at(&dao(), DAY);
    k.set_recovery_days(10);
    at(&agent(), DAY / 2); // the vote comes later than the strikes
    for c in 1..=3 { meeting::strike(c); }
    k.propose_recovery("ipfs://plan".into(), h.clone());
    at(&dao(), DAY);
    k.approve_recovery(h.clone());
    assert_eq!(k.get_recovery().0.unwrap().ramp_days, 10);
    at(&dao(), 3 * DAY);
    k.set_recovery_days(60); // a running ramp keeps the length it was approved with
    at(&agent(), 3 * DAY);
    assert_eq!(k.get_agent_member().standing_bps, 2_500 + 7_500 * 2 / 10);
    for c in 4..=6 { meeting::strike(c); }
    assert!(k.get_agent_standing().suspended);
    assert!(k.get_recovery().0.unwrap().cancelled_at.is_some(), "cancelled");
    assert_eq!(k.get_recovery().1, 10_000);
    // the members reinstate outright: full standing, no ramp
    at(&dao(), 4 * DAY);
    k.reinstate_agent();
    at(&agent(), 4 * DAY);
    assert_eq!(k.get_agent_member().standing_bps, 10_000);
    // days 0: an approved plan restores at once
    at(&agent(), 5 * DAY);
    for c in 7..=9 { meeting::strike(c); }
    at(&dao(), 5 * DAY);
    k.set_recovery_days(0);
    at(&agent(), 5 * DAY);
    k.propose_recovery("ipfs://plan-2".into(), h.clone());
    at(&dao(), 6 * DAY);
    k.approve_recovery(h.clone());
    assert_eq!(k.get_agent_member().standing_bps, 10_000);
    assert!(fails(|| { at(&dao(), 6 * DAY); k.approve_recovery(h.clone()); }), "already approved");
}

// ---------- 0.3.6 part B: polls ----------

const HOUR: u64 = 3_600_000_000_000;

fn open_p(k: &mut Koperasi, who: &str, kind: polls::PollKind, ns: u64) -> u32 {
    at_paying(&acc(who), ns, NearToken::from_millinear(10));
    k.open_poll("Which embedding model?".into(), vec!["a".into(), "b".into()], kind, 24, None)
}

fn vote(k: &mut Koperasi, who: &str, id: u32, option: u32, ns: u64) -> u128 {
    at(&acc(who), ns);
    k.vote_poll(id, option).0
}

/// A general poll: one member, one vote; every refusal on opening, voting and closing.
#[test]
fn a_general_poll_counts_one_member_one_vote_and_refuses_what_it_should() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet", "carol.testnet"]);
    use polls::PollKind::General;
    let try_open = |k: &mut Koperasi, who: &str, fee: u128, q: String, opts: Vec<String>, hours: u32| {
        at_paying(&acc(who), DAY, NearToken::from_millinear(fee));
        k.open_poll(q, opts, General, hours, None)
    };
    let two = || vec!["yes".to_string(), "no".to_string()];
    assert!(fails(|| { try_open(&mut k, "mallory.testnet", 10, "q".into(), two(), 24); }), "only a member");
    assert!(fails(|| { try_open(&mut k, "alice.testnet", 9, "q".into(), two(), 24); }), "attach the fee");
    assert!(fails(|| { try_open(&mut k, "alice.testnet", 10, " ".into(), two(), 24); }), "empty question");
    assert!(fails(|| { try_open(&mut k, "alice.testnet", 10, "x".repeat(281), two(), 24); }), "question too long");
    assert!(fails(|| { try_open(&mut k, "alice.testnet", 10, "q".into(), vec!["only".into()], 24); }), "one option");
    assert!(fails(|| { try_open(&mut k, "alice.testnet", 10, "q".into(), (0..9).map(|i| i.to_string()).collect(), 24); }), "nine options");
    assert!(fails(|| { try_open(&mut k, "alice.testnet", 10, "q".into(), vec!["a".into(), "".into()], 24); }), "empty option");
    assert!(fails(|| { try_open(&mut k, "alice.testnet", 10, "q".into(), vec!["a".into(), "b".repeat(81)], 24); }), "option too long");
    assert!(fails(|| { try_open(&mut k, "alice.testnet", 10, "q".into(), two(), 0); }), "0 hours");
    assert!(fails(|| { try_open(&mut k, "alice.testnet", 10, "q".into(), two(), 721); }), "over 30 days");
    assert_eq!(k.get_polls(None, None).len(), 0, "nothing was kept by a refused poll");

    let id = try_open(&mut k, "alice.testnet", 10, "Hold the annual meeting online?".into(), (0..8).map(|i| format!("o{i}")).collect(), 24);
    assert_eq!(id, 0);
    assert!(logs_have("\"poll_opened\"") && logs_have("\"mode\":\"one_member\""));
    assert_eq!(vote(&mut k, "alice.testnet", id, 1, DAY + 1), 1);
    assert!(logs_have("\"poll_voted\""));
    assert!(fails(|| { vote(&mut k, "alice.testnet", id, 2, DAY + 2); }), "once each");
    assert!(fails(|| { vote(&mut k, "mallory.testnet", id, 1, DAY + 2); }), "only a member");
    assert!(fails(|| { vote(&mut k, "bob.testnet", id, 8, DAY + 2); }), "no such option");
    assert!(fails(|| { vote(&mut k, "bob.testnet", 7, 0, DAY + 2); }), "no such poll");
    vote(&mut k, "bob.testnet", id, 1, DAY + 2);
    vote(&mut k, "carol.testnet", id, 3, DAY + 3);
    assert!(fails(|| { at(&acc("anyone.testnet"), DAY + 23 * HOUR); k.close_poll(id); }), "still open");
    assert!(fails(|| { vote(&mut k, "carol.testnet", id, 1, DAY + 24 * HOUR); }), "closed at the deadline");
    at(&acc("anyone.testnet"), DAY + 24 * HOUR);
    assert_eq!(k.close_poll(id), Some(1));
    assert!(logs_have("\"poll_closed\"") && logs_have("\"result\":1"));
    let p = k.get_poll(id).unwrap();
    assert!(p.closed);
    assert_eq!((p.tallies[1].0, p.tallies[3].0, p.voters.len()), (2, 1, 3));
    assert!(fails(|| { at(&acc("anyone.testnet"), DAY + 25 * HOUR); k.close_poll(id); }), "closed once");
    // a tie for first, or no votes: no result
    let tie = open_p(&mut k, "bob.testnet", General, 2 * DAY);
    vote(&mut k, "alice.testnet", tie, 0, 2 * DAY + 1);
    vote(&mut k, "bob.testnet", tie, 1, 2 * DAY + 1);
    let empty = open_p(&mut k, "bob.testnet", General, 2 * DAY);
    at(&acc("anyone.testnet"), 3 * DAY);
    assert_eq!(k.close_poll(tie), None);
    assert_eq!(k.close_poll(empty), None);
}

/// A technical poll weighs votes by reputation only when the members voted that mode; general polls never do; the mode
/// is fixed when a poll opens.
#[test]
fn a_technical_poll_is_weighed_by_reputation_only_if_the_by_laws_say_so() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet", "carol.testnet"]);
    use polls::PollKind::{General, Technical};
    commons::mark(&acc("alice.testnet"), |s| s.pledges_honored += 30); // weight 3000
    commons::mark(&acc("bob.testnet"), |s| s.pledges_honored += 10); // weight 1000; carol 0
    assert_eq!(k.get_technical_vote_mode(), "one_member");
    assert!(fails(|| { as_(&acc("alice.testnet"), near(0)); k.set_technical_vote("reputation".into()); }), "only the DAO");
    assert!(fails(|| { as_(&dao(), near(0)); k.set_technical_vote("plutocracy".into()); }), "bad mode");
    // default: a technical poll is one member, one vote
    let before = open_p(&mut k, "alice.testnet", Technical, DAY);
    as_(&dao(), near(0));
    k.set_technical_vote("reputation".into());
    assert!(logs_have("\"technical_vote_set\""));
    assert_eq!(k.get_technical_vote_mode(), "reputation");
    let tech = open_p(&mut k, "alice.testnet", Technical, DAY);
    let gen = open_p(&mut k, "alice.testnet", General, DAY);
    assert_eq!(k.get_poll(tech).unwrap().mode, "reputation");
    assert_eq!(k.get_poll(gen).unwrap().mode, "one_member");
    assert_eq!(k.get_poll(before).unwrap().mode, "one_member", "the mode is fixed at opening");
    for id in [before, tech, gen] {
        let w = vote(&mut k, "alice.testnet", id, 0, DAY + 1);
        assert_eq!(w, if id == tech { 3000 } else { 1 });
        vote(&mut k, "bob.testnet", id, 1, DAY + 1);
        vote(&mut k, "carol.testnet", id, 1, DAY + 1);
    }
    at(&acc("anyone.testnet"), 2 * DAY);
    assert_eq!(k.close_poll(tech), Some(0), "3000 against 1000 + 0");
    assert!(logs_have("\"mode\":\"reputation\""));
    assert_eq!(k.close_poll(gen), Some(1), "1 against 2");
    assert_eq!(k.close_poll(before), Some(1));
    assert_eq!(k.get_poll(tech).unwrap().tallies.iter().map(|t| t.0).collect::<Vec<_>>(), vec![3000, 1000]);
    // and back to one member, one vote
    as_(&dao(), near(0));
    k.set_technical_vote("one_member".into());
    let id = open_p(&mut k, "bob.testnet", Technical, 3 * DAY);
    assert_eq!(k.get_poll(id).unwrap().mode, "one_member");
}

/// Only the last 100 polls are kept; a dropped poll can no longer be voted or closed.
#[test]
fn only_the_last_100_polls_are_kept() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    for _ in 0..100 {
        open_p(&mut k, "alice.testnet", polls::PollKind::General, DAY);
    }
    // the 101st would drop poll #0 while it is still open (24 h): refused
    assert!(fails(|| { open_p(&mut k, "alice.testnet", polls::PollKind::General, DAY + 3_600_000_000_000); }), "an open poll is never dropped");
    open_p(&mut k, "alice.testnet", polls::PollKind::General, 2 * DAY + 1);
    assert!(k.get_poll(0).is_none() && k.get_poll(100).is_some());
    let all = k.get_polls(None, Some(500));
    assert_eq!((all.len(), all[0].id, all[99].id), (100, 1, 100));
    assert_eq!(k.get_polls(None, None).len(), 20);
    assert_eq!(k.get_polls(Some(95), Some(10)).len(), 6);
    assert!(fails(|| { vote(&mut k, "alice.testnet", 0, 0, 2 * DAY + 2); }));
    assert!(fails(|| { at(&acc("anyone.testnet"), 3 * DAY); k.close_poll(0); }));
}

// ---------- 0.3.6 part B: loans to sister co-ops ----------

fn unused(p: PromiseOrValue<U128>) -> u128 {
    match p {
        PromiseOrValue::Value(v) => v.0,
        _ => panic!("a promise"),
    }
}

fn sister_setup() -> (Koperasi, AccountId) {
    let mut k = setup();
    let sister = acc("koperasi-two.testnet");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone()]);
    lending::add_risk(1_000_000);
    (k, sister)
}

fn lend(k: &mut Koperasi, coop: &AccountId, amount: u128, days: u32) {
    at(&dao(), DAY);
    let _ = k.lend_to_sister(coop.clone(), acc("sister-dao.testnet"), U128(amount), days, None);
}

fn repay(k: &mut Koperasi, msg: &str, amount: u128) -> u128 {
    as_(&usdc(), near(0));
    unused(k.ft_on_transfer(acc("koperasi-two.testnet"), U128(amount), msg.into()))
}

/// The DAO lends a sister co-op from the risk fund; every refusal; it is repaid (in parts) back into the fund.
#[test]
fn the_dao_lends_a_sister_coop_from_the_risk_fund_and_it_repays() {
    let (mut k, sister) = sister_setup();
    assert!(fails(|| { at(&acc("alice.testnet"), DAY); let _ = k.lend_to_sister(sister.clone(), acc("sister-dao.testnet"), U128(100), 30, None); }), "only the DAO");
    assert!(fails(|| lend(&mut k, &acc("stranger.testnet"), 100, 30)), "not a sister");
    assert!(fails(|| lend(&mut k, &sister, 500_001, 30)), "more than half the risk fund");
    assert!(fails(|| lend(&mut k, &sister, 0, 30)), "nothing");
    assert!(fails(|| lend(&mut k, &sister, 100, 0)), "0 days");
    assert!(fails(|| lend(&mut k, &sister, 100, 366)), "over a year");
    as_(&dao(), near(0));
    k.pause();
    assert!(fails(|| lend(&mut k, &sister, 100, 30)), "paused");
    as_(&dao(), near(0));
    k.unpause();
    assert_eq!(k.get_sister_loans().len(), 0, "nothing kept by a refusal");

    lend(&mut k, &sister, 500_000, 30);
    assert!(logs_have("\"sister_loan\""));
    assert_eq!(k.get_risk_fund().0 .0, 500_000);
    assert_eq!(k.get_ledger().unwrap().1 .0, 500_000, "in flight until the callback");
    let l = &k.get_sister_loans()[0];
    assert_eq!((l.id, l.amount.0, l.status, l.due.0), (0, 500_000, lending::SisterLoanStatus::Open, DAY + 30 * DAY));
    assert!(fails(|| lend(&mut k, &sister, 100, 30)), "one loan open per co-op");
    at(&me(), DAY);
    k.on_sister_lent(0, U128(500_000), Ok(()));
    assert_eq!(k.get_ledger().unwrap().1 .0, 0);
    assert_eq!(k.get_risk_fund().0 .0, 500_000, "a transfer that went through keeps the loan");

    // repayment: a bad id, a wrong token, an unknown loan: all returned
    assert_eq!(repay(&mut k, "sister_repay:x", 10), 10);
    assert_eq!(repay(&mut k, "sister_repay:9", 10), 10);
    as_(&acc("fake-usdc.testnet"), near(0));
    assert_eq!(unused(k.ft_on_transfer(sister.clone(), U128(10), "sister_repay:0".into())), 10, "only the co-op's USDC");
    assert_eq!(k.get_risk_fund().0 .0, 500_000);
    // in parts, anyone may pay; the excess is returned
    assert_eq!(repay(&mut k, "sister_repay:0", 200_000), 0);
    assert!(logs_have("\"sister_repaid\"") && logs_have("\"outstanding\":\"300000\""));
    assert_eq!(k.get_sister_loans()[0].status, lending::SisterLoanStatus::Open);
    assert_eq!(repay(&mut k, "sister_repay:0", 400_000), 100_000);
    assert_eq!(k.get_risk_fund().0 .0, 1_000_000, "all back in the risk fund");
    assert_eq!(k.get_sister_loans()[0].status, lending::SisterLoanStatus::Repaid);
    assert_eq!(repay(&mut k, "sister_repay:0", 5), 5, "a repaid loan takes nothing more");
    assert!(fails(|| { at(&acc("anyone.testnet"), 40 * DAY); k.mark_sister_late(0); }), "a repaid loan is not late");
    // repaid: the co-op may borrow again
    lend(&mut k, &sister, 100, 30);
    assert_eq!(k.get_sister_loans()[1].id, 1);
}

/// A failed transfer rolls the books back: the fund is whole, the loan void and nothing more can be paid into it.
#[test]
fn a_failed_sister_loan_transfer_goes_back_to_the_risk_fund() {
    let (mut k, sister) = sister_setup();
    lend(&mut k, &sister, 400_000, 30);
    at(&me(), DAY);
    k.on_sister_lent(0, U128(400_000), Err(PromiseError::Failed));
    assert!(logs_have("\"sister_loan_failed\""));
    assert_eq!(k.get_risk_fund().0 .0, 1_000_000);
    assert_eq!(k.get_ledger().unwrap().1 .0, 0);
    assert_eq!(k.get_sister_loans()[0].status, lending::SisterLoanStatus::Failed);
    assert_eq!(repay(&mut k, "sister_repay:0", 400_000), 400_000, "a void loan takes nothing");
    assert!(fails(|| { at(&acc("anyone.testnet"), 40 * DAY); k.mark_sister_late(0); }), "a void loan is not late");
    lend(&mut k, &sister, 400_000, 30); // not open: the co-op may be lent again
}

/// Past due, anyone calls a sister loan late: recorded here and told to the sister co-ops; that co-op is not lent again.
/// A co-op another sister noted late is not lent either.
#[test]
fn a_late_sister_loan_is_recorded_and_told_and_blocks_further_loans() {
    let (mut k, sister) = sister_setup();
    lend(&mut k, &sister, 300_000, 10);
    assert!(fails(|| { at(&acc("anyone.testnet"), 11 * DAY); k.mark_sister_late(0); }), "not due yet: due is day 11");
    assert!(fails(|| { at(&acc("anyone.testnet"), 12 * DAY); k.mark_sister_late(5); }), "no such loan");
    at(&acc("anyone.testnet"), 12 * DAY);
    k.mark_sister_late(0);
    assert!(logs_have("\"sister_late\"") && logs_have("\"outstanding\":\"300000\""));
    assert!(fails(|| { at(&acc("anyone.testnet"), 12 * DAY); k.mark_sister_late(0); }), "once");
    let l = &k.get_sister_loans()[0];
    assert!(l.was_late && l.status == lending::SisterLoanStatus::Late);
    assert_eq!(k.get_sister_late(sister.clone()), 1);
    // still repayable; the record stays
    assert_eq!(repay(&mut k, "sister_repay:0", 300_000), 0);
    assert_eq!(k.get_sister_loans()[0].status, lending::SisterLoanStatus::Repaid);
    assert_eq!(k.get_risk_fund().0 .0, 1_000_000);
    assert!(fails(|| lend(&mut k, &sister, 100, 30)), "a loan to this co-op went late");
    // a co-op that a sister noted late is refused too
    let third = acc("koperasi-three.testnet");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone(), third.clone()]);
    as_(&sister, near(0));
    k.note_late_elsewhere(third.clone(), true);
    assert!(fails(|| lend(&mut k, &third, 100, 30)), "noted late by a sister");
    as_(&sister, near(0));
    k.note_late_elsewhere(third.clone(), false);
    lend(&mut k, &third, 100, 30);
}

// ---------- 0.3.7 part A: a technical poll's result becomes a DAO proposal ----------

fn bl(version: u32, hash: &str) -> Option<polls::BylawsRef> {
    Some(polls::BylawsRef { version, hash: hash.into(), uri: format!("config/config.v{version}.yaml") })
}

/// The DAO proposal `poll_to_proposal` filed: its description and the decoded `set_config` args.
fn filed_proposal() -> Option<(String, Value)> {
    near_sdk::test_utils::get_created_receipts().iter().flat_map(|r| r.actions.clone()).find_map(|a| match a {
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"add_proposal" => {
            let v: Value = near_sdk::serde_json::from_slice(&args).unwrap();
            let p = &v["proposal"];
            let call = &p["kind"]["FunctionCall"];
            assert_eq!(call["actions"][0]["method_name"], "set_config");
            assert_eq!(call["receiver_id"], me().to_string());
            let b64 = call["actions"][0]["args"].as_str().unwrap();
            let raw = near_sdk::base64::Engine::decode(&near_sdk::base64::engine::general_purpose::STANDARD, b64).unwrap();
            Some((p["description"].as_str().unwrap().to_string(), near_sdk::serde_json::from_slice(&raw).unwrap()))
        }
        _ => None,
    })
}

/// Every refusal of a by-laws reference on opening; the deposit grows with each reference; the view adds the keys.
#[test]
fn a_poll_carries_by_laws_only_when_well_formed_and_paid_for() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    use polls::PollKind::{General, Technical};
    let try_open = |k: &mut Koperasi, fee: u128, kind: polls::PollKind, b: Vec<Option<polls::BylawsRef>>| {
        at_paying(&acc("alice.testnet"), DAY, NearToken::from_millinear(fee));
        k.open_poll("Which embedding model?".into(), vec!["a".into(), "b".into()], kind, 24, Some(b))
    };
    assert!(fails(|| { try_open(&mut k, 30, General, vec![bl(2, H2), None]); }), "only a technical poll");
    assert!(fails(|| { try_open(&mut k, 30, Technical, vec![bl(2, H2)]); }), "one entry per option");
    assert!(fails(|| { try_open(&mut k, 30, Technical, vec![None, None]); }), "at least one reference");
    assert!(fails(|| { try_open(&mut k, 30, Technical, vec![bl(1, H2), None]); }), "a version above the current one");
    assert!(fails(|| { try_open(&mut k, 30, Technical, vec![bl(2, "abc"), None]); }), "a sha256 hash");
    assert!(fails(|| { try_open(&mut k, 30, Technical, vec![bl(2, &"A".repeat(64)), None]); }), "lowercase hex");
    let bad_uri = |u: &str| vec![Some(polls::BylawsRef { version: 2, hash: H2.into(), uri: u.into() }), None];
    assert!(fails(|| { try_open(&mut k, 30, Technical, bad_uri("")); }), "empty uri");
    assert!(fails(|| { try_open(&mut k, 30, Technical, bad_uri("a b")); }), "uri with a space");
    assert!(fails(|| { try_open(&mut k, 30, Technical, bad_uri(&"u".repeat(201))); }), "uri too long");
    assert!(fails(|| { try_open(&mut k, 29, Technical, vec![bl(2, H2), bl(3, H1)]); }), "0.01 NEAR per reference");
    assert!(fails(|| { as_(&acc("mallory.testnet"), NearToken::from_millinear(30)); k.open_poll("q".into(), vec!["a".into(), "b".into()], Technical, 24, Some(vec![bl(2, H2), None])); }), "only a member");
    assert_eq!(k.get_polls(None, None).len(), 0, "nothing was kept by a refused poll");
    let id = try_open(&mut k, 20, Technical, vec![bl(2, H2), None]);
    let p = k.get_poll(id).unwrap();
    assert_eq!(p.bylaws, Some(vec![bl(2, H2), None]));
    assert_eq!(p.proposal, None);
    // the JSON view keeps every key it had and adds the new ones
    let j = near_sdk::serde_json::to_value(&p).unwrap();
    assert_eq!(j["question"], "Which embedding model?");
    assert_eq!(j["mode"], "one_member");
    assert_eq!(j["bylaws"][0]["hash"], H2);
    assert!(j["bylaws"][1].is_null() && j["proposal"].is_null());
    // the old call (no by-laws) still works and shows none
    let plain = open_p(&mut k, "alice.testnet", Technical, DAY);
    assert_eq!(k.get_poll(plain).unwrap().bylaws, None);
}

/// A closed poll's winning by-laws are filed once as a DAO proposal calling set_config; every refusal; a failed filing
/// returns the bond and may be tried again.
#[test]
fn a_closed_polls_winning_by_laws_become_a_dao_proposal_once() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet", "carol.testnet"]);
    use polls::PollKind::Technical;
    let open_b = |k: &mut Koperasi, b: Vec<Option<polls::BylawsRef>>| {
        at_paying(&acc("alice.testnet"), DAY, NearToken::from_millinear(30));
        k.open_poll("Switch the embedding model?".into(), vec!["bge-m3".into(), "keep".into()], Technical, 24, Some(b))
    };
    let propose = |k: &mut Koperasi, who: &str, id: u32, fee: u128, ns: u64| {
        at_paying(&acc(who), ns, NearToken::from_millinear(fee));
        let _ = k.poll_to_proposal(id);
    };
    let id = open_b(&mut k, vec![bl(2, H2), None]);
    let lost = open_b(&mut k, vec![bl(2, H2), None]); // "keep" wins: it carries no by-laws
    let tie = open_b(&mut k, vec![bl(2, H2), bl(3, H1)]);
    let plain = open_p(&mut k, "alice.testnet", Technical, DAY);
    vote(&mut k, "alice.testnet", id, 0, DAY + 1);
    vote(&mut k, "bob.testnet", id, 0, DAY + 1);
    vote(&mut k, "carol.testnet", id, 1, DAY + 1);
    vote(&mut k, "alice.testnet", lost, 1, DAY + 1);
    vote(&mut k, "alice.testnet", tie, 0, DAY + 1);
    vote(&mut k, "bob.testnet", tie, 1, DAY + 1);
    vote(&mut k, "alice.testnet", plain, 0, DAY + 1);
    assert!(fails(|| propose(&mut k, "anyone.testnet", id, 100, DAY + 2)), "close the poll first");
    at(&acc("anyone.testnet"), 2 * DAY);
    for p in [id, lost, tie, plain] {
        k.close_poll(p);
    }
    assert!(fails(|| propose(&mut k, "anyone.testnet", tie, 100, 2 * DAY)), "no result");
    assert!(fails(|| propose(&mut k, "anyone.testnet", lost, 100, 2 * DAY)), "the winner carries no by-laws");
    assert!(fails(|| propose(&mut k, "anyone.testnet", plain, 100, 2 * DAY)), "a poll with no by-laws");
    assert!(fails(|| propose(&mut k, "anyone.testnet", 9, 100, 2 * DAY)), "no such poll");
    assert!(fails(|| propose(&mut k, "anyone.testnet", id, 99, 2 * DAY)), "the bond");
    as_(&dao(), near(0));
    k.pause();
    assert!(fails(|| propose(&mut k, "anyone.testnet", id, 100, 2 * DAY)), "paused");
    as_(&dao(), near(0));
    k.unpause();

    // anyone files it; the description and the set_config call are the poll's
    propose(&mut k, "anyone.testnet", id, 100, 2 * DAY);
    let (desc, args) = filed_proposal().expect("an add_proposal call");
    assert_eq!(desc, format!("Poll #{id} (one_member): Switch the embedding model? \u{2192} bge-m3; by-laws v2 {H2}"));
    assert_eq!((args["version"].as_u64(), args["hash"].as_str(), args["points"].as_u64()), (Some(2), Some(H2), Some(0)));
    assert_eq!(args["uri"], "config/config.v2.yaml");
    assert!(args["contributor"].is_null());
    assert!(fails(|| propose(&mut k, "bob.testnet", id, 100, 2 * DAY)), "in flight: once");
    // the filing failed: the bond goes back and the poll may be filed again
    at(&me(), 2 * DAY);
    k.on_poll_proposed(id, acc("anyone.testnet"), Err(PromiseError::Failed));
    assert!(logs_have("bond returned"));
    assert_eq!(k.get_poll(id).unwrap().proposal, None);
    propose(&mut k, "bob.testnet", id, 150, 2 * DAY); // the 0.05 NEAR over the bond goes back at once
    at(&me(), 2 * DAY);
    k.on_poll_proposed(id, acc("bob.testnet"), Ok(42));
    assert!(logs_have("\"poll_proposed\"") && logs_have("\"proposal\":42"));
    assert_eq!(k.get_poll(id).unwrap().proposal, Some(42));
    assert!(fails(|| propose(&mut k, "carol.testnet", id, 100, 3 * DAY)), "once per poll");
}

/// By-laws overtaken while the poll ran (the DAO set that version meanwhile) are not filed.
#[test]
fn a_poll_whose_by_laws_were_overtaken_is_not_filed() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    at_paying(&acc("alice.testnet"), DAY, NearToken::from_millinear(20));
    let id = k.open_poll("q".into(), vec!["v2".into(), "keep".into()], polls::PollKind::Technical, 24, Some(vec![bl(2, H2), None]));
    vote(&mut k, "alice.testnet", id, 0, DAY + 1);
    as_(&dao(), near(0));
    k.set_config(2, H1.into(), "other".into(), None, 0);
    at(&acc("anyone.testnet"), 2 * DAY);
    k.close_poll(id);
    at_paying(&acc("anyone.testnet"), 2 * DAY, NearToken::from_millinear(100));
    assert!(fails(|| { let _ = k.poll_to_proposal(id); }), "no longer newer");
}

/// A dropped poll takes its by-laws and its proposal link with it.
#[test]
fn a_dropped_poll_drops_its_by_laws_and_link() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    at_paying(&acc("alice.testnet"), DAY, NearToken::from_millinear(20));
    k.open_poll("q".into(), vec!["v2".into(), "keep".into()], polls::PollKind::Technical, 1, Some(vec![bl(2, H2), None]));
    at(&me(), DAY);
    k.on_poll_proposed(0, acc("alice.testnet"), Ok(5));
    assert_eq!(k.get_poll(0).unwrap().proposal, Some(5));
    for _ in 0..100 {
        open_p(&mut k, "alice.testnet", polls::PollKind::General, 2 * DAY);
    }
    assert!(k.get_poll(0).is_none());
    assert!(env::storage_read(b"poll_bylaws:0").is_none() && env::storage_read(b"poll_proposal:0").is_none());
}

// ---------- 0.3.7 part A: juries drawn by reputation ----------

#[test]
fn only_the_dao_draws_juries_by_reputation() {
    let mut k = setup();
    assert!(!k.get_jury_by_reputation(), "off by default");
    assert!(fails(|| { as_(&acc("alice.testnet"), near(0)); k.set_jury_by_reputation(true); }), "only the DAO");
    as_(&dao(), near(0));
    k.set_jury_by_reputation(true);
    assert!(logs_have("\"jury_mode_set\"") && logs_have("\"by_reputation\":true"));
    assert!(k.get_jury_by_reputation());
    k.set_jury_by_reputation(false);
    assert!(logs_have("\"by_reputation\":false"));
    assert!(!k.get_jury_by_reputation());
}

/// With the mode on, three weighty members are drawn over two with no reputation (who weigh the floor: 20 in 3,000,020).
#[test]
fn a_jury_by_reputation_favours_the_weighty() {
    let heavy = ["bob.testnet", "dave.testnet", "erin.testnet"];
    let mut k = court();
    for h in heavy {
        commons::mark(&acc(h), |s| s.pledges_honored += 10_000); // weight 1,000,000 each; alice and carol 0
    }
    as_(&dao(), near(0));
    k.set_jury_by_reputation(true);
    open(&mut k, "frank.testnet", 2 * DAY);
    let mut j: Vec<String> = k.get_cases(None, None)[0].jurors.iter().map(|a| a.to_string()).collect();
    j.sort();
    assert_eq!(j, heavy);
}

/// Nobody is excluded: with no reputation at all, everyone weighs the floor and a jury is still drawn; members out of
/// good standing are still never drawn.
#[test]
fn a_jury_by_reputation_draws_members_with_no_reputation_at_the_floor() {
    let mut k = court();
    as_(&dao(), near(0));
    k.set_jury_by_reputation(true);
    commons::mark(&acc("alice.testnet"), |s| s.pledges_broken += 1);
    commons::mark(&acc("bob.testnet"), |s| s.slashed += 1);
    open(&mut k, "frank.testnet", 2 * DAY);
    let mut j: Vec<String> = k.get_cases(None, None)[0].jurors.iter().map(|a| a.to_string()).collect();
    j.sort();
    assert_eq!(j, ["carol.testnet", "dave.testnet", "erin.testnet"]);
}

// ---------- 0.3.7 part B: interest on sister loans; the agent asks for one ----------

fn lend_at(k: &mut Koperasi, coop: &AccountId, amount: u128, days: u32, bps: Option<u16>) {
    at(&dao(), DAY);
    let _ = k.lend_to_sister(coop.clone(), acc("sister-dao.testnet"), U128(amount), days, bps);
}

fn interest_of(k: &Koperasi, id: u32) -> (u128, u128) {
    k.get_sister_interest().iter().find(|(i, _, _)| *i == id).map_or((0, 0), |(_, d, p)| (d.0, p.0))
}

/// Interest: principal first into the risk fund, then interest to the DAO (the surplus); Repaid only when both are paid;
/// a payment that does not cover the interest leaves the loan open; the excess is returned.
#[test]
fn a_sister_loan_with_interest_repays_principal_to_the_risk_fund_and_interest_to_the_surplus() {
    let (mut k, sister) = sister_setup();
    assert!(fails(|| lend_at(&mut k, &sister, 400_000, 30, Some(2001))), "at most 2000 bps");
    lend_at(&mut k, &sister, 400_000, 30, Some(1000));
    at(&me(), DAY);
    k.on_sister_lent(0, U128(400_000), Ok(()));
    assert_eq!(interest_of(&k, 0), (40_000, 0), "10% of the amount, for the term");
    // the principal alone: back in the risk fund, still open for the interest
    assert_eq!(repay(&mut k, "sister_repay:0", 400_000), 0);
    assert_eq!(k.get_risk_fund().0 .0, 1_000_000);
    assert!(logs_have("\"outstanding\":\"40000\"") && !logs_have("\"sister_interest\""));
    assert_eq!(k.get_sister_loans()[0].status, lending::SisterLoanStatus::Open);
    // part of the interest: forwarded to the DAO, not enough to settle
    assert_eq!(repay(&mut k, "sister_repay:0", 10_000), 0);
    assert!(logs_have("\"sister_interest\"") && logs_have("\"amount\":\"10000\"") && logs_have("\"outstanding\":\"30000\""));
    assert_eq!(k.get_ledger().unwrap().1 .0, 10_000, "the interest is in flight to the DAO");
    assert_eq!(k.get_risk_fund().0 .0, 1_000_000, "interest never goes into the risk fund");
    assert_eq!(k.get_sister_loans()[0].status, lending::SisterLoanStatus::Open);
    assert_eq!(interest_of(&k, 0), (40_000, 10_000));
    // the forward fails: kept for flush_to_dao
    at(&me(), DAY);
    k.on_forwarded(U128(10_000), Err(PromiseError::Failed));
    assert_eq!(k.get_info().unforwarded.0, 10_000);
    // overpaid: what is not owed comes back
    assert_eq!(repay(&mut k, "sister_repay:0", 50_000), 20_000);
    assert_eq!(k.get_sister_loans()[0].status, lending::SisterLoanStatus::Repaid);
    assert_eq!(interest_of(&k, 0), (40_000, 40_000));
    assert_eq!(repay(&mut k, "sister_repay:0", 5), 5, "settled: nothing more taken");
}

/// One payment covering the principal and part of the interest; no interest by default; late shows interest owed.
#[test]
fn one_payment_splits_between_principal_and_interest_and_late_counts_interest() {
    let (mut k, sister) = sister_setup();
    lend_at(&mut k, &sister, 200_000, 10, Some(500)); // 10_000 interest
    assert_eq!(repay(&mut k, "sister_repay:0", 205_000), 0);
    assert_eq!(k.get_risk_fund().0 .0, 1_000_000);
    assert_eq!(interest_of(&k, 0), (10_000, 5_000));
    assert_eq!(k.get_sister_loans()[0].status, lending::SisterLoanStatus::Open, "the interest is not covered yet");
    at(&acc("anyone.testnet"), 12 * DAY);
    k.mark_sister_late(0);
    assert!(logs_have("\"outstanding\":\"5000\""));
    assert_eq!(repay(&mut k, "sister_repay:0", 5_000), 0);
    assert_eq!(k.get_sister_loans()[0].status, lending::SisterLoanStatus::Repaid);
    // without interest_bps: no interest, settled with the principal
    let third = acc("koperasi-three.testnet");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone(), third.clone()]);
    lend_at(&mut k, &third, 100, 30, None);
    assert_eq!(interest_of(&k, 1), (0, 0));
    assert_eq!(repay(&mut k, "sister_repay:1", 150), 50);
    assert_eq!(k.get_sister_loans()[1].status, lending::SisterLoanStatus::Repaid);
    assert!(!logs_have("\"sister_interest\""));
}

/// A failed transfer voids the loan: no interest stays due.
#[test]
fn a_failed_sister_loan_owes_no_interest() {
    let (mut k, sister) = sister_setup();
    lend_at(&mut k, &sister, 400_000, 30, Some(2000));
    assert_eq!(interest_of(&k, 0), (80_000, 0));
    at(&me(), DAY);
    k.on_sister_lent(0, U128(400_000), Err(PromiseError::Failed));
    assert_eq!(interest_of(&k, 0), (0, 0));
    assert_eq!(repay(&mut k, "sister_repay:0", 80_000), 80_000);
}

fn agent_suggests(k: &mut Koperasi, who: &AccountId, ns: u64, coop: &AccountId, amount: u128, days: u32, bps: u16, why: &str, sig: Option<String>) {
    at_paying(who, ns, tasks::PAYOUT_BOND);
    let _ = k.agent_suggest_sister_loan(coop.clone(), acc("sister-dao.testnet"), U128(amount), days, bps, why.into(), sig);
}

/// The proposal the contract filed: (bond attached, the lend_to_sister args it carries).
fn filed_loan() -> (u128, Value) {
    near_sdk::test_utils::get_created_receipts().iter().flat_map(|r| r.actions.clone()).find_map(|a| match a {
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"add_proposal" => {
            let p: Value = near_sdk::serde_json::from_slice(&args).unwrap();
            let a = &p["proposal"]["kind"]["FunctionCall"]["actions"][0];
            assert_eq!(a["method_name"], "lend_to_sister");
            let inner = near_sdk::base64::Engine::decode(&near_sdk::base64::engine::general_purpose::STANDARD, a["args"].as_str().unwrap()).unwrap();
            Some((attached_deposit.as_yoctonear(), near_sdk::serde_json::from_slice(&inner).unwrap()))
        }
        _ => None,
    }).expect("an add_proposal")
}

/// The agent asks the members for a loan to a sister co-op: the contract files the DAO proposal (bond attached by the
/// caller); one open suggestion per sister until a loan is made or 7 days pass; every refusal.
#[test]
fn the_agent_asks_the_members_for_a_loan_to_a_sister_coop() {
    let (mut k, sister) = sister_setup();
    let why = "kop-two lost a client; it repaid on time before";
    let stranger = acc("stranger.testnet");
    assert!(fails(|| agent_suggests(&mut k, &stranger, DAY, &sister, 100_000, 30, 500, why, None)), "not the agent");
    assert!(fails(|| { at(&agent(), DAY); let _ = k.agent_suggest_sister_loan(sister.clone(), acc("sister-dao.testnet"), U128(100_000), 30, 500, why.into(), None); }), "no bond");
    assert!(fails(|| agent_suggests(&mut k, &agent(), DAY, &acc("stranger-coop.testnet"), 100_000, 30, 500, why, None)), "not a sister");
    assert!(fails(|| agent_suggests(&mut k, &agent(), DAY, &sister, 500_001, 30, 500, why, None)), "over half the risk fund");
    assert!(fails(|| agent_suggests(&mut k, &agent(), DAY, &sister, 0, 30, 500, why, None)), "nothing");
    assert!(fails(|| agent_suggests(&mut k, &agent(), DAY, &sister, 100_000, 0, 500, why, None)), "0 days");
    assert!(fails(|| agent_suggests(&mut k, &agent(), DAY, &sister, 100_000, 30, 2001, why, None)), "over 2000 bps");
    assert!(fails(|| agent_suggests(&mut k, &agent(), DAY, &sister, 100_000, 30, 500, " ", None)), "no reason");
    assert!(fails(|| agent_suggests(&mut k, &agent(), DAY, &sister, 100_000, 30, 500, &"x".repeat(281), None)), "reason over 280");
    assert!(fails(|| { at_paying(&agent(), DAY, tasks::PAYOUT_BOND); let _ = k.agent_suggest_sister_loan(sister.clone(), sister.clone(), U128(100_000), 30, 500, why.into(), None); }), "paid to the sister's contract");

    agent_suggests(&mut k, &agent(), DAY, &sister, 100_000, 30, 500, why, None);
    let (bond, args) = filed_loan();
    assert_eq!(bond, tasks::PAYOUT_BOND.as_yoctonear());
    assert_eq!(args, json!({ "coop": sister, "paid_to": "sister-dao.testnet", "amount": "100000", "days": 30, "interest_bps": 500 }));
    let s = k.get_loan_suggestion(sister.clone()).unwrap();
    assert_eq!((s.amount.0, s.days, s.interest_bps, s.proposal, s.by.clone()), (100_000, 30, 500, None, agent()));
    at(&me(), DAY);
    k.on_loan_suggested(sister.clone(), U128(100_000), agent(), Ok(7));
    assert!(logs_have("\"loan_suggested\"") && logs_have("\"proposal\":7"));
    assert_eq!(k.get_loan_suggestion(sister.clone()).unwrap().proposal, Some(7));
    assert!(fails(|| agent_suggests(&mut k, &agent(), 2 * DAY, &sister, 100_000, 30, 500, why, None)), "one open per sister");
    // the members vote it: the DAO executes lend_to_sister with those args; the suggestion is settled
    lend_at(&mut k, &sister, 100_000, 30, Some(500));
    assert!(k.get_loan_suggestion(sister.clone()).is_none());
    assert_eq!(interest_of(&k, 0), (5_000, 0));
    assert!(fails(|| agent_suggests(&mut k, &agent(), 2 * DAY, &sister, 100_000, 30, 500, why, None)), "a loan to it is open");
}

/// Not filed: the suggestion is forgotten and the bond refunded; after 7 days a new one may be filed; the gates.
#[test]
fn a_loan_suggestion_not_filed_is_forgotten_and_the_gates_hold() {
    let (mut k, sister) = sister_setup();
    let why = "steady repayer";
    agent_suggests(&mut k, &agent(), DAY, &sister, 100_000, 30, 0, why, None);
    at(&me(), DAY);
    k.on_loan_suggested(sister.clone(), U128(100_000), agent(), Err(PromiseError::Failed));
    assert!(k.get_loan_suggestion(sister.clone()).is_none());
    assert!(near_sdk::test_utils::get_created_receipts().iter().any(|r| r.receiver_id == agent()
        && r.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::Transfer { deposit, .. } if *deposit == tasks::PAYOUT_BOND))), "bond refunded");
    agent_suggests(&mut k, &agent(), DAY, &sister, 100_000, 30, 0, why, None);
    at(&me(), DAY);
    k.on_loan_suggested(sister.clone(), U128(100_000), agent(), Ok(1));
    // 7 days on, no loan made: open again
    assert!(fails(|| agent_suggests(&mut k, &agent(), 8 * DAY - 1, &sister, 100_000, 30, 0, why, None)));
    agent_suggests(&mut k, &agent(), 8 * DAY, &sister, 100_000, 30, 0, why, None);
    // a TEE-only agent unattested; a suspended agent; paused
    as_(&dao(), near(0));
    k.set_agent_tee(agent(), true);
    assert!(fails(|| agent_suggests(&mut k, &agent(), 20 * DAY, &sister, 100_000, 30, 0, why, None)), "TEE-only, unattested");
    as_(&dao(), near(0));
    k.set_agent_tee(agent(), false);
    agent_suggests(&mut k, &agent(), 20 * DAY, &sister, 100_000, 30, 0, why, None);
    at(&me(), 30 * DAY);
    for c in 0..3 {
        meeting::strike(c);
    }
    assert!(fails(|| agent_suggests(&mut k, &agent(), 30 * DAY, &sister, 100_000, 30, 0, why, None)), "suspended");
    at(&dao(), 31 * DAY);
    k.reinstate_agent();
    agent_suggests(&mut k, &agent(), 31 * DAY, &acc("koperasi-two.testnet"), 100_000, 30, 0, why, None); // reinstated: allowed
    as_(&dao(), near(0));
    k.pause();
    assert!(fails(|| agent_suggests(&mut k, &agent(), 40 * DAY, &sister, 100_000, 30, 0, why, None)), "paused");
    // a co-op that went late here is not suggested
    as_(&dao(), near(0));
    k.unpause();
    let third = acc("koperasi-three.testnet");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone(), third.clone()]);
    lend_at(&mut k, &third, 1_000, 1, None);
    at(&acc("anyone.testnet"), 3 * DAY);
    k.mark_sister_late(0);
    assert!(fails(|| agent_suggests(&mut k, &agent(), 40 * DAY, &third, 100, 30, 0, why, None)), "late before");
}

/// The signed path: anyone submits the agent's signature, once; every term is signed.
#[test]
fn anyone_may_submit_the_agents_signed_loan_suggestion_once() {
    use ed25519_dalek::{Signer, SigningKey};
    let (mut k, sister) = sister_setup();
    let relayer = acc("relayer.testnet");
    let why = "kop-two needs a bridge loan";
    let sk = SigningKey::from_bytes(&[5; 32]);
    let pk: Vec<u8> = [vec![0u8], sk.verifying_key().to_bytes().to_vec()].concat();
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(agent()).signer_account_id(agent())
        .signer_account_pk(pk.try_into().unwrap()).block_timestamp(DAY);
    testing_env!(b.build());
    k.record_receipt("j-pk".into(), U128(1), U128(0), H1.into(), "00".into(), None);
    let msg = k.get_loan_suggestion_message(sister.clone(), acc("sister-dao.testnet"), U128(100_000), 30, 300, why.into());
    assert_eq!(msg, lending::agent_loan_message(&me(), 0, &sister, &acc("sister-dao.testnet"), 100_000, 30, 300, why));
    assert!(msg.starts_with("koperasi-agent-loan/1 koperasi.testnet #0 "));
    let sig = near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, sk.sign(msg.as_bytes()).to_bytes());
    assert!(fails(|| agent_suggests(&mut k, &relayer, DAY, &sister, 200_000, 30, 300, why, Some(sig.clone()))), "the amount is signed");
    assert!(fails(|| agent_suggests(&mut k, &relayer, DAY, &sister, 100_000, 30, 900, why, Some(sig.clone()))), "the interest is signed");
    assert!(fails(|| agent_suggests(&mut k, &relayer, DAY, &sister, 100_000, 30, 300, "other", Some(sig.clone()))), "the reason is signed");
    assert!(fails(|| agent_suggests(&mut k, &relayer, DAY, &sister, 100_000, 30, 300, why, None)), "no signature");
    agent_suggests(&mut k, &relayer, DAY, &sister, 100_000, 30, 300, why, Some(sig.clone()));
    assert_eq!(k.get_loan_suggestion(sister.clone()).unwrap().by, relayer);
    at(&me(), DAY);
    k.on_loan_suggested(sister.clone(), U128(100_000), relayer.clone(), Err(PromiseError::Failed));
    assert!(fails(|| agent_suggests(&mut k, &relayer, DAY, &sister, 100_000, 30, 300, why, Some(sig.clone()))), "replayed: nonce 0 was used");
}

// ---------- 0.3.8: the agent opens technical polls ----------

const POLL_FEE: NearToken = NearToken::from_millinear(10);

fn agent_poll(k: &mut Koperasi, who: &AccountId, ns: u64, fee: NearToken, q: &str, b: Option<Vec<Option<polls::BylawsRef>>>,
              why: &str, sig: Option<String>) -> u32 {
    at_paying(who, ns, fee);
    k.agent_open_poll(q.into(), vec!["bge-m3".into(), "keep".into()], 24, b, why.into(), sig)
}

/// The agent opens a technical poll directly, one at a time; members vote, anyone closes; its by-laws go to the DAO.
#[test]
fn the_agent_opens_a_technical_poll_one_at_a_time_and_its_by_laws_reach_the_dao() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet", "bob.testnet"]);
    let why = "refunds rose 3x since v1: retrieval misses";
    assert!(fails(|| { agent_poll(&mut k, &acc("alice.testnet"), DAY, POLL_FEE, "q?", None, why, None); }), "a member is not the agent");
    assert!(fails(|| { agent_poll(&mut k, &agent(), DAY, NearToken::from_millinear(9), "q?", None, why, None); }), "storage deposit");
    assert!(fails(|| { agent_poll(&mut k, &agent(), DAY, POLL_FEE, "q?", Some(vec![bl(2, H2), None]), why, None); }), "0.01 more per reference");
    assert!(fails(|| { agent_poll(&mut k, &agent(), DAY, POLL_FEE, "q?", None, "", None); }), "empty reason");
    assert!(fails(|| { agent_poll(&mut k, &agent(), DAY, POLL_FEE, "q?", None, &"r".repeat(281), None); }), "reason too long");
    assert!(fails(|| { agent_poll(&mut k, &agent(), DAY, POLL_FEE, "", None, why, None); }), "the poll's own terms still hold");
    assert!(k.get_agent_polls().is_empty());
    let id = agent_poll(&mut k, &agent(), DAY, NearToken::from_millinear(20), "Switch the embedding model?", Some(vec![bl(2, H2), None]), why, None);
    assert!(logs_have("\"agent_poll_opened\"") && logs_have(why) && logs_have("\"poll_opened\""));
    let p = k.get_poll(id).unwrap();
    assert_eq!((p.kind, p.by.clone(), p.agent_reason.as_deref()), (polls::PollKind::Technical, agent(), Some(why)));
    let a = k.get_agent_polls();
    assert_eq!((a.len(), a[0].id, a[0].reason.as_str()), (1, id, why));
    // a member's poll is not the agent's
    let mine = open_p(&mut k, "alice.testnet", polls::PollKind::Technical, DAY);
    assert!(k.get_poll(mine).unwrap().agent_reason.is_none());
    // one at a time: refused until the first is past its deadline
    assert!(fails(|| { agent_poll(&mut k, &agent(), DAY + 23 * 3_600_000_000_000, POLL_FEE, "again?", None, why, None); }), "still open");
    vote(&mut k, "alice.testnet", id, 0, DAY + 1);
    vote(&mut k, "bob.testnet", id, 0, DAY + 2);
    assert!(fails(|| { at(&agent(), DAY + 3); k.vote_poll(id, 1); }), "the agent does not vote");
    let id2 = agent_poll(&mut k, &agent(), 2 * DAY, POLL_FEE, "again?", None, why, None); // past the deadline, not closed yet
    assert!(fails(|| { agent_poll(&mut k, &agent(), 2 * DAY, POLL_FEE, "third?", None, why, None); }), "the second is open");
    at(&acc("anyone.testnet"), 2 * DAY);
    assert_eq!(k.close_poll(id), Some(0));
    at_paying(&acc("anyone.testnet"), 2 * DAY, tasks::PAYOUT_BOND);
    let _ = k.poll_to_proposal(id);
    let (_, args) = filed_proposal().expect("filed");
    assert_eq!((args["version"].as_u64(), args["hash"].as_str()), (Some(2), Some(H2)));
    // the second closes as usual (no votes), then a third may open
    at(&acc("anyone.testnet"), 3 * DAY);
    assert_eq!(k.close_poll(id2), None);
    agent_poll(&mut k, &agent(), 3 * DAY, POLL_FEE, "third?", None, why, None);
    assert_eq!(k.get_agent_polls().len(), 3);
}

/// Paused, suspended, or TEE-only and unattested: the agent opens no poll.
#[test]
fn the_agent_opens_no_poll_when_paused_suspended_or_unattested() {
    let mut k = setup();
    let why = "inference cost per job doubled";
    as_(&dao(), near(0));
    k.pause();
    assert!(fails(|| { agent_poll(&mut k, &agent(), DAY, POLL_FEE, "q?", None, why, None); }), "paused");
    as_(&dao(), near(0));
    k.unpause();
    at(&agent(), DAY);
    for c in 0..3 {
        meeting::strike(c);
    }
    assert!(fails(|| { agent_poll(&mut k, &agent(), DAY, POLL_FEE, "q?", None, why, None); }), "suspended");
    at(&dao(), DAY + 1); // strikes before the reinstatement no longer count
    k.reinstate_agent();
    as_(&dao(), near(0));
    k.set_agent_tee(agent(), true);
    assert!(fails(|| { agent_poll(&mut k, &agent(), DAY, POLL_FEE, "q?", None, why, None); }), "TEE-only, unattested");
    as_(&dao(), near(0));
    k.set_agent_tee(agent(), false);
    agent_poll(&mut k, &agent(), DAY, POLL_FEE, "q?", None, why, None);
}

/// The signed path: anyone submits the agent's signature, once; question, options, by-laws, hours and reason are signed.
#[test]
fn anyone_may_submit_the_agents_signed_poll_once() {
    use ed25519_dalek::{Signer, SigningKey};
    let mut k = setup();
    let relayer = acc("relayer.testnet");
    let why = "two embedding models tie on our evals";
    let sk = SigningKey::from_bytes(&[4; 32]);
    let pk: Vec<u8> = [vec![0u8], sk.verifying_key().to_bytes().to_vec()].concat();
    let mut b = VMContextBuilder::new();
    b.current_account_id(me()).predecessor_account_id(agent()).signer_account_id(agent())
        .signer_account_pk(pk.try_into().unwrap()).block_timestamp(DAY);
    testing_env!(b.build());
    k.record_receipt("j-pk".into(), U128(1), U128(0), H1.into(), "00".into(), None);
    let opts = vec!["bge-m3".to_string(), "keep".to_string()];
    let refs = Some(vec![bl(2, H2), None]);
    let msg = k.get_agent_poll_message("Switch?".into(), opts.clone(), 24, refs.clone(), why.into());
    // the content hash is the sha256 of the compact JSON, keys in this order
    let json = format!("{{\"question\":\"Switch?\",\"options\":[\"bge-m3\",\"keep\"],\"bylaws\":[{{\"version\":2,\"hash\":\"{H2}\",\"uri\":\"config/config.v2.yaml\"}},null]}}");
    let hex: String = env::sha256(json.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(msg, format!("koperasi-agent-poll/1 koperasi.testnet #0 24 {hex}\n{why}"));
    assert_eq!(msg, polls::agent_poll_message(&me(), 0, 24, &polls::agent_poll_content("Switch?", &opts, &refs), why));
    let enc = |s: &SigningKey| near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, s.sign(msg.as_bytes()).to_bytes());
    let sig = enc(&sk);
    let fee = NearToken::from_millinear(20);
    let try_ = |k: &mut Koperasi, ns: u64, q: &str, o: Vec<String>, h: u32, b: Option<Vec<Option<polls::BylawsRef>>>, w: &str, s: Option<String>| {
        at_paying(&relayer, ns, fee);
        k.agent_open_poll(q.into(), o, h, b, w.into(), s)
    };
    assert!(fails(|| { try_(&mut k, DAY, "Switch?", opts.clone(), 24, refs.clone(), why, None); }), "no signature");
    assert!(fails(|| { try_(&mut k, DAY, "Switch?", opts.clone(), 24, refs.clone(), why, Some("AAAA".into())); }), "not 64 bytes");
    assert!(fails(|| { try_(&mut k, DAY, "Switch now?", opts.clone(), 24, refs.clone(), why, Some(sig.clone())); }), "the question is signed");
    assert!(fails(|| { try_(&mut k, DAY, "Switch?", vec!["keep".into(), "bge-m3".into()], 24, refs.clone(), why, Some(sig.clone())); }), "the options are signed");
    assert!(fails(|| { try_(&mut k, DAY, "Switch?", opts.clone(), 24, Some(vec![bl(3, H2), None]), why, Some(sig.clone())); }), "the by-laws are signed");
    assert!(fails(|| { try_(&mut k, DAY, "Switch?", opts.clone(), 48, refs.clone(), why, Some(sig.clone())); }), "the hours are signed");
    assert!(fails(|| { try_(&mut k, DAY, "Switch?", opts.clone(), 24, refs.clone(), "other", Some(sig.clone())); }), "the reason is signed");
    assert!(fails(|| { try_(&mut k, DAY, "Switch?", opts.clone(), 24, refs.clone(), why, Some(enc(&SigningKey::from_bytes(&[3; 32])))); }), "another key");
    let id = try_(&mut k, DAY, "Switch?", opts.clone(), 24, refs.clone(), why, Some(sig.clone()));
    assert_eq!(k.get_poll(id).unwrap().by, agent(), "the agent opened it, not the relayer");
    // replayed once the poll is decided: the signature was for nonce 0
    assert!(fails(|| { try_(&mut k, 3 * DAY, "Switch?", opts.clone(), 24, refs.clone(), why, Some(sig.clone())); }), "replayed");
    assert!(k.get_agent_poll_message("Switch?".into(), opts.clone(), 24, refs.clone(), why.into()).contains(" #1 "));
    // its own nonce: the by-laws proposal and accept messages still start at 0
    assert!(k.get_agent_proposal_message(2, H2.into(), "u".into(), "r".into()).contains(" #0 "));
    assert!(k.get_accept_message(acc("kop-two.testnet"), 0).contains(" #0 "));
}

/// An agent poll's record leaves with the poll once 100 newer polls push it out.
#[test]
fn an_agent_polls_record_leaves_with_the_poll() {
    let mut k = setup();
    with_members(&mut k, &["alice.testnet"]);
    let id = agent_poll(&mut k, &agent(), DAY, POLL_FEE, "q?", None, "why", None);
    for _ in 0..polls::MAX_POLLS {
        open_p(&mut k, "alice.testnet", polls::PollKind::General, 3 * DAY);
    }
    assert!(k.get_poll(id).is_none());
    assert!(k.get_agent_polls().is_empty());
    assert!(env::storage_read(format!("poll_agent:{id}").as_bytes()).is_none());
}

// ---------- 0.3.8: the referral share, paid automatically ----------

/// USDC transfers the contract started: (receiver, amount).
fn ft_transfers() -> Vec<(String, u128)> {
    near_sdk::test_utils::get_created_receipts().iter().flat_map(|r| r.actions.clone()).filter_map(|a| match a {
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"ft_transfer" => {
            let v: Value = near_sdk::serde_json::from_slice(&args).unwrap();
            Some((v["receiver_id"].as_str().unwrap().to_string(), v["amount"].as_str().unwrap().parse().unwrap()))
        }
        _ => None,
    }).collect()
}

/// A steward, a sister co-op whose job "j-ref" was accepted here, its treasury, a 30% share.
fn referral_setup() -> (Koperasi, AccountId, AccountId) {
    let mut k = setup();
    let sister = acc("kop-two.testnet");
    let treasury = acc("kop-two.sputnik-v2.testnet");
    as_(&dao(), near(0));
    k.set_steward(Some(steward()));
    k.set_sister_coops(vec![sister.clone()]);
    k.set_referral_share(3000);
    k.set_coop_treasury(sister.clone(), Some(treasury.clone()));
    at(&me(), DAY);
    k.on_referral_read(sister.clone(), 0, Ok(ref_board(0, "j-ref", &me())));
    // the job's own receipt: the share is cut from at most its price and the referral's budget (5 USDC)
    receipt(&mut k, "j-ref", 10_000_000, H1);
    (k, sister, treasury)
}

fn deposit(k: &mut Koperasi, from: &AccountId, amount: u128, msg: &str) -> u128 {
    as_(&usdc(), near(0));
    match k.ft_on_transfer(from.clone(), U128(amount), msg.into()) {
        PromiseOrValue::Value(v) => v.0,
        _ => panic!("expected a value"),
    }
}

/// Only the DAO sets the share (at most 50%) and a sister's treasury (not a contract); None removes it.
#[test]
fn only_the_dao_sets_the_referral_share_and_a_sisters_treasury() {
    let mut k = setup();
    let sister = acc("kop-two.testnet");
    let t = acc("kop-two.sputnik-v2.testnet");
    assert_eq!(k.get_referral_share(), 0);
    assert!(fails(|| { as_(&acc("alice.testnet"), near(0)); k.set_referral_share(3000); }), "only the DAO");
    assert!(fails(|| { as_(&dao(), near(0)); k.set_referral_share(5001); }), "at most 5000 bps");
    as_(&dao(), near(0));
    k.set_referral_share(5000);
    assert!(logs_have("\"referral_share_set\""));
    k.set_referral_share(3000);
    assert_eq!(k.get_referral_share(), 3000);
    assert!(fails(|| { as_(&dao(), near(0)); k.set_coop_treasury(sister.clone(), Some(t.clone())); }), "not a sister yet");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone()]);
    assert!(fails(|| { as_(&acc("alice.testnet"), near(0)); k.set_coop_treasury(sister.clone(), Some(t.clone())); }), "only the DAO");
    assert!(fails(|| { as_(&acc("alice.testnet"), near(0)); k.set_coop_treasury(sister.clone(), None); }), "only the DAO (removal)");
    assert!(fails(|| { as_(&dao(), near(0)); k.set_coop_treasury(sister.clone(), Some(sister.clone())); }), "the sister's contract");
    assert!(fails(|| { as_(&dao(), near(0)); k.set_coop_treasury(sister.clone(), Some(me())); }), "this contract");
    as_(&dao(), near(0));
    k.set_coop_treasury(sister.clone(), Some(t.clone()));
    assert!(logs_have("\"coop_treasury_set\""));
    assert_eq!(k.get_coop_treasury(sister.clone()), Some(t));
    k.set_coop_treasury(sister.clone(), None);
    assert_eq!(k.get_coop_treasury(sister), None);
}

/// "earnings:<job>" for a referred job: 30% to the sister's treasury, once; the rest booked as usual.
#[test]
fn a_referred_jobs_earnings_pay_the_referring_coop_its_share_once() {
    let (mut k, sister, treasury) = referral_setup();
    as_(&dao(), near(0));
    k.set_agent_saves(1000);
    assert_eq!(deposit(&mut k, &steward(), 10_000_000, "earnings:j-ref"), 0);
    assert_eq!(ft_transfers(), vec![(treasury.to_string(), 1_500_000), (dao().to_string(), 7_650_000)], "30% of the job's share base (its 5 USDC budget, not the 10 USDC deposit); the agent saves 10% of the rest");
    assert!(logs_have("\"referral_share_paid\"") && logs_have("\"job_id\":\"j-ref\"") && logs_have("\"to\":\"kop-two.sputnik-v2.testnet\""));
    let p = k.get_referral_share_paid("j-ref".into()).unwrap();
    assert_eq!((p.from_coop, p.to, p.amount.0, p.failed), (sister.clone(), treasury.clone(), 1_500_000, false));
    assert_eq!(k.get_audit().deposited.0, 10_000_000, "the whole deposit counts as passed on");
    assert_eq!(k.get_risk_fund().0, U128(850_000));
    assert_eq!(k.get_ledger().unwrap().1 .0, 9_150_000, "both transfers in flight");
    at(&me(), DAY);
    k.on_referral_share("j-ref".into(), U128(1_500_000), Ok(()));
    assert_eq!(k.get_ledger().unwrap().1 .0, 7_650_000);
    // once per job: a second deposit for it pays no share again
    deposit(&mut k, &steward(), 1_000_000, "earnings:j-ref");
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 900_000)]);
    assert_eq!(k.get_referral_share_paid("j-ref".into()).unwrap().amount.0, 1_500_000);
}

/// Every case that pays no share: plain "earnings", its own job, no job named, not the steward, another msg, no share
/// voted, no treasury.
#[test]
fn earnings_pay_no_referral_share_unless_every_condition_holds() {
    let (mut k, sister, _) = referral_setup();
    deposit(&mut k, &steward(), 1_000_000, "earnings");
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 1_000_000)], "plain earnings work as before");
    deposit(&mut k, &steward(), 1_000_000, "earnings:j-own");
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 1_000_000)], "a job of its own");
    deposit(&mut k, &steward(), 1_000_000, "earnings:");
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 1_000_000)], "no job named");
    assert_eq!(deposit(&mut k, &acc("mallory.testnet"), 1_000_000, "earnings:j-ref"), 1_000_000, "not the steward: returned");
    assert_eq!(deposit(&mut k, &steward(), 1_000_000, "earningsj-ref"), 1_000_000, "another msg: returned");
    as_(&dao(), near(0));
    k.set_referral_share(0);
    deposit(&mut k, &steward(), 1_000_000, "earnings:j-ref");
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 1_000_000)], "no share voted");
    as_(&dao(), near(0));
    k.set_referral_share(3000);
    k.set_coop_treasury(sister, None);
    deposit(&mut k, &steward(), 1_000_000, "earnings:j-ref");
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 1_000_000)], "no treasury");
    assert!(k.get_referral_share_paid("j-ref".into()).is_none(), "nothing paid for the job");
    assert_eq!(k.get_audit().deposited.0, 5_000_000);
}

/// A failed transfer: the share goes to the DAO's unforwarded balance, the job stays marked (never sent twice).
#[test]
fn a_failed_referral_share_goes_to_the_dao_and_is_never_sent_twice() {
    let (mut k, sister, _) = referral_setup();
    deposit(&mut k, &steward(), 1, "earnings:j-ref");
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 1)], "30% of 1 rounds to 0: nothing sent");
    assert!(k.get_referral_share_paid("j-ref".into()).is_none(), "nor marked");
    deposit(&mut k, &steward(), 2_000_000, "earnings:j-ref");
    at(&me(), DAY);
    k.on_referral_share("j-ref".into(), U128(600_000), Err(PromiseError::Failed));
    assert!(logs_have("\"referral_share_failed\"") && logs_have("\"from_coop\":\"kop-two.testnet\""));
    assert_eq!(k.get_info().unforwarded.0, 600_000);
    let p = k.get_referral_share_paid("j-ref".into()).unwrap();
    assert_eq!((p.from_coop, p.failed), (sister, true));
    assert_eq!(k.get_ledger().unwrap().1 .0, 1_400_000 + 1, "only the DAO transfers still in flight");
    deposit(&mut k, &steward(), 2_000_000, "earnings:j-ref");
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 2_000_000)], "not again");
    at(&acc("anyone.testnet"), DAY);
    k.flush_to_dao();
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 600_000)]);
}

// ---------- 0.3.9: binding federation credit; the federation dividend ----------

/// The panic message of a refused call.
fn panic_msg(f: impl FnOnce()) -> String {
    let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a refusal");
    e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
}

/// (score, late, open past due, repaid on time) of `coop` at time `ns`.
fn credit_at(k: &Koperasi, coop: &AccountId, ns: u64) -> (u32, u32, u32, u32) {
    at(&acc("anyone.testnet"), ns);
    let c = k.get_coop_credit(coop.clone());
    (c.score, c.late, c.open_past_due, c.repaid_on_time)
}

/// The score: 100, -10 per open loan past due, +5 per loan repaid on time (at most 100), -40 per late loan here or
/// sister's late note, at least 0.
#[test]
fn a_sister_coops_credit_score_follows_the_federation_rule() {
    let (mut k, sister) = sister_setup();
    assert_eq!(credit_at(&k, &sister, DAY), (100, 0, 0, 0), "no record: 100");
    lend(&mut k, &sister, 100_000, 10); // due day 11
    assert_eq!(credit_at(&k, &sister, 5 * DAY), (100, 0, 0, 0), "open, not yet due");
    assert_eq!(credit_at(&k, &sister, 12 * DAY), (90, 0, 1, 0), "open past due: -10");
    repay(&mut k, "sister_repay:0", 100_000);
    assert_eq!(credit_at(&k, &sister, 12 * DAY), (100, 0, 0, 1), "repaid on time: +5, at most 100");
    lend(&mut k, &sister, 100_000, 10);
    assert_eq!(credit_at(&k, &sister, 12 * DAY), (95, 0, 1, 1));
    at(&acc("anyone.testnet"), 12 * DAY);
    k.mark_sister_late(1);
    assert_eq!(credit_at(&k, &sister, 12 * DAY), (65, 1, 0, 1), "late here: -40 (no longer counted as open past due)");
    let (third, fourth) = (acc("koperasi-three.testnet"), acc("koperasi-four.testnet"));
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone(), third.clone(), fourth.clone()]);
    as_(&third, near(0));
    k.note_late_elsewhere(sister.clone(), true);
    assert_eq!(credit_at(&k, &sister, 12 * DAY), (25, 2, 0, 1), "a sister's late note: -40");
    as_(&fourth, near(0));
    k.note_late_elsewhere(sister.clone(), true);
    assert_eq!(credit_at(&k, &sister, 12 * DAY), (0, 3, 0, 1), "floor 0");
    as_(&fourth, near(0));
    k.note_late_elsewhere(sister.clone(), false);
    assert_eq!(credit_at(&k, &sister, 12 * DAY).0, 25, "a lifted note no longer counts");
    assert_eq!(credit_at(&k, &third, 12 * DAY), (100, 0, 0, 0), "another co-op's record is its own");
}

/// `lend_to_sister` lends at most half the risk fund x score/100 (the refusal names the score; 0 cannot borrow) and logs
/// the cap; the 0.3.6 refusals still stand behind it.
#[test]
fn lend_to_sister_is_capped_by_the_coops_credit_score() {
    let (mut k, sister) = sister_setup();
    lend(&mut k, &sister, 500_000, 10);
    assert!(logs_have("\"coop_credit_cap\"") && logs_have("\"score\":100") && logs_have("\"cap\":\"500000\""));
    at(&me(), DAY);
    k.on_sister_lent(0, U128(500_000), Ok(()));
    at(&acc("anyone.testnet"), 12 * DAY);
    k.mark_sister_late(0);
    repay(&mut k, "sister_repay:0", 500_000);
    assert_eq!(k.get_risk_fund().0 .0, 1_000_000);
    let m = panic_msg(|| lend(&mut k, &sister, 400_000, 10));
    assert!(m.contains("federation credit score 60/100: at most 300000"), "{m}");
    let m = panic_msg(|| lend(&mut k, &sister, 300_000, 10));
    assert!(m.contains("a loan to this co-op went late"), "under the cap, the 0.3.6 refusal still holds: {m}");
    let (third, fourth) = (acc("koperasi-three.testnet"), acc("koperasi-four.testnet"));
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone(), third.clone(), fourth.clone()]);
    for c in [&third, &fourth] {
        as_(c, near(0));
        k.note_late_elsewhere(sister.clone(), true);
    }
    let m = panic_msg(|| lend(&mut k, &sister, 1, 10));
    assert!(m.contains("federation credit score 0/100: this co-op cannot borrow"), "{m}");
    assert_eq!(k.get_sister_loans().len(), 1, "nothing kept by a refusal");
    // a co-op with no record borrows the usual cap
    assert!(fails(|| lend(&mut k, &fourth, 500_001, 10)));
    lend(&mut k, &fourth, 500_000, 10);
    assert!(logs_have("\"coop\":\"koperasi-four.testnet\"") && logs_have("\"cap\":\"500000\""));
}

/// The agent's suggestion is checked against the same cap before the DAO proposal is filed.
#[test]
fn the_agents_loan_suggestion_is_capped_by_the_coops_credit_score() {
    let (mut k, sister) = sister_setup();
    let why = "kop-three asked for working capital";
    let (third, fourth) = (acc("koperasi-three.testnet"), acc("koperasi-four.testnet"));
    as_(&dao(), near(0));
    k.set_sister_coops(vec![sister.clone(), third.clone(), fourth.clone()]);
    lend_at(&mut k, &third, 100_000, 1, None);
    at(&acc("anyone.testnet"), 3 * DAY);
    k.mark_sister_late(0);
    // 900_000 left in the risk fund: half is 450_000, at score 60 at most 270_000
    let m = panic_msg(|| agent_suggests(&mut k, &agent(), 4 * DAY, &third, 300_000, 30, 0, why, None));
    assert!(m.contains("federation credit score 60/100: at most 270000"), "{m}");
    let m = panic_msg(|| agent_suggests(&mut k, &agent(), 4 * DAY, &third, 100, 30, 0, why, None));
    assert!(m.contains("this co-op was late on a loan"), "{m}");
    for c in [&sister, &fourth] {
        as_(c, near(0));
        k.note_late_elsewhere(third.clone(), true);
    }
    let m = panic_msg(|| agent_suggests(&mut k, &agent(), 4 * DAY, &third, 100, 30, 0, why, None));
    assert!(m.contains("federation credit score 0/100"), "{m}");
    assert!(k.get_loan_suggestion(third.clone()).is_none(), "nothing filed");
    agent_suggests(&mut k, &agent(), 4 * DAY, &fourth, 450_000, 30, 0, why, None); // no record: the usual cap
    assert!(k.get_loan_suggestion(fourth).is_some());
}

/// Only the DAO sets the federation dividend, at most 10000 bps; 0 by default.
#[test]
fn only_the_dao_sets_the_federation_dividend() {
    let mut k = setup();
    assert_eq!(k.get_federation_dividend(), 0);
    assert!(fails(|| { as_(&acc("alice.testnet"), near(0)); k.set_federation_dividend(5000); }), "only the DAO");
    assert!(fails(|| { as_(&dao(), near(0)); k.set_federation_dividend(10_001); }), "at most 10000");
    as_(&dao(), near(0));
    k.set_federation_dividend(10_000);
    assert!(logs_have("\"federation_dividend_set\"") && logs_have("\"bps\":10000"));
    assert_eq!(k.get_federation_dividend(), 10_000);
}

/// Sisters two (the borrower), three, four (treasuries t2, t3, t4) and five (no treasury); a 50% dividend; loan #0 to
/// two: 100_000 at 10% (10_000 interest), lent.
fn dividend_setup() -> (Koperasi, AccountId, AccountId, AccountId) {
    let (mut k, two) = sister_setup();
    let (t3, t4) = (acc("kop-three.sputnik-v2.testnet"), acc("kop-four.sputnik-v2.testnet"));
    as_(&dao(), near(0));
    k.set_sister_coops(vec![two.clone(), acc("koperasi-three.testnet"), acc("koperasi-four.testnet"), acc("koperasi-five.testnet")]);
    k.set_coop_treasury(two.clone(), Some(acc("kop-two.sputnik-v2.testnet")));
    k.set_coop_treasury(acc("koperasi-three.testnet"), Some(t3.clone()));
    k.set_coop_treasury(acc("koperasi-four.testnet"), Some(t4.clone()));
    k.set_federation_dividend(5000);
    lend_at(&mut k, &two, 100_000, 30, Some(1000));
    at(&me(), DAY);
    k.on_sister_lent(0, U128(100_000), Ok(()));
    (k, two, t3, t4)
}

/// The dividend's share of each interest payment is split equally among the other sisters with a treasury; the rest
/// goes to the DAO; per loan, what each treasury was paid is kept.
#[test]
fn a_sister_loans_interest_pays_the_federation_dividend_to_the_other_sisters() {
    let (mut k, _, t3, t4) = dividend_setup();
    // the principal and 4_000 of interest: 1_000 to each of t3 and t4, 2_000 to the DAO
    assert_eq!(repay(&mut k, "sister_repay:0", 104_000), 0);
    assert_eq!(ft_transfers(), vec![(t3.to_string(), 1_000), (t4.to_string(), 1_000), (dao().to_string(), 2_000)],
        "not the borrower's treasury, not a sister without one");
    assert!(logs_have("\"federation_dividend\"") && logs_have("\"loan_id\":0") && logs_have("\"to\":\"kop-three.sputnik-v2.testnet\""));
    assert_eq!(k.get_ledger().unwrap().1 .0, 4_000, "all three in flight");
    // the rest of the interest; the excess is returned
    assert_eq!(repay(&mut k, "sister_repay:0", 7_000), 1_000);
    assert_eq!(ft_transfers(), vec![(t3.to_string(), 1_500), (t4.to_string(), 1_500), (dao().to_string(), 3_000)]);
    let paid: Vec<(String, u128, u128)> = k.get_federation_dividend_paid(0).iter().map(|p| (p.to.to_string(), p.amount.0, p.failed.0)).collect();
    assert_eq!(paid, vec![(t3.to_string(), 2_500, 0), (t4.to_string(), 2_500, 0)]);
    assert_eq!(k.get_sister_loans()[0].status, lending::SisterLoanStatus::Repaid);
    assert_eq!(k.get_risk_fund().0 .0, 1_000_000, "the principal back in the risk fund");
    at(&me(), DAY);
    k.on_federation_dividend(0, t3.clone(), U128(1_500), Ok(()));
    assert_eq!(k.get_ledger().unwrap().1 .0, 4_000 + 6_000 - 1_500);
    assert_eq!(k.get_info().unforwarded.0, 0);
    // settled: nothing more paid out
    assert_eq!(repay(&mut k, "sister_repay:0", 5_000), 5_000);
    assert!(ft_transfers().is_empty());
}

/// bps 0: all the interest to the DAO, as before; only the borrower has a treasury: all to the DAO; 100% to one
/// treasury: nothing to the DAO; a share too small to split: all to the DAO.
#[test]
fn the_federation_dividend_needs_a_share_and_another_treasury() {
    let (mut k, two) = sister_setup();
    let three = acc("koperasi-three.testnet");
    let t3 = acc("kop-three.sputnik-v2.testnet");
    as_(&dao(), near(0));
    k.set_sister_coops(vec![two.clone(), three.clone()]);
    k.set_coop_treasury(two.clone(), Some(acc("kop-two.sputnik-v2.testnet")));
    k.set_coop_treasury(three.clone(), Some(t3.clone()));
    let mut id = 0;
    let mut loan = |k: &mut Koperasi, interest_paid: u128| {
        lend_at(k, &two, 100_000, 30, Some(1000));
        repay(k, &format!("sister_repay:{id}"), 100_000 + interest_paid);
        id += 1;
        ft_transfers()
    };
    assert_eq!(loan(&mut k, 10_000), vec![(dao().to_string(), 10_000)], "bps 0: unchanged");
    assert!(k.get_federation_dividend_paid(0).is_empty());
    as_(&dao(), near(0));
    k.set_federation_dividend(10_000);
    k.set_coop_treasury(three.clone(), None);
    assert_eq!(loan(&mut k, 10_000), vec![(dao().to_string(), 10_000)], "only the borrower has a treasury");
    assert!(k.get_federation_dividend_paid(1).is_empty());
    as_(&dao(), near(0));
    k.set_coop_treasury(three.clone(), Some(t3.clone()));
    assert_eq!(loan(&mut k, 10_000), vec![(t3.to_string(), 10_000)], "100% to the one other treasury");
    as_(&dao(), near(0));
    k.set_federation_dividend(1);
    assert_eq!(loan(&mut k, 10_000), vec![(t3.to_string(), 1), (dao().to_string(), 9_999)], "rounded down, the rest to the DAO");
    as_(&dao(), near(0));
    k.set_federation_dividend(5000);
    lend_at(&mut k, &two, 100_000, 30, Some(1000));
    repay(&mut k, "sister_repay:4", 100_001);
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 1)], "half of 1 rounds to 0: all to the DAO");
    assert!(k.get_federation_dividend_paid(4).is_empty());
}

/// A dividend transfer that fails goes to the DAO's unforwarded balance and is marked; never sent to the sister again.
#[test]
fn a_failed_federation_dividend_goes_to_the_dao() {
    let (mut k, _, t3, t4) = dividend_setup();
    repay(&mut k, "sister_repay:0", 110_000);
    assert_eq!(ft_transfers(), vec![(t3.to_string(), 2_500), (t4.to_string(), 2_500), (dao().to_string(), 5_000)]);
    at(&me(), DAY);
    k.on_federation_dividend(0, t3.clone(), U128(2_500), Err(PromiseError::Failed));
    assert!(logs_have("\"federation_dividend_failed\"") && logs_have("\"to\":\"kop-three.sputnik-v2.testnet\""));
    assert_eq!(k.get_info().unforwarded.0, 2_500);
    assert_eq!(k.get_ledger().unwrap().1 .0, 10_000 - 2_500);
    let paid: Vec<(String, u128, u128)> = k.get_federation_dividend_paid(0).iter().map(|p| (p.to.to_string(), p.amount.0, p.failed.0)).collect();
    assert_eq!(paid, vec![(t3.to_string(), 2_500, 2_500), (t4.to_string(), 2_500, 0)]);
    assert_eq!(repay(&mut k, "sister_repay:0", 10_000), 10_000, "settled: nothing more");
    at(&acc("anyone.testnet"), DAY);
    k.flush_to_dao();
    assert_eq!(ft_transfers(), vec![(dao().to_string(), 2_500)]);
}
