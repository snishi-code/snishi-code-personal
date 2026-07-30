// 下部固定の操作バー: [受信] ─spacer─ [ホーム] ─spacer─ [送信]。
// どの画面 (ホーム/患者詳細/設定) でも同じ意味 (左=受信 / 中央=ホーム / 右=送信) に固定するため、
// 3 画面で重複していた JSX をここへ 1 本化した。差分 (class / data-ui / ラベル / disabled / onClick) は
// props で渡す。DOM 構造と data-ui はテストが依存するので変えない (div > IconButton・spacer・…)。

import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';

/** 1 ボタン分の指定。onClick 省略時は非活性ボタン (現在地など)。 */
interface BottomActionButton {
  label: string;
  dataUi: string;
  onClick?: () => void;
  disabled?: boolean;
}

interface BottomActionBarProps {
  /** バー div の className (詳細画面のみ detailActionBar を足す等)。 */
  className?: string;
  /** バー div の data-ui (home.actionBar / detail.actionBar / settings.actionBar)。 */
  dataUi: string;
  /** 左: 受信 (scan アイコン)。省略時は非表示 (端末間QRの撤去で現在は未使用。簡素同期での復活枠)。 */
  recv?: BottomActionButton;
  /** 中央: ホーム (home アイコン)。 */
  home: BottomActionButton;
  /** 右: 送信 (qr アイコン)。省略時は非表示 (端末間同期の撤去で現在は未使用。簡素同期での復活枠)。 */
  send?: BottomActionButton;
}

export function BottomActionBar({ className, dataUi, recv, home, send }: BottomActionBarProps) {
  const barClassName = className ? `bottomActionBar ${className}` : 'bottomActionBar';
  return (
    <div className={barClassName} data-ui={dataUi}>
      {recv ? (
        <IconButton
          label={recv.label}
          dataUi={recv.dataUi}
          onClick={recv.onClick}
          disabled={recv.disabled}
        >
          <Icon name="scan" size={20} />
        </IconButton>
      ) : null}
      <span className="viewToolbarSpacer" />
      <IconButton
        label={home.label}
        dataUi={home.dataUi}
        onClick={home.onClick}
        disabled={home.disabled}
      >
        <Icon name="home" size={20} />
      </IconButton>
      <span className="viewToolbarSpacer" />
      {send ? (
        <IconButton
          label={send.label}
          dataUi={send.dataUi}
          onClick={send.onClick}
          disabled={send.disabled}
        >
          <Icon name="qr" size={20} />
        </IconButton>
      ) : null}
    </div>
  );
}
