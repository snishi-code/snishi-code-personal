/*
 * 汎用リスト行。EntryListItem の「main/sub/trailing スロット」を
 * ドメイン非依存に抽象化したもの。
 * - クリック可能なときは <button> としてレンダリングされる。
 * - trailing は右端（金額・アイコン等）。
 */
import type { ReactNode } from 'react';

export function ListRow({
  main,
  sub,
  trailing,
  onClick,
  dataUi,
}: {
  /** メインテキスト（必須） */
  main: ReactNode;
  /** サブテキスト（日付・補足等） */
  sub?: ReactNode;
  /** 右端に置く要素（金額・アイコン等） */
  trailing?: ReactNode;
  onClick?: () => void;
  dataUi?: string;
}) {
  const content = (
    <>
      <div className="list__main">
        <div className="list__title">{main}</div>
        {sub ? <div className="list__sub">{sub}</div> : null}
      </div>
      {trailing ? <span className="list__trailing">{trailing}</span> : null}
    </>
  );

  if (onClick) {
    return (
      <li>
        <button type="button" className="list__item" onClick={onClick} data-ui={dataUi}>
          {content}
        </button>
      </li>
    );
  }
  return (
    <li className="list__item" data-ui={dataUi}>
      {content}
    </li>
  );
}
