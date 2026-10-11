### Visual QA · PR #214: Auto-approve small, low-risk refunds

Refunds under $50 from low-risk customers are now approved and paid on the spot instead of waiting for finance. Everything else still goes to a person, now with a risk score attached. The Slack ping and the nightly receipt job are gone: receipts are emailed the moment money moves.

**Risk: medium** — Money now leaves without a human check for small refunds, so the $50 limit, the risk threshold, and the fail-closed path all need testing.

**Refund flow** (3 new, 3 changed, 2 removed)
- **Changed** · Refund request — Two new columns: the risk score and whether it was auto-approved.
- **New** · Risk check — New: every refund gets a fraud score before anything else happens.
- **New** · Small and low risk? — New decision: is it under $50, low risk, and the first refund this month? ⚠️ high risk
- **New** · Approved right away — New: small, low-risk refunds are marked approved and paid immediately. ⚠️ high risk
- **Removed** · Slack ping — Removed: finance no longer gets a Slack message per refund.
- **Changed** · Finance review — The queue now only gets refunds that need a person, with their risk score.
- **Changed** · Receipt email — Receipts go out immediately instead of the next morning.
- **Removed** · Nightly receipt job — Removed: the 2 a.m. batch of receipt emails.

<details><summary>9 changed connections</summary>

- **New** · Refund request → Risk check — Every new refund now goes through the risk check first.
- **New** · Risk check → Small and low risk? — The risk score feeds straight into the small-and-low-risk decision.
- **New** · Small and low risk? → Approved right away (Yes) — When all three conditions hold, the refund skips finance entirely.
- **New** · Small and low risk? → Finance review (No) — Anything that fails the rule goes to a person, as every refund did before.
- **Removed** · Refund request → Finance review (every refund) — Refunds no longer go straight into the review queue; they pass the risk check and rule first.
- **Removed** · Finance review → Slack ping (pings) — Queuing a refund no longer posts to Slack.
- **New** · Approved right away → Payments (pays now) — Auto-approved refunds go straight to the payout.
- **Changed** · Payments → Receipt email (right away) — The payout now sends the receipt itself.
- **Removed** · Nightly receipt job → Receipt email (02:00) — The nightly batch no longer sends receipts (it was deleted).

</details>

**Services** (1 new, 3 changed, 2 removed)
- **Changed** · Shop app — The refund screen now shows the real outcome instead of a generic promise.
- **Changed** · Refunds logic — Now calls the risk service and pays small refunds itself.
- **Changed** · Postgres — The refunds table gets two columns and an index.
- **Removed** · Cron worker — The refund receipt job is gone, so the worker no longer touches refunds.
- **Removed** · Slack — Refunds no longer post to Slack.
- **New** · RiskScore — A new outside dependency.

<details><summary>4 changed connections</summary>

- **New** · Refunds logic → RiskScore (score lookup) — New call on every refund request.
- **New** · Refunds logic → Email sender (receipt) — Receipts are now sent directly when a refund is paid.
- **Removed** · Refunds logic → Slack — The Slack ping is gone.
- **Removed** · Cron worker → Email sender (nightly batch) — The nightly batch no longer sends receipts.

</details>

<details><summary><b>QA checklist</b> (47)</summary>

- [ ] Refund request: After an auto-approval, the refund row has `auto_approved = true` and a `risk_score`
- [ ] Refund request: Refunds created before this change still load (new columns are empty or false)
- [ ] Refund request: Run the migration on a copy of production data → it finishes quickly; the new index doesn't lock the table for long
- [ ] Risk check: Turn the risk service off and request a $10 refund → it goes to finance review; nothing is paid
- [ ] Risk check: Make the risk service answer slowly (over 0.8 s) → same as above: review, no payment
- [ ] Risk check: The score saved on the refund matches what the risk service returned
- [ ] Small and low risk?: Refund of $49.99, score 10, no recent refunds → approved instantly
- [ ] Small and low risk?: Refund of exactly $50.00 → goes to review (the limit is “under” $50)
- [ ] Small and low risk?: Score of exactly 30 → goes to review (must be below 30)
- [ ] Small and low risk?: Second small refund within 30 days → goes to review
- [ ] Small and low risk?: A refund in another currency is compared in cents of that currency (check this is intended)
- [ ] Approved right away: Auto-approve a refund → Stripe shows the refund within a minute and the receipt email arrives
- [ ] Approved right away: The refund does not appear in the finance review queue
- [ ] Approved right away: If the Stripe payout fails, the refund is not left marked as paid
- [ ] Slack ping: Requesting any refund no longer posts to #finance
- [ ] Slack ping: Finance agreed to watch the review queue instead (confirm with them before release)
- [ ] Finance review: Request a $120 refund → it appears in the queue with a risk score
- [ ] Finance review: Reviewers can still approve and decline exactly as before
- [ ] Receipt email: Get a refund approved → one receipt email arrives within a minute
- [ ] Receipt email: Nobody receives two receipts for one refund
- [ ] Receipt email: Refunds paid on release day before the deploy still get a receipt
- [ ] Nightly receipt job: The job no longer appears in the scheduler after deploy
- [ ] Nightly receipt job: No receipt emails are sent around 02:00 the next night
- [ ] Refund request → Risk check: No refund skips the risk check
- [ ] Risk check → Small and low risk?: Score 29 with a $10 first refund → auto-approved
- [ ] Risk check → Small and low risk?: Score 30, same refund → goes to review
- [ ] Small and low risk? → Approved right away (Yes): $49.99 / score 10 / first refund → auto-approved
- [ ] Small and low risk? → Finance review (No): $50.00 → review
- [ ] Small and low risk? → Finance review (No): score 30 → review
- [ ] Refund request → Finance review (every refund): Small, low-risk refunds never appear in the queue
- [ ] Finance review → Slack ping (pings): No #finance message on any refund
- [ ] Approved right away → Payments (pays now): Stripe refund is created right after approval
- [ ] Payments → Receipt email (right away): Exactly one receipt per paid refund
- [ ] Nightly receipt job → Receipt email (02:00): No 02:00 receipt batch
- [ ] Shop app: Request a $20 refund as a low-risk customer → the screen says Approved and shows the timeline
- [ ] Shop app: Request a $120 refund → the screen says a person will review it within 2 days
- [ ] Shop app: Old app versions still show a sensible message (they ignore the new status field)
- [ ] Refunds logic: See the Refund flow diagram for the checks on each step
- [ ] Postgres: Migration runs cleanly on a copy of production data
- [ ] Cron worker: Scheduler config no longer lists nightlyRefundEmails
- [ ] Slack: No refund messages in #finance
- [ ] RiskScore: `RISK_URL` is configured in staging and production
- [ ] RiskScore: Refunds still work (via review) when RiskScore is down
- [ ] Refunds logic → RiskScore (score lookup): Times out after 0.8 s and falls back to review
- [ ] Refunds logic → Email sender (receipt): One email per paid refund
- [ ] Refunds logic → Slack: No Slack messages
- [ ] Cron worker → Email sender (nightly batch): No 02:00 batch

</details>

Not in the diagram: `src/refunds/__tests__/decide.test.ts` (Tests for the new decision rule), `package-lock.json` (Dependency lockfile)

<sub>11 files, +214 −61 · interactive before/after diagram: <code>report.html</code> · made with visual-qa</sub>
