# Agent Coordination 運用

Codex / Claude / 人間の責務を分け、複数エージェントが同じブランチ・同じファイルを同時に触って
混線しないようにするための不変条件。サイト憲法（外部送信ゼロ / ローカルファースト / dev・main 保護 /
ドキュメント原則）を上書きしない。

> 作業管理の参考資料は `Workspace/_workspace-management/`（Obsidian で読む作業管理正本）。
> Notion / Handoff は使わない（Notion connector は切断済み、Handoff フォルダは廃止）。
> Claude への実装指示の正本は、ユーザーが会話に貼り付けた本文。`_workspace-management/` は
> Claude にとって参照のみで、Claude が自動で従う指示正本ではない（編集は管理役 Codex がユーザー許可時に行う）。

## 役割

- **人間**: 最終判断。Claude 作業開始の承認。`dev` / `main` への merge 判断。Codex と Claude の両方の会話・状態を見られる唯一の主体。
- **Codex**: 設計・監査・指示書作成支援。コード / ビルド成果物 / コミットの編集は、ユーザーが明示的に許可した狭い範囲に限る。Claude 向け指示書は、ユーザーが明確に依頼したときだけ作る。
- **Claude**: 主実装担当。会話に貼り付けられた指示本文を正とし、指定された worktree だけを編集する。

## 状態判断の優先順位

2 つの AI アプリ（Codex / Claude）が同時に動き、さらに人間が Claude へ直接指示する場合がある。
そのため、Codex は「自分が知らない Claude 側の追加指示が存在し得る」ことを前提にする。

1. ユーザーの最新発言・方針決定
2. Claude の最新完了報告・対象 worktree / branch の実状態
3. 各 repo 内のドキュメント・実際の checkout（恒久仕様の正本）
4. `_workspace-management/*.md`（作業管理の参考資料・現況整理）

食い違う場合は、ユーザーの最新発言と実際の branch / worktree / diff を優先し、仮定で指示書や監査結論を
作らず、必要なら人間に確認する。

## 指示書の渡し方

タスク別の指示書は、**会話に直接貼り付ける（コピペ）**。

- Codex は、ユーザーが「指示書を作って」など明確に依頼した場合だけ Claude 向け指示書を書く。
- 実ユーズメモ・方針相談・未実装メモを、そのまま勝手に Claude 向け指示書へ変換しない。
- Codex が指示書を書く場合も、最終的に人間が会話へ貼り付け、Claude の実装開始を承認する。
- 形式は後述の「指示書テンプレート」を使う。

## Claude に渡す filesystem root

原則として、そのタスク専用の Claude worktree だけを渡す。

渡さないもの:

- `Workspace/` 全体
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

## Claude 完了時チェック

完了時に以下を報告する。

- 変更概要
- commit hash
- `git status --short --branch`
- 実行した検証
- 未実行の検証と理由
- 判断に迷った点

## Codex 監査

Codex は Claude の差分を監査する。コード / ビルド成果物 / コミットは、ユーザーが明示的に許可した狭い範囲を除いて修正しない。
追加の Claude 向け指示書は、ユーザーが明確に依頼した場合だけ作る。確認項目:

- サイト憲法違反がないこと
- 外部送信・外部 CDN がないこと
- `simple-ledger-src/` を直し、必要に応じて `simple-ledger/` を再ビルドしていること
- i18n / data-ui / CSS variables / design tokens を守っていること
- テスト・no-exfil guard が通っていること

## 指示書テンプレート

会話に貼り付ける指示書は以下の形式を使う。

```md
## 目的 / 背景
## 対象リポ・ファイル
## 変更内容（具体）
## やってはいけないこと
## 検証手順
## 受け入れ条件
```

## やってはいけないこと

- Claude に workspace 全体を渡さない。
- Claude に medical リポを参照させない。
- 指示書・内部監査メモ・作業中メモを GitHub へ push しない。
- 外部送信ゼロに例外を作らない。
