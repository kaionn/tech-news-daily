# CLAUDE.md

## プロジェクト概要

tech-news-daily: 技術ニュースを毎日収集・整形し、GitHub Pages で公開する静的サイト。GitHub Actions workflow `daily-digest.yml` が claude-code-action で WebSearch → HTML 生成 → main push → Pages デプロイを毎日自動実行する（2026-07-05 に CCR routine から全面移行）。

## デプロイパイプライン（GHA daily-digest: 生成→push→Pages）

`.github/workflows/daily-digest.yml`（cron `8 21 * * *` = 06:08 JST、`workflow_dispatch` で手動実行可）が単一 workflow で完結する:

1. **生成 (claude-code-action@v1)**: `prompts/daily-digest.md` の指示に従い Claude がファイルを生成・編集する。**Claude は git 操作を一切しない**（ファイル生成のみ）
2. **反映 (workflow step)**: 生成物（`index.html` / `archive/` / `feed.xml`）に変更があり、`index.html` に当日日付が含まれることを検証してから `github-actions[bot]` 名義で `YYYY-MM-DD のテックニュースダイジェスト` として main へ commit/push する。変更ゼロ・日付不整合は run を fail させる（**失敗が必ず可視化される**のがこの構成の要）
3. **デプロイ**: `GITHUB_TOKEN` push は `pages.yml` を発火させないため、同 workflow が `configure-pages` → `upload-pages-artifact` → `deploy-pages` を自前実行する

認証は repo secret `CLAUDE_CODE_OAUTH_TOKEN`（Pro/Max サブスクの OAuth トークン、ローカルで `claude setup-token` を実行して生成・失効時も同コマンドで再発行）。PAT は不要。

稼働確認: `gh run list --workflow=daily-digest.yml`。失敗時は `gh run view <id> --log-failed`。手動リトライは `gh workflow run daily-digest.yml`。

### 旧構成（CCR routine、2026-07-05 停止）

旧構成は CCR routine (`trig_01LvUYkX4UXHkv8KDLsFH9eL`) が `claude/**` ブランチに commit → ハーネスが自動 push → `auto-merge-digest.yml` が main へ取り込む方式だった。2026-07-03 からハーネスの branch push が**サイレントに失敗**する障害（5 run 連続、routine 側は毎回正常完了・ログにエラーなし・Claude GitHub App 設定も正常）が続いたため GHA へ全面移行し、routine は claude.ai 側で pause した。障害は Anthropic に報告済み。`auto-merge-digest.yml` は routine を誤って再開した場合の受け皿として残置している。sandbox は `persist_session: false` のため push されなかった digest は復元不可（2026-07-03〜05 号は欠番）。

## HTML 構造と生成 prompt の同期

`index.html` のセクション構成・CSS クラス・要素（stats-bar, toc, numbers-bar, editorial 等）を変更した場合、生成 prompt `prompts/daily-digest.md` も**同一コミットで**必ず更新する。prompt はテンプレートとして `index.html` の構造を前提に毎日生成するため、HTML 構造と prompt が乖離すると生成結果が壊れる。

対象の対応表:

| HTML 側の変更 | prompt 側の更新 |
|---|---|
| 新セクション追加（例: Code & Tools） | prompt にセクション定義を追加 |
| 新 CSS クラス追加（例: .deep-dive, .editorial） | prompt に該当クラスの使い方を記述 |
| カード階層の変更 | prompt の出力フォーマット仕様を更新 |
| feed.xml のエントリ形式変更 | prompt の feed.xml 生成部分を更新 |

prompt は repo 内ファイルなので通常の Edit → commit → push で更新できる（旧 CCR 時代の「claude.ai UI で手動貼り替え」は不要になった）。prompt には git 操作を書かない — commit/push/検証は `daily-digest.yml` の責務で、Claude はファイル生成のみを担う。

## 日次コンテンツ生成ワークフロー

手動で `index.html` を更新する場合、以下の順序で実行する:

1. 現在の `index.html` を `archive/YYYY-MM-DD.html` にコピー
2. `archive/index.html` に新エントリを追加
3. `index.html` を新フォーマットで生成
4. `feed.xml` に新エントリを追加（Atom フィード）
5. commit → push（GitHub Pages が自動デプロイ）

`daily-digest.yml` は 1-4 を Claude 生成で、5 を workflow step で自動実行する（「デプロイパイプライン」参照）。手動更新時は自分で main に commit → push すれば `pages.yml` が直接デプロイする。

## サイトアセット変更は push まで完了させる

`index.html` / `style.css` / `feed.xml` を変更したら、同セッション内で必ず commit → push まで完了させる。日次 workflow は毎朝 origin/main を前提に生成・push するため、ローカル未 push の変更は公開サイトに一切反映されないだけでなく、日次 push とローカルが分岐して退行状態（旧フォーマットでの公開継続）を生む。「実装完了 = push 完了」であり、コミットせずセッションを終えることを禁止する。

## archive/ の整合性

過去の「main push できていなかったバグ」により、`archive/index.html` の一覧リンクと `archive/YYYY-MM-DD.html` の実ファイルがズレることがある。片方だけ push が届いた日は、以下の 2 状態が残る:

- **デッドリンク**: 一覧には載っているが実ファイルが無い（404）
- **孤立ファイル**: 実ファイルはあるが一覧に載っていない

確認・復旧手順:

1. 実ファイル一覧: `ls archive/*.html`
2. 一覧のリンク: `archive/index.html` の `<a href="YYYY-MM-DD.html">` を抽出
3. 差分を突き合わせ、デッドリンクは git 履歴から HTML を復元（`git show <commit>:index.html`）、孤立ファイルは一覧に追記
4. git コミット履歴が一次ソース。archive フォルダが壊れても各日の digest コミットから全て復元できる

なお当日分（`index.html` のトップ）は、翌日 run の「昨日分をアーカイブ」ステップで初めて `archive/YYYY-MM-DD.html` 化される。当日中は `archive/index.html` の当日リンクが 404 になるが、これは仕様通り（バグではない）。

prompt の Step 7 self-review にはこの archive 整合チェックが含まれていないため、日次 run では自動修正されない。

## コミット前セルフチェック

`index.html` 生成後、以下を commit 前に検証する:

- stats-bar の記事数・カテゴリ数・ソース数が実際のカード数と一致する
- 全 `<a href>` が有効な URL（`http://` or `https://` 始まり）
- 前日の archive と記事が重複していない（タイトル照合）
- feed.xml の最新 `<entry>` の日付・タイトルが index.html と整合
- archive/index.html の先頭カードが今日の日付

## 重複回避

新規ダイジェスト生成時、直前の archive（`archive/YYYY-MM-DD.html`）を必ず読み、同一ストーリーの再掲載を避ける。同トピックの続報は可（新情報がある場合のみ）。

## サイト設計仕様

### 5 セクション構成

1. 🔥 Top Stories — Featured Cards（2-3 枚、冒頭 1 本は deep-dive + editorial コメント）
2. ⚡ Dev & Engineering — Standard Cards（4-6 枚）
3. 🇯🇵 日本語テックコミュニティ — Standard Cards（3-4 枚）
4. 🛠 Code & Tools — Standard Cards（ツール/ライブラリ特化）
5. 🔗 Quick Links — 1 行アイテム（5-8 件）

### 3 階層カード

| 階層 | クラス | 要素 |
|------|--------|------|
| Featured | `.card.featured` | key-points（3 点）+ why-it-matters + 読了時間 + content-type 絵文字 |
| Standard | `.card` | key-points（2 点）+ 読了時間 + content-type 絵文字 |
| Quick Link | `.quick-link` | 見出し + 1 文補足のみ |

### ヘッダー下の共通要素

- `.stats-bar`: 記事数・カテゴリ数・ソース数
- `.toc`: セクションアンカーリンク
- `.numbers-bar`: 印象的な数字のコールアウト

### カテゴリタグ（8 種）

AI, Dev, OSS, Security, Product, Infra, Frontend, Data

### コンテンツ種別絵文字

📦 リリース / 📜 解説 / 👀 注目 / 🔒 セキュリティ / 💰 ビジネス / 🛠 ツール / 🔬 研究

### リンク品質基準

生成 prompt（`prompts/daily-digest.md`）と手動生成の両方で以下を厳守する:

- 掲載 URL は一次ソースの記事直リンク必須（URL がパスを持つ個別記事であること）
- トップページ URL（例: thehackernews.com）・まとめサイト・アグリゲーター URL は掲載禁止
- 記事直リンクが見つからないニュースは掲載せず落とす
- push 前に self-review を実施: 全 URL の直リンク確認・日付・カテゴリ多様性・文字数のチェック
