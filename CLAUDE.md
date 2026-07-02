# CLAUDE.md

## プロジェクト概要

tech-news-daily: 技術ニュースを毎日収集・整形し、GitHub Pages で公開する静的サイト。CCR routine (`trig_01LvUYkX4UXHkv8KDLsFH9eL`) が WebSearch → HTML 生成を毎日自動実行する。

## デプロイパイプライン（CCR → GHA auto-merge → Pages）

CCR routine はサンドボックス上の作業ブランチ `claude/**` にコミットするだけで、**main へは直接 push しない**。`git push origin main` は PAT を実体化するため auto-mode classifier に阻まれる（＝以前サイトが数日更新されなかった真因）。責務を分離している:

1. **生成 (CCR)**: routine が `index.html` 等を作業ブランチにコミットする。CCR ハーネスがそのブランチをハーネス自身の認証で自動 push する（PAT 不要）。
2. **反映 (GitHub Actions)**: `.github/workflows/auto-merge-digest.yml` が `claude/**` への push を検知し、head コミットが `YYYY-MM-DD のテックニュースダイジェスト` 形式のときだけ main へ取り込む（fast-forward、衝突時は新しい digest を `-X theirs` 優先）。
3. **デプロイ**: 同 workflow が続けて Pages をデプロイする。`pages.yml`（`push: main` trigger）は `GITHUB_TOKEN` 由来の push では発火しないため、auto-merge 側で `configure-pages` → `upload-pages-artifact` → `deploy-pages` を自前実行している。

routine prompt には main への push 手順・PAT を**入れない**（入れても classifier で死ぬだけ）。digest ブランチが放置されて main に届かなくなったら、まず auto-merge workflow の Run 失敗を疑う（`gh run list --workflow=auto-merge-digest.yml`）。手動復旧は `git merge --ff-only origin/claude/<branch>` → `git push origin main`。

## HTML 構造と CCR routine の同期

`index.html` のセクション構成・CSS クラス・要素（stats-bar, toc, numbers-bar, editorial 等）を変更した場合、CCR routine (`trig_01LvUYkX4UXHkv8KDLsFH9eL`) の prompt も必ず更新する。routine はテンプレートとして `index.html` の構造を前提に毎日生成するため、HTML 構造と prompt が乖離すると生成結果が壊れる。

対象の対応表:

| HTML 側の変更 | routine prompt 側の更新 |
|---|---|
| 新セクション追加（例: Code & Tools） | prompt にセクション定義を追加 |
| 新 CSS クラス追加（例: .deep-dive, .editorial） | prompt に該当クラスの使い方を記述 |
| カード階層の変更 | prompt の出力フォーマット仕様を更新 |
| feed.xml のエントリ形式変更 | prompt の feed.xml 生成部分を更新 |

### routine prompt の更新手段

prompt 更新は claude.ai の routine 編集画面（https://claude.ai/code/triggers/trig_01LvUYkX4UXHkv8KDLsFH9eL）からユーザーが手動で貼り替える。セッション側は新 prompt をファイルで用意して渡すところまで。

現行の prompt (v4 以降) は main への push・PAT を含まない（デプロイは GHA auto-merge が担うため。上記「デプロイパイプライン」参照）。そのため RemoteTrigger 経由の更新も classifier に引っかからなくなったが、routine 編集は UI 手動貼り替えを既定の運用とする。

## 日次コンテンツ生成ワークフロー

手動で `index.html` を更新する場合、以下の順序で実行する:

1. 現在の `index.html` を `archive/YYYY-MM-DD.html` にコピー
2. `archive/index.html` に新エントリを追加
3. `index.html` を新フォーマットで生成
4. `feed.xml` に新エントリを追加（Atom フィード）
5. commit → push（GitHub Pages が自動デプロイ）

CCR routine は 1-4 を作業ブランチ上で自動実行し、5 の main 反映＋デプロイは GHA auto-merge が担う（「デプロイパイプライン」参照）。手動更新時は自分で main に commit → push すれば `pages.yml` が直接デプロイする（手動 push は auto-merge を経由しない）。

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
