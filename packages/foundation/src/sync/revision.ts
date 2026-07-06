// 端末間 LWW 同期の revision プリミティブ (Lamport/HLC-lite)。
//
// local-first アプリの「群 revision」比較に使う、domain 非依存の純関数 2 つ。
// hospital-workspace の userWorkSync で実運用実績のある実装を foundation へ昇格したもの
// (2026-07-06)。アプリ側は re-export か直接 import で使う。

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 受信した revision を取り込むべきか。strictly greater のときだけ true。
 * 同じ payload を重複受信しても (==) false で巻き戻り/破壊しない。古い revision (<) も false で
 * 新しい状態を守る (LWW の受信側判定)。
 */
export function shouldApplyRevision(existingUpdatedAt: number, incomingUpdatedAt: number): boolean {
  return num(incomingUpdatedAt) > num(existingUpdatedAt);
}

/**
 * ローカル編集時の次の群 revision (Lamport/HLC-lite)。
 *
 * revision は端末間 LWW の比較値だが、各端末の壁時計は揃っている保証がない。生の Date.now() を
 * そのまま使うと、時計が進んだ端末の revision が「未来」に立ち、それを見た後の相手側編集
 * (実時間では新しい) が LWW で静かに棄却され続ける (時計ズレの汚染)。
 *
 * そこで編集時のスタンプは必ず `max(now, 既存 revision + 1)` にする:
 *   - 既存値 (= 相手から同期済みの値を含む) を見た後の編集は、時計に関係なく必ずそれより大きい
 *     revision を持つ → 因果的に後の編集が落ちることはない。
 *   - 両端末が互いを見ずに同じ群を編集した真の並行編集だけが壁時計の近似で決着する
 *     (単一スカラー revision の LWW として設計どおり)。
 * 採用した相手の revision が自端末の時計より先でも、単調性は保たれ比較は常に一貫する。
 */
export function nextGroupRevision(nowTs: number, prevRevision?: number): number {
  return Math.max(num(nowTs), num(prevRevision) + 1);
}
