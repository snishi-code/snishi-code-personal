# 固定資産の売却・故障処理

この文書は、固定資産購入を月額化した `MonthlyCostItem` を、売却・故障・廃棄で途中終了するための次フェーズ仕様。
実装前の設計メモであり、現行実装にはまだこの操作はない。

## 目的

洗濯機・冷蔵庫・PC・車などを `fixed-asset` として購入し、生活コストとして月額化したあと、予定より早く売却・故障・廃棄した場合に次を同時に満たす。

- 固定資産購入そのものを購入月の PL 支出にしない。
- 生活コストは、利用済み期間の月額化分と、売却・故障時の残存損益で見る。
- 固定資産の BS 残高を残しっぱなしにしない。
- 売却益・売却損は、通常の家計カテゴリと混ぜすぎず、既定は `その他収入` / `その他支出` に寄せる。

## 対象

初期対応は、次の `MonthlyCostItem` だけを対象にする。

- `sourceEntryId` がある。
- `recognitionCreditAccountId` があり、その科目の role が `fixed-asset`。
- `status` が `active` または `paused`。
- 全体売却・全体故障のみ。部分売却は未対応。

対象外:

- サブスク、年払い、定期イベントなど、固定資産ではない月額化コスト。
- `sourceAllocationId` 由来の旧按分項目。
- 複数の実物を 1 つの `MonthlyCostItem` にまとめたケースの一部処分。

## 入力

月額化コスト画面の固定資産由来アイテムに「売却/故障」操作を置く。

必須:

- 処分日 `date`
- 売却額 `proceedsAmount`（故障・廃棄は 0）
- 売却額の入金先 `destinationAccountId`（`proceedsAmount > 0` のときだけ必須。role は `daily-asset` または `reserve-asset`）

既定:

- 売却益: `その他収入`（revenue / income-category）
- 売却損: `その他支出`（expense / expense-category）
- 故障・廃棄: 売却額 0 の売却として扱う

## 残存額の考え方

このアプリの固定資産月額化は、永続仕訳ではなく `MonthlyCostItem` の formula で生活コストを見る分析レイヤである。
そのため、処分時の損益は購入額そのものではなく、まだ生活コストとして認識していない残りを基準にする。

定義:

- `recognizedAmount`: `startMonth` から処分月の前月までに formula で認識済みの合計。
- `remainingAmount`: `amount - recognizedAmount`。0 未満にはしない。
- 処分月から先の formula は止めるため、処分時に `endMonth` を処分月の前月にする。

処分月の扱い:

- v1 では「処分月は未使用」とみなし、処分月から月額化を止める。
- 月末処分などで処分月も生活コストに含めたい場合は、ユーザーが処分日を翌月にする運用で回避する。
- 日割りはしない。

## 損益

- `proceedsAmount > remainingAmount`: 差額は売却益。
- `proceedsAmount < remainingAmount`: 差額は売却損。
- `proceedsAmount === remainingAmount`: 損益なし。
- 故障・廃棄は `proceedsAmount = 0` なので、原則 `remainingAmount` が売却損。

売却損は既定で `その他支出` に入れ、生活コストに含める。これは「想定より早く失った残りの生活コスト」と見るため。
売却益は既定で `その他収入` に入れる。

## 生成仕訳

現行スキーマは 2 行仕訳制約を持つため、売却・故障は必要に応じて複数の生成仕訳に分ける。
すべて同一 transaction で保存し、`metadata.monthlyCostId` と処分用 metadata を付けて通常編集・削除を fail-closed にする。

### 1. 月額化済み分の BS 調整

過去に formula で生活コストとして見た分は、永続仕訳では固定資産を減らしていない。
処分時に固定資産残高を残さないため、`recognizedAmount > 0` のときは生活コストに混ぜない調整仕訳を作る。

候補:

```text
借方 月額化累計調整（system-adjustment）
貸方 固定資産
```

この調整は Dashboard の生活コストから除外される必要がある。

### 2. 売却額の入金

`proceedsAmount > 0` のとき:

```text
借方 入金先資産
貸方 固定資産
```

金額は `min(proceedsAmount, remainingAmount)`。

### 3. 売却損

`proceedsAmount < remainingAmount` のとき:

```text
借方 その他支出
貸方 固定資産
```

金額は `remainingAmount - proceedsAmount`。

### 4. 売却益

`proceedsAmount > remainingAmount` のとき:

```text
借方 入金先資産
貸方 その他収入
```

金額は `proceedsAmount - remainingAmount`。

## 月額化コスト本体の更新

処分が保存されたら、対象 `MonthlyCostItem` を次のように更新する。

- `status = 'ended'`
- `endMonth = 処分月の前月`
- `updatedAt = now`
- 処分情報を保持する拡張フィールドまたは関連エンティティを追加する。

推奨は、後から監査できるように `AssetDisposal` のような独立エンティティを追加すること。
MVP で metadata だけにする場合でも、少なくとも `disposalDate`、`proceedsAmount`、`generatedEntryIds` は辿れるようにする。

## 保存境界

保存前に必ず検証する。

- 対象 `MonthlyCostItem` が固定資産由来である。
- 対象がすでに `ended` ではない。
- `proceedsAmount` は 0 以上の整数。
- `proceedsAmount > 0` のとき、入金先は `daily-asset` または `reserve-asset`。
- 固定資産科目の残高が、少なくとも処分で減らす金額以上ある。
- 同じ `MonthlyCostItem` に処分が重複登録されない。
- 生成仕訳、月額化コスト更新、必要なら CF 更新を 1 transaction で保存する。

## UI

月額化コスト画面の固定資産由来アイテムだけに操作を出す。

- ボタン名: `売却/故障`
- 売却額 0 を許可し、故障・廃棄として扱う。
- 保存前に、次を確認表示する。
  - 処分日
  - 売却額
  - 残存額
  - 売却益または売却損
  - 月額化コストが終了する月
  - 生成される仕訳の概要

## テスト観点

- 購入額 300,000 / 120 か月、60 か月経過後に 0 円故障 → 売却損 150,000、以後の月額化 0。
- 購入額 300,000 / 120 か月、60 か月経過後に 200,000 円売却 → 売却益 50,000。
- 処分月以降、Dashboard の月額化コストに対象アイテムが出ない。
- 固定資産 BS 残高が処分後に残らない。
- 生成仕訳は通常編集・削除できない。
- 同じアイテムの二重処分を拒否する。
- 売却額があるのに入金先がない場合は拒否する。

## 注意

この処理は会計上の厳密な減価償却ではなく、生活コスト判断のための月額化レイヤと、BS の固定資産残高を整合させるための実用設計である。
正式な会計帳簿として扱うなら、購入時から月次減価償却仕訳を永続化する設計に切り替える必要がある。
