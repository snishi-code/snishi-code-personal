# Agent Handoff 運用

Codex / Claude / 人間の責務を分け、MCP 導入後も複数エージェントが同じブランチ・同じファイルを
同時に触って混線しないようにするための不変条件。サイト憲法（外部送信ゼロ / ローカルファースト /
dev・main 保護 / ドキュメント原則）を上書きしない。

## 役割

- **人間**: 最終判断。Claude 作業開始の承認。`dev` / `main` への merge 判断。
- **Codex**: 教師・設計・実装指示書作成・監査。コード / ビルド成果物 / コミットは編集しない。
- **Claude**: 実装担当。承認済み指示書に基づき、指定された worktree だけを編集する。

## MCP の位置づけ

- MCP は Codex から Claude を自動実行するためのものではない。
- MCP は handoff 文書・作業報告・監査メモを共有するための補助線として使う。
- Claude の実装開始は人間が承認する（MCP 導入で外部送信や権限拡大を正当化しない）。

## Handoff 置き場（リポ外）

推奨パス: `/Users/onishi/workspace/_agent-handoff/`

- GitHub に push されるリポの**外**に置く。
- 実タスクの指示書・Claude 作業報告・Codex 監査メモだけを置く。
- 医療リポや他カテゴリのコードを参照させるための抜け道にしない。

推奨ファイル:

- `current-task.md`: Codex が作る、Claude 向けの承認済み指示書。
- `claude-report.md`: Claude の作業報告。
- `audit-note.md`: Codex の監査メモ。

## Claude に渡す filesystem root

原則として以下だけを渡す。

- `/Users/onishi/workspace/_agent-handoff/`
- そのタスク専用の Claude worktree

渡さないもの:

- `/Users/onishi/workspace` 全体
- `snishi-code-medical` / `snishi-code.com`
- 他タスクの worktree
- 正規リポの `dev` / `main` checkout

## ブランチ / worktree

- 1 タスクにつき 1 つの専用 worktree を作る。ブランチ名は `claude/<task-name>`。
- Claude は `dev` / `main` に直接 commit / push しない。
- タスク完了後、人間または監査役が確認してから `dev` に merge する。

## Claude 開始時チェック

作業開始前に以下を報告する。

```sh
pwd
git branch --show-current
git status --short --branch
```

加えて、読み込んだ handoff ファイル名を報告する。

## Claude 完了時チェック

完了時に以下を報告する。

- 変更概要
- commit hash
- `git status --short --branch`
- 実行した検証
- 未実行の検証と理由
- 判断に迷った点

## Codex 監査

Codex は Claude の差分を監査する。コードは修正せず、必要なら追加指示書を作る。確認項目:

- サイト憲法違反がないこと
- 外部送信・外部 CDN がないこと
- `simple-ledger-src/` を直し、必要に応じて `simple-ledger/` を再ビルドしていること
- i18n / data-ui / CSS variables / design tokens を守っていること
- テスト・no-exfil guard が通っていること

## Handoff テンプレート

Claude へ渡す指示書は以下の形式を使う。

```md
## 目的 / 背景
## 対象リポ・ファイル
## 変更内容（具体）
## やってはいけないこと
## 検証手順
## 受け入れ条件
```

## やってはいけないこと

- MCP を使って Codex が Claude を勝手に実行開始しない。
- Claude に workspace 全体を渡さない。
- Claude に medical リポを参照させない。
- handoff フォルダをリポ内に置いて commit しない。
- 指示書・内部監査メモ・作業中メモを GitHub へ push しない。
- 外部送信ゼロに例外を作らない。
