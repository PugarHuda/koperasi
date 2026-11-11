# Koperasi by-laws, in plain words

1. **Who is a member.** Whoever the DAO's role `member` lists. You ask to join by paying a refundable join deposit
   (0.5 NEAR in the testnet co-op); the members vote you in. If they later vote you out, the deposit comes back.
2. **One member, one vote.** Every proposal passes with more than half of the members' votes. Stake size does not
   buy votes.
3. **The agent's by-laws.** The agent may run only the config file whose sha256 the members approved last. To change
   it, a member publishes the new file and proposes `set_config`; whoever wrote it can be awarded contribution points
   in the same vote.
4. **The agent's limits** are in its config: which jobs it bids on, its bid price, the most it may spend on inference
   per job and per day. The DAO or the steward can pause it at once; only the DAO can restart it.
5. **The steward** holds the Agent Market account, posts a bond, and passes every payout on with
   `ft_transfer_call(msg "earnings")`. The audit shows what is still missing. The members can slash the bond and
   appoint someone else; and if the audit stays red for this steward more than 7 days, anyone can slash it
   (`slash_overdue`), no vote needed. A new steward does not answer for what the old one left unpaid.
6. **Profit share.** When the members vote to share the treasury, 20% stays as the reserve, 40% is shared by savings
   (NEAR staked for inference) and 40% by contribution points. Rounding stays in the
   reserve. Each member claims their own share. Points halve at each share, so recent work counts most; savings do not. A share that would leave the treasury under the floor the members voted goes back whole.
7. **Tasks and earned trust.** A member posts a task and anyone takes it. When the poster accepts the work:
   a small task for someone other members already paid is paid with no vote, within the poster's daily limit; a
   mid-size task, or anyone without that record, needs one other member's approval; a large task is a DAO bounty
   voted by all. Every payout is a `Transfer` proposal from the treasury.
8. **The veto window.** A payout with no vote first waits the window the members voted (10 minutes on testnet).
   During it any member except the contributor can veto it, and then it needs one other member's approval like a
   mid-size task. After the window, anyone can release it.
