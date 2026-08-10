/*
 * CSV 取込（Import Profile）のデータ層テスト（fake-indexeddb 上・指示書 §9 の repository/復元分）。
 *  - profile の seed / 削除 / 復元（削除済み組み込みが勝手に復活しない）
 *  - binding の role 制約・一意性
 *  - applyImportBatch の原子性（途中失敗 0 件・二重適用拒否・stale revision・digest 不一致）
 *  - 仕訳削除 → decision 同時解除・link/unlink・ignore/unignore の冪等
 *  - export / import(replace) / snapshot / reset の完全往復
 *  - 仕訳編集での import メタ保持
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  applyImportBatch,
  deleteEntry,
  deleteImportProfile,
  findProfileBinding,
  getImportDecisions,
  getImportFileRecords,
  loadLedger,
  removeImportDecisions,
  resetAll,
  restoreBuiltinImportProfiles,
  upsertEntry,
  upsertImportProfile,
  upsertProfileBinding,
  type ImportBatchAction,
  type ApplyImportBatchInput,
} from '../src/data/repository';
import {
  buildExportPackage,
  exportToJsonText,
  importFromJsonText,
  restoreFromSnapshot,
} from '../src/data/exportImport';
import { buildSimpleEntry, toSimpleInput } from '../src/domain/entry';
import { externalRowKey, fingerprintRowKey, profileDslDigest } from '../src/domain/importIdentity';
import {
  PAYPAY_BUILTIN_ID,
  PAYPAY_BUILTIN_VERSION,
  PAYPAY_PROFILE_ID,
  PAYPAY_PROFILE_NAME,
} from '../src/domain/importProfilePresets';
import { importDecisionSchema } from '../src/domain/schema';
import type { ImportProfile, ImportProfileDsl } from '../src/domain/importDsl';
import type { JournalEntry, Ledger, ProfileBinding } from '../src/domain/types';

const SOURCE = 'PayPay本体';
const FILE_HASH = 'file-hash-1';

/** テスト用のユーザー定義 DSL（全行が row になる最小形）。 */
const USER_DSL: ImportProfileDsl = {
  dslVersion: 1,
  fileFormat: { encoding: 'utf-8', delimiter: ',', headerRowIndex: 0 },
  columns: {
    date: { column: 'date', format: 'YYYY-MM-DD' },
    amount: { mode: 'signed', column: 'amount', positiveDirection: 'inflow' },
    description: { columns: ['desc'] },
  },
  kindRules: [{ when: { op: 'contains', column: 'desc', value: '' }, kind: 'row' }],
};

function userProfile(overrides: Partial<ImportProfile> = {}): ImportProfile {
  return {
    id: 'user-profile-1',
    name: 'ユーザー定義CSV',
    dsl: USER_DSL,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

function account(ledger: Ledger, name: string) {
  const found = ledger.accounts.find((a) => a.name === name);
  if (!found) throw new Error(`account not found: ${name}`);
  return found;
}

function binding(ledger: Ledger, overrides: Partial<ProfileBinding> = {}): ProfileBinding {
  return {
    id: 'binding-1',
    profileId: PAYPAY_PROFILE_ID,
    sourceIdentity: SOURCE,
    ownAccountId: account(ledger, 'チャージ残高').id,
    kindDestinations: { 'ポイント、残高の獲得': account(ledger, 'その他収入').id },
    chargeSourceAccountId: account(ledger, '預金').id,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

async function paypayDigest(): Promise<string> {
  const ledger = await loadLedger();
  const profile = ledger.importProfiles.find((p) => p.id === PAYPAY_PROFILE_ID);
  if (!profile) throw new Error('builtin profile not seeded');
  return profileDslDigest(profile.dsl);
}

function batchInput(
  digest: string,
  actions: ImportBatchAction[],
  overrides: Partial<ApplyImportBatchInput> = {},
): ApplyImportBatchInput {
  return {
    profileId: PAYPAY_PROFILE_ID,
    profileDigest: digest,
    sourceIdentity: SOURCE,
    fileHash: FILE_HASH,
    fileTotalRowCount: 10,
    actions,
    ...overrides,
  };
}

/** 支払い行の仕訳（借方 変動費 / 貸方 チャージ残高）。 */
function paymentEntry(ledger: Ledger, amount: number, description = '取込 支払い'): JournalEntry {
  return buildSimpleEntry({
    date: '2026-08-01',
    description,
    debitAccountId: account(ledger, '変動費').id,
    creditAccountId: account(ledger, 'チャージ残高').id,
    amount,
  });
}

function rk(no: string, kind = '支払い'): string {
  return externalRowKey(SOURCE, [no, kind]);
}

describe('組み込み profile の seed / 削除 / 復元（§1-1）', () => {
  it('fresh DB に PayPay profile が seed され、builtinId / version が固定値', async () => {
    const ledger = await loadLedger();
    const builtin = ledger.importProfiles.find((p) => p.id === PAYPAY_PROFILE_ID);
    expect(builtin).toMatchObject({
      name: PAYPAY_PROFILE_NAME,
      builtin: { builtinId: PAYPAY_BUILTIN_ID, builtinVersion: PAYPAY_BUILTIN_VERSION },
    });
  });

  it('削除した組み込みは再起動（loadLedger）でも自動復活せず、「組み込みを復元」だけで戻る', async () => {
    await loadLedger();
    await deleteImportProfile(PAYPAY_PROFILE_ID);
    expect((await loadLedger()).importProfiles).toHaveLength(0);

    const restored = await restoreBuiltinImportProfiles();
    expect(restored.some((p) => p.id === PAYPAY_PROFILE_ID)).toBe(true);
    const after = await loadLedger();
    expect(after.importProfiles.find((p) => p.id === PAYPAY_PROFILE_ID)?.builtin).toEqual({
      builtinId: PAYPAY_BUILTIN_ID,
      builtinVersion: PAYPAY_BUILTIN_VERSION,
    });
    // 冪等: もう一度呼んでも 1 件のまま。
    await restoreBuiltinImportProfiles();
    expect((await loadLedger()).importProfiles).toHaveLength(1);
  });

  it('組み込みの編集は builtin 印を維持し、「復元」で原本へ戻る', async () => {
    const ledger = await loadLedger();
    const builtin = ledger.importProfiles.find((p) => p.id === PAYPAY_PROFILE_ID)!;
    await upsertImportProfile({ ...builtin, name: '改名した組み込み' });
    const edited = (await loadLedger()).importProfiles.find((p) => p.id === PAYPAY_PROFILE_ID)!;
    expect(edited.name).toBe('改名した組み込み');
    expect(edited.builtin?.builtinId).toBe(PAYPAY_BUILTIN_ID);

    await restoreBuiltinImportProfiles();
    const restored = (await loadLedger()).importProfiles.find((p) => p.id === PAYPAY_PROFILE_ID)!;
    expect(restored.name).toBe(PAYPAY_PROFILE_NAME);
  });

  it('ユーザー入力からの builtin 印の持ち込みは拒否する（fail-closed）', async () => {
    await loadLedger();
    await expect(
      upsertImportProfile(userProfile({ builtin: { builtinId: 'forged', builtinVersion: 1 } })),
    ).rejects.toMatchObject({ code: 'error.importProfile.builtinReserved' });
    expect((await loadLedger()).importProfiles.some((p) => p.id === 'user-profile-1')).toBe(false);
  });
});

describe('ProfileBinding の保存境界（§1-1b）', () => {
  it('正しい binding を保存し、profile × 取込元で引ける', async () => {
    const ledger = await loadLedger();
    await upsertProfileBinding(binding(ledger));
    const found = await findProfileBinding(PAYPAY_PROFILE_ID, SOURCE);
    expect(found?.ownAccountId).toBe(account(ledger, 'チャージ残高').id);
  });

  it('自口座・チャージ源泉は日常資産のみ・自口座と相手方の同一指定は拒否', async () => {
    const ledger = await loadLedger();
    await expect(
      upsertProfileBinding(binding(ledger, { ownAccountId: account(ledger, '変動費').id })),
    ).rejects.toMatchObject({ code: 'error.importBinding.ownAccountRole' });
    await expect(
      upsertProfileBinding(
        binding(ledger, { chargeSourceAccountId: account(ledger, 'クレジットカード').id }),
      ),
    ).rejects.toMatchObject({ code: 'error.importBinding.chargeSourceRole' });
    await expect(
      upsertProfileBinding(
        binding(ledger, { chargeSourceAccountId: account(ledger, 'チャージ残高').id }),
      ),
    ).rejects.toMatchObject({ code: 'error.importBinding.sameAccount' });
    await expect(
      upsertProfileBinding(
        binding(ledger, {
          kindDestinations: { 支払い: account(ledger, 'チャージ残高').id },
        }),
      ),
    ).rejects.toMatchObject({ code: 'error.importBinding.sameAccount' });
    await expect(
      upsertProfileBinding(binding(ledger, { kindDestinations: { 支払い: 'missing-account' } })),
    ).rejects.toMatchObject({ code: 'error.importBinding.destinationRole' });
  });

  it('存在しない profile への binding と、同一 (profile, 取込元) の重複を拒否', async () => {
    const ledger = await loadLedger();
    await expect(
      upsertProfileBinding(binding(ledger, { profileId: 'missing-profile' })),
    ).rejects.toMatchObject({ code: 'error.importProfile.notFound' });
    await upsertProfileBinding(binding(ledger));
    await expect(upsertProfileBinding(binding(ledger, { id: 'binding-2' }))).rejects.toMatchObject({
      code: 'error.importBinding.duplicate',
    });
    // 同じ id への上書き（編集）は通る。
    await upsertProfileBinding(binding(ledger, { chargeSourceAccountId: undefined }));
    expect((await findProfileBinding(PAYPAY_PROFILE_ID, SOURCE))?.chargeSourceAccountId).toBe(
      undefined,
    );
  });
});

describe('applyImportBatch の一括適用（§4-4）', () => {
  it('register / link / ignore を単一適用で保存し、由来メタとファイル記録が付く', async () => {
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    const entry = paymentEntry(ledger, 1200);
    const result = await applyImportBatch(
      batchInput(digest, [
        { kind: 'register', rowKey: rk('1'), entry },
        // 多対一: 別の行を同じ仕訳へリンク（チャージの裏表のような形）。
        { kind: 'link', rowKey: rk('2', 'チャージ'), entryId: entry.id },
        { kind: 'ignore', rowKey: rk('3', 'ポイント、残高の獲得') },
      ]),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.decisions).toHaveLength(3);

    const after = await loadLedger();
    const saved = after.journalEntries.find((e) => e.id === entry.id);
    expect(saved?.metadata).toMatchObject({
      importSource: PAYPAY_PROFILE_ID,
      importSourceIdentity: SOURCE,
      importRowKey: rk('1'),
    });
    const decisions = await getImportDecisions([
      rk('1'),
      rk('2', 'チャージ'),
      rk('3', 'ポイント、残高の獲得'),
    ]);
    expect(decisions.get(rk('1'))).toMatchObject({ status: 'registered', entryId: entry.id });
    expect(decisions.get(rk('2', 'チャージ'))).toMatchObject({
      status: 'linked',
      entryId: entry.id,
    });
    expect(decisions.get(rk('3', 'ポイント、残高の獲得'))).toMatchObject({ status: 'ignored' });
    expect(decisions.get(rk('3', 'ポイント、残高の獲得'))?.entryId).toBe(undefined);
    // provenance が保存される（§5-1）。
    expect(decisions.get(rk('1'))?.provenance).toMatchObject({
      profileId: PAYPAY_PROFILE_ID,
      profileDigest: digest,
      fileHash: FILE_HASH,
      sourceIdentity: SOURCE,
      identityVersion: 1,
    });
    // ファイル記録（情報表示と再開用）。
    expect((await getImportFileRecords())[FILE_HASH]).toMatchObject({
      totalRowCount: 10,
      decidedCount: 3,
    });
  });

  it('binding 学習を適用と同一バッチで保存できる', async () => {
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    await applyImportBatch(
      batchInput(digest, [{ kind: 'ignore', rowKey: rk('10') }], {
        bindingUpdate: binding(ledger),
      }),
    );
    expect((await findProfileBinding(PAYPAY_PROFILE_ID, SOURCE))?.id).toBe('binding-1');
  });

  it('原子性: 不正行（存在しない科目）が混ざったバッチは 0 件更新', async () => {
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    const good = paymentEntry(ledger, 800);
    const bad: JournalEntry = {
      ...paymentEntry(ledger, 500),
      id: 'bad-entry',
      lines: [
        { accountId: 'no-such-account', side: 'debit', amount: 500 },
        { accountId: account(ledger, 'チャージ残高').id, side: 'credit', amount: 500 },
      ],
    };
    await expect(
      applyImportBatch(
        batchInput(digest, [
          { kind: 'register', rowKey: rk('20'), entry: good },
          { kind: 'register', rowKey: rk('21'), entry: bad },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'error.entry.unknownAccount' });
    const after = await loadLedger();
    expect(after.journalEntries).toHaveLength(ledger.journalEntries.length);
    expect(after.importDecisions).toHaveLength(0);
    expect(await getImportFileRecords()).toEqual({});
  });

  it('リンク先が存在しないバッチは全拒否（0 件更新）', async () => {
    const digest = await paypayDigest();
    await expect(
      applyImportBatch(
        batchInput(digest, [{ kind: 'link', rowKey: rk('30'), entryId: 'missing-entry' }]),
      ),
    ).rejects.toMatchObject({ code: 'error.import.linkTargetMissing' });
    expect((await loadLedger()).importDecisions).toHaveLength(0);
  });

  it('二重適用: 同一バッチの再実行は alreadyDecided で全拒否（結果は 1 回目のまま）', async () => {
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    const entry = paymentEntry(ledger, 300);
    const input = batchInput(digest, [
      { kind: 'register', rowKey: rk('40'), entry },
      { kind: 'ignore', rowKey: rk('41') },
    ]);
    await applyImportBatch(input);
    // 再実行では entry.id も衝突するが、決定済み検査が先に全拒否する。
    await expect(applyImportBatch(input)).rejects.toMatchObject({
      code: 'error.import.alreadyDecided',
    });
    const after = await loadLedger();
    expect(after.importDecisions).toHaveLength(2);
    expect(after.journalEntries.filter((e) => e.id === entry.id)).toHaveLength(1);
    expect((await getImportFileRecords())[FILE_HASH]?.decidedCount).toBe(2);
  });

  it('stale revision: レビュー後に台帳が変わっていれば全拒否', async () => {
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    const staleVersion = { deviceId: ledger.meta.deviceId, revision: ledger.meta.revision };
    // レビュー表示後に別の保存が入った（revision が進んだ）状況を作る。
    await upsertImportProfile(userProfile());
    await expect(
      applyImportBatch(
        batchInput(digest, [{ kind: 'ignore', rowKey: rk('50') }], {
          expectedLedgerVersion: staleVersion,
        }),
      ),
    ).rejects.toMatchObject({ code: 'error.common.staleData' });
    expect((await loadLedger()).importDecisions).toHaveLength(0);
  });

  it('profile digest 不一致（レビュー中の profile 変更）は全拒否', async () => {
    const digest = await paypayDigest();
    // レビュー表示後に profile が編集された（DSL が変わった）状況: 別 DSL のユーザー profile を
    // 同じ ID にはできないため、digest の食い違いそのものを渡して検証する。
    await expect(
      applyImportBatch(batchInput('stale-digest', [{ kind: 'ignore', rowKey: rk('60') }])),
    ).rejects.toMatchObject({ code: 'error.import.profileChanged' });
    expect((await loadLedger()).importDecisions).toHaveLength(0);
    // 正しい digest なら通る（対照）。
    await applyImportBatch(batchInput(digest, [{ kind: 'ignore', rowKey: rk('60') }]));
    expect((await loadLedger()).importDecisions).toHaveLength(1);
  });

  it('取込元識別子と一致しない rowKey・バッチ内重複・既存 ID 上書きを拒否', async () => {
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    await expect(
      applyImportBatch(
        batchInput(digest, [{ kind: 'ignore', rowKey: externalRowKey('別の口座', ['1', 'x']) }]),
      ),
    ).rejects.toMatchObject({ code: 'error.import.rowKeyMismatch' });
    await expect(
      applyImportBatch(
        batchInput(digest, [
          { kind: 'ignore', rowKey: rk('70') },
          { kind: 'ignore', rowKey: rk('70') },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'error.import.duplicateRowKey' });
    // 既存仕訳と同じ ID の register は黙った上書きになるため拒否。
    const existing = paymentEntry(ledger, 100);
    await upsertEntry(existing);
    await expect(
      applyImportBatch(
        batchInput(digest, [
          {
            kind: 'register',
            rowKey: rk('71'),
            entry: { ...paymentEntry(ledger, 200), id: existing.id },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'error.import.entryIdConflict' });
  });
});

describe('decision のライフサイクル（§1-2・§4 手順 6）', () => {
  it('仕訳の削除で、その仕訳を参照する decision（registered / linked）が同一 tx で解除される', async () => {
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    const entry = paymentEntry(ledger, 900);
    await applyImportBatch(
      batchInput(digest, [
        { kind: 'register', rowKey: rk('80'), entry },
        { kind: 'link', rowKey: rk('81'), entryId: entry.id },
        { kind: 'ignore', rowKey: rk('82') },
      ]),
    );
    await deleteEntry(entry.id);
    const after = await loadLedger();
    // registered / linked は未解決へ戻り、ignore（仕訳非参照）は残る。
    expect(after.importDecisions.map((d) => d.key)).toEqual([rk('82')]);
    expect((await getImportFileRecords())[FILE_HASH]?.decidedCount).toBe(1);
  });

  it('無視の解除 / リンクの解除は decision 削除の対称 1 操作で冪等', async () => {
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    const entry = paymentEntry(ledger, 700);
    await applyImportBatch(
      batchInput(digest, [
        { kind: 'register', rowKey: rk('90'), entry },
        { kind: 'link', rowKey: rk('91'), entryId: entry.id },
        { kind: 'ignore', rowKey: rk('92') },
      ]),
    );
    expect(await removeImportDecisions([rk('91'), rk('92')])).toBe(2);
    const after = await loadLedger();
    expect(after.importDecisions.map((d) => d.key)).toEqual([rk('90')]);
    // 冪等: 既に無いキーの解除は何もしない（revision も進まない）。
    const beforeRevision = after.meta.revision;
    expect(await removeImportDecisions([rk('91'), rk('92')])).toBe(0);
    expect((await loadLedger()).meta.revision).toBe(beforeRevision);
    expect((await getImportFileRecords())[FILE_HASH]?.decidedCount).toBe(1);
    // 仕訳そのものは残る（リンク解除はデータを消さない）。
    expect((await loadLedger()).journalEntries.some((e) => e.id === entry.id)).toBe(true);
  });

  it('仕訳の編集で import 由来メタが保持される（entry.ts の更新ヘルパー修正の固定）', async () => {
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    const entry = paymentEntry(ledger, 1500);
    await applyImportBatch(batchInput(digest, [{ kind: 'register', rowKey: rk('95'), entry }]));
    const saved = (await loadLedger()).journalEntries.find((e) => e.id === entry.id)!;
    // 編集フォームと同じ経路（toSimpleInput → buildSimpleEntry）で摘要だけ変える。
    const edited = buildSimpleEntry(
      { ...toSimpleInput(saved), description: '編集後の摘要' },
      { id: saved.id, createdAt: saved.createdAt },
    );
    await upsertEntry(edited);
    const after = (await loadLedger()).journalEntries.find((e) => e.id === entry.id)!;
    expect(after.description).toBe('編集後の摘要');
    expect(after.metadata).toMatchObject({
      importSource: PAYPAY_PROFILE_ID,
      importSourceIdentity: SOURCE,
      importRowKey: rk('95'),
    });
  });
});

describe('importDecisionSchema の status ↔ entryId 相関（§1-2）', () => {
  const base = {
    key: fingerprintRowKey(SOURCE, 'ab'.repeat(32), 1),
    decidedAt: '2026-08-11T00:00:00.000Z',
    provenance: {
      profileId: PAYPAY_PROFILE_ID,
      profileDigest: 'digest',
      fileHash: FILE_HASH,
      sourceIdentity: SOURCE,
      identityVersion: 1,
    },
  };

  it('registered / linked は entryId 必須', () => {
    expect(importDecisionSchema.safeParse({ ...base, status: 'registered' }).success).toBe(false);
    expect(importDecisionSchema.safeParse({ ...base, status: 'linked' }).success).toBe(false);
    expect(
      importDecisionSchema.safeParse({ ...base, status: 'registered', entryId: 'e1' }).success,
    ).toBe(true);
    expect(
      importDecisionSchema.safeParse({ ...base, status: 'linked', entryId: 'e1' }).success,
    ).toBe(true);
  });

  it('ignored は entryId 禁止', () => {
    expect(importDecisionSchema.safeParse({ ...base, status: 'ignored' }).success).toBe(true);
    expect(
      importDecisionSchema.safeParse({ ...base, status: 'ignored', entryId: 'e1' }).success,
    ).toBe(false);
  });
});

describe('完全往復（§7 チェックリスト・§9 復元）', () => {
  async function seedImportState() {
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    await upsertImportProfile(userProfile());
    await upsertProfileBinding(binding(await loadLedger()));
    const entry = paymentEntry(ledger, 2500);
    await applyImportBatch(
      batchInput(digest, [
        { kind: 'register', rowKey: rk('100'), entry },
        { kind: 'ignore', rowKey: rk('101') },
      ]),
    );
    return loadLedger();
  }

  it('export → import(replace) で profiles / bindings / decisions が往復する', async () => {
    const seeded = await seedImportState();
    const outcome = await importFromJsonText(exportToJsonText(seeded));
    expect(outcome.kind).toBe('ok');
    const after = await loadLedger();
    expect(after.importProfiles.map((p) => p.id).sort()).toEqual(
      [PAYPAY_PROFILE_ID, 'user-profile-1'].sort(),
    );
    expect(after.profileBindings).toHaveLength(1);
    expect(after.importDecisions.map((d) => d.key).sort()).toEqual([rk('100'), rk('101')].sort());
  });

  it('削除済みの組み込みは import(replace) で勝手に復活しない', async () => {
    await seedImportState();
    await deleteImportProfile(PAYPAY_PROFILE_ID);
    const withoutBuiltin = await loadLedger();
    const outcome = await importFromJsonText(exportToJsonText(withoutBuiltin), { force: true });
    expect(outcome.kind).toBe('ok');
    const after = await loadLedger();
    expect(after.importProfiles.map((p) => p.id)).toEqual(['user-profile-1']);
    // decision / binding は残る（soft reference）。
    expect(after.profileBindings).toHaveLength(1);
    expect(after.importDecisions).toHaveLength(2);
  });

  it('snapshot 作成 → 復元で profiles / bindings / decisions が戻る', async () => {
    const seeded = await seedImportState();
    const snapshot = buildExportPackage(seeded);
    // スナップショット後に変更を入れてから復元する。
    await removeImportDecisions([rk('101')]);
    await deleteImportProfile('user-profile-1');
    expect((await loadLedger()).importDecisions).toHaveLength(1);

    const restored = await restoreFromSnapshot(snapshot);
    expect(restored.importProfiles.map((p) => p.id).sort()).toEqual(
      [PAYPAY_PROFILE_ID, 'user-profile-1'].sort(),
    );
    expect(restored.importDecisions).toHaveLength(2);
    expect(restored.profileBindings).toHaveLength(1);
  });

  it('reset(全消去) で取込データが消え、組み込み profile だけが seed し直される', async () => {
    await seedImportState();
    await deleteImportProfile(PAYPAY_PROFILE_ID);
    await resetAll();
    const after = await loadLedger();
    expect(after.importProfiles.map((p) => p.id)).toEqual([PAYPAY_PROFILE_ID]);
    expect(after.profileBindings).toHaveLength(0);
    expect(after.importDecisions).toHaveLength(0);
    expect(await getImportFileRecords()).toEqual({});
  });

  it('v8 の必須配列が欠けたパッケージは validation-error（fail-closed）', async () => {
    const seeded = await seedImportState();
    const pkg = JSON.parse(exportToJsonText(seeded)) as Record<string, unknown>;
    delete pkg['importDecisions'];
    const outcome = await importFromJsonText(JSON.stringify(pkg), { force: true });
    expect(outcome.kind).toBe('validation-error');
    // 既存データは変更されない。
    expect((await loadLedger()).importDecisions).toHaveLength(2);
  });
});
