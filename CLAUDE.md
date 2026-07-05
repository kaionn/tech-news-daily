# CLAUDE.md

## プロジェクト概要

tech-news-daily: 技術ニュースを毎日収集・整形し、GitHub Pages で公開する静的サイト。CCR routine (`trig_01LvUYkX4UXHkv8KDLsFH9eL`) が WebSearch → HTML 生成を毎日自動実行する。

## デプロイパイプライン（CCR → GHA auto-merge → Pages）

CCR routine はサンドボックス上の作業ブランチ `claude/**` にコミットするだけで、**main へは直接 push しない**。`git push origin main` は PAT を実体化するため auto-mode classifier に阻まれる（＝以前サイトが数日更新されなかった真因）。責務を分離している:

1. **生成 (CCR)**: routine が `index.html` 等を作業ブランチにコミットする。CCR ハーネスがそのブランチをハーネス自身の認証で自動 push する（PAT 不要）。
2. **反映 (GitHub Actions)**: `.github/workflows/auto-merge-digest.yml` が `claude/**` への push を検知し、head コミットが `YYYY-MM-DD のテックニュースダイジェスト` 形式のときだけ main へ取り込む（fast-forward、衝突時は新しい digest を `-X theirs` 優先）。
3. **デプロイ**: 同 workflow が続けて Pages をデプロイする。`pages.yml`（`push: main` trigger）は `GITHUB_TOKEN` 由来の push では発火しないため、auto-merge 側で `configure-pages` → `upload-pages-artifact` → `deploy-pages` を自前実行している。

routine prompt には main への push 手順・PAT を**入れない**（入れても classifier で死ぬだけ）。digest ブランチが放置されて main に届かなくなったら、まず auto-merge workflow の Run 失敗を疑う（`gh run list --workflow=auto-merge-digest.yml`）。手動復旧は `git merge --ff-only origin/claude/<branch>` → `git push origin main`。

### CCR push 失敗の切り分けとリカバリ

CCR ハーネスの作業ブランチ push は **Claude GitHub App が `kaionn/tech-news-daily` への Repository access 付きでインストールされていること**が前提。App が外れていると routine の生成・commit は正常完了するのに push だけがサイレントに失敗する（run ログの transcript は「The CCR harness will push the branch」で終わり、エラーは一切表示されない）。OAuth 再連携（Authorized GitHub Apps）と App インストール（Installed GitHub Apps）は**別管理**で、claude.ai で GitHub を再連携しても App のインストールは復活しない。claude.ai のコネクタ選択画面に本 repo が表示されない場合も同じ原因。

切り分け手順:

1. GitHub イベント履歴で `claude/**` ブランチの CreateEvent 有無を確認（正常時は発火 6〜8 分後にブランチが作られる）
2. `gh run list --workflow=auto-merge-digest.yml` で直近の workflow 実行を確認、0 件なら push 自体が未達
3. https://github.com/settings/installations の Claude App → Repository access に本 repo が含まれるか確認する

sandbox は `persist_session: false` のため、push されなかった digest はセッション終了とともに消失し復元不可（例: 2026-07-03 号は `archive/2026-07-03.html` が欠番のまま）。欠番を埋めようとせず、次回 run の正常化（App 再インストール等）を優先する。どうしても当日分を埋めたい場合のみ、main 上で直接ダイジェストを新規生成して push する（auto-merge 経由不要）。

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

### routine prompt に git config / commit author 指定を書かない

CCR サンドボックスには commit author を `Claude <noreply@anthropic.com>` へ re-author させる組み込み hook があり、prompt 側の `git config user.name` 指定や「amend 禁止」の指示より hook が優先される（prompt では制御できない）。prompt は author 設定に一切触れず、ハーネス既定に任せる（v5 で `git config` 行を削除済み）。

## 日次コンテンツ生成ワークフロー

手動で `index.html` を更新する場合、以下の順序で実行する:

1. 現在の `index.html` を `archive/YYYY-MM-DD.html` にコピー
2. `archive/index.html` に新エントリを追加
3. `index.html` を新フォーマットで生成
4. `feed.xml` に新エントリを追加（Atom フィード）
5. commit → push（GitHub Pages が自動デプロイ）

CCR routine は 1-4 を作業ブランチ上で自動実行し、5 の main 反映＋デプロイは GHA auto-merge が担う（「デプロイパイプライン」参照）。手動更新時は自分で main に commit → push すれば `pages.yml` が直接デプロイする（手動 push は auto-merge を経由しない）。

## サイトアセット変更は push まで完了させる

`index.html` / `style.css` / `feed.xml` を変更したら、同セッション内で必ず commit → push まで完了させる。CCR routine は毎朝 origin/main を前提に生成・push するため、ローカル未 push の変更は公開サイトに一切反映されないだけでなく、routine の日次 push とローカルが分岐して退行状態（旧フォーマットでの公開継続）を生む。「実装完了 = push 完了」であり、コミットせずセッションを終えることを禁止する。

## archive/ の整合性

過去の「main push できていなかったバグ」により、`archive/index.html` の一覧リンクと `archive/YYYY-MM-DD.html` の実ファイルがズレることがある。片方だけ push が届いた日は、以下の 2 状態が残る:

- **デッドリンク**: 一覧には載っているが実ファイルが無い（404）
- **孤立ファイル**: 実ファイルはあるが一覧に載っていない

確認・復旧手順:

1. 実ファイル一覧: `ls archive/*.html`
2. 一覧のリンク: `archive/index.html` の `<a href="YYYY-MM-DD.html">` を抽出
3. 差分を突き合わせ、デッドリンクは git 履歴から HTML を復元（`git show <commit>:index.html`）、孤立ファイルは一覧に追記
4. git コミット履歴が一次ソース。archive フォルダが壊れても各日の digest コミットから全て復元できる

なお当日分（`index.html` のトップ）は、翌日 routine の「昨日分をアーカイブ」ステップで初めて `archive/YYYY-MM-DD.html` 化される。当日中は `archive/index.html` の当日リンクが 404 になるが、これは仕様通り（バグではない）。

routine の Step 7 self-review にはこの archive 整合チェックが含まれていないため、routine では自動修正されない。

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

routine prompt と手動生成の両方で以下を厳守する:

- 掲載 URL は一次ソースの記事直リンク必須（URL がパスを持つ個別記事であること）
- トップページ URL（例: thehackernews.com）・まとめサイト・アグリゲーター URL は掲載禁止
- 記事直リンクが見つからないニュースは掲載せず落とす
- push 前に self-review を実施: 全 URL の直リンク確認・日付・カテゴリ多様性・文字数のチェック
