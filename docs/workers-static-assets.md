# Workers Static Assets migration

## Scope

One site, https://tech-news.kaion-lab.com/, contains daily digest (/), AI product trends (/ai-trends.html and /ai-trends/), plugin trends (/trends.html), archives, public JSON and Atom (/feed.xml). All four primary deployment callers use deploy-current-site.yml. Generation schedules, Claude models and AI issue guards remain unchanged.

The separate kaionn/tech-learning-daily repository serves daily foundational articles at https://tech-learn.kaion-lab.com/ using Pages project tech-learning-daily. It is not a confirmed weekly-news target and is excluded. PR #7 is merged, but its publication-monitor Worker is separate from this site host; merging does not establish its activation state. Keep its secrets, Cron and bindings outside site-host changes. Preserve the Pages project and historical pages.dev host for rollback.

## Verified deployment and remaining checks (2026-10-11 UTC)

PRs [#8](https://github.com/kaionn/tech-news-daily/pull/8) and [#9](https://github.com/kaionn/tech-news-daily/pull/9) are merged. The later [production deploy run 38096740040](https://github.com/kaionn/tech-news-daily/actions/runs/38096740040) succeeded at 2026-10-10 23:56:58 UTC with:

- `SITE_DEPLOY_TARGET=workers` and source `fefaad6a53ce5162b9a406de627f38a6aba4ea2e`.
- 218 staged public files, 6,454,412 bytes; Wrangler 4.149.0.
- Worker `tech-news-daily-site`, version `060d5586-6420-43aa-9fcb-63f3858698df`.

This supersedes PR #9's earlier credential failure and pending-host-variable status. Do not repeat credential setup or production upload based on that older text. The run proves upload through CI; its “No targets deployed” output does not establish the externally managed Custom Domain association, current DNS/TLS, or current workflow enabled states.

Remaining read-only acceptance checks:

1. Verify `tech-news.kaion-lab.com` is associated with `tech-news-daily-site` in Cloudflare and TLS is valid. Inspect the existing association before considering any DNS/domain change.
2. Compare public responses against the **deployed source snapshot**, including daily/AI/plugin pages, canonical redirects, media types and excluded-path 404s, using the command below.
3. Read current `SITE_DEPLOY_TARGET` and all four publishing workflow states. They were temporarily disabled during cutover; a successful manual deploy alone does not prove that the three scheduled generators resumed.
4. Observe the next natural scheduled publication and its shared Workers deployment. Do not dispatch generation solely to verify migration.

The 2026-10-11 saved cloud environment could fetch Git and read Actions logs through the connector, but its network proxy denied direct production HTTPS and GitHub management API requests. Those live checks remain unverified, not failed site checks. No DNS, credentials, workflow state or production deployment was changed by this verification work.

## Deployment contract

Repository variable `SITE_DEPLOY_TARGET` selects the host:

| Value | Behavior |
| --- | --- |
| unset, empty, `pages` | Existing Pages project `tech-news-daily` |
| `workers` | Assets-only Worker `tech-news-daily-site` |
| other | Fail before fetch/upload; no implicit fallback |

Both paths keep the shared site-deploy lock acquired before checkout/fetch, uploading an archive of latest origin/main, never an old caller HEAD. Workers config and staging code also come from that latest snapshot. Upload failure fails the job without automatic fallback. The 10-minute job timeout remains. No new Cloudflare build integration or Worker Cron is required: generation remains on GitHub Actions.

`scripts/stage-static-assets.mjs SOURCE OUTPUT` copies only required top-level HTML/CSS/Atom/icons, HTML under archive/ and ai-trends/, and JSON under data/. Dotfiles and all other repository files are excluded. Symlinks/nonregular public files, missing required assets, existing output directories, overlapping trees, files over 25MiB and more than 20,000 files fail closed. The output parent must exist. A new public asset type requires an explicit allowlist update. Pages keeps its existing tracked-file archive for fallback.

`wrangler.jsonc` contains no Worker script, bindings, secrets, routes or Cron. workers_dev and preview_urls are false. Its sibling public/ is created only in temporary staging. No ASSETS binding is needed for an assets-only Worker.

## URL compatibility and previews

The auto-trailing-slash HTML policy retains Pages-style behavior: /trends.html and dated .html links redirect to extensionless URLs; /archive/ serves its index. Atom IDs, absolute links, OGP metadata, article paths and public JSON are not rewritten. Keep the same custom domain at cutover to preserve subscriptions and links.

Intentional difference: nonexistent paths return **404**, not the root HTML. The pre-migration Pages site without a 404 file returned root HTML with 200 for missing paths. Workers uses not_found_handling=none, never SPA fallback. Today's Atom archive link can remain unavailable until the next daily archive step; migration does not invent missing historical issues.

Local preview requires no cloud credentials: create a temporary directory, stage public files, copy config alongside public/, and use `wrangler dev --local --config <temporary-config>`. Never point assets at the repo root. Verify root, trends.html, ai-trends.html, dated AI article, archive/, dated digest, feed.xml, public JSON, CSS/icons and missing paths. Compare final paths, content bytes, media types, relative CSS, Atom XML and AI top/permalink agreement. Repo scripts/prompts, dotfiles, Wrangler config and monitor source must return 404.

Cloud preview is a separate authorized operation after token-policy review. Use a distinct staging Worker with no production domain, Cron, secrets or DO bindings, or deliberately enable version URLs only for the assets-only site. Version URLs are public unless Cloudflare Access protects them; they share the version's resources and are not isolated environments. Do not reuse the monitor Worker. Record exact source SHA/version and do not run generation.

The manual-only `deploy-workers-preview.yml` workflow deploys latest main to the fixed `tech-news-daily-site-preview` Worker, using the existing CI secrets. Dispatch it on main after review/merge: `gh workflow run deploy-workers-preview.yml --ref main`. It has a separate preview lock, a ten-minute timeout and no target inputs. It does not read/change SITE_DEPLOY_TARGET or attach a custom domain. The snapshot config must retain the reviewed assets-only shape; script, routes, Cron, bindings or a changed asset directory fail before upload. Wrangler is pinned to the locally verified 4.148.0. Do not enable shell tracing or print/export secret values. An authorization failure stops this verification without creating credentials, expanding scopes or falling back to Pages.

A successful CI preview verifies deployment access for the credential actually bound in Actions; a local OAuth deployment alone does not. Compare the source SHA, public content and excluded-path 404s before preparing production. This dispatch uploads existing content and never runs a generator. The preview workflow is not a production cutover or a substitute for domain/TLS checks.

## Repeatable read-only verification

Use Node 24 and an archive of the SHA recorded by the latest successful deploy, not an uncommitted checkout or a newer generator commit that has not deployed yet:

```sh
snapshot_dir=$(mktemp -d)
git archive fefaad6a53ce5162b9a406de627f38a6aba4ea2e | tar -x -C "$snapshot_dir"
node scripts/verify-site.mjs "$snapshot_dir" https://tech-news.kaion-lab.com
check_status=$?
rm -rf "$snapshot_dir"
(exit "$check_status")
```

Update the example SHA when a later deployment succeeds. The verifier stages the same public allowlist locally and performs only unauthenticated GETs: 13 representative assets plus 11 internal/nonexistent paths. It checks exact source bytes, media types and final canonical URLs, permits at most three same-origin redirects, and fails on network/TLS errors or a missing sample. Normal TLS verification stays enabled. HTTP is allowed only for loopback local previews. Exit zero proves these sampled responses, not every historical URL, Cloudflare account configuration, or scheduler health. It never deploys, generates content, changes settings or sends alerts.

Read repository settings using an already authorized GitHub session (no credential values):

```sh
gh api repos/kaionn/tech-news-daily/actions/variables/SITE_DEPLOY_TARGET --jq '{name,value}'
for workflow in daily-digest.yml weekly-ai-trends.yml weekly-plugin-trends.yml deploy-site.yml; do
  gh api "repos/kaionn/tech-news-daily/actions/workflows/$workflow" --jq '{path,state}'
done
```

Expected selection is `workers`, and each state must be `active`. API denial is an unknown state; do not infer `active` from YAML schedules. If disabled, the exact operation to review is enabling that named workflow in `kaionn/tech-news-daily`; do not silently enable, dispatch, or change the variable.

| Caller | Schedule in the checked-in workflow (UTC) | Shared deployment |
| --- | --- | --- |
| `daily-digest.yml` | Daily 21:00 | `deploy-current-site.yml` |
| `weekly-ai-trends.yml` | Mon/Wed/Fri 22:00 (Tue/Thu/Sat 07:00 JST) | same |
| `weekly-plugin-trends.yml` | Sun/Tue/Thu 22:00 (Mon/Wed/Fri 07:00 JST) | same |
| `deploy-site.yml` | Main content push / manual | same |

## Permissions and cost (not changed)

CI references CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The successful run above establishes that its bound credential could upload the site Worker at that time; it does not reveal token policy or guarantee future access. No secret values or token policies were read during this follow-up. Stop for authorization if new credentials or broader permissions are needed. Keep DNS/zone writes out of routine content deploy; use an authorized operator for domain setup.

Static asset requests are free and unlimited; storage has no added cost. Workers Free allows 20,000 assets/version and 25MiB/file; staging enforces these limits. This site has no Worker script, run_worker_first, DO, KV or R2. LLM generation costs and monitor usage are separate. No paid-plan upgrade is required for this design. Actual account plan/usage, Worker-name availability and CI token policy must be confirmed before remote upload.

## Cutover and rollback runbook

The following describes coordinated host changes, not outstanding instructions to repeat the successful upload. Any further production/DNS/credential change requires its own authorization:

1. Keep SITE_DEPLOY_TARGET unset/pages. Review token policy and perform separately authorized staging deployment and URL/body checks.
2. Wait for active deploys and prevent new deploys during a coordinated cutover. Prepare a latest-main production Worker without a public route. Record source SHA/Worker version and current Pages deployment, domain association and DNS metadata.
3. Move tech-news.kaion-lab.com from Pages to the site Worker's Custom Domain. Cloudflare requires an active zone and cannot create a Custom Domain over an existing CNAME. Inspect actual DNS; do not blindly delete records. Verify TLS/paths, select SITE_DEPLOY_TARGET=workers, and resume the pipeline. Drain queued jobs so old host selections do not survive. Domain setup stays outside routine content config.
4. Retain Pages project, fallback deploy code and historical pages.dev host. That hostname does not become workers.dev. Verify any old-host redirects separately.

Rollback is coordinated, never automatic: pause/drain deploys, either `wrangler rollback <version-id>` on the assets-only Worker, or reselect pages, upload latest main to Pages, verify it and restore the saved Pages domain/DNS association. The variable alone does not move the hostname. Resume only after date/body/TLS checks. A version rollback restores older article content; prefer latest-main reupload for configuration-only faults. Do not delete either host or change monitor state.

## Official references

- [Migration](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
- [HTML routing](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)
- [Billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [CI authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)
- [Rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
