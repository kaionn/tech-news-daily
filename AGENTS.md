# AGENTS.md

## プロジェクト概要

tech-news-daily: 技術ニュース・AI 動向・プラグイントレンドを生成し、Cloudflare Workers Static Assets で公開する静的サイト。ホストの設定・移行証跡・未確認事項は `docs/workers-static-assets.md` を参照。Pages project はロールバック用に維持する。

## デプロイパイプライン（GitHub Actions: 生成→push→共通配置）

`daily-digest.yml` は cron `0 21 * * *`（06:00 JST）、AI 動向は `weekly-ai-trends.yml`、プラグイントレンドは `weekly-plugin-trends.yml`。workflow の有効状態は GitHub API で別途確認する（YAML の存在だけでは稼働を証明しない）。

1. **生成**: 各 prompt に従ってファイルを生成・編集する。生成エージェントは git 操作を行わない。
2. **反映**: workflow が生成物を検証し、bot 名義で main に commit/push する。git 書き込み禁止ガードと、変更ゼロ・日付不整合を失敗にする既存検証を維持する。
3. **配置**: 各 caller が `deploy-current-site.yml` を呼び、`site-deploy` ロック取得後の最新 `origin/main` を配置する。手動 main content push は `deploy-site.yml` が同じ処理を呼ぶ。`GITHUB_TOKEN` push は別 workflow を発火しないため、生成 workflow 自身が配置を呼ぶ。

`SITE_DEPLOY_TARGET=workers` は assets-only Worker `tech-news-daily-site` を選ぶ。未設定/空/`pages` は Pages、未知値は失敗し、自動 fallback はしない。通常配置に独自ドメイン/DNS・監視 Worker の変更を含めない。認証値や権限を変更せず、稼働確認は `gh run list --workflow=daily-digest.yml` と公開本文検証で行う。

### Codex の git 操作はツール層で禁止（2026-07-17 対策）

2026-07-16/17 の 2 run で、action@v1 の実体更新（Codex 2.1.211 へ bump）を境に、Codex が prompt の禁止記述を無視して自分で `git commit` + `git push` するようになった（`Codex[bot]` 名義の unsigned ローカルコミット）。その結果 workflow の commit step が clean tree を見て「生成物に変更がない」で fail した（サイト自体は Codex[bot] push が `pages.yml` を発火させたためデプロイされていた）。

対策として `claude_args` に `--disallowedTools "Bash(git add:*),Bash(git commit:*),..."` を追加し、prompt 頼みでなくツール層で git 書き込み系を物理的に拒否する。workflow / prompt を変更する際もこのガードを外さないこと。commit step は「Codex が commit 済み」と「本当に生成失敗」をエラーメッセージで区別する。

### 旧構成（CCR routine、2026-07-05 停止）

旧構成は CCR routine (`trig_01LvUYkX4UXHkv8KDLsFH9eL`) が `Codex/**` ブランチに commit → ハーネスが自動 push → `auto-merge-digest.yml` が main へ取り込む方式だった。2026-07-03 からハーネスの branch push が**サイレントに失敗**する障害（5 run 連続、routine 側は毎回正常完了・ログにエラーなし・Codex GitHub App 設定も正常）が続いたため GHA へ全面移行し、routine は Codex.ai 側で pause した。障害は Anthropic に報告済み。`auto-merge-digest.yml` は routine を誤って再開した場合の受け皿として残置している。sandbox は `persist_session: false` のため push されなかった digest は復元不可（2026-07-03〜05 号は欠番）。

## HTML 構造と生成 prompt の同期

`index.html` のセクション構成・CSS クラス・要素（stats-bar, toc, numbers-bar, editorial 等）を変更した場合、生成 prompt `prompts/daily-digest.md` も**同一コミットで**必ず更新する。prompt はテンプレートとして `index.html` の構造を前提に毎日生成するため、HTML 構造と prompt が乖離すると生成結果が壊れる。

対象の対応表:

| HTML 側の変更 | prompt 側の更新 |
|---|---|
| 新セクション追加（例: Code & Tools） | prompt にセクション定義を追加 |
| 新 CSS クラス追加（例: .deep-dive, .editorial） | prompt に該当クラスの使い方を記述 |
| カード階層の変更 | prompt の出力フォーマット仕様を更新 |
| feed.xml のエントリ形式変更 | prompt の feed.xml 生成部分を更新 |

prompt は repo 内ファイルなので通常の Edit → commit → push で更新できる（旧 CCR 時代の「Codex.ai UI で手動貼り替え」は不要になった）。prompt には git 操作を書かない — commit/push/検証は `daily-digest.yml` の責務で、Codex はファイル生成のみを担う。

## 日次コンテンツ生成ワークフロー

手動で `index.html` を更新する場合、以下の順序で実行する:

1. 現在の `index.html` を `archive/YYYY-MM-DD.html` にコピー
2. `archive/index.html` に新エントリを追加
3. `index.html` を新フォーマットで生成
4. `feed.xml` に新エントリを追加（Atom フィード）
5. commit → push（main の content push は共通 Cloudflare 配置を起動）

`daily-digest.yml` は 1-4 を Codex 生成で、5 を workflow step で自動実行する（「デプロイパイプライン」参照）。手動更新時は自分で main に commit → push すれば `deploy-site.yml` が共通配置を呼ぶ。

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
