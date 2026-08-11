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
  archiveAccount,
  createImportProfile,
  deleteAccount,
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
/** 行キーの名前空間 = binding の不変な取込元 ID（表示名 SOURCE とは別・監査 P1-3）。 */
const SOURCE_ID = 'source-paypay-1';
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
    sourceId: SOURCE_ID,
    sourceIdentity: SOURCE,
    ownAccountId: account(ledger, 'チャージ残高').id,
    kindDestinations: { 'ポイント、残高の獲得': account(ledger, 'その他収入').id },
    chargeSourceAccountId: account(ledger, '預金').id,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

/** applyImportBatch は binding の実在が必須（監査 P1-3）のため、適用系テストは先に seed する。 */
async function seedPaypayBinding(overrides: Partial<ProfileBinding> = {}): Promise<ProfileBinding> {
  return upsertProfileBinding(binding(await loadLedger(), overrides));
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
    bindingId: 'binding-1',
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
  return externalRowKey(SOURCE_ID, [no, kind]);
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

  it('組み込みの編集 = 複製→新規（旧をアーカイブ・新規に builtin 印は付かない）', async () => {
    const ledger = await loadLedger();
    const builtin = ledger.importProfiles.find((p) => p.id === PAYPAY_PROFILE_ID)!;
    // 上書き保存は廃止（作者決定 2026-08-11）: 同一 ID への保存は fail-closed に拒否。
    await expect(createImportProfile({ ...builtin, name: '改名した組み込み' })).rejects.toThrow();
    // 編集 = archiveProfileId 指定で旧をアーカイブして新規作成。
    const copy = await createImportProfile(
      userProfile({ id: 'paypay-copy-1', name: '改名した組み込み', dsl: builtin.dsl }),
      { archiveProfileId: PAYPAY_PROFILE_ID },
    );
    expect(copy.builtin).toBe(undefined);
    const after = await loadLedger();
    const archived = after.importProfiles.find((p) => p.id === PAYPAY_PROFILE_ID)!;
    expect(archived.archived).toBe(true);
    expect(archived.builtin?.builtinId).toBe(PAYPAY_BUILTIN_ID); // 印は原本に残る
    const created = after.importProfiles.find((p) => p.id === 'paypay-copy-1')!;
    expect(created.name).toBe('改名した組み込み');
    expect(created.builtin).toBe(undefined); // 複製側に組み込み印は付かない
    expect(created.archived).toBe(undefined); // 新規は常に非アーカイブ

    // 「組み込みを復元」= 原本での上書き = アーカイブ済み組み込みが有効へ戻る唯一の経路。
    await restoreBuiltinImportProfiles();
    const restored = (await loadLedger()).importProfiles.find((p) => p.id === PAYPAY_PROFILE_ID)!;
    expect(restored.name).toBe(PAYPAY_PROFILE_NAME);
    expect(restored.archived).toBe(undefined);
  });

  it('ユーザー入力からの builtin 印の持ち込みは拒否する（fail-closed）', async () => {
    await loadLedger();
    await expect(
      createImportProfile(userProfile({ builtin: { builtinId: 'forged', builtinVersion: 1 } })),
    ).rejects.toMatchObject({ code: 'error.importProfile.builtinReserved' });
    expect((await loadLedger()).importProfiles.some((p) => p.id === 'user-profile-1')).toBe(false);
  });

  it('既存 ID への保存（黙った上書き）と存在しない archiveProfileId を拒否する', async () => {
    await loadLedger();
    await createImportProfile(userProfile());
    await expect(
      createImportProfile(userProfile({ name: '同じIDで上書き' })),
    ).rejects.toMatchObject({ code: 'error.importProfile.idConflict' });
    // 何も変わっていない（部分保存なし）。
    const after = await loadLedger();
    expect(after.importProfiles.find((p) => p.id === 'user-profile-1')?.name).toBe(
      'ユーザー定義CSV',
    );
    await expect(
      createImportProfile(userProfile({ id: 'user-profile-2' }), {
        archiveProfileId: 'missing-profile',
      }),
    ).rejects.toMatchObject({ code: 'error.importProfile.notFound' });
    expect((await loadLedger()).importProfiles.some((p) => p.id === 'user-profile-2')).toBe(false);
  });

  it('作り直し（アーカイブ+新規）で binding が新 profile へ付け替わる（sourceId 不変）', async () => {
    const ledger = await loadLedger();
    await createImportProfile(userProfile());
    await upsertProfileBinding(
      binding(ledger, {
        id: 'binding-user',
        profileId: 'user-profile-1',
        sourceId: 'source-user-1',
      }),
    );
    await createImportProfile(userProfile({ id: 'user-profile-2', name: '作り直し版' }), {
      archiveProfileId: 'user-profile-1',
    });
    const after = await loadLedger();
    expect(after.importProfiles.find((p) => p.id === 'user-profile-1')?.archived).toBe(true);
    expect(after.importProfiles.find((p) => p.id === 'user-profile-2')?.archived).toBe(undefined);
    // binding は同一 tx で新 profile へ移り、sourceId は不変 = 過去の決定の照合が保たれる。
    const moved = after.profileBindings.find((b) => b.id === 'binding-user')!;
    expect(moved.profileId).toBe('user-profile-2');
    expect(moved.sourceId).toBe('source-user-1');
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

  it('存在しない profile への binding と、同一 (profile, 取込元表示名) の重複を拒否', async () => {
    const ledger = await loadLedger();
    await expect(
      upsertProfileBinding(binding(ledger, { profileId: 'missing-profile' })),
    ).rejects.toMatchObject({ code: 'error.importProfile.notFound' });
    await upsertProfileBinding(binding(ledger));
    await expect(
      upsertProfileBinding(binding(ledger, { id: 'binding-2', sourceId: 'source-paypay-2' })),
    ).rejects.toMatchObject({
      code: 'error.importBinding.duplicate',
    });
    // 同じ id への上書き（編集）は通る。
    await upsertProfileBinding(binding(ledger, { chargeSourceAccountId: undefined }));
    expect((await findProfileBinding(PAYPAY_PROFILE_ID, SOURCE))?.chargeSourceAccountId).toBe(
      undefined,
    );
  });

  it('sourceId は不変（既存 binding の変更を拒否）・全 binding で一意（監査 P1-3）', async () => {
    const ledger = await loadLedger();
    await upsertProfileBinding(binding(ledger));
    // 既存 binding の sourceId 変更は拒否（過去の決定が照合できなくなる）。
    await expect(
      upsertProfileBinding(binding(ledger, { sourceId: 'source-paypay-renamed' })),
    ).rejects.toMatchObject({ code: 'error.importBinding.sourceIdImmutable' });
    // 別 binding が同じ sourceId を名乗るのも拒否（名前空間の混線）。
    await expect(
      upsertProfileBinding(binding(ledger, { id: 'binding-2', sourceIdentity: '別名の取込元' })),
    ).rejects.toMatchObject({ code: 'error.importBinding.sourceIdDuplicate' });
    // 表示名の変更は sourceId 不変のまま通る（監査 P1-3 の緩和面）。
    await upsertProfileBinding(binding(ledger, { sourceIdentity: 'PayPay改名後' }));
    const renamed = await findProfileBinding(PAYPAY_PROFILE_ID, 'PayPay改名後');
    expect(renamed?.sourceId).toBe(SOURCE_ID);
  });
});

describe('applyImportBatch の一括適用（§4-4）', () => {
  it('register / link / ignore を単一適用で保存し、由来メタとファイル記録が付く', async () => {
    const ledger = await loadLedger();
    await seedPaypayBinding();
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
    // provenance が保存される（§5-1。名前空間は表示名ではなく不変の sourceId）。
    expect(decisions.get(rk('1'))?.provenance).toMatchObject({
      profileId: PAYPAY_PROFILE_ID,
      profileDigest: digest,
      fileHash: FILE_HASH,
      sourceId: SOURCE_ID,
      identityVersion: 1,
    });
    // ファイル記録（情報表示と再開用）。
    expect((await getImportFileRecords())[FILE_HASH]).toMatchObject({
      totalRowCount: 10,
      decidedCount: 3,
    });
  });

  it('binding 学習（既存 binding の更新）を適用と同一バッチで保存できる', async () => {
    const ledger = await loadLedger();
    await seedPaypayBinding();
    const digest = await paypayDigest();
    const learned = binding(ledger, {
      kindDestinations: {
        'ポイント、残高の獲得': account(ledger, 'その他収入').id,
        支払い: account(ledger, '変動費').id,
      },
    });
    await applyImportBatch(
      batchInput(digest, [{ kind: 'ignore', rowKey: rk('10') }], {
        bindingUpdate: learned,
      }),
    );
    expect((await findProfileBinding(PAYPAY_PROFILE_ID, SOURCE))?.kindDestinations['支払い']).toBe(
      account(ledger, '変動費').id,
    );
  });

  it('原子性: 不正行（存在しない科目）が混ざったバッチは 0 件更新', async () => {
    const ledger = await loadLedger();
    await seedPaypayBinding();
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
    await seedPaypayBinding();
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
    await seedPaypayBinding();
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
    await seedPaypayBinding();
    const ledger = await loadLedger();
    const digest = await paypayDigest();
    const staleVersion = { deviceId: ledger.meta.deviceId, revision: ledger.meta.revision };
    // レビュー表示後に別の保存が入った（revision が進んだ）状況を作る。
    await createImportProfile(userProfile());
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
    await seedPaypayBinding();
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

  it('取込元 ID と一致しない rowKey・バッチ内重複・既存 ID 上書きを拒否', async () => {
    const ledger = await loadLedger();
    await seedPaypayBinding();
    const digest = await paypayDigest();
    await expect(
      applyImportBatch(
        batchInput(digest, [
          { kind: 'ignore', rowKey: externalRowKey('other-source-id', ['1', 'x']) },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'error.import.rowKeyMismatch' });
    // 表示名（sourceIdentity）で作ったキーも通らない（名前空間は sourceId・監査 P1-3）。
    await expect(
      applyImportBatch(
        batchInput(digest, [{ kind: 'ignore', rowKey: externalRowKey(SOURCE, ['1', 'x']) }]),
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

  it('binding 再検証: 存在しない bindingId は全拒否（0 件更新・監査 P1-3）', async () => {
    await seedPaypayBinding();
    const digest = await paypayDigest();
    await expect(
      applyImportBatch(
        batchInput(digest, [{ kind: 'ignore', rowKey: rk('110') }], {
          bindingId: 'missing-binding',
        }),
      ),
    ).rejects.toMatchObject({ code: 'error.importBinding.notFound' });
    // binding と profile の不整合（別 profile の binding）も拒否。
    await createImportProfile(userProfile());
    await expect(
      applyImportBatch(
        batchInput(digest, [{ kind: 'ignore', rowKey: rk('110') }], {
          profileId: 'user-profile-1',
          profileDigest: await profileDslDigest(USER_DSL),
        }),
      ),
    ).rejects.toMatchObject({ code: 'error.importBinding.notFound' });
    expect((await loadLedger()).importDecisions).toHaveLength(0);
  });

  it('binding 再検証: 参照科目の消失（計上先の削除）は全拒否（0 件更新・監査 P1-3）', async () => {
    const ledger = await loadLedger();
    await seedPaypayBinding();
    const digest = await paypayDigest();
    // binding が計上先に指す「その他収入」を削除（未参照の科目は削除できる = soft reference が壊れる）。
    await deleteAccount(account(ledger, 'その他収入').id);
    await expect(
      applyImportBatch(batchInput(digest, [{ kind: 'ignore', rowKey: rk('111') }])),
    ).rejects.toMatchObject({ code: 'error.importBinding.destinationRole' });
    expect((await loadLedger()).importDecisions).toHaveLength(0);
    expect(await getImportFileRecords()).toEqual({});
  });

  it('binding 再検証: 参照科目のアーカイブは全拒否（UI の broken 判定と同一条件・0 件更新）', async () => {
    const ledger = await loadLedger();
    await seedPaypayBinding();
    const digest = await paypayDigest();
    // 計上先（その他収入）をアーカイブ → 実在はするが archived = UI では broken 表示。
    // 適用側（tx 内再検証）も同じ条件で全拒否する（判定のズレを作らない・P1 の穴埋め）。
    await archiveAccount(account(ledger, 'その他収入').id);
    await expect(
      applyImportBatch(batchInput(digest, [{ kind: 'ignore', rowKey: rk('112') }])),
    ).rejects.toMatchObject({ code: 'error.importBinding.destinationRole' });
    expect((await loadLedger()).importDecisions).toHaveLength(0);
    expect(await getImportFileRecords()).toEqual({});
  });

  it('別 profile ×同名の取込元でも sourceId が違えば rowKey は衝突しない（監査 P1-3）', async () => {
    const ledger = await loadLedger();
    await seedPaypayBinding();
    await createImportProfile(userProfile());
    // 別 profile に同じ表示名「PayPay本体」の取込元を作る（sourceId は別）。
    await upsertProfileBinding(
      binding(ledger, {
        id: 'binding-user',
        profileId: 'user-profile-1',
        sourceId: 'source-user-1',
        kindDestinations: {},
      }),
    );
    // 同じ externalId タプルでも名前空間（sourceId）が違うため rowKey 自体が別物。
    expect(externalRowKey(SOURCE_ID, ['1', '支払い'])).not.toBe(
      externalRowKey('source-user-1', ['1', '支払い']),
    );
    // PayPay 側で決定済みでも、user 側の同じタプルの行は alreadyDecided にならず適用できる。
    const digest = await paypayDigest();
    await applyImportBatch(batchInput(digest, [{ kind: 'ignore', rowKey: rk('1') }]));
    await applyImportBatch(
      batchInput(
        await profileDslDigest(USER_DSL),
        [{ kind: 'ignore', rowKey: externalRowKey('source-user-1', ['1', '支払い']) }],
        { profileId: 'user-profile-1', bindingId: 'binding-user' },
      ),
    );
    const after = await loadLedger();
    expect(after.importDecisions).toHaveLength(2);
    expect(new Set(after.importDecisions.map((d) => d.provenance.sourceId))).toEqual(
      new Set([SOURCE_ID, 'source-user-1']),
    );
  });

  it('取込元の表示名を変更しても既存 decision は生きている（sourceId 不変・監査 P1-3）', async () => {
    const ledger = await loadLedger();
    await seedPaypayBinding();
    const digest = await paypayDigest();
    await applyImportBatch(batchInput(digest, [{ kind: 'ignore', rowKey: rk('120') }]));
    // 表示名を変更（sourceId は不変）。
    await upsertProfileBinding(binding(ledger, { sourceIdentity: 'PayPay改名後' }));
    // 同じ行の再決定は alreadyDecided = 過去の決定が改名後も照合されている。
    await expect(
      applyImportBatch(batchInput(digest, [{ kind: 'ignore', rowKey: rk('120') }])),
    ).rejects.toMatchObject({ code: 'error.import.alreadyDecided' });
    const decisions = await getImportDecisions([rk('120')]);
    expect(decisions.get(rk('120'))?.provenance.sourceId).toBe(SOURCE_ID);
  });
});

describe('decision のライフサイクル（§1-2・§4 手順 6）', () => {
  it('仕訳の削除で、その仕訳を参照する decision（registered / linked）が同一 tx で解除される', async () => {
    const ledger = await loadLedger();
    await seedPaypayBinding();
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
    await seedPaypayBinding();
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
    await seedPaypayBinding();
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
    key: fingerprintRowKey(SOURCE_ID, 'ab'.repeat(32), 1),
    decidedAt: '2026-08-11T00:00:00.000Z',
    provenance: {
      profileId: PAYPAY_PROFILE_ID,
      profileDigest: 'digest',
      fileHash: FILE_HASH,
      sourceId: SOURCE_ID,
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
    await createImportProfile(userProfile());
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

  it('archived が export → import(replace) / snapshot を往復し、reset で消える（v9）', async () => {
    await loadLedger();
    await createImportProfile(userProfile());
    await createImportProfile(userProfile({ id: 'user-profile-2', name: '第2版' }), {
      archiveProfileId: 'user-profile-1',
    });
    const seeded = await loadLedger();
    expect(seeded.importProfiles.find((p) => p.id === 'user-profile-1')?.archived).toBe(true);

    // export → import(replace)。
    const outcome = await importFromJsonText(exportToJsonText(seeded));
    expect(outcome.kind).toBe('ok');
    const replaced = await loadLedger();
    expect(replaced.importProfiles.find((p) => p.id === 'user-profile-1')?.archived).toBe(true);
    expect(replaced.importProfiles.find((p) => p.id === 'user-profile-2')?.archived).toBe(
      undefined,
    );

    // snapshot → 復元。
    const snapshot = buildExportPackage(replaced);
    await deleteImportProfile('user-profile-1');
    const restored = await restoreFromSnapshot(snapshot);
    expect(restored.importProfiles.find((p) => p.id === 'user-profile-1')?.archived).toBe(true);

    // reset(全消去): アーカイブ済みも含めて消え、組み込みだけが seed し直される。
    await resetAll();
    expect((await loadLedger()).importProfiles.map((p) => p.id)).toEqual([PAYPAY_PROFILE_ID]);
  });

  it('v9 の必須配列が欠けたパッケージは validation-error（fail-closed）', async () => {
    const seeded = await seedImportState();
    const pkg = JSON.parse(exportToJsonText(seeded)) as Record<string, unknown>;
    delete pkg['importDecisions'];
    const outcome = await importFromJsonText(JSON.stringify(pkg), { force: true });
    expect(outcome.kind).toBe('validation-error');
    // 既存データは変更されない。
    expect((await loadLedger()).importDecisions).toHaveLength(2);
  });
});
