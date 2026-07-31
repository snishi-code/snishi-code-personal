/*
 * 日本語メッセージ。UI 文字列はコンポーネントに直書きせず、すべてここへ集約する。
 * 将来 en を足すときは同じキー集合の Record を用意し、locale で切り替える。
 *
 * 旧名称（INPUT / PL / BS / CF / INVENTORY）はキーにも値にも使わない。
 */
export const ja = {
  'nav.accounts': '勘定科目',
  'nav.allocations': '毎月のもの',
  'nav.cashflow': '資金繰り',
  'nav.yearlyOverview': '年間・全体',
  'nav.tags': 'タグ',
  'nav.settings': '設定',
  'nav.help': 'ヘルプ',

  'common.cancel': 'キャンセル',
  'common.save': '保存',
  'common.delete': '削除',
  'common.edit': '編集',
  'common.search': '検索',
  'common.required': '必須',
  'common.menu': 'メニュー',
  'common.home': 'ホーム',
  'common.loading': '読み込み中…',
  'common.proceed': '実行する',

  'header.home': 'ホーム',

  'dashboard.title': 'ホーム',
  'dashboard.entryActions': '日常入力（収入・支出・振替）',
  'dashboard.revenue': '収入',
  'dashboard.expense': '支出',
  'dashboard.netIncome': '収支',
  'dashboard.assets': '資産',
  'dashboard.liabilities': '負債',
  'dashboard.netAssets': '純資産',
  'dashboard.viewAll': 'すべて見る',
  'dashboard.statDetail': '{label}の内訳を開く',
  'dashboard.noMonthEntries': '仕訳はまだありません。',
  'dashboard.entriesOf': '仕訳',
  'dashboard.flowOf': '収支',
  'dashboard.positionAsOf': '財政状態（{date} 時点）',
  // 支出の内訳（ホーム「支出」のタップ先）
  'expenseBreakdown.title': '支出の内訳',
  'expenseBreakdown.intro':
    '何へ支出したかを費用カテゴリ別に見られます。継続コストの月割り分も各カテゴリに含まれます。',
  'expenseBreakdown.byCategory': '費用カテゴリ別',
  'expenseBreakdown.categoryTotal': '支出合計',
  'expenseBreakdown.noCategory': 'この期間の支出はまだありません。',
  'expenseBreakdown.normalExpense': '通常支出',
  'expenseBreakdown.monthlyCost': '継続コスト',
  'expenseBreakdown.total': '支出合計',
  'expenseBreakdown.trend': '支出の推移',
  'dashboard.trendNet': '収支の推移',
  'dashboard.trendLiving': '支出の推移',
  'dashboard.trendAssets': '純資産の推移',
  'dashboard.trendDrillYear': 'その年の月別へ',

  'journal.monthlyCostTag': '継続コスト',

  // 継続コスト資産（項目名・金額・開始日・終了日の4項目。開始日 = 購入の仕訳の日付）
  'monthlyCost.amount': '金額',
  'monthlyCost.monthly': '月あたり',
  'monthlyCost.thisMonth': '今月の計上額',
  'monthlyCost.expenseCategory': '費用の行き先',
  'monthlyCost.editTitle': '継続コスト資産を編集',
  'monthlyCost.name': '名称',
  'monthlyCost.showEnded': '終了分も表示',
  // 過去から再計算される項目を変えたときの注意（破壊的操作の予告。不具合ではなく仕様）。
  'monthlyCost.pastRecalcWarning':
    '金額・期間・費用の行き先を変えると、過去の支出・収支・残存価値もさかのぼって再計算されます。',
  'monthlyCost.deleteConfirmTitle': '継続コスト資産を削除しますか？',
  'monthlyCost.deleteConfirmBody':
    '「{name}」を削除します。購入の仕訳と回収の振替も一緒に削除されます。登録済みの返済仕訳（未来日付の振替）は残ります。',
  'ccItem.startDate': '開始日',
  'ccItem.endDate': '終了日（任意）',
  'ccItem.period': '期間',
  'ccItem.remainingValue': '残存価値',
  'ccItem.archiveTitle': 'アーカイブ',
  'ccItem.transferTarget': '振替先を選ぶ',
  'ccItem.openPurchase': 'その仕訳を開く',
  'ccItem.quickSpan': '{years}年',

  'cashflow.title': '資金繰り',
  'cashflow.intro':
    '未来日付の仕訳から、自由に動かせるお金の推移を見ます。カード・ローンは行をタップすると返済計画を登録できます。',
  'cashflow.until': '表示終了日',
  'cashflow.untilHint': '今日からこの日までの入出金予定を投影します。',
  'cashflow.freeFunds': '自由に動かせるお金',
  'cashflow.minFree': '期間内の最低額',
  'cashflow.depleteWarning': 'この期間に自由に動かせるお金がマイナスになる予定があります。',
  'cashflow.nextDue': '次回支払日',
  'cashflow.installmentsLeft': '残り {count} 回',
  'cashflow.post': '実績化',
  'cashflow.postNeedsCounter': '相手科目を設定すると実績化できます。',
  'cashflow.deleteSchedule': '削除',
  // CF 再構成: 自由に動かせるお金の推移・負債返済を主役に、未来予定はホーム入力へ寄せる。
  'cashflow.freeTrendTitle': '自由に動かせるお金の推移',
  'cashflow.debtTitle': '支払用負債・返済予定',
  'cashflow.debtIntro': '負債ごとに、残りの支払予定・次回支払日・残回数を確認できます。',
  'cashflow.debtBalance': '残高',
  'cashflow.debtNoPlan': '返済予定が未登録です。',
  'cashflow.debtNoPlanHint': '残高があるなら、ホームの「支出」で未来日付の返済を登録できます。',
  // 負債行の展開 = 登録済みの返済（未来日付の保存仕訳）。タップで仕訳の編集シートへ。
  'cashflow.repaymentsRegistered': '登録済みの返済',
  'cashflow.futureTitle': '未来の入出金・振替予定',
  'cashflow.futureIntro':
    'ホームの 収入 / 支出 / 振替 で未来日付を選ぶと、ここに表示され資金繰りに反映されます。',
  'cashflow.futureEmpty': '未来日付の予定はありません。',
  'cashflow.scheduleSecondaryTitle': '分割・定期の返済予定',
  'cashflow.scheduleSecondaryHint':
    '以前のバージョンで作られた返済予定です。新しくは作られません（返済は未来日付の振替仕訳として登録されます）。実績化または削除で整理できます。',

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

  'tags.title': 'タグ',
  'tags.intro':
    '勘定科目を増やさずに、旅行・帰省・学会などのイベント/目的で後から抽出できる分析軸です。PL/BS は変わりません。',
  'tags.add': 'タグを追加',
  'tags.edit': 'タグを編集',
  'tags.name': '名称',
  'tags.namePlaceholder': '例: 2026 北海道旅行 / 帰省 / 学会',
  'tags.entryOnlyHint':
    'タグは仕訳全体に付くイベント/目的ラベルです（カード名・銀行名には使いません）。',
  'tags.archive': 'アーカイブ',
  'tags.unarchive': 'アーカイブ解除',
  'tags.archived': 'アーカイブ済み',
  'tags.delete': '削除',
  'tags.showArchived': 'アーカイブ済みも表示',
  'tags.empty': 'タグはありません。「タグを追加」から作成できます。',
  'tags.noneForScope': '対象のタグがありません。タグ画面で作成できます。',
  'tags.deleteConfirmTitle': 'タグを削除しますか？',
  'tags.deleteConfirmBody':
    '「{name}」を削除します。使用中の場合は削除できません（アーカイブしてください）。',
  'tags.error.name': '名称を入力してください。',
  'tags.error.save': 'タグを保存できませんでした。',

  'adjust.intro': '実際の残高との差額を、任意の日に補正します（「締め」はありません）。',
  'adjust.account': '対象科目（資産・負債）',
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
  'adjust.noAccounts': '資産・負債の科目がありません。',
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
  'opening.error.amount': '初期残高は 1 以上の整数で入力してください。',

  'journal.adjustmentTag': '補正',
  'tags.summary': 'タグ集計',
  'tags.period': '対象期間',
  'tags.entryTags': '全体タグ',
  'tags.taggedCount': '{count}件',
  'tags.noTaggedData': 'タグ付きデータがありません。',

  'entry.tags': 'タグ（全体）',
  'entry.tagsHint': '旅行・イベントなど、仕訳全体に付くタグ（任意）。',

  'journal.filterTag': 'タグで絞り込み',
  'journal.allTags': 'すべてのタグ',

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

  'entry.editTitle': '仕訳を編集',
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
  'entry.error.amount-invalid': '金額は 1 以上の整数で入力してください。',
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
  'entry.ccToggle': '継続コスト資産として持つ',
  'entry.ccBackToCategory': '通常のカテゴリに戻す',
  'entry.ccTargetName': '継続コスト資産の名前',
  'entry.ccTargetNameHint':
    '継続コスト資産として登録する項目名です（例: 自動車 / 洗濯機）。勘定科目は増えません。',
  'entry.ccCategory': '費用の行き先',
  'entry.error.loanNotExpense':
    'ローン（その他負債）は通常の支出の支払い元にできません。継続コスト化するか、借入として振替で実行してください。',
  // 返済を資金繰りに入れるトグル ON 時の必須検証（口座・回数が無いと CF が作られないため fail closed）。
  'entry.error.repayAccount': '返済元の口座を選んでください。',
  'entry.error.repayCount': '返済回数は 1 以上で入力してください。',
  'entry.source.manual': '左側（貸方）',
  'entry.destination.manual': '右側（借方）',
  'entry.detailToggle': '詳細（メモ・タグ）',
  // 逆仕訳・特殊編集は日常の「詳細」と分け、簿記編集として明示する。
  'entry.manualSwitch': '簿記編集（左→右を直接指定）',
  'entry.noAccounts': '候補の科目がありません。「勘定科目」で追加してください。',
  'entry.reversalTitle': '取消/返金を記録',
  'entry.reversalNote':
    '元の仕訳は削除せず、反対の仕訳を作成します。金額を変えれば部分返金も記録できます。',
  'entry.monthlyizeRepayToggle': '分割・後日引落を資金繰りに入れる',
  'entry.monthlyizeRepayNote':
    '支払い元が負債のため、返済を未来日付の振替仕訳としてまとめて登録できます（仕訳一覧・資金繰りに反映）。',
  'entry.monthlyizeRepayAccount': '引落口座',
  'entry.monthlyizeRepayCount': '返済回数',
  'entry.monthlyizeRepayStart': '初回引落日',
  'entry.monthlyizeRepayStartHint': '購入日とは別に、最初に現金が引き落とされる日を入れます。',
  'entry.error.category-required': '費用の行き先を選んでください。',
  // 支出の支払い元（左辺）のローン導線。「ローンを組む」で既存ローン選択＋新規ローン作成へ切り替える。
  'entry.loanArrange': 'ローンを組む',
  'entry.loanArrangePick': '組むローンを選ぶ',
  'entry.loanArrangeEmpty': 'ローンがありません。「新しいローンを作成」で追加できます。',
  'entry.loanArrangeCreate': '新しいローンを作成',
  'entry.loanArrangeBack': 'ローンをやめる',

  'journal.reverseAction': '取消/返金を記録',
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

  // 年間・全体（旧帳簿の年次シート相当。月別 / 年別の表だけを表示する）。
  'yearlyOverview.title': '年間・全体',
  'yearlyOverview.intro': '収支・費目・資産の推移を、月別または年別の表で確認できます。',
  'yearlyOverview.modeYear': '年間',
  'yearlyOverview.modeAll': '全体',
  'yearlyOverview.previousYear': '{year}年へ戻る',
  'yearlyOverview.nextYear': '{year}年へ進む',
  'yearlyOverview.noPreviousYear': '前のデータ年はありません',
  'yearlyOverview.noNextYear': '次のデータ年はありません',
  'yearlyOverview.monthLabel': '{month}月',
  'yearlyOverview.itemColumn': '項目',
  'yearlyOverview.revenue': '収入',
  'yearlyOverview.expense': '支出',
  'yearlyOverview.net': '収支',
  'yearlyOverview.monthlyCost': '継続コスト',
  'yearlyOverview.totalAssets': '総資産',
  'yearlyOverview.netAssets': '純資産',
  'yearlyOverview.expenseCategory': '費目別: {name}',
  'yearlyOverview.yearCaption': '{year}年の月別一覧',
  'yearlyOverview.allCaption': '全期間の年別一覧',
  'yearlyOverview.noData': '表示できる仕訳データがありません。',

  // 資産の内訳（ホーム「資産」のタップ先）。4 枠（自由 / 自由でない / 投資 / 継続コスト台帳）。
  'assets.title': '資産の内訳',
  'assets.intro': '持っているお金・資産の内訳と、月ごとの推移です。',
  'assets.total': '資産合計',
  'assets.trend': '資産の推移',
  'assets.frame.free': '自由に動かせるお金',
  'assets.frame.fixed': '自由に動かせないお金',
  'assets.frame.investment': '投資',
  'assets.frame.ledger': '継続コスト台帳',

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
    '大きな箱はアプリが管理します。箱の中の内訳だけを追加・名前変更・アーカイブできます。登録済みの初期残高・補正は仕訳一覧で確認できます。',
  'accounts.edit': '内訳を編集',
  'accounts.addTitle': '{box}の内訳を追加',
  'accounts.boxLabel': '大分類',
  'accounts.boxLockedHint':
    '大分類は変更できません。分類を変えたい場合は、新しい内訳を作って古い内訳をアーカイブしてください。',
  'accounts.emptyBox': 'まだ内訳がありません。',
  'accounts.openingAmount': '初期残高（任意）',
  'accounts.openingDate': '基準日',
  'accounts.openingHint':
    '入力すると、内訳の作成と同時に初期残高（opening 仕訳）を登録します。空欄なら内訳だけを作成します。登録した初期残高は仕訳一覧で確認できます。',
  'accounts.archiveRenameTitle': 'アーカイブ済みと名前が重複しています',
  'accounts.archiveRenameBody':
    '同じ名前「{name}」のアーカイブ済み内訳があります。アーカイブ側を「{renamed}」へ変更して続行しますか？',
  'accounts.archiveRenameConfirm': '変更して続行',
  'accounts.name': '科目名',
  'accounts.balance': '残高',
  'accounts.archived': 'アーカイブ済み',
  'accounts.archive': 'アーカイブ',
  'accounts.unarchive': 'アーカイブ解除',
  'accounts.showArchived': 'アーカイブ済みも表示',
  'accounts.type.asset': '資産',
  'accounts.type.liability': '負債',
  'accounts.type.equity': '純資産',
  'accounts.type.revenue': '収益',
  'accounts.type.expense': '費用',
  'accounts.role.daily-asset': '日常資産（現金・預金）',
  'accounts.role.investment-asset': '投資資産',
  'accounts.role.continuing-cost-asset': '継続コスト台帳（内部集約）',
  'accounts.role.payment-liability': '支払用負債（クレジットカード等）',
  'accounts.role.other-liability': 'その他の負債（ローン等）',
  'accounts.role.equity': '純資産（元入金等）',
  'accounts.role.income-category': '収入カテゴリ',
  'accounts.role.expense-category': '支出カテゴリ',
  'accounts.role.system-adjustment': '調整用（自動生成）',
  'accounts.inUse': '使用中',

  // ユーザー向けの「大きな箱」（大分類）。アプリ側が守り、ユーザーは内訳だけを編集する。
  'box.cash': '現預金・決済資産',
  'box.investment': '投資',
  'box.shortTermDebt': 'カード・未払',
  'box.longTermDebt': 'ローン',
  'box.income': '収入カテゴリ',
  'box.expense': '支出カテゴリ',
  'box.addSubdivision': '内訳を追加',
  'box.addLoan': 'ローンを追加',
  'box.addCategory': 'カテゴリを追加',
  'box.longTermDebtHint':
    '住宅ローン・分割返済など返済予定を持つ債務です。借入の実行や分割返済の予定は、振替（借入）や継続コスト化の導線から作れます。',

  'settings.title': '設定',
  'settings.manageSection': '管理',
  'settings.dataSection': 'データ',
  'settings.export': 'JSON で書き出し',
  'settings.exportDesc': '台帳を JSON ファイルに書き出します（バックアップ・端末間共有用）。',
  'settings.import': 'JSON を読み込み',
  'settings.importDesc':
    'JSON ファイルを取り込みます。取り込み前に自動でスナップショットを作成します。',
  'settings.snapshots': 'スナップショット',
  'settings.snapshotsDesc': '取り込み・復元の前に自動保存された状態です。ここから復元できます。',
  'settings.resetAll': 'すべてのデータを削除',
  'settings.resetAllDesc': '台帳・科目・仕訳・スナップショットをすべて削除し、初期状態に戻します。',
  'settings.about': 'アプリ情報',
  'settings.ledgerName': '台帳名',
  'settings.currency': '通貨コード',
  'settings.version': 'バージョン',
  'settings.schemaVersion': 'スキーマ版',
  'settings.revision': 'リビジョン',
  'settings.offlineNote': 'データは端末内にのみ保存され、外部へ送信されません。',

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
  'toast.deleted': '削除しました。',
  'toast.exported': '書き出しました。',
  'toast.restored': '復元しました。',
  'toast.reset': 'すべてのデータを削除しました。',
  'toast.posted': '実績化しました。',
  'toast.error': 'エラーが発生しました。',

  'help.title': 'ヘルプ',
  'help.body':
    'これは複式簿記の家計簿です。日々の収入・支出・振替を記録すると、ホームと各項目（収入/支出/収支/資産/負債/純資産）の内訳・推移に自動で反映されます。データは端末内にのみ保存され、外部送信はありません。バックアップや端末間共有は設定の「JSON で書き出し／読み込み」を使ってください。',

  'a11y.openMenu': 'メニューを開く',

  // ドメイン/リポジトリ由来のユーザー表示エラー。domain/repository は LedgerError(code, params)
  // を投げ、表示は UI 層が errorText() で行う（保存境界の fail-closed なエラーも i18n に集約）。
  'error.account.roleTypeMismatch': '役割が区分と一致しません。',
  'error.account.typeLocked': '使用中の科目は区分を変更できません。',
  'error.account.roleLocked':
    '使用中の内訳は別の大分類へ移動できません。新しい内訳を作り、古い内訳をアーカイブしてください。',
  'error.account.nameConflict': '同じ名前の内訳が既にあります（別の箱でも重複できません）。',
  'error.account.nameConflictArchived': '同じ名前のアーカイブ済み内訳があります。',
  'error.account.deleteInUse': 'この科目は使用中のため削除できません。アーカイブしてください。',
  'error.entry.monthlyCost':
    '購入の仕訳は削除できません。継続コスト資産の項目（毎月のもの）を削除すると一緒に消えます。',
  'error.entry.scheduleLinked':
    '実績化済みの予定に紐づく仕訳は編集・削除できません。資金繰りの予定から操作してください。',
  'error.entry.adjustment': '残高補正の仕訳は、仕訳一覧の補正行から編集・削除してください。',
  'error.entry.virtual': '導出専用の仮想仕訳は保存できません。',
  'error.entry.invalidStructure': '仕訳の形式が正しくないため保存できません。',
  'error.entry.unknownAccount': '仕訳が存在しない勘定科目を参照しています。',
  'error.entry.accountRoleMismatch': '仕訳の勘定科目の役割と区分が一致していません。',
  'error.tag.unknown': '存在しないタグを参照しています。',
  'error.tag.duplicateName': '同じ名前の有効なタグが既にあります。',
  'error.tag.deleteInUse': 'このタグは使用中のため削除できません。アーカイブしてください。',
  'error.schedule.notFound': '予定が見つかりません。',
  'error.schedule.alreadyProcessed': 'この予定は既に処理済みです。',
  'error.schedule.counterRequired': '相手科目が未設定の予定は実績化できません。',
  'error.schedule.invalidStructure': '予定の形式が正しくないため保存できません。',
  'error.schedule.unknownAccount': '予定が存在しない口座を参照しています。',
  'error.adjust.targetNotFound': '対象科目が見つかりません。',
  'error.adjust.assetLiabilityOnly': '残高補正できるのは資産・負債の科目です。',
  'error.adjust.internalRole': '継続コスト台帳は内部の集約口座のため残高補正できません。',
  'error.adjust.notFound': '対象の残高補正が見つかりません。',
  'error.adjust.notAdjustment': 'この仕訳は残高補正ではありません。',
  'error.opening.assetLiabilityOnly': '初期残高を登録できるのは資産・負債の科目です。',
  'error.opening.notOpening': 'この仕訳は初期残高ではありません。',
  'error.common.nameRequired': '名称を入力してください。',
  'error.common.amountInvalid': '金額は 1 以上の整数で入力してください。',
  'error.monthlyCost.dateRequired': '開始日（購入の仕訳の日付）を入力してください。',
  'error.monthlyCost.expenseCategory': '費用の行き先の勘定科目を選んでください。',
  'error.monthlyCost.paymentSource':
    '支払い元は資金（現金・預金）かカード・ローンを選んでください。',
  'error.monthlyCost.repaymentAccount': '返済口座は日常資産を選んでください。',
  'error.monthlyCost.notFound': '対象の継続コスト資産が見つかりません。',
  'error.monthlyCost.invalidStructure': '継続コスト資産の内容が不正です。',
  'error.monthlyCost.endBeforeStart': '終了日は開始日以降にしてください。',
  'error.monthlyCost.deletePosted':
    '返済が実績化済みのため削除できません。アーカイブ（終了日の設定）を使ってください。',
  // 4項目モデル（指示書#5）で新設したエラーコード。
  'error.monthlyCost.purchaseAfterEnd': '購入の仕訳の日付は終了日以前にしてください。',
  'error.monthlyCost.deleteLiability':
    '負債で購入した項目は削除できません。アーカイブ（終了日の設定）を使ってください。',
  'error.monthlyCost.recoveryDestination': '振替先の科目を選んでください。',
  'error.entry.ledgerAccount': '継続コスト台帳の科目は継続コスト資産の登録からだけ使えます。',
  'error.account.archiveBalance':
    '残高が残っている科目はアーカイブできません。先に振替で残高を 0 にしてください。',
  'error.recurring.everyMonthsInvalid': '周期は 1〜1200 か月の整数で入力してください。',
  // 監査 2026-07-30 対応で新設したエラーコード。
  'error.monthlyCost.recoveryBeforeStart':
    '回収の振替の日付は開始日（購入の仕訳の日付）以降にしてください。',
  'error.monthlyCost.editLiability':
    '負債（カード・ローン）で購入した項目は、支払い元・金額・日付を変更できません（自動作成した返済の仕訳と合わなくなるため）。終了はアーカイブ（終了日の設定）を使ってください。',
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
  'accounts.movable': '自由に動かせる',
  'accounts.notMovable': '自由に動かせない',

  // 返済設定（負債の勘定科目）と資金繰りの返済予定
  'accounts.repaymentAccount': '返済口座',
  'accounts.repaymentDay': '毎月の返済日',
  'accounts.repaymentUnset': '未設定',
  'accounts.repaymentHint': '設定すると、資金繰り画面の返済予定づくりで既定値になります。',
  'error.account.repaymentOnlyLiability':
    '返済口座・返済日はカード・未払 / ローンの科目にのみ設定できます。',
  'error.account.repaymentDayInvalid': '返済日は 1〜31 で入力してください。',
  'cashflow.repayAdd': '返済予定を追加',
  'cashflow.repayTitle': '返済予定を追加',
  'cashflow.repayIntro':
    '返済口座から「{name}」への返済を、支払日の振替仕訳としてそのまま登録します（仕訳一覧・資金繰りに反映）。',
  'cashflow.repayAmount': '返済額',
  'cashflow.repayAmountHint': '既定はいまの残高（全額）です。請求額に合わせて変更できます。',
  'cashflow.repayFrom': '返済口座',
  'cashflow.repayDate': '支払日',
  'cashflow.repaySettingsHint':
    '勘定科目（カード・ローン）の編集で返済口座と毎月の返済日を設定すると、ここに既定値が入ります。',
  'cashflow.repaySettingsLine': '返済口座: {account}・毎月{day}日',
  'cashflow.repayScheduleTitle': '{name}の返済',
  'cashflow.repayCount': '返済回数',
  'cashflow.repayCountHint':
    '1 = カードの次回引落などの単発。毎月同額のローンは回数を入れると、毎月の振替仕訳をまとめて登録します（合計は返済額に一致）。',
  'cashflow.repayPerMonth': '月あたり約 {amount} × {count} 回',
  'error.repay.countInvalid': '返済回数は 1 以上の整数で入力してください。',
  'error.repay.liabilityRequired': '返済先はカード・未払 / ローンの負債科目を選んでください。',

  // 毎月のもの（くり返し記帳 = 実仕訳の自動起票 / 継続コスト資産 = 月割りの導出）
  'monthly.title': '毎月のもの',
  'monthly.add': '追加',
  'monthly.empty':
    'まだ登録がありません。「追加」からサブスク・給与・積立・持ち物などを登録できます。',
  'monthly.pick.rule': 'くり返し記帳',
  'monthly.pick.asset': 'いま持っているものを登録',

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
  'recurring.amountHint': '月によって金額が違う場合は、起票された仕訳をその月だけ編集します。',
  'recurring.intervalMonths': '周期（か月）',
  'recurring.firstPostingDate': '初回の起票日',
  'recurring.refBroken':
    '参照している科目が削除またはアーカイブされています。このルールの起票は止まっています（編集で科目を選び直してください）。',
  'recurring.from.manual': '貸方（支払い元・減る側）',
  'recurring.to.manual': '借方（増える・使う側）',
  'recurring.manualHint':
    '行き先が費用なら自動で継続コストとして期間配分し、資産・負債・収入なら直接記帳します。',
  'recurring.everyMonthDay': '毎月{day}日',
  'recurring.everyNMonthsDay': '{n}か月ごと {day}日',
  'recurring.paused': '停止中',
  'recurring.pause': '停止',
  'recurring.resume': '再開',
  'recurring.resumeNote': '再開すると今月ぶんから起票されます（停止中の月は起票されません）。',
  'recurring.deleteConfirmTitle': '定期ルールを削除',
  'recurring.deleteConfirmBody':
    '「{name}」を削除します。起票済みの仕訳・できた継続コスト資産はそのまま残ります。',
  'error.recurring.invalidStructure': '定期ルールの形式が不正です。',
  'error.recurring.flowInvalid':
    '科目の組み合わせが不正です（源泉と行き先を別の科目にしてください。内部集約・調整科目は使えません）。',
  'error.recurring.notFound': '定期ルールが見つかりません。',
  'monthlyCost.sectionTitle': '継続コスト資産',

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
