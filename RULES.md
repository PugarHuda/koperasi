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
   appoint someone else.
6. **Profit share.** When the members vote to share the treasury, 20% stays as the reserve, 40% is shared by savings
   (NEAR staked for inference) and 40% by contribution points earned since the last share. Rounding stays in the
   reserve. Each member claims their own share. Points reset after each share; savings do not.
