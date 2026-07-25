# tech-news-daily: 週次プラグイントレンドセクション（疎結合 workflow + data/*.json 一次ソース）

作成日: 2026-07-20

## 背景

「開発トレンド紹介プロダクト」構想のうちトレンド系を、新規サイトを立てず tech-news-daily に週次で追加する。ニュース（LLM 要約のフロー型）とトレンド（数値収集 + 週次差分）はパイプラインの性質が別物なので疎結合に設計する。対象は **AI コーディング系**（Claude Code プラグイン / MCP サーバー / AI コーディング CLI・拡張）1 カテゴリ、**固定ウォッチリスト方式**（ユーザー確認済み 2026-07-20）。

## 調査結果

- 日次 run は `.github/workflows/daily-digest.yml`（cron 21:00 UTC）: claude-code-action 生成 → workflow step が commit/push → wrangler で Cloudflare Pages に自前 deploy。GITHUB_TOKEN push は `deploy-site.yml` を発火させない
- `deploy-site.yml` は手動 push 用（paths: index.html / archive/** / style.css / feed.xml）
- サイトは `index.html`（LLM が毎日全再生成、5 セクション）+ `style.css`（静的）。`data/` `scripts/` は未存在。repo に package.json 無し
- npm downloads API（`api.npmjs.org/downloads/point/last-week/{pkg}`）は無認証。scoped パッケージはバルク取得不可のため 1 件ずつ叩く
- GitHub stars は `GET /repos/{owner}/{repo}` の `stargazers_count`。GITHUB_TOKEN で足りる（PAT 不要）。stars の履歴 API は無いため週次スナップショット蓄積が必須
- VS Code Marketplace は公式 API 無し（非公式 extensionquery のみ）

## 設計判断

### 1. 表示は静的 `trends.html` をスクリプトが決定論的に生成（採用）

週次 workflow 内の Node スクリプトが `data/` を読んで `trends.html` を丸ごと生成する。`index.html` はヘッダーに `trends.html` への静的リンクを持つだけ。

- 理由: 数値経路に LLM を挟まない（幻覚・フォーマット崩れゼロ）。日次生成への影響は「プロンプトに静的リンク 1 行」のみ
- 却下案 A「日次 prompt が trends.json を読んで index.html 内にセクション描画」: 数値の転記を LLM に任せることになり、毎日 322 行の prompt に描画仕様が増える。疎結合の原則にも反する
- 却下案 B「週次も claude-code-action で生成」: OAuth トークン消費が増えるだけで、決定論的処理に LLM は不要

### 2. データレイアウト（一次ソース = data/*.json）

```
data/plugins/watchlist.json            # 追跡対象（手動編集。1 エントリ追加で翌週から反映）
data/plugins/snapshots/2026-W30.json   # 週次スナップショット（ISO 週番号、JST 基準）
data/plugins/trends.json               # 最新週 + 前週比を計算済みの生成物（サイト・将来の CLI 配信が読む）
```

- watchlist エントリ: `{ "id", "name", "category": "claude-code" | "mcp" | "ai-tool", "github": "owner/repo" | null, "npm": "pkg-name" | null, "url", "description" }`。`description` は 1〜2 文の静的な日本語説明（手動編集。トレンド解釈は書かず、ツールが何かだけを書く）
- snapshot: `{ "week", "collected_at", "items": [{ "id", "stars", "npm_weekly_downloads" }] }`
- trends.json: 各 item に現在値 + 前週値 + delta + 伸び率 + **直近 8 週の履歴系列**（スパークライン用。全 snapshot から再計算）。前週スナップショットが無い項目は delta を null（表示は「—」、NEW バッジ）にして落とさない

### 2b. trends.html の画面構成（モック v4 で確定・2026-07-20 ユーザー承認済み）

参照: リポジトリ `tmp/mock-trends.html`（デザイン確定版 v4 = v2 に「今週の新顔」とタグを統合したマージ版）

1. **ヘッダー + 3 ページナビ**（日刊 / プラグイントレンド / AI プロダクト動向）
2. **週間概況文**: 「16 中 13 が上昇。最大の伸びは X (+N%) で M 週連続」形式 + 新顔の最大伸び 1 行。件数・最大伸び・連続上昇週数など**データから機械的に言える範囲のみ**のテンプレート生成（解釈・因果の推測文は生成しない。LLM 非経由の原則を守る）
3. **急上昇 TOP 5（ウォッチリスト内）**: カテゴリ横断で週間伸び率（stars / npm DL 伸び率の大きい方）順。順位 + 8 週スパークライン + description + delta + タグ
4. **今週の新顔（GitHub 発掘）**: 拡張セクション（Task 4-5）。NEW バッジ + 🔥伸びバッジ（前週 pool にあれば実 delta、無ければ「約 +N/週 (平均)」= stars ÷ 経過週数）+ AI 紹介文 3〜4 文（失敗時は GitHub description フォールバック）+ タグ + created 日付
5. **カテゴリ別ツールカード**: ツール名 + 言語タグ + 8 週スパークライン（インライン SVG polyline、依存なし）+ description + stars / npm DL の各 metric（▲▼・伸び率・相対バー。npm 未公開は「npm 未公開」表示）
6. カテゴリごとの傾向コメントは**書かない**（解釈になるため。v2 モックにあった傾向文は v4 で削除済み）

タグの供給源（全て決定論）: ドメインタグ = watchlist の category / rising は topics からのマッピング表、言語タグ = GitHub API の `language` フィールド（収集時に snapshot へ保存）。履歴が 2 週未満の項目のスパークラインは非表示（プレースホルダにしない）。

### 3. 収集スクリプトは依存ゼロの Node 単発スクリプト

`scripts/weekly-plugin-trends.mjs`（Node 20+ 組み込み fetch、package.json 不要）。処理順: watchlist 読込 → GitHub / npm 取得（失敗した項目は null 記録で続行、全滅時のみ exit 1）→ snapshot 書出 → 前週 snapshot と突合して trends.json 生成 → trends.html 描画。ローカルでも `node scripts/weekly-plugin-trends.mjs` で全再現可能。

### 4. 週次 workflow は日次と同パターンの自己完結型

`.github/workflows/weekly-plugin-trends.yml`: cron `0 22 * * 0`（月曜 07:00 JST。JST 日付境界 15:00 UTC から 7h 離れており cron 遅延 2.5h でも同日）+ workflow_dispatch。permissions を yaml 内で明示（`contents: write`。kaionn org 規約）。checkout → スクリプト実行 → 変更検証 → `github-actions[bot]` 名義で commit/push → `git archive HEAD` クリーンコピーから wrangler deploy（daily-digest.yml と同一パターン。GITHUB_TOKEN push は deploy-site.yml を発火させないため自前 deploy が必須）。

### 5. 初期ウォッチリスト（15 件前後・後から自由に増減）

- claude-code: anthropics/claude-code (`@anthropic-ai/claude-code`), ryoppippi/ccusage (`ccusage`), musistudio/claude-code-router
- mcp: modelcontextprotocol/servers, modelcontextprotocol/typescript-sdk (`@modelcontextprotocol/sdk`), github/github-mcp-server, microsoft/playwright-mcp (`@playwright/mcp`), upstash/context7
- ai-tool: cline/cline, RooCodeInc/Roo-Code, continuedev/continue, Aider-AI/aider, openai/codex (`@openai/codex`), google-gemini/gemini-cli (`@google/gemini-cli`), sst/opencode, All-Hands-AI/OpenHands

実装時に `gh api` で repo 実在を検証してから確定する（リネーム・移転があり得る）。

## 拡張: 急上昇リポジトリ発掘 + LLM 紹介文（2026-07-20 ユーザー確定）

参考ポスト https://x.com/so_ainsight/status/2079041116180242577 （「今週 GitHub で急上昇した AI リポジトリ 10 選」+ 各 2〜3 行の日本語紹介文）の体験を週次ページに取り込む。watchlist 定点観測とは別ブロックとして trends.html に「📈 今週の急上昇」セクションを追加する。

### 発掘（決定論的・スクリプト）

- GitHub Search API（`gh` 不使用、REST + GITHUB_TOKEN）で複数クエリ（`topic:ai` / `topic:llm` / `topic:mcp` / キーワード claude・agent 等）を叩き、「created が直近 60 日以内 + stars しきい値以上」を stars 順でマージ・dedupe
- watchlist 掲載済み + `data/plugins/featured.json`（過去に紹介した full_name と週の履歴）を除外して上位 10 件を `data/plugins/rising/{week}.json` に書く（`blurb_ja: null` で初期化）
- featured.json に今週分を追記（再掲防止）

### 紹介文（LLM・失敗容認）

- 週次 workflow に claude-code-action step を追加（`continue-on-error: true`）。`prompts/weekly-trends-blurbs.md` の指示で rising/{week}.json の各項目に日本語 2〜3 文の `blurb_ja` を書き込む（git 操作は daily 同様 disallowedTools で物理禁止）
- 描画は blurb_ja が null なら GitHub の英語 description にフォールバック（LLM 失敗でも run は完走）

### workflow の実行順

collect+discover（script）→ blurbs（claude-code-action、失敗容認）→ render（script --render-only）→ commit → deploy

## タスク

- [x] Task 1: `data/plugins/watchlist.json` 初期ウォッチリスト作成（repo 実在検証込み・description 記入）+ `scripts/weekly-plugin-trends.mjs`（収集 → snapshot → trends.json → trends.html 生成。画面は `tmp/mock-trends.html` の構成に従う）。ローカル実行で trends.html まで生成できること
- [x] Task 2: `.github/workflows/weekly-plugin-trends.yml` 新設（cron 月曜 07:00 JST、permissions 明示、commit/push + wrangler deploy）
- [x] Task 3: `index.html` ヘッダーに trends.html への静的リンク追加 + `prompts/daily-digest.md` に同リンクの維持指示を同一コミットで追記（CLAUDE.md の HTML/prompt 同期規約）+ `deploy-site.yml` の paths に `trends.html` 追加
- [x] Task 4: 発掘フェーズ実装（GitHub Search 複数クエリ → rising/{week}.json + featured.json）+ trends.html に「今週の急上昇」セクション追加
- [x] Task 5: `prompts/weekly-trends-blurbs.md` 新規 + workflow に claude-code-action step（continue-on-error、git 禁止ガード）+ render step 追加
- [x] Task 6: `gh workflow run weekly-plugin-trends.yml` で初回実行し、公開 URL・データ整合・紹介文生成を検証

## 受け入れ条件

- 週次 run 完了後、https://tech-news.kaion-lab.com/trends.html で watchlist 全項目の stars / npm 週間 DL と前週比が見られる
- 初週（前週データ無し）でも run は成功し、前週比は「—」表示になる
- 一部項目の取得失敗（404 等）でも run は落ちず、該当項目のみ欠測表示になる
- `daily-digest.yml` は本施策のファイルに一切触れず、従来どおり成功し続ける（疎結合）
- watchlist.json に 1 エントリ追記するだけで、翌週の run から新項目が表に載る
- 読まなくなったら weekly workflow を disable するだけで撤退でき、日次 run に影響しない

## 対象ファイル

- `data/plugins/watchlist.json` - 新規（追跡対象リスト）
- `scripts/weekly-plugin-trends.mjs` - 新規（収集 + 差分 + trends.html 生成、依存ゼロ）
- `.github/workflows/weekly-plugin-trends.yml` - 新規（週次 cron、自己完結 deploy）
- `trends.html` - 生成物（スクリプト出力、手編集しない）
- `index.html` / `prompts/daily-digest.md` - ヘッダーリンク追加 + prompt 同期（同一コミット）
- `.github/workflows/deploy-site.yml` - paths に trends.html 追加

## validation

- `node scripts/weekly-plugin-trends.mjs` がローカルで exit 0、`data/plugins/snapshots/` と `trends.html` が生成される
- 前週 snapshot 有り/無しの両ケースで実行して trends.json の delta が期待どおり（無し → null）
- `gh workflow run weekly-plugin-trends.yml` → run success → 公開 URL で表示確認
- 翌日の daily run success を確認（疎結合の実証）

## 参考

- ハンドオフ: `~/.claude/handoffs/tech-news-daily/weekly-plugin-trends.md`
- secretary: `9ba772ff`（着手済み）
- kaionn org セキュリティ規約: `~/.claude/rules/_projects/kaionn-org.md`（permissions 明示）
- cron 遅延の学び: learnings 2026-07-17（日付境界から 2.5h 以上離す）
