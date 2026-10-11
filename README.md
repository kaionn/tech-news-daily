# Tech News Daily

AI が毎朝届けるテックニュースダイジェスト。

## URL

https://tech-news.kaion-lab.com/

## 仕組み

1. GitHub Actions の `daily-digest.yml` が毎朝 WebSearch でテックニュースを収集
2. HTML を生成して `index.html` を上書き、前日分を `archive/` に退避
3. workflow が main へ反映し、共通 `deploy-current-site.yml` が最新 main を Cloudflare Workers Static Assets へ配置（`SITE_DEPLOY_TARGET=workers`）

AI 動向とプラグイントレンドも同じサイト・共通配置処理を使う。Pages はロールバック用に保持する。[移行状況と読み取り専用検証](docs/workers-static-assets.md)を参照。

## テスト

`node --test scripts/tests/*.test.mjs` で renderer・公開ガード・静的アセット・監視 Worker・配信検証のテストを実行する。
