/*
 * overlays.tsx（オーバーレイ登録簿 + 登録内蔵ラッパー）のテスト。
 *  - 登録順 = 開いた順で、closeTopOverlay は最前面（最後に開いたもの）だけを閉じる。
 *    閉じる = onClose が state を変えて unmount することで登録が外れる（実運用と同じ）。
 *  - useDirtyGuard: dirty 時は破棄確認が登録され、Back（closeTopOverlay）が
 *    「編集を続ける」として確認だけを閉じる。
 */
import { useState } from 'react';
import { act } from 'react';
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import {
  Modal,
  OverlayBinding,
  closeTopOverlay,
  useDirtyGuard,
  _resetOverlaysForTests,
} from '../src/ui/overlays';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

describe('オーバーレイ登録簿', () => {
  it('closeTopOverlay は最後に開いた overlay だけを閉じ、無ければ false', () => {
    const closed: string[] = [];
    let closeA = () => {};
    let closeB = () => {};

    function Harness() {
      const [a, setA] = useState(true);
      const [b, setB] = useState(true);
      closeA = () => setA(false);
      closeB = () => setB(false);
      return (
        <>
          {a ? (
            <OverlayBinding
              onClose={() => {
                closed.push('a');
                closeA();
              }}
            />
          ) : null}
          {b ? (
            <OverlayBinding
              onClose={() => {
                closed.push('b');
                closeB();
              }}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);

    // 最後に開いた b が先に閉じる（閉じると unmount され、登録が外れる）。
    act(() => {
      expect(closeTopOverlay()).toBe(true);
    });
    expect(closed).toEqual(['b']);

    act(() => {
      expect(closeTopOverlay()).toBe(true);
    });
    expect(closed).toEqual(['b', 'a']);

    // すべて閉じたら false（appHistory は次の優先度へ進む）。
    expect(closeTopOverlay()).toBe(false);
  });

  it('unmount で登録が外れる', () => {
    const closed: string[] = [];
    const { unmount } = render(<OverlayBinding onClose={() => closed.push('x')} />);
    unmount();
    expect(closeTopOverlay()).toBe(false);
    expect(closed).toEqual([]);
  });

  it('Modal ラッパーは onClose を登録する', () => {
    function Harness() {
      const [visible, setVisible] = useState(true);
      return visible ? (
        <Modal title="テストシート" onClose={() => setVisible(false)}>
          <p>body</p>
        </Modal>
      ) : null;
    }
    render(<Harness />);
    expect(screen.getByText('テストシート')).toBeInTheDocument();
    act(() => {
      expect(closeTopOverlay()).toBe(true);
    });
    expect(screen.queryByText('テストシート')).not.toBeInTheDocument();
  });
});

describe('useDirtyGuard（登録簿対応版）', () => {
  function GuardedSheet({ dirty, onClose }: { dirty: boolean; onClose: () => void }) {
    const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);
    return (
      <>
        <Modal title="編集" onClose={requestClose} dismissMode="if-clean">
          <p>form</p>
        </Modal>
        {discardConfirm}
      </>
    );
  }

  it('未編集なら Back（closeTopOverlay）で即閉じる', () => {
    let closed = false;
    render(<GuardedSheet dirty={false} onClose={() => (closed = true)} />);
    act(() => {
      expect(closeTopOverlay()).toBe(true);
    });
    expect(closed).toBe(true);
  });

  it('編集済みなら破棄確認が出て、Back は「編集を続ける」として確認だけを閉じる', () => {
    let closed = false;
    render(<GuardedSheet dirty={true} onClose={() => (closed = true)} />);

    // 1 回目の Back: requestClose → dirty なので破棄確認が開く（シートは閉じない）。
    act(() => {
      expect(closeTopOverlay()).toBe(true);
    });
    expect(closed).toBe(false);
    expect(screen.getByText('変更を破棄しますか？')).toBeInTheDocument();

    // 2 回目の Back: 最前面 = 破棄確認。キャンセル（編集を続ける）として確認だけ閉じる。
    act(() => {
      expect(closeTopOverlay()).toBe(true);
    });
    expect(closed).toBe(false);
    expect(screen.queryByText('変更を破棄しますか？')).not.toBeInTheDocument();

    // 破棄を明示的に選んだときだけ close が走る。
    act(() => {
      expect(closeTopOverlay()).toBe(true); // 確認を再表示
    });
    fireEvent.click(screen.getByText('破棄する'));
    expect(closed).toBe(true);
  });
});
