/*
 * 仕訳の貼り付け一括登録のパーサ（v13.10）。
 *
 * 形式は作者決定（2026-08-19 受信箱）: 1 行 = 1 仕訳・カンマ区切り・
 * 順序 = 日付,摘要,金額,貸方,借方・厳密形式。テキストの生成はユーザー側の AI に
 * 丸投げしアプリは関知しない。重複検知もアプリ側ではやらない（メール運用で制御）。
 *
 * 「厳密」の境界: 許すのは各セルの前後空白 trim と空行スキップだけ（貼り付けの実務上
 * 不可避）。それ以外の寛容処理（全角カンマ・桁区切り・日付形式のゆらぎ等）はしない。
 * エラーは全行ぶん行番号付きで列挙し、1 行でもあれば呼び出し側は 1 件も登録しない。
 *
 * 科目はテキストの名前と完全一致で解決する。「借方が決まらない行」もテキスト側が
 * 「未記入」等の実在する科目名を書く前提で、アプリは特別扱いしない（専用科目の
 * 自動生成はしない）。候補は簿記編集（manual モード）と同じ = 継続コスト台帳
 * （continuing-cost-asset）だけを除く全 role。台帳仕訳は専用導線のみの既存不変条件を守る。
 */
import type { Account } from '../domain/types';
import type { SimpleEntryInput } from '../domain/entry';
import { isValidIsoDate, MAX_LEDGER_DATE } from '../domain/calendar';
import { accountExistsAt } from '../domain/accountLifetime';
import { parseAmountToMinor } from './amountText';

/** 一度に受け付ける最大行数（想定 100〜200 の余裕 5 倍。誤爆貼り付けのフリーズ防止ガード）。 */
export const PASTE_MAX_ROWS = 1000;

/** journalEntrySchema の description max と同値（保存境界で弾かれる前に行番号付きで示す）。 */
const DESCRIPTION_MAX = 200;

export type PasteError =
  | { kind: 'too-many'; count: number }
  | { kind: 'field-count'; line: number }
  | { kind: 'date'; line: number }
  | { kind: 'description'; line: number }
  | { kind: 'amount'; line: number }
  | { kind: 'unknown-account'; line: number; name: string }
  | { kind: 'ambiguous-account'; line: number; name: string }
  | { kind: 'account-period'; line: number; name: string }
  | { kind: 'same-account'; line: number };

export interface PasteParseResult {
  rows: SimpleEntryInput[];
  errors: PasteError[];
}

/** 金額セルの厳密形（正の数・小数 2 桁まで）。'12.'・'.5' のような省略形は受けない。 */
const AMOUNT_STRICT = /^\d+(\.\d{1,2})?$/;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export function parsePasteText(text: string, accounts: Account[]): PasteParseResult {
  const byName = new Map<string, Account[]>();
  for (const account of accounts) {
    if (account.role === 'continuing-cost-asset') continue;
    const list = byName.get(account.name);
    if (list) list.push(account);
    else byName.set(account.name, [account]);
  }

  const rows: SimpleEntryInput[] = [];
  const errors: PasteError[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  const nonEmptyCount = lines.filter((raw) => raw.trim() !== '').length;
  if (nonEmptyCount > PASTE_MAX_ROWS) {
    return { rows, errors: [{ kind: 'too-many', count: nonEmptyCount }] };
  }

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === '') return;
    const cells = raw.split(',').map((cell) => cell.trim());
    if (cells.length !== 5) {
      errors.push({ kind: 'field-count', line });
      return;
    }
    const [date, description, amountCell, creditName, debitName] = cells as [
      string,
      string,
      string,
      string,
      string,
    ];
    let bad = false;

    const dateValid = DATE_SHAPE.test(date) && isValidIsoDate(date) && date <= MAX_LEDGER_DATE;
    if (!dateValid) {
      errors.push({ kind: 'date', line });
      bad = true;
    }

    if (description === '' || description.length > DESCRIPTION_MAX) {
      errors.push({ kind: 'description', line });
      bad = true;
    }

    const amount = AMOUNT_STRICT.test(amountCell) ? parseAmountToMinor(amountCell) : null;
    if (amount === null || amount <= 0) {
      errors.push({ kind: 'amount', line });
      bad = true;
    }

    const resolve = (name: string): Account | null => {
      const list = byName.get(name);
      if (!list) {
        errors.push({ kind: 'unknown-account', line, name });
        return null;
      }
      if (list.length > 1) {
        errors.push({ kind: 'ambiguous-account', line, name });
        return null;
      }
      const account = list[0]!;
      // 日付セルが不正な行は期間判定ができない（date エラーが既に出ている）。
      if (dateValid && !accountExistsAt(account, date)) {
        errors.push({ kind: 'account-period', line, name });
        return null;
      }
      return account;
    };
    const credit = resolve(creditName);
    const debit = resolve(debitName);
    if (!credit || !debit) bad = true;
    else if (credit.id === debit.id) {
      errors.push({ kind: 'same-account', line });
      bad = true;
    }

    if (bad || !credit || !debit || amount === null) return;
    rows.push({
      date,
      description,
      amount,
      debitAccountId: debit.id,
      creditAccountId: credit.id,
    });
  });

  return { rows, errors };
}
