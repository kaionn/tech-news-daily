# AI trends publication guard

This change prepares an external observer and protects generation/deployment. It does **not** install a monitor, configure a notification destination, add credentials/permissions, dispatch recovery, or deploy anything. Merge/activation remain separate steps.

## Publication contract

AI trends is due Tuesday/Thursday/Saturday at 07:00 JST. Publication must be observed by **10:30 JST inclusive**. A negative observation at/after 10:30 records a deadline failure even when Actions has not fired, is queued/running, or reports success. A later positive observation after that failure records `late_recovery`; the deadline miss stays recorded. Successful observations before/at the deadline record `on_time`.

A positive check fetches both `/ai-trends.html` and `/ai-trends/YYYY-MM-DD.html` with a cache-busting query and no-cache request. When the target is the latest issue, both must have the target date in the visible date header, a nonempty theme/section body, an HTTPS source, a complete page, and the same article region (including examples, editorial and quick picks). Navigation, footer and past-issue lists are excluded from the body comparison because relative links differ. Once a newer issue is on top, recovery of a past issue instead requires a valid newer top and its exact archive date/link/title matching the target permalink, whose date/body/source are still checked. With normal JSON available, its content is also checked. This does not retroactively prove a missed on-time publication. An HTTP 200 on an old/empty/inconsistent page fails. No Actions status, LLM `generated_at`, JSON file existence, footer date or HTTP Last-Modified proves publication. Generation guard additionally compares the expected normal JSON's title, sections, text and links to public content.

The validator is tied to the existing deterministic renderer's HTML classes. Layout changes must update the validator and tests together. It verifies the served HTML, not the external source articles' claims. Proxy/CDN propagation and transient network failure can produce a conservative negative observation; the event stores the reason rather than hiding it as a successful run.

If the first positive observation is after the deadline and no deadline observation exists, status is `published_deadline_unknown`: a page available now cannot establish when it was published. Do not infer an on-time result from `generated_at`, or fabricate a failure/recovery pair. The external scheduler must start before the deadline, poll across it, and itself be monitored. Loss of the observer, its clock or state is a monitoring outage, not evidence of on-time publication.

## External CLI (Node 24, no GitHub token)

Run from a checkout of the merged code on independent infrastructure, **outside GitHub Actions**:

```sh
# Read-only public check: exit 0 published, 1 not published, 2 invalid CLI/config.
node scripts/ai-publication.mjs check --issue 2026-10-06

# One shared persistent state file per issue; default site is the production origin.
node scripts/ai-publication.mjs observe --issue 2026-10-06 --state /persistent/ai-trends/2026-10-06.json

# Only after the receiver durably accepts the event:
node scripts/ai-publication.mjs ack --issue 2026-10-06 --state /persistent/ai-trends/2026-10-06.json --event ai-trends:2026-10-06:failure
```

`observe` emits JSON `{issue,status,pending}`. Exit 0 means `pending`, `on_time`, or `late_recovery`; 1 means `deadline_missed`; 2 means invalid input/state, lock conflict or another observer error; 3 means `published_deadline_unknown`. Check `status`, not just exit 0: `pending` is not publication. `--issue` may be omitted to select the latest Tuesday/Thursday/Saturday in JST, but automated delivery should explicitly enumerate each due issue and retain failed issues until their recovery is observed. Do not silently switch a still-failed issue's state to a new date. Each fetch has a 10-second bound and a 2MiB body limit; use a 60-second outer CLI bound. HTTPS origin only; at most three same-origin redirects are followed (Cloudflare canonicalizes `.html` URLs); cross-origin redirects fail closed. No recovery command is dispatched.

## Exactly one logical failure and recovery; delivery acknowledgement

The versioned issue-specific state stores each failure/recovery event once, with a stable ID `ai-trends:ISSUE:failure|recovery`. A lock directory serializes writers sharing the same filesystem; state replacement is atomic. No stale lock is automatically stolen. On crash, verify that the prior writer has stopped, inspect/back up the state, and remove its lock manually. Corrupt or mismatched state fails closed and is never reset automatically. Keep state outside the site/repository, on persistent local/shared storage with atomic rename and mkdir semantics. Independent copies of state or hosts with unshared storage are **not** a supported distributed lock.

Notification routing is intentionally not implemented. A future adapter must deliver `pending` in failure-before-recovery order, using the event ID as the receiver's idempotency key, and acknowledge only after durable acceptance. Until acknowledged, polls return the same pending ID for retry. An interrupted send can have reached the destination before ack; exactly-once user-visible delivery therefore **requires receiver-side deduplication**. Without that support, the guarantee is one logical event with at-least-once delivery, not one visible message. Recovery acknowledgement is rejected before failure acknowledgement. Record and monitor adapter failures separately; do not drop the outbox or mark an undelivered event as sent. No notification is sent by this PR or by the local verification.

## Generation and deploy safeguards

Scheduled generation fixes the issue from the run's immutable REST `created_at`, mapped to the latest 07:00 JST Tuesday/Thursday/Saturday slot. Queued execution and reruns therefore retain the same issue rather than recomputing the runner's current date. GitHub's cron delivery can itself be delayed: the mapping uses the creation time of the actual run, not an unavailable nominal cron timestamp. If a scheduled run is not created until a later distribution slot, its intended original slot cannot be reconstructed; use explicit manual `issue_date` for the missing issue. The read is public REST with no added token/Actions permission; unavailable/rate-limited metadata fails closed.

`workflow_dispatch` requires a real Tuesday/Thursday/Saturday `issue_date`; future issues are refused. Natural and manual recovery use the same guard:

- Normal JSON + public matching article: skip generation/render/deploy.
- Normal JSON + absent/stale/unverified public article: render and deploy only, including a clean git tree after a prior deploy failure.
- Absent JSON + already public target article: skip rather than regenerate.
- Absent JSON + absent public article: generate exactly the fixed target JSON.
- Existing invalid JSON (including zero curated sources or source URLs with whitespace, unsafe attribute characters, credentials or a scheme the renderer would drop): fail; never overwrite it automatically. At least one normal HTTPS example/quick-pick URL is required.

Before commit, a fetch/cmp refuses a differing same-date JSON on main. A later non-fast-forward push/rebase conflict fails rather than overwriting main. The existing generation concurrency and model/Git-write tool bans remain. Renderer selects the newest JSON when repairing an older issue, so the top is not reset to that older issue.

All four Cloudflare paths call `deploy-current-site.yml`. Its shared `site-deploy` job lock is acquired **before** checkout/fetch; it archives `origin/main`, never the caller's old HEAD. An old pending caller may run last, but fetches the newest snapshot. Running deployments are not cancelled. GitHub may replace an older pending job; the surviving job still deploys latest main. This assumes fast-forward main and no direct out-of-band production deploys. Legacy `auto-merge-digest.yml` uses a different GitHub Pages target and is not changed. The tests use temporary git repositories and a fake uploader; they do not contact Cloudflare.

## Remaining production activation steps (not performed)

1. Review/merge the Draft PR separately; ensure pre-change workflows/direct deploys have finished before relying on the common lock.
2. Provision an independent scheduler with a correct UTC/JST clock, Node 24, persistent state and a single shared writer per issue. Start checks before 10:30 and across the boundary (for example every minute with the outer bound above); retain each failure until observed recovery. Monitor scheduler health and poll/clock/storage errors. GitHub Actions cron alone is insufficient.
3. Select a notification destination/adapter with event-ID deduplication, durable acceptance, ordered delivery and explicit ack. Configure its production authentication only with separate authorization; none is supplied here.
4. Verify staged old-HTTP200, missing article, mismatched bodies, concurrent writer, adapter send failure, repeat poll and delayed-recovery scenarios; enable production notification only after that review. No automatic recovery dispatch is part of the design.
