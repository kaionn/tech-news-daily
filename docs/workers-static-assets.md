# Workers Static Assets migration (prepared, not activated)

## Scope

One site, https://tech-news.kaion-lab.com/, contains daily digest (/), AI product trends (/ai-trends.html and /ai-trends/), plugin trends (/trends.html), archives, public JSON and Atom (/feed.xml). All four primary deployment callers use deploy-current-site.yml. Generation schedules, Claude models and AI issue guards remain unchanged.

The separate kaionn/tech-learning-daily repository serves daily foundational articles at https://tech-learn.kaion-lab.com/ using Pages project tech-learning-daily. It is not a confirmed weekly-news target and is excluded. PR7's publication-monitor Worker is separate from this site host. This migration does not configure secrets, grant permissions, activate monitoring, modify DNS, create a cloud preview, remove Pages or switch production.

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

Intentional difference: nonexistent paths return **404**, not the root HTML. The current Pages site without a 404 file returns root HTML with 200 for missing paths. Workers uses not_found_handling=none, never SPA fallback. Today's Atom archive link can remain unavailable until the next daily archive step; migration does not invent missing historical issues.

Local preview requires no cloud credentials: create a temporary directory, stage public files, copy config alongside public/, and use `wrangler dev --local --config <temporary-config>`. Never point assets at the repo root. Verify root, trends.html, ai-trends.html, dated AI article, archive/, dated digest, feed.xml, public JSON, CSS/icons and missing paths. Compare final paths, content bytes, media types, relative CSS, Atom XML and AI top/permalink agreement. Repo scripts/prompts, dotfiles, Wrangler config and monitor source must return 404.

Cloud preview is a separate authorized operation after token-policy review. Use a distinct staging Worker with no production domain, Cron, secrets or DO bindings, or deliberately enable version URLs only for the assets-only site. Version URLs are public unless Cloudflare Access protects them; they share the version's resources and are not isolated environments. Do not reuse the monitor Worker. Record exact source SHA/version and do not run generation.

The manual-only `deploy-workers-preview.yml` workflow deploys latest main to the fixed `tech-news-daily-site-preview` Worker, using the existing CI secrets. Dispatch it on main after review/merge: `gh workflow run deploy-workers-preview.yml --ref main`. It has a separate preview lock, a ten-minute timeout and no target inputs. It does not read/change SITE_DEPLOY_TARGET or attach a custom domain. The snapshot config must retain the reviewed assets-only shape; script, routes, Cron, bindings or a changed asset directory fail before upload. Wrangler is pinned to the locally verified 4.148.0. Do not enable shell tracing or print/export secret values. An authorization failure stops this verification without creating credentials, expanding scopes or falling back to Pages.

A successful CI preview verifies deployment access for the credential actually bound in Actions; a local OAuth deployment alone does not. Compare the source SHA, public content and excluded-path 404s before preparing production. This dispatch uploads existing content and never runs a generator. The preview workflow is not a production cutover or a substitute for domain/TLS checks.

## Permissions and cost (not changed)

CI references CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, but names do not prove Workers access. No secret values or token policies were read. Verify account-scoped Workers Scripts write permission before upload; a Pages-only token may be insufficient. Stop for authorization if new credentials or broader permissions are needed. Keep DNS/zone writes out of routine content deploy; use an authorized operator for domain setup.

Static asset requests are free and unlimited; storage has no added cost. Workers Free allows 20,000 assets/version and 25MiB/file; staging enforces these limits. This site has no Worker script, run_worker_first, DO, KV or R2. LLM generation costs and monitor usage are separate. No paid-plan upgrade is required for this design. Actual account plan/usage, Worker-name availability and CI token policy must be confirmed before remote upload.

## Cutover and rollback (not performed)

After separate review/merge and production-cutover approval:

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
