/*
 * 日本語メッセージ。UI 文字列はコンポーネントに直書きせず、すべてここへ集約する。
 * 将来 en を足すときは同じキー集合の Record を用意し、locale で切り替える。
 *
 * 旧名称（INPUT / PL / BS / CF / INVENTORY）はキーにも値にも使わない。
 */
export const ja = {
  'nav.accounts': '勘定科目',
  'nav.allocations': '月割り台帳',
  'nav.cashflow': '資金繰り',
  'nav.timeline': 'タイムライン',
  'nav.settings': '設定',
  'nav.help': 'ヘルプ',

  'common.cancel': 'キャンセル',
  'common.save': '保存',
  'common.delete': '削除',
  'common.edit': '編集',
  'common.search': '検索',
  'common.sort': '並び替え',
  'common.sortDesc': '降順',
  'common.sortAsc': '昇順',

  // 一覧の並び替えの軸（仕訳一覧・月割り台帳で共通。正本は ui/ListSearchSort の LIST_SORT_AXES）。
  'listSort.date': '日付',
  'listSort.amount': '金額',
  'listSort.name': '名称',

  'common.required': '必須',
  'common.menu': 'メニュー',
  'common.home': 'ホーム',
  'common.loading': '読み込み中…',
  'common.proceed': '実行する',

  // 時間の単位（ズーム）。ヘッダーのセグメントと、時間平面の目盛り見出しで同じ語を使う。
  'zoom.group': '時間の単位',
  'zoom.day': '日',
  'zoom.month': '月',
  'zoom.year': '年',
  // 数値レンズには日の列が無い（1 日 1 列の表は数字として読めない）。理由を読み上げにも出す。
  'zoom.dayUnavailable': '日（数値では選べません）',

  'timeline.title': 'タイムライン',
  'timeline.intro': '時間の中で、勘定科目・持ち物・フローがどのようにつながるかを見ます。',
  // レンズ = 同じ時間平面の見え方。線分 = 帯とポッチ、数値 = 表。
  'timeline.lens': '見え方',
  'timeline.lens.segment': '線分',
  'timeline.lens.matrix': '数値',
  'timeline.previous': '前の期間',
  'timeline.next': '次の期間',
  'timeline.showEnded': '終了分も表示',
  'timeline.open': '開く',
  'timeline.empty': 'この期間に存在するものはありません。',
  'timeline.flow': '{credit} → {debit}',
  'timeline.flowCount': '{count}件のフロー',
  'timeline.generation': '持ち物を生成',
  'timeline.today': '今日',

  'dashboard.title': 'ホーム',
  'dashboard.entryActions': '日常入力（収入・支出・振替）',
  'dashboard.revenue': '収入',
  'dashboard.expense': '支出',
  'dashboard.netIncome': '収支',
  'dashboard.assets': '資産',
  'dashboard.liabilities': '負債',
  'dashboard.netAssets': '純資産',
  'dashboard.viewAll': 'すべて見る',
  'dashboard.moreEntries': 'さらに表示（残り {count} 件）',
  'dashboard.shownCount': '{total} 件中 {shown} 件を表示中',
  'dashboard.statDetail': '{label} {amount}、内訳を開く',
  'dashboard.noMonthEntries': '仕訳はまだありません。',
  'dashboard.entriesOf': '仕訳',
  // 支出の内訳（ホーム「支出」のタップ先）
  'expenseBreakdown.title': '支出の内訳',
  'expenseBreakdown.intro':
    '何へ支出したかを費用カテゴリ別に見られます。持ち物の月割り分も各カテゴリに含まれます。',
  'expenseBreakdown.byCategory': '費用カテゴリ別',
  'expenseBreakdown.categoryTotal': '支出合計',
  'expenseBreakdown.noCategory': 'この期間の支出はまだありません。',
  'expenseBreakdown.normalExpense': '通常支出',
  'expenseBreakdown.monthlyCost': '月割り',
  'expenseBreakdown.total': '支出合計',
  'expenseBreakdown.trend': '支出の推移',
  'dashboard.trendNet': '収支の推移',
  'dashboard.trendLiving': '支出の推移',
  'dashboard.trendAssets': '純資産の推移',
  'dashboard.trendDrillYear': 'その年の月別へ',

  'journal.monthlyCostTag': '月割り',

  // 継続コスト資産（項目名・金額・開始日・終了日の4項目。開始日 = 購入の仕訳の日付）
  'monthlyCost.amount': '金額',
  'monthlyCost.monthly': '月あたり',
  'monthlyCost.thisMonth': '今月の計上額',
  'monthlyCost.fromRule': 'くり返し記帳から',
  // 計上先 = 月割り（継続コスト）の費用/収入の行き先。income 行き（差引形）も通るため中立表記。
  'monthlyCost.expenseCategory': '計上先',
  'monthlyCost.editTitle': '持ち物を編集',
  'monthlyCost.name': '名称',
  'monthlyCost.showEnded': '終了分も表示',
  // 過去から再計算される項目を変えたときの注意（破壊的操作の予告。不具合ではなく仕様）。
  'monthlyCost.pastRecalcWarning':
    '金額・期間・計上先を変えると、過去の支出・収支・残存価値もさかのぼって再計算されます。',
  'monthlyCost.deleteConfirmTitle': '持ち物を削除しますか？',
  'monthlyCost.deleteConfirmBody':
    '「{name}」を削除します。購入の仕訳と回収の振替も一緒に削除されます。登録済みの返済仕訳（未来日付の振替）は残ります。',
  // 動詞体系（v13.1・作者確定 2026-08-16）: 破壊的操作は編集シート最下部（赤・注意文つき）。
  // 削除 = 取り消し不可（保険は書き出した JSON とスナップショットのみ・注意文に明記）。
  'monthlyCost.deleteAction': 'この持ち物を削除…',
  'monthlyCost.deleteDangerHint':
    '購入の仕訳と回収の振替も一緒に消えます。削除は取り消せません（保険は書き出した JSON とスナップショットだけです）。',
  'ccItem.startDate': '開始日',
  'ccItem.endDate': '終了日（任意）',
  'ccItem.endDateClear': '終了日を解除',
  'ccItem.period': '期間',
  'ccItem.remainingValue': '残存価値',
  // 動詞は「終了」（v13.1・行アクションのテキスト化。「アーカイブ」の語は持ち物系から撤去）。
  'ccItem.archiveTitle': '終了',
  // アーカイブシート（終了日 + 回収 + 残りの扱いを 1 枚で決める。シート自体が確認面）。
  'ccItem.archiveDateHint': 'この日で終わりにします。先の日付にすれば一覧へ戻せます。',
  'ccItem.archiveRecovery': '回収額',
  'ccItem.archiveRecoveryHint':
    '売却・返金などで戻ってきた額。既定は終了日時点の残存価値です。0 なら回収の仕訳は作りません。',
  'ccItem.archiveRecoveryTo': '回収先',
  'ccItem.archiveRemainder': '残り（{amount}）の扱い',
  'ccItem.archiveRemainderSpread': '期間に割り振る',
  'ccItem.archiveRemainderSpreadHint': '開始日から終了日までの各月へ、残りを配り直します。',
  'ccItem.archiveRemainderExpense': '終了日に全額費用にする',
  'ccItem.archiveRemainderExpenseHint':
    '過去の月額はそのままにして、残りを終了日の「{account}」へ 1 本で計上します。',
  'ccItem.archiveRemainderNoneHint': '残りがないので、どちらを選んでも結果は変わりません。',
  'ccItem.archiveConfirm': '終了する',
  'ccItem.openPurchase': 'その仕訳を開く',
  'ccItem.quickSpan': '{years}年',

  'cashflow.title': '資金繰り',
  // v13.4 ③: 起点はヘッダーの日付（基準日）。今日ではない。
  // v13.4 ④: 返済の登録・編集は月割り台帳へ移した（この画面は見るだけ）。
  'cashflow.intro':
    'ヘッダーの日付から先の仕訳で、自由に動かせるお金の推移を見ます。日付を変えるとその日を起点に見直します。返済計画の登録・編集は月割り台帳で行います。',
  'cashflow.freeFundsAsOf': '{date} の自由に動かせるお金',
  // 「いつ足りなくなるか」。下回りが無いときは警告色を使わない静かな 1 行。
  'cashflow.shortfallOn': '{date} に自由に動かせるお金が 0 を下回る見込みです。',
  'cashflow.shortfallNone': '{year}年まで、自由に動かせるお金が 0 を下回る予定はありません。',
  // グラフ（基準日起点・右へ横スクロールする日次折れ線）。
  'cashflow.chartTitle': '自由に動かせるお金の推移（{from} 〜 {to}）',
  'cashflow.chartExtend': 'さらに {months} ヶ月先へ',
  'cashflow.chartAtHorizon': '{year}年（見通せる上限）まで表示しています。',
  'cashflow.chartEnd': '{date} の見込み: ',
  'cashflow.chartSummary':
    '自由に動かせるお金の推移。{from} は {start}、{to} は {end}。この範囲の最低額は {low}。',
  'cashflow.chartTickYear': '{year}年',
  'cashflow.chartTickMonth': '{month}月',
  'cashflow.debtTitle': '支払用負債・返済予定',
  // v13.4 ④: 資金繰りの負債行は表示オンリー。タップ = 月割り台帳の同じ負債へ移動。
  'cashflow.debtIntro':
    'ヘッダーの日付の時点で残高がある負債だけを、残りの支払予定・次回支払日・残回数とともに出します。行をタップすると月割り台帳の同じ負債へ移動し、そこで返済予定を登録・編集できます。',
  'cashflow.debtOpenInAllocations': '{name} を月割り台帳で開く',
  'cashflow.debtNoPlan': '返済予定がありません（月割り台帳で登録できます）。',
  'cashflow.futureTitle': '先の入出金・振替予定',
  'cashflow.futureIntro':
    'グラフに出している範囲（{from} 〜 {to}）の予定です。ホームの 収入 / 支出 / 振替 で先の日付を選ぶと、ここに表示され資金繰りに反映されます。',
  'cashflow.futureEmpty': 'この範囲に予定はありません。',

  // 負債の新規作成（支出の支払い方法 / 振替の源泉・行き先から）
  'liability.form.title': '新しい負債を作る',
  'liability.form.intro':
    'クレジットカードやローンなどの負債科目を作ります。残高や返済は通常の入力（振替・支出）で動かします。',
  'liability.name': '名称',
  'liability.namePlaceholder': '例: 楽天カード / 自動車ローン',
  'liability.kind': '種類',
  'liability.role.card': 'クレジットカード等',
  'liability.role.loan': '借入・ローン',
  'liability.error.name': '名称を入力してください。',

  'adjust.intro': '実際の残高との差額を、任意の日に補正します（「締め」はありません）。',
  'adjust.account': '対象科目（資産・負債・費用・収入）',
  'adjust.date': '日付',
  'adjust.actual': '実残高',
  'adjust.expected': 'アプリ上の理論残高',
  'adjust.delta': '差額',
  'adjust.deltaHint': '差額 = 実残高 − 理論残高（プラスで増加、マイナスで減少）。',
  'adjust.save': '補正する',
  // 各勘定科目行から残高補正を開く導線（補正・勘定科目の統合）。
  'adjust.rowAction': '補正',
  'adjust.createTitle': '「{name}」の残高を補正',
  'adjust.noChange': '差額がないため、補正仕訳は作成しませんでした。',
  'adjust.error.actual': '実残高を入力してください。',
  'adjust.noAccounts': '補正できる科目がありません。',
  // 登録済みの補正（現実アンカー）は仕訳一覧から編集・削除する。
  'adjust.editTitle': '残高補正を編集',
  'adjust.editIntro':
    '理論残高は、この補正自身を除いて計算し直します（補正の二重掛けを避けるため）。',
  'adjust.update': '更新する',
  'adjust.removedZero': '差額がなくなったため、補正を削除しました。',
  'adjust.deleted': '残高補正を削除しました。',
  'adjust.deleteConfirmTitle': '残高補正を削除しますか？',
  'adjust.deleteConfirmBody':
    'この補正仕訳を削除します。対象日以降の理論残高は、補正前の状態に戻ります。',
  'adjust.deleteAction': 'この補正を削除…',
  'adjust.deleteDangerHint':
    '削除は取り消せません（保険は書き出した JSON とスナップショットだけです）。',

  // 初期残高（kind='opening'）。登録は科目追加シート、編集・削除は仕訳一覧から。
  'opening.account': '対象科目（資産・負債）',
  'opening.amount': '初期残高',
  'opening.date': '基準日',
  'opening.editTitle': '初期残高を編集',
  'opening.update': '更新する',
  'opening.deleted': '初期残高を削除しました。',
  'opening.deleteConfirmTitle': '初期残高を削除しますか？',
  'opening.deleteConfirmBody':
    'この初期残高を削除します。対象科目の初期残高はなくなり、資産・負債の残高の意味が変わります。',
  'opening.deleteAction': 'この初期残高を削除…',
  'opening.deleteDangerHint':
    '削除は取り消せません（保険は書き出した JSON とスナップショットだけです）。',
  'opening.error.amount': '初期残高を入力してください（0 は不可）。',

  'journal.adjustmentTag': '補正',

  'journal.title': '仕訳',
  'journal.searchPlaceholder': '摘要・メモで検索',
  'journal.from': '開始日',
  'journal.to': '終了日',
  'journal.clearFilter': '絞り込みを解除',
  'journal.empty': '該当する仕訳がありません。',
  'journal.opening': '初期残高',
  'journal.deleteConfirmTitle': '仕訳を削除しますか？',
  'journal.deleteConfirmBody': '「{description}」を削除します。この操作は取り消せません。',
  'journal.count': '{count}件',
  'journal.total': '合計',

  'entry.editTitle': '仕訳を編集',
  'entry.deleteAction': 'この仕訳を削除…',
  'entry.deleteDangerHint':
    '削除は取り消せません（保険は書き出した JSON とスナップショットだけです）。実際の取引を取り消すなら反対仕訳を使ってください。',
  'entry.date': '日付',
  'entry.description': '摘要',
  'entry.descriptionPlaceholder': '例: スーパーで食料品',
  'entry.debitAccount': '借方（増える・使う側）',
  'entry.creditAccount': '貸方（支払い元・減る側）',
  'entry.amount': '金額',
  'entry.memo': 'メモ',
  'entry.error.date-required': '日付を入力してください。',
  'entry.error.description-required': '項目を入力してください。',
  'entry.error.debit-required': '借方の科目を選んでください。',
  'entry.error.credit-required': '貸方の科目を選んでください。',
  'entry.error.same-account': '借方と貸方に同じ科目は選べません。',
  'entry.error.amount-invalid': '金額を入力してください（0 は不可）。',
  'entry.error.invalid-transfer':
    'この振替の組み合わせは登録できません。資金どうしの移動、資金からの返済、借入の実行のいずれかにしてください。',

  'entry.type.income': '収入',
  'entry.type.expense': '支出',
  'entry.type.transfer': '振替',
  'entry.income.title': '収入を記録',
  'entry.expense.title': '支出を記録',
  'entry.transfer.title': '振替を記録',
  'entry.manual.title': '簿記編集',
  'entry.income.target': '入金先',
  'entry.income.category': 'カテゴリ（収入）',
  'entry.expense.category': 'カテゴリ（支出）',
  'entry.expense.source': '支払元',
  'entry.transfer.from': '移動元',
  'entry.transfer.to': '移動先',
  // お金の流れ（簿記用語を出さない）
  'entry.item': '項目',
  'entry.itemPlaceholder': '例: スーパー / 給与 / 家賃',
  'entry.flow.income': '収入元 → 入る場所',
  'entry.flow.expense': '支払い方法 → 使い道',
  'entry.flow.transfer': '移動元 → 移動先',
  'entry.flow.manual': '貸方 → 借方',
  'entry.source.income': '収入元',
  'entry.destination.income': '入る場所',
  'entry.source.expense': '支払い方法',
  'entry.destination.expense': '使い道',
  // 継続コスト資産の入力: 行き先を「継続コスト資産（自由入力の項目名）」に切り替える。
  'entry.ccToggle': '持ち物として登録する',
  'entry.ccBackToCategory': '通常のカテゴリに戻す',
  'entry.ccTargetName': '持ち物の名前',
  'entry.ccTargetNameHint':
    '持ち物として登録する項目名です（例: 自動車 / 洗濯機）。勘定科目は増えません。',
  'entry.ccCategory': '計上先',
  'entry.error.loanNotExpense':
    'ローン（その他負債）は通常の支出の支払い元にできません。持ち物として登録するか、借入として振替で実行してください。',
  // 返済を資金繰りに入れるトグル ON 時の必須検証（口座・回数が無いと CF が作られないため fail closed）。
  'entry.error.repayAccount': '返済元の口座を選んでください。',
  'entry.error.repayCount': '返済回数は 1〜{max} の整数で入力してください。',
  'entry.source.manual': '左側（貸方）',
  'entry.destination.manual': '右側（借方）',
  'entry.detailToggle': '詳細（メモ）',
  // 逆仕訳・特殊編集は日常の「詳細」と分け、簿記編集として明示する。
  'entry.manualSwitch': '簿記編集（左→右を直接指定）',
  'entry.noAccounts': '候補の科目がありません。「勘定科目」で追加してください。',
  'entry.reversalTitle': '取消/返金を記録',
  'entry.reversalNote':
    '元の仕訳は削除せず、反対の仕訳を作成します。金額を変えれば部分返金も記録できます。',
  // 2 回目以降の取消で「この仕訳をいくら取り消し済みか」を常時見せる（0 件のときは出さない）。
  'entry.reversal.reversedSoFar': '取消済み: {reversed} / 残り: {remaining}',
  // 残りを超えても保存はできる（過剰返金・補償はありうる）。止めずに気づかせるだけ。
  'entry.reversal.overWarning': '取消済みと合わせて元の金額を超えます（このまま保存できます）。',
  'entry.monthlyizeRepayToggle': '分割・後日引落を資金繰りに入れる',
  'entry.monthlyizeRepayNote':
    '支払い元が負債のため、返済を未来日付の振替仕訳としてまとめて登録できます（仕訳一覧・資金繰りに反映）。',
  'entry.monthlyizeRepayAccount': '引落口座',
  'entry.monthlyizeRepayCount': '返済回数',
  'entry.monthlyizeRepayCountHint': '一度に登録できる上限は {max} 回です。',
  'entry.monthlyizeRepayStart': '初回引落日',
  'entry.monthlyizeRepayStartHint': '購入日とは別に、最初に現金が引き落とされる日を入れます。',
  'entry.error.category-required': '計上先を選んでください。',
  // 支出の支払い元（左辺）のローン導線。「ローンを組む」で既存ローン選択＋新規ローン作成へ切り替える。
  'entry.loanArrange': 'ローンを組む',
  'entry.loanArrangePick': '組むローンを選ぶ',
  'entry.loanArrangeEmpty': 'ローンがありません。「新しいローンを作成」で追加できます。',
  'entry.loanArrangeCreate': '新しいローンを作成',
  'entry.loanArrangeBack': 'ローンをやめる',

  'journal.reverseAction': '取消/返金を記録',
  // 行ボタンは短い動詞（v13.2: 記号は伝わらない。既存タグ「取消/返金」と同じ語）。
  'journal.reverseShort': '取消',
  'journal.reversalTag': '取消/返金',
  'journal.filteredByAccount': '「{name}」で絞り込み中',
  'journal.clearAccountFilter': '科目の絞り込みを解除',
  'journal.filteredByNormalExpense': '通常支出のみ',
  'journal.clearNormalExpenseFilter': '通常支出の絞り込みを解除',
  'journal.showFuture': '将来予定も表示',
  'journal.accountBalanceIncrease': '{name}の残高が増える金額: {amount}',
  'journal.accountBalanceDecrease': '{name}の残高が減る金額: {amount}',

  // 期間フィルタの選択肢ラベル（タグ画面などで再利用）。
  'statements.allPeriods': '全期間',
  'statements.thisMonth': '今月',
  'statements.thisYear': '今年',

  // 期間: ヘッダーの日付チップ（透明な date input の 1 タップ選択）。年・全期間のロジックは内部に維持する。
  'period.dateLabel': '{year}年{month}月{day}日',
  'period.openDate': '対象の日付を選ぶ',
  'period.yearUnit': '{year}年',
  'period.today': '今日',
  'period.allPeriod': '全期間',
  'period.pickerYear': '対象期間（年）',
  'period.noTrendData': '推移を表示するデータがありません。',
  'period.trendYearHint': '年ラベルをタップすると、その年の月別表示に切り替わります。',
  // 内訳ページ共通（収入 / 資産 / 負債 / 純資産）。旧・財務諸表を項目ごとに分解した。
  'breakdown.noData': 'データがありません。',
  'breakdown.drilldownHint': '科目をタップすると、その仕訳を一覧で確認できます。',
  'breakdown.viewEntries': '「{name}」の仕訳を表示',
  'breakdown.asOfDate': '{date} 時点の残高',
  'breakdown.subtotal': '小計',

  // 収入の内訳（ホーム「収入」のタップ先）。
  'income.title': '収入の内訳',
  'income.intro': '収入の入り方と、月ごとの推移です。',
  'income.total': '収入合計',
  'income.trend': '収入の推移',

  // 収支（ホーム「収支」のタップ先）。手元に残る額の推移を主役にする。
  'netIncome.title': '収支（手元に残る額）',
  'netIncome.intro': '収入から支出を引いた、毎月の残り方です。',
  'netIncome.revenue': '収入',
  'netIncome.expense': '支出',
  'netIncome.result': '収支',
  'netIncome.trend': '収支の推移',

  // 数値レンズの表（旧「年間・全体」画面。v13.5 D で時間平面のレンズへ吸収）。
  // v13.4 ②で利回りも導出（保存境界と同じもの）になり、過去列にも導出行が出る。
  // 「未来だけが投影」ではなくなったので、表全体が導出込みであることを先に名乗る。
  'matrix.projectionNote':
    '表は定期ルール・持ち物・投資利回りの導出を含みます。未来列にはまだ起きていない予定も含みます。',
  // 桁あふれで投影を打ち切った科目の注記（アプリ都合の端点を名乗る・仮の数字が本物の顔をしない）。
  'projection.truncatedNotice':
    '「{name}」の投影は金額が計算上限を超えるため {month} で打ち切りました。それ以降の投影は表示に含まれません。',
  'matrix.monthLabel': '{month}月',
  // 年をまたぐ窓なので、年の変わり目の列だけ年を名乗る（読み上げは常に年つき）。
  'matrix.monthLabelWithYear': '{year}年{month}月',
  'matrix.monthJump': '{date} 時点の残高をホームで見る',
  'matrix.yearDrill': '{year}年を月で見る',
  'matrix.itemColumn': '項目',
  'matrix.revenue': '収入',
  'matrix.expense': '支出',
  'matrix.net': '収支',
  'matrix.monthlyCost': '月割り',
  'matrix.totalAssets': '総資産',
  'matrix.netAssets': '純資産',
  'matrix.expenseCategory': '費目別: {name}',
  'matrix.caption': '{from} 〜 {to} の一覧',
  'matrix.noData': '表示できる仕訳データがありません。',

  // 資産の内訳（ホーム「資産」のタップ先）。4 枠（自由 / 自由でない / 投資 / 継続コスト台帳）。
  'assets.title': '資産の内訳',
  'assets.intro': '持っているお金・資産の内訳と、月ごとの推移です。',
  'assets.total': '資産合計',
  'assets.trend': '資産の推移',
  'assets.frame.free': '自由に動かせるお金',
  'assets.frame.fixed': '自由に動かせないお金',
  'assets.frame.investment': '投資',
  'assets.frame.ledger': '月割り台帳',

  // 負債の内訳（ホーム「負債」のタップ先）。
  'liabilities.title': '負債の内訳',
  'liabilities.intro': 'カードやローンなど、これから払うお金の内訳です。',
  'liabilities.total': '負債合計',
  'liabilities.trend': '負債の推移',
  'liabilities.cashflowLink': '返済計画・資金繰りを見る',

  // 純資産（ホーム「純資産」のタップ先）。正味の財産 = 資産 − 負債。
  'netAssets.title': '純資産（正味の財産）',
  'netAssets.intro': '資産から負債を引いた、正味の財産の推移です。',
  'netAssets.retained': '今期の損益',
  'netAssets.total': '純資産合計',
  'netAssets.trend': '純資産の推移',

  'accounts.title': '勘定科目',
  'accounts.intro':
    '大きな箱はアプリが管理します。箱の中の内訳だけを追加・名前変更・終了できます。登録済みの初期残高・補正は仕訳一覧で確認できます。',
  'accounts.edit': '内訳を編集',
  'accounts.addTitle': '{box}の内訳を追加',
  'accounts.boxLabel': '大分類',
  'accounts.boxLockedHint':
    '大分類は変更できません。分類を変えたい場合は、新しい内訳を作って古い内訳を終了してください。',
  'accounts.emptyBox': 'まだ内訳がありません。',
  // 開始日欄（§A 案1）: 空欄 = 過去へ開いた線分。明示値を空欄へ戻せば開始日を削除できる。
  'accounts.startDateHint': '空欄 = 過去の制限なし。空欄に戻すと開始日を削除します。',
  'accounts.openingAmount': '初期残高（任意）',
  'accounts.openingDate': '基準日',
  'accounts.openingHint':
    '入力すると、内訳の作成と同時に初期残高（opening 仕訳）を登録します。空欄なら内訳だけを作成します。登録した初期残高は仕訳一覧で確認できます。',
  'accounts.archiveRenameTitle': '終了済みと名前が重複しています',
  'accounts.archiveRenameBody':
    '同じ名前「{name}」の終了済み内訳があります。終了済み側を「{renamed}」へ変更して続行しますか？',
  'accounts.archiveRenameConfirm': '変更して続行',
  'accounts.name': '科目名',
  'accounts.balance': '残高',
  'accounts.periodAmount': '{period}の発生額',
  'accounts.autoBadge': '自動',
  'accounts.outsideSlice': 'この断面には存在しない',
  'accounts.archive': '終了',
  // 残高 0 の科目も無確認では終了させない（2026-08-15 作者合意）。残高が残る科目は
  // 振替シートが確認を兼ねるので、この確認は通らない。
  'accounts.archiveConfirmTitle': 'この科目を終了しますか？',
  'accounts.archiveConfirmBody':
    '「{name}」を今日を終了点として記録します。登録済みの仕訳はそのまま残ります。',
  'accounts.unarchiveConfirmTitle': '終了を解除しますか？',
  'accounts.unarchiveConfirmBody': '「{name}」の終了点を消して、また使えるようにします。',
  'accounts.archiveSkipTransfer': '振替せずに終了',
  'accounts.unarchive': '終了を解除',
  // 科目の削除 UI（v13.1・plan 未決①の解消）: 未使用なら活性・使用中は紐づき件数を添えて
  // 不活性（fail-closed の理由を見せる）。記録を残して使うのをやめるのはアーカイブ。
  'accounts.deleteAction': 'この科目を削除…',
  'accounts.deleteDangerHint':
    '削除は取り消せません（保険は書き出した JSON とスナップショットだけです）。',
  'accounts.deleteInUseHint':
    '仕訳 {entries} 件・持ち物 {items} 件・くり返し記帳 {rules} 件から参照されているため削除できません。使うのをやめるには「終了」を使ってください。',
  'accounts.deleteConfirmTitle': '科目を削除しますか？',
  'accounts.deleteConfirmBody': '「{name}」を削除します。この操作は取り消せません。',
  'accounts.showArchived': 'この断面に存在しない科目も表示',
  'accounts.type.asset': '資産',
  'accounts.type.liability': '負債',
  'accounts.type.equity': '純資産',
  'accounts.type.revenue': '収益',
  'accounts.type.expense': '費用',
  'accounts.role.daily-asset': '日常資産（現金・預金）',
  'accounts.role.investment-asset': '投資資産',
  'accounts.role.continuing-cost-asset': '月割り台帳（内部集約）',
  'accounts.role.payment-liability': '支払用負債（クレジットカード等）',
  'accounts.role.other-liability': 'その他の負債（ローン等）',
  'accounts.role.equity': '純資産（元入金等）',
  'accounts.role.income-category': '収入カテゴリ',
  'accounts.role.expense-category': '支出カテゴリ',
  'accounts.role.system-adjustment': '調整用（自動生成）',
  'accounts.inUse': '使用中',

  // ユーザー向けの「大きな箱」（大分類）。アプリ側が守り、ユーザーは内訳だけを編集する。
  'box.cashFixedHint':
    'Suica・チャージ残高など、支払いには使えるが資金繰りの原資には数えないお金。',
  'box.investment': '投資',
  'box.shortTermDebt': 'カード・未払',
  'box.longTermDebt': 'ローン',
  'box.income': '収入カテゴリ',
  'box.expense': '支出カテゴリ',
  'box.addSubdivision': '内訳を追加',
  'box.addLoan': 'ローンを追加',
  'box.addCategory': 'カテゴリを追加',
  'box.longTermDebtHint':
    '住宅ローン・分割返済など返済予定を持つ債務です。借入の実行や分割返済の予定は、振替（借入）や持ち物の登録の導線から作れます。',

  'settings.title': '設定',
  'settings.dataSection': 'データ',
  'settings.export': 'JSON で書き出し',
  'settings.exportDesc': '台帳を JSON ファイルに書き出します（バックアップ・端末間共有用）。',
  'settings.import': 'JSON を読み込み',
  'settings.importDesc':
    'JSON ファイルを取り込みます。取り込み前に自動でスナップショットを作成します。',
  // 取込の免責 1 行（§C・2026-08-11）。機構は足さない（fail-closed schema が既にゲート）。
  'settings.importDisclaimer': 'このアプリが書き出した JSON 以外の取込は動作保証外です。',
  'settings.snapshots': 'スナップショット',
  'settings.snapshotsDesc': '取り込み・復元の前に自動保存された状態です。ここから復元できます。',
  'settings.resetAll': 'すべてのデータを削除',
  'settings.resetAllDesc': '台帳・科目・仕訳・スナップショットをすべて削除し、初期状態に戻します。',
  'settings.about': 'アプリ情報',
  'settings.ledgerName': '台帳名',
  'settings.ledgerNameRequired': '台帳名を入力してください。',
  'settings.currencyHint': '表示に使う単位の文字列です（8 文字まで）。換算はしません。',
  'settings.fractionDigits': '小数の表示桁数',
  'settings.fractionDigitsHint':
    '入力できる小数の桁もこの設定に従います。保存されている金額は変わりません。',
  'settings.currency': '金額の単位',
  'settings.currencyRequired': '金額の単位を入力してください。',
  'settings.version': 'バージョン',
  'settings.schemaVersion': 'スキーマ版',
  'settings.revision': 'リビジョン',
  'settings.offlineNote': 'データは端末内にのみ保存され、外部へ送信されません。',

  // スナップショット理由コード（保存は 'import' / 'restore'・表示はここで訳す）。
  'snapshot.reason.import': 'import前',
  'snapshot.reason.restore': '復元前',
  'snapshot.restore': '復元',
  'snapshot.delete': '削除',
  'snapshot.empty': 'スナップショットはありません。',
  'snapshot.restoreConfirmTitle': 'この時点に復元しますか？',
  'snapshot.restoreConfirmBody':
    '現在のデータは上書きされます（復元前に自動でスナップショットを作成します）。',
  'snapshot.entries': '仕訳 {count} 件',

  'import.conflictTitle': '変更が競合しています',
  'import.conflictBody':
    '取り込むファイルは現在の台帳と別の版に基づいています（端末側 rev {local} / ファイル基準 rev {base}）。上書きすると現在のデータはスナップショットに退避され、ファイルの内容で置き換わります。続けますか？',
  'import.success': '{accounts} 科目・{entries} 件の仕訳を取り込みました。',
  'import.error.parse': 'JSON を解析できませんでした。ファイルが壊れている可能性があります。',
  'import.error.notOurFile': 'このアプリの書き出しファイルではありません。',
  'import.error.validation': '形式が正しくありません: {detail}',
  'import.error.unknownVersion': '未対応の版のデータです。',

  'reset.confirmTitle': 'すべてのデータを削除しますか？',
  'reset.confirmBody': 'この操作は取り消せません。必要なら先に JSON で書き出してください。',
  'reset.keyword': '削除',

  // 復旧画面（ErrorBoundary）。DB の版不整合（VersionError）で開けない詰みからの最終手段。
  'recovery.wipe': 'DB を初期化して再起動',
  'recovery.wipeFailed':
    'DB を削除できませんでした。このアプリを開いている他のタブ・ウィンドウをすべて閉じてください（閉じた時点で削除が完了することがあります）。そのあとページを再読み込みして、もう一度お試しください。',
  'recovery.schemaMismatchHint':
    '旧版データのままでは JSON の読み込みもできません。手順: ①「DB を初期化して再起動」で初期化 → ②起動後に設定から、現行版へ変換済みの JSON を読み込んでください。',

  'toast.saved': '保存しました。',
  'toast.recurringSavedFollowupFailed':
    'ルールは保存しましたが、画面の再読込に失敗しました。画面を開き直してください。',
  'toast.deleted': '削除しました。',
  'toast.exported': '書き出しました。',
  'toast.restored': '復元しました。',
  'toast.reset': 'すべてのデータを削除しました。',
  'toast.error': 'エラーが発生しました。',

  'help.title': 'ヘルプ',
  'help.body':
    'これは複式簿記の家計簿です。日々の収入・支出・振替を記録すると、ホームと各項目（収入/支出/収支/資産/負債/純資産）の内訳・推移に自動で反映されます。データは端末内にのみ保存され、外部送信はありません。バックアップや端末間共有は設定の「JSON で書き出し／読み込み」を使ってください。',

  'a11y.openMenu': 'メニューを開く',
  'a11y.back': '戻る',
  'a11y.home': 'ホーム',
  'a11y.scrollTop': '一番上へ移動',
  // ページ先頭の skip-link。行き先は本文（#main）なので、名前も行き先を言う
  // （「ホーム」だと押した先と読み上げが食い違う）。
  'a11y.skipToContent': '本文へ移動',

  // ドメイン/リポジトリ由来のユーザー表示エラー。domain/repository は LedgerError(code, params)
  // を投げ、表示は UI 層が errorText() で行う（保存境界の fail-closed なエラーも i18n に集約）。
  'error.account.roleTypeMismatch': '役割が区分と一致しません。',
  'error.account.typeLocked': '使用中の科目は区分を変更できません。',
  'error.account.roleLocked':
    '使用中の内訳は別の大分類へ移動できません。新しい内訳を作り、古い内訳を終了してください。',
  'error.account.nameConflict': '同じ名前の内訳が既にあります（別の箱でも重複できません）。',
  'error.account.nameConflictArchived': '同じ名前の終了済み内訳があります。',
  'error.account.deleteInUse': 'この科目は使用中のため削除できません。終了してください。',
  'error.account.periodInvalid': '科目の開始日・終了日を確認してください。',
  'error.account.referenceOutsidePeriod':
    'この科目を使う仕訳・予定・ルールが存在期間の外にあります。先に開始日・終了日または参照先を見直してください。',
  'error.account.archiveDate': '終了時の振替日は終了日と同じ日にしてください。',
  'error.account.archiveCounterpartType':
    '終了時の振替先は、元の科目と同じ区分から選んでください。',
  'error.entry.monthlyCost':
    '購入の仕訳は削除できません。持ち物の項目（月割り台帳）を削除すると一緒に消えます。',
  'error.entry.adjustment': '残高補正の仕訳は、仕訳一覧の補正行から編集・削除してください。',
  'error.entry.virtual': '導出専用の仮想仕訳は保存できません。',
  'error.entry.invalidStructure': '仕訳の形式が正しくないため保存できません。',
  'error.entry.unknownAccount': '仕訳が存在しない勘定科目を参照しています。',
  'error.entry.accountRoleMismatch': '仕訳の勘定科目の役割と区分が一致していません。',
  'error.adjust.targetNotFound': '対象科目が見つかりません。',
  'error.adjust.assetLiabilityOnly': '残高補正できるのは資産・負債・費用・収入の科目です。',
  'error.adjust.internalRole': '月割り台帳（内部の集約口座）と残高調整科目は残高補正できません。',
  'error.adjust.notFound': '対象の残高補正が見つかりません。',
  'error.adjust.notAdjustment': 'この仕訳は残高補正ではありません。',
  'error.opening.assetLiabilityOnly': '初期残高を登録できるのは資産・負債の科目です。',
  'error.opening.notOpening': 'この仕訳は初期残高ではありません。',
  'error.common.nameRequired': '名称を入力してください。',
  'error.common.amountInvalid': '金額を入力してください（0 は不可）。',
  'error.monthlyCost.dateRequired': '開始日（購入の仕訳の日付）を入力してください。',
  'error.monthlyCost.expenseCategory': '計上先の勘定科目を選んでください。',
  'error.monthlyCost.paymentSource':
    '支払い元は資金（現金・預金）かカード・ローンを選んでください。',
  'error.monthlyCost.repaymentAccount': '返済口座は日常資産を選んでください。',
  'error.monthlyCost.notFound': '対象の持ち物が見つかりません。',
  'error.monthlyCost.invalidStructure': '持ち物の内容が不正です。',
  'error.monthlyCost.endBeforeStart': '終了日は開始日以降にしてください。',
  // 4項目モデル（指示書#5）で新設したエラーコード。
  'error.monthlyCost.purchaseAfterEnd': '購入の仕訳の日付は終了日以前にしてください。',
  'error.monthlyCost.deleteLiability':
    '負債で購入した項目は削除できません。「終了」（終了日の設定）を使ってください。',
  'error.monthlyCost.recoveryDestination': '振替先の科目を選んでください。',
  'error.entry.ledgerAccount': '月割り台帳の科目は持ち物の登録からだけ使えます。',
  'error.account.archiveBalance':
    '残高が残っている科目は終了できません。先に振替で残高を 0 にしてください。',
  'error.recurring.everyMonthsInvalid': '周期は 1〜1200 か月の整数で入力してください。',
  'error.recurring.dayOfMonthInvalid': '起票日は 1〜31 日の整数で入力してください。',
  'error.recurring.periodInvalid': 'ルールの開始日・終了日を確認してください。',
  'error.recurring.settlementInvalid':
    '清算の対象（配分中の持ち物）と終了日を確認してください。切り替え日は起票日から次回起票日までの間である必要があります。',
  'error.recurring.amountChangeModeRequired':
    '金額の変更方法（全期間、または今日から）を選んでください。',
  'error.recurring.splitDependency':
    '今日分の仕訳または持ち物を安全に分けられません。対象の起票内容を確認してください。',
  // ルール由来（rec- 仕訳 / ccr- item）の読み取り専用化（作者決定 2026-08-15）。
  // 画面から到達できない経路でも保存境界で fail-closed に止める。
  'error.recurring.generatedReadOnly':
    'くり返し記帳から生まれた記録は直接編集できません。ルール側を編集してください。',
  // 監査 2026-07-30 対応で新設したエラーコード。
  'error.monthlyCost.recoveryBeforeStart':
    '回収の振替の日付は開始日（購入の仕訳の日付）以降にしてください。',
  'error.monthlyCost.editLiability':
    '負債（カード・ローン）で購入した項目は、支払い元・金額・日付を変更できません（自動作成した返済の仕訳と合わなくなるため）。終わらせるには「終了」（終了日の設定）を使ってください。',
  'error.common.staleData':
    '別のタブ（またはウィンドウ）でデータが変更されています。ページを再読み込みしてから、もう一度お試しください。',
  'error.common.revisionExhausted':
    'データの更新番号が上限に達したため保存できません。JSON バックアップを書き出してから、DB を初期化して読み込み直してください。',
  'error.db.schemaVersionMismatch':
    '保存データのスキーマ版({found})がこのアプリの版({expected})と一致しません。JSON バックアップの読み込み、または「DB を初期化して再起動」で復旧してください。',

  // 戻る操作（dirty guard・終了確認）
  'guard.discardTitle': '変更を破棄しますか？',
  'guard.discardBody': '入力した内容は保存されません。',
  'guard.discardConfirm': '破棄する',
  'guard.discardCancel': '編集を続ける',
  'exit.confirmTitle': 'アプリを終了しますか？',
  'exit.confirmBody': 'データは端末内に保存されています。次回も続きから使えます。',
  'exit.confirmLabel': '終了する',

  // 符号付き金額入力（マイナス残高の初期残高・補正の実残高）
  'common.signedAmountHint':
    'マイナスは先頭に -（例: -3000）。立替金が相手側に振れている場合などに。',

  // 支出内訳 → 仕訳一覧ドリルダウン
  'expenseBreakdown.drillDown': '{name} の仕訳を見る',

  // 勘定科目の並び替え（箱内・上下ボタン式）
  'accounts.reorder': '並び替え',
  'accounts.reorderDone': '並び替えを終了',
  'accounts.moveUp': '上へ',
  'accounts.moveDown': '下へ',

  // 履歴の無い既存科目への初期残高登録（勘定科目画面の補正導線から自動分岐）
  'opening.registerTitle': '初期残高を登録（{name}）',
  'opening.registerIntro':
    'この科目にはまだ記録がありません。いまの実残高は補正（差額が収入/支出扱い）ではなく、初期残高として登録します。',
  'opening.registerSave': '初期残高を登録',

  // 「自由に動かせる」チェック（現預金の内訳のみ・既定 ON。OFF = 資金繰りの原資に数えない）

  // 返済設定（負債の勘定科目）と資金繰りの返済予定
  'accounts.repaymentAccount': '返済口座',
  'accounts.repaymentDay': '毎月の返済日',
  'accounts.repaymentUnset': '未設定',
  'accounts.repaymentHint': '設定すると、資金繰り画面の返済予定づくりで既定値になります。',
  'error.account.repaymentOnlyLiability':
    '返済口座・返済日はカード・未払 / ローンの科目にのみ設定できます。',
  'error.account.repaymentDayInvalid': '返済日は 1〜31 で入力してください。',

  // 投資の利回り投影（投資科目の編集シート・§D）
  'projection.entryDescription': '投影: {name}',
  'projection.suggestedAccountName': '投資益',
  'accounts.projectionAccountArchivedHint':
    '計上先は終了済みのため、投影は生成されません。別の収入科目を選ぶか、終了を解除してください。',
  'accounts.annualReturn': '想定利回り（年率%）',
  'accounts.annualReturnHint':
    '空欄 = 投影なし。設定すると、未来の断面にだけ毎月「計上先 → この科目」の評価益（投影）が現れます。',
  'accounts.projectionAccount': '投影の計上先',
  'accounts.projectionAccountHint':
    '評価益を計上する収入科目（例: 投資益）。利回りとセットで設定します。',
  'error.account.returnOnlyInvestment': '想定利回りは投資の科目にのみ設定できます。',
  'error.account.returnInvalid': '想定利回りは -99.99〜1000%（小数第2位まで）で入力してください。',
  'error.account.projectionPair': '想定利回りと投影の計上先はセットで設定してください。',
  'error.account.projectionAccountInvalid': '投影の計上先には既存の収入科目を選んでください。',
  // 支払用負債・返済予定（v13.4 ④ で資金繰りから月割り台帳へ移設。文言は画面をまたいで共有する）
  'repay.sectionTitle': '支払用負債',
  'repay.sectionIntro':
    'ヘッダーの日付の時点で残高があるカード・ローンです。返済予定の登録・編集はここで行います（資金繰りには登録した予定が反映されます）。',
  'repay.none': 'この日の時点で残高のある負債はありません。',
  'repay.balance': '残高',
  'repay.nextDue': '次回支払日',
  'repay.installmentsLeft': '残り {count} 回',
  'repay.noPlanHint': '返済予定がありません。「返済を登録」から登録できます。',
  'repay.noPlanTag': '返済予定なし',
  // 負債行の展開 = 登録済みの返済（基準日より後の保存仕訳）。タップで仕訳の編集シートへ。
  'repay.registered': '登録済みの返済',
  'repay.add': '返済を登録',
  'repay.title': '返済予定を追加',
  'repay.intro':
    '返済口座から「{name}」への返済を、支払日の振替仕訳としてそのまま登録します（仕訳一覧・資金繰りに反映）。',
  'repay.amount': '返済額',
  'repay.amountHint': '既定はいまの残高（全額）です。請求額に合わせて変更できます。',
  'repay.from': '返済口座',
  'repay.date': '支払日',
  'repay.settingsHint':
    '勘定科目（カード・ローン）の編集で返済口座と毎月の返済日を設定すると、ここに既定値が入ります。',
  'repay.settingsLine': '返済口座: {account}・毎月{day}日',
  'repay.scheduleTitle': '{name}の返済',
  'repay.count': '返済回数',
  'repay.countHint':
    '1 = カードの次回引落などの単発。毎月同額のローンは {max} 回までまとめて登録できます（合計は返済額に一致）。',
  'repay.perMonth': '月あたり約 {amount} × {count} 回',
  'error.repay.countInvalid': '返済回数は 1〜{max} の整数で入力してください。',
  'error.settings.invalid':
    '台帳の設定を保存できませんでした（名前は 1〜120 文字・単位は 1〜8 文字で入力してください）。',
  'error.snapshot.invalid': 'スナップショットの形式が不正です。',
  'snapshot.loadError':
    'スナップショットを読み込めません。データを削除せず、JSON バックアップを確認してください。',
  'error.amount.overflow': '金額の合計が扱える範囲を超えました。',
  'error.repay.totalTooSmall': '返済総額が回数より少なく、金額 0 の回ができるため登録できません。',
  'error.repay.liabilityRequired': '返済先はカード・未払 / ローンの負債科目を選んでください。',

  // 月割り台帳（くり返し記帳 = 実仕訳の自動起票 / 継続コスト資産 = 月割りの導出）
  'monthly.title': '月割り台帳',
  'monthly.add': '追加',
  'monthly.empty':
    'まだ登録がありません。「追加」からサブスク・給与・積立・持ち物などを登録できます。',
  'monthly.pick.rule': 'くり返し記帳',
  'monthly.pick.asset': 'いま持っているものを登録',
  'monthly.searchPlaceholder': '項目名・科目名で検索',
  'monthly.searchEmpty': '該当する項目がありません。',
  'monthly.searchCount': 'くり返し記帳 {rules} 件・持ち物 {items} 件・支払用負債 {liabilities} 件',

  'recurring.sectionTitle': 'くり返し記帳',
  'recurring.sectionIntro':
    '支払日に実際の仕訳として自動で記帳されます（アプリを開いたときにまとめて起票）。金額が変わった月は、できた仕訳をその月だけ編集してください。',
  'recurring.createTitle': '定期ルールを追加',
  'recurring.editTitle': '定期ルールを編集',
  'recurring.kind.expense': '支出（定期の支払い）',
  'recurring.kind.income': '収入（給与など）',
  'recurring.kind.transfer': '振替（積立など）',
  'recurring.kind.manual': '簿記編集（科目を直接指定）',
  'recurring.name': '摘要',
  'recurring.nameHint': '起票される仕訳の名前（例: NISA積立 / 給与 / Netflix）。',
  'recurring.amount': '金額',
  'recurring.amountHint':
    '金額を変えるときは、全期間を変えるか、今日から新しい金額に分けるかを選べます。',
  'recurring.intervalMonths': '周期（か月）',
  // v13.1 その4: 旧「起票周期の基準日」の改枠。データは従来どおり startMonth + dayOfMonth と
  // 相互変換する（保存形は不変・見せ方だけ「最初に起票される日」へ寄せる）。
  'recurring.firstPostingDate': '初回の起票日',
  'recurring.firstPostingDateHint':
    '最初に起票する日です。毎回の起票日と周期の位相もこの日で決まります。',
  'recurring.detailsToggle': '詳細（ルールの存在期間）',
  // 編集 = 全期間の引き直し（宣言モデル）。この日から変えたいときの動詞は「切替」。
  'recurring.editRetroactiveNote':
    '編集は全期間に効きます。過去 {count} 回の起票が引き直されます（この日から変えるなら「切替」）。',
  'recurring.ruleStartDate': 'ルールの開始日',
  'recurring.ruleStartDateHint': 'このルールが存在し始める日です。',
  'recurring.ruleEndDate': 'ルールの終了点（任意）',
  'recurring.ruleEndDateHint': 'この日からルールは存在しません。空欄の間は継続します。',
  'recurring.rulePeriod': 'ルール期間',
  'recurring.ruleEndBefore': '{date} より前まで',
  'recurring.ruleNoEnd': '継続中',
  // 行の右列の状態チップ（v13.2）: 操作ボタンが出ない行も同じ位置を状態で埋める
  // （空白にすると縦揃えが崩れ、「なぜボタンが無いか」も分からないため）。
  // 終了予定は「いつまで動くか」を日付で示す（v13.3・実ユーズ指摘「予定と済みの違いが
  // 分からない」）。日付は排他的終了点の前日 = 実際にルールが存在する最後の日。
  'recurring.statusEndScheduled': '{date} まで',
  'recurring.statusEnded': '終了済み',
  'recurring.statusNotStarted': '開始前',
  'recurring.postingSchedule': '起票',
  'recurring.amountChangeTitle': '金額の変更方法',
  'recurring.amountChangeBody':
    'これまでの金額も変えるか、{date} を境に新しいルールへ分けるかを選んでください。',
  'recurring.amountChangeWholeOnlyBody':
    'このルールには {date} より前またはその日以降の期間がないため、その日を境に分けられません。全期間の金額変更だけ選べます。',
  'recurring.amountChangeAll': '全期間の金額を変更',
  'recurring.amountChangeAllHint': '過去に起票された仕訳と持ち物も、新しい金額へ変更します。',
  'recurring.amountChangeFromToday': '{date} から新しい金額',
  'recurring.amountChangeFromTodayHint':
    '現在のルールは {date} より前までとし、その日から新しいルールを開始します。起票周期の基準月は現在のルールから引き継ぎ、日と周期は編集内容を使います。',
  'recurring.amountChangeBack': '編集に戻る',
  'recurring.refBroken':
    '参照している科目が削除または終了しています。このルールの起票は止まっています（編集で科目を選び直してください）。',
  'recurring.from.manual': '貸方（支払い元・減る側）',
  'recurring.manualHint':
    'このルールで増える・使う側の科目です。支払いは一旦台帳（保管庫）に置かれ、次の支払いまでの期間に割り振られます。',
  'recurring.everyMonthDay': '毎月{day}日',
  'recurring.everyNMonthsDay': '{n}か月ごと {day}日',
  'recurring.firstPosting': '初回の起票',
  'recurring.firstPostingStatus': '初回の起票は {date} です',
  'recurring.firstPostingNone': '初回の起票はありません',
  'recurring.end': '終了',
  // 終了日シート（無確認の即終了はしない・2026-08-15 作者合意）。終了点は含まない端点なので、
  // 一覧の「{date} より前まで」と同じ意味を「この日以降は起票されません」で言い直す。
  'recurring.endSheetTitle': 'ルールを終了する',
  'recurring.endSheetDate': '終了点',
  'recurring.endSheetBody':
    'この日以降は起票されません。起票済みの仕訳と持ち物はそのまま残ります。',
  'recurring.endSheetConfirm': '終了する',
  // 切り替えシート（v13・作者確定 2026-08-16）: 「編集 = 全期間を引き直す」に対して
  // 「切り替え = この日から別の線」。位相（起票周期の基準月）と科目は現在のルールから引き継ぐ。
  'recurring.switch': '切り替え',
  // 行アクションのテキストボタン（44px・aria は従来どおり動詞: 名前）。
  'recurring.switchShort': '切替',
  'recurring.switchTitle': 'この日から切り替える',
  'recurring.switchDate': '切り替え日',
  'recurring.switchDateHint':
    'この日の起票から新しい条件になります。現在のルールはこの日より前までです。',
  'recurring.switchNewConditions': '新しい条件',
  'recurring.switchDayOfMonth': '起票日',
  'recurring.switchDayOfMonthHint':
    '毎回の起票日（1〜31。その日が無い月は月末へ寄せます）。周期の位相は現在のルールから引き継ぎます。',
  'recurring.switchPreview': '起票プレビュー',
  'recurring.switchPreviewPredecessor': '現在のルールは {date} より前までです。',
  'recurring.switchPreviewSuccessor': '新しい条件の初回の起票は {date} です。',
  'recurring.switchPreviewSuccessorNone': '新しい条件では起票されません。',
  'recurring.switchConfirm': '切り替える',
  // 清算パネル（切り替えシート・終了シートで共通）。「生まれた線は自分の寿命を持つ」の
  // 唯一の調整口: 選んだ持ち物だけをその日で終わりにし、回収はアーカイブと同じ 3 点で決める。
  'recurring.settlementTitle': '配分中の持ち物',
  'recurring.settlementIntro':
    'このルールから生まれた、まだ配分の途中の持ち物です。何も選ばなければ、それぞれの終了日まで配分を続けます。',
  'recurring.settlementKeep': 'そのまま使い切る',
  'recurring.settlementEnd': 'この日で終える',
  // 動詞体系（v13.1）: 「再開」は撤去（実体は新規登録と同じで「終了の Undo」と誤読させる。
  // 再契約 = 新規登録・終了の間違い = 解除）。終了の Undo = 「終了日を解除」（編集シート下部）。
  'recurring.clearEndDate': '終了日を解除',
  'recurring.clearEndDateConfirmTitle': '終了日を解除しますか？',
  'recurring.clearEndDateConfirmBody':
    '「{name}」の終了点を消して、ルールを継続中に戻します。止めていた間の起票も引き直されます。',
  'recurring.deleteAction': 'このルールを削除…',
  'recurring.deleteDangerHint':
    '起票された仕訳と持ち物も一緒に消えます。削除は取り消せません（保険は書き出した JSON とスナップショットだけです）。今日までの分を残して止めるなら「終了」を使ってください。',
  // ルール削除はカスケード（作者決定 2026-08-15）: 積み木の下が消えれば上も消える。
  // 復旧は同じ内容で登録し直すだけなので、取り消せない旨ではなく戻し方を添える。
  'recurring.deleteConfirmTitle': '定期ルールを削除',
  'recurring.deleteConfirmBody':
    '「{name}」を削除します。このルールから生まれた {count} 回分の仕訳と持ち物も一緒に消えます。未来の予定もすべて消えます。（同じ内容でルールを登録し直せば復旧できます）',
  'recurring.deleteConfirmNoPostingsBody':
    '「{name}」を削除します。まだ起票はありません。未来の予定がすべて消えます。',
  'error.recurring.invalidStructure': '定期ルールの形式が不正です。',
  'error.recurring.flowInvalid':
    '科目の組み合わせが不正です（源泉と行き先を別の科目にしてください。内部集約・調整科目は使えません）。',
  'error.recurring.notFound': '定期ルールが見つかりません。',
  // 起票ゼロの線分は「生まれない線」= 宣言モデルでは意味を持たない（v13.3）。
  // 終了ではなく削除が正しい動詞なので、その扉を名指しで指す。
  'error.recurring.neverPosts':
    'この期間ではルールが一度も起票されません（初回の起票日がルール期間の外です）。期間を見直すか、使わないルールなら編集画面の下部にある「このルールを削除…」を使ってください。',
  'monthlyCost.sectionTitle': '持ち物',

  // 初期残高の一括登録（初回起動時に自動表示・設定から再表示可能）
  'onboarding.title': 'はじめに：いまの残高を登録',
  'onboarding.intro':
    '手元の現金や口座の残高を入れると、今日から収支と資産を追えます。金額は空欄のままでもかまいません（あとから登録できます）。',
  'onboarding.assetSection': '資産（いまある残高）',
  'onboarding.liabilitySection': '負債（カード未払・借入）',
  'onboarding.dateLabel': '基準日',
  'onboarding.dateHint': 'この日付時点の残高（初期残高）として登録します。',
  'onboarding.amountPlaceholder': '未入力はスキップ',
  'onboarding.registered': '登録済み',
  'onboarding.save': '登録する',
  'onboarding.skip': 'あとで設定',
  'onboarding.laterHint': 'このシートは「設定 > 初期残高の一括登録」からいつでも開けます。',
  'settings.onboardingOpen': '初期残高の一括登録',
} as const;

export type MessageKey = keyof typeof ja;
