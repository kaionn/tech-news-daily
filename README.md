# Tech News Daily

AI が毎朝届けるテックニュースダイジェスト。

## URL

https://kaionn.github.io/tech-news-daily/

## 仕組み

1. Claude Code routine が毎朝 WebSearch でテックニュースを収集
2. HTML を生成して `index.html` を上書き、前日分を `archive/` に退避
3. push → GitHub Pages に自動デプロイ
