# CLAUDE.md

## プロジェクト概要

tech-news-daily: 技術ニュースを毎日収集・整形し、GitHub Pages で公開する静的サイト。CCR routine (`trig_01LvUYkX4UXHkv8KDLsFH9eL`) が WebSearch → HTML 生成を毎日自動実行する。

## HTML 構造と CCR routine の同期

`index.html` のセクション構成・CSS クラス・要素（stats-bar, toc, numbers-bar, editorial 等）を変更した場合、CCR routine (`trig_01LvUYkX4UXHkv8KDLsFH9eL`) の prompt も必ず更新する。routine はテンプレートとして `index.html` の構造を前提に毎日生成するため、HTML 構造と prompt が乖離すると生成結果が壊れる。

対象の対応表:

| HTML 側の変更 | routine prompt 側の更新 |
|---|---|
| 新セクション追加（例: Code & Tools） | prompt にセクション定義を追加 |
| 新 CSS クラス追加（例: .deep-dive, .editorial） | prompt に該当クラスの使い方を記述 |
| カード階層の変更 | prompt の出力フォーマット仕様を更新 |
| feed.xml のエントリ形式変更 | prompt の feed.xml 生成部分を更新 |

## 日次コンテンツ生成ワークフロー

手動で `index.html` を更新する場合、以下の順序で実行する:

1. 現在の `index.html` を `archive/YYYY-MM-DD.html` にコピー
2. `archive/index.html` に新エントリを追加
3. `index.html` を新フォーマットで生成
4. `feed.xml` に新エントリを追加（Atom フィード）
5. commit → push（GitHub Pages が自動デプロイ）

CCR routine はこの 1-5 を自動実行する。手動更新時も同じ順序を守ること。

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
