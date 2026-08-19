import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { act, useEffect, useState } from 'react';
import {
  TimelineCalendarView,
  continuousCostChildren,
  type TimelineZoom,
} from '../src/ui/screens/TimelineCalendar';
import { buildLensRowViews } from '../src/ui/components/LensRowTree';
import { buildLensRowTree } from '../src/domain/lensRows';
import { ACCOUNT_ACCENTS, TIMELINE_ACCOUNT_BOXES } from '../src/ui/accountBoxes';
import { closeTopOverlay, _resetOverlaysForTests } from '../src/ui/overlays';
import type { Account } from '../src/domain/types';
import { UI } from '../src/ui-contract';
import './setup';

const cash: Account = {
  id: 'cash',
  name: '預金',
  type: 'asset',
  role: 'daily-asset',
  archived: false,
  startDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const food: Account = {
  id: 'food',
  name: '食費',
  type: 'expense',
  role: 'expense-category',
  archived: false,
  startDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const flow = {
  id: 'entry-1',
  date: '2026-02-10',
  description: '昼のラーメン',
  amount: 120000,
  sourceAccountId: cash.id,
  destinationAccountId: food.id,
  target: { kind: 'entry' as const, entryId: 'entry-1' },
};

const model = {
  buckets: [
    { key: '2026-01', from: '2026-01-01', to: '2026-01-31' },
    { key: '2026-02', from: '2026-02-01', to: '2026-02-28' },
  ],
  boxes: [
    {
      key: 'assetFree',
      spans: [{ from: '2026-01-01', to: '2026-02-28' }],
      dots: [{ bucketKey: '2026-02', date: flow.date, netChange: -1200, flows: [flow] }],
      accounts: [
        {
          account: cash,
          spans: [{ from: '2026-01-01', to: '2026-02-28' }],
          dots: [{ bucketKey: '2026-02', date: flow.date, netChange: -1200, flows: [flow] }],
        },
      ],
    },
    {
      key: 'expense',
      spans: [{ from: '2026-01-01', to: '2026-02-28' }],
      dots: [{ bucketKey: '2026-02', date: flow.date, netChange: 1200, flows: [flow] }],
      accounts: [
        {
          account: food,
          spans: [{ from: '2026-01-01', to: '2026-02-28' }],
          dots: [{ bucketKey: '2026-02', date: flow.date, netChange: 1200, flows: [flow] }],
        },
      ],
    },
  ],
};

/**
 * v13.6 H3: ラベル列（行の集合・開閉・チェック）は**画面**が持ち、描画本体は受け取るだけ。
 * 単体テストでも画面と同じ規則で組む薄いラッパーを通す（テスト専用の木を作らない）。
 */
type ViewProps = Parameters<typeof TimelineCalendarView>[0];
function LensView(props: Omit<ViewProps, 'rows' | 'onToggleRow' | 'onCheckRow'>) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>());
  const tree = buildLensRowTree(props.accounts, {
    extraChildren: (boxKey) => continuousCostChildren(props.model.boxes, boxKey),
  });
  return (
    <TimelineCalendarView
      {...props}
      rows={buildLensRowViews({ tree, expanded, hidden })}
      onToggleRow={(id) =>
        setExpanded((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        })
      }
      onCheckRow={(id, checked) =>
        setHidden((current) => {
          const next = new Set(current);
          if (checked) next.delete(id);
          else next.add(id);
          return next;
        })
      }
    />
  );
}

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const popover = () => document.querySelector<HTMLElement>(`[data-ui="${UI.timeline.popover}"]`);
const viewportEl = () =>
  document.querySelector<HTMLElement>(`[data-ui="${UI.timeline.viewport}"]`)!;

function rect(box: { top: number; left: number; width: number; height: number }): DOMRect {
  const { top, left, width, height } = box;
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom は実レイアウトを持たないため、位置決めが読む 2 つの実測だけを固定する。
 * viewport は jsdom 既定の 1024x768。
 */
function stubLayout(
  dot: { top: number; left: number },
  size: { width: number; height: number },
): void {
  const dotRect = rect({ top: dot.top, left: dot.left, width: 44, height: 44 });
  const popoverRect = rect({ top: 0, left: 0, width: size.width, height: size.height });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('timeline-calendar__popover')) return popoverRect;
    if (this.classList.contains('timeline-calendar__dot')) return dotRect;
    return rect({ top: 0, left: 0, width: 0, height: 0 });
  });
}

/**
 * ズームは App（ヘッダー）が持つ props になったので、単体テストでは**stateful なラッパー**が
 * 持つ。`setZoom` は「同じマウントのまま props だけ差し替える」入口（再マウントと区別する）。
 */
function renderView({
  onOpenTarget = () => undefined,
  initialWindowKey = 'month:initial',
}: { onOpenTarget?: (target: unknown) => void; initialWindowKey?: string } = {}) {
  // props を差し替える入口をテスト側へ出す。変数の再代入は render 中の副作用として
  // lint に弾かれるので、器（オブジェクト）のプロパティへ載せる。
  const handles: {
    setZoom?: (zoom: TimelineZoom) => void;
    setWindowKey?: (key: string) => void;
  } = {};

  function Harness() {
    const [zoom, setZoom] = useState<TimelineZoom>('month');
    const [windowKey, setWindowKey] = useState(initialWindowKey);
    // 差し替え口の公開は commit 後（render 中に外の値を書かない）。
    useEffect(() => {
      handles.setZoom = setZoom;
      handles.setWindowKey = setWindowKey;
      // setState は同一性が保たれるので 1 回でよい（毎 render 書き直す必要が無い）。
    }, []);
    return (
      <LensView
        model={model}
        zoom={zoom}
        today="2026-02-15"
        accounts={[cash, food]}
        currency="JPY"
        onOpenTarget={onOpenTarget}
        windowKey={windowKey}
      />
    );
  }

  const view = render(<Harness />);
  return {
    ...view,
    setZoom: (zoom: TimelineZoom) => {
      act(() => handles.setZoom!(zoom));
    },
    setWindowKey: (key: string) => {
      act(() => handles.setWindowKey!(key));
    },
  };
}

describe('TimelineCalendarView', () => {
  it('既存の順序と色を再利用した大きな箱を9分類持つ', () => {
    expect(TIMELINE_ACCOUNT_BOXES).toHaveLength(9);
    expect(TIMELINE_ACCOUNT_BOXES.map((box) => box.key)).toEqual([
      'assetFree',
      'assetFixed',
      'investment',
      'continuingCost',
      'shortTermDebt',
      'longTermDebt',
      'income',
      'expense',
      'equity',
    ]);
  });

  it('箱は 9 つ + 恒等行 2 つが常に並び、子を持つ箱だけが開く（開閉はズーム変更後も残る）', () => {
    const view = renderView();

    // 骨格（9 箱）はデータの有無によらず並ぶ。恒等行（収支・純資産）も列に出る。
    expect(document.querySelectorAll(`[data-ui="${UI.timeline.boxRow}"]`)).toHaveLength(9);
    const detailRows = () =>
      document.querySelectorAll(`[data-ui="${UI.timeline.detailRow}"]`).length;
    // 既定は全部たたんだ状態 = 見えている非箱行は恒等行の 2 つだけ。
    expect(detailRows()).toBe(2);

    // 展開トグルが付くのは子を持つ箱（預金のある assetFree・食費のある expense）だけ。
    const boxToggles = document.querySelectorAll(`[data-ui="${UI.timeline.rowToggle}"]`);
    expect(boxToggles).toHaveLength(2);

    fireEvent.click(boxToggles[0]!);
    expect(detailRows()).toBe(3);
    expect(document.body).toHaveTextContent('預金');

    // ズームはヘッダー（App）から props で降ってくる。同じマウントのまま差し替えても
    // 開閉状態は画面ローカルに残る。
    view.setZoom('year');
    expect(detailRows()).toBe(3);
    expect(document.body).toHaveTextContent('預金');
  });

  it('窓（ズーム・前後移動）が変わったら開いているポップオーバーを捨てる', () => {
    // 窓が変わるとポッチの実体も座標も入れ替わる。持ち越すと、消えたポッチに紐づいた
    // ポップオーバーだけが宙に浮いて残る。
    const view = renderView({ initialWindowKey: 'month:2026-01-01:2026-02-28' });
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.flowDot}"]`)!);
    expect(popover()).toBeInTheDocument();

    // 同じマウントのまま窓だけ送る（再マウントで消えたのでは検証にならない）。
    view.setWindowKey('month:2029-01-01:2029-02-28');
    expect(popover()).not.toBeInTheDocument();
    // 表そのものは残る = 窓を送っただけで画面ごと作り直していない。
    expect(viewportEl()).toBeInTheDocument();
  });

  it('フローのポッチから摘要・矢印・金額を出し、実体の遷移 target を渡す', () => {
    const onOpenTarget = vi.fn();
    renderView({ onOpenTarget });

    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.flowDot}"]`)!);

    // 摘要が 1 行目（何の仕訳か）、科目の対と日付が 2 行目。
    const flowName = document.querySelector('.timeline-calendar__flow-name')!;
    expect(flowName).toHaveTextContent('昼のラーメン');
    const flowSub = document.querySelector('.timeline-calendar__flow-sub')!;
    expect(flowSub).toHaveTextContent('預金 → 食費');
    expect(flowSub).toHaveTextContent('2026-02-10');
    expect(document.querySelector(`[data-ui="${UI.timeline.popover}"]`)).toHaveTextContent(
      '預金 → 食費',
    );
    expect(document.querySelector(`[data-ui="${UI.timeline.popover}"]`)).toHaveTextContent('1,200');
    expect(document.querySelector('.timeline-calendar__connector line')).toBeInTheDocument();
    // つながっている 2 行（預金の箱・支出の箱）以外は薄くなる = 骨格の残り 9 行。
    expect(document.querySelectorAll('.timeline-calendar__row--dimmed')).toHaveLength(9);

    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.open}"]`)!);
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'entry', entryId: 'entry-1' });
  });

  it('行の実高は接続線が仮定する ROW_HEIGHT と一致する（1px/行のズレを作らない）', () => {
    renderView();
    // 接続線は y を `index * ROW_HEIGHT + ROW_HEIGHT / 2` で置く。行がそれより 1px でも高いと
    // ズレが行数ぶん累積し、下の行ほど線が繋がらなくなる（border-top で実際に起きた）。
    // jsdom は実レイアウトを持たないので、**レイアウトに影響する指定が無いこと**を CSS 側で守る:
    // 区切り線は box-shadow（レイアウト非影響）で描き、高さの正本は --timeline-row-height 1 つ。
    // import.meta.url は vite が /@fs/... へ書き換えるため cwd 起点で読む（vitest の cwd = app root）。
    const css = readFileSync(join(process.cwd(), 'src/ui/app.css'), 'utf8');
    const separator = css.slice(
      css.indexOf('.timeline-calendar__row + .timeline-calendar__row'),
      css.indexOf('.timeline-calendar__row--detail'),
    );
    expect(separator).toContain('box-shadow');
    // 色トークン var(--border) は使ってよい。禁止するのは**高さを増やす border プロパティ**。
    expect(separator, '行の区切りに border を使うと 1px/行ずつ接続線がずれる').not.toMatch(
      /^\s*border(-top|-bottom|-width)?\s*:/m,
    );
    // 高さの指定は --timeline-row-height だけ（生値を持ち込まない）。
    const rowRule = css.slice(
      css.indexOf('.timeline-calendar__row {\n  position: relative;'),
      css.indexOf('.timeline-calendar__row + .timeline-calendar__row'),
    );
    expect(rowRule).toContain('min-height: var(--timeline-row-height)');
  });

  it('ポップオーバーは表のスクロール枠の外（body 直下）へ出す＝上下端で切られない', () => {
    renderView();
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.flowDot}"]`)!);

    // 実バグの再発防止: スクロール枠（overflow を持つ表）の子孫に描くと端で切られる。
    const opened = popover()!;
    expect(opened).toBeInTheDocument();
    expect(viewportEl().contains(opened)).toBe(false);
    expect(opened.parentElement).toBe(document.body);
    // 位置は fixed（body 直下でも absolute だと本文スクロールで置き去りになる）。
    const css = readFileSync(join(process.cwd(), 'src/ui/app.css'), 'utf8');
    const rule = css.slice(
      css.indexOf('.timeline-calendar__popover {'),
      css.indexOf('.timeline-calendar__popover-title'),
    );
    expect(rule).toContain('position: fixed');
  });

  it('接続線が下の行へ伸びるときはポップオーバーをポッチの上へ出す（線を隠さない）', () => {
    stubLayout({ top: 400, left: 500 }, { width: 300, height: 200 });
    renderView();
    const dots = document.querySelectorAll(`[data-ui="${UI.timeline.flowDot}"]`);
    expect(dots.length).toBeGreaterThanOrEqual(2);

    // 上の行（預金）のポッチ → 相手（食費）は下の行 → 線が下へ伸びる → 上へ反転。
    fireEvent.click(dots[0]!);
    expect(popover()!.dataset.placement).toBe('above');
    expect(popover()!.style.top).toBe('192px'); // 400 - 8(隙間) - 200(高さ)

    fireEvent.click(dots[0]!); // 同じポッチで閉じる

    // 下の行（食費）のポッチ → 相手は上の行 → 既定どおりポッチの下（反転しない）。
    fireEvent.click(dots[dots.length - 1]!);
    expect(popover()!.dataset.placement).toBe('below');
    expect(popover()!.style.top).toBe('452px'); // 444(ポッチ下端) + 8
  });

  it('画面下端のポッチでも viewport に収める（下に入らなければ上へ反転する）', () => {
    // 実機で見切れた条件: 表の最下行のポッチ。fixed 座標を viewport 基準で反転・クランプする。
    stubLayout({ top: 700, left: 500 }, { width: 300, height: 200 });
    renderView();
    const dots = document.querySelectorAll(`[data-ui="${UI.timeline.flowDot}"]`);

    fireEvent.click(dots[dots.length - 1]!); // 既定は下だが 768 の viewport に入らない
    const opened = popover()!;
    expect(opened.dataset.placement).toBe('above');
    const top = Number.parseFloat(opened.style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + 200).toBeLessThanOrEqual(768 - 8);
  });

  it('端末 Back（overlays 登録簿）はポップオーバーだけを閉じ、画面は据え置く', () => {
    renderView();
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.flowDot}"]`)!);
    expect(popover()).toBeInTheDocument();

    act(() => {
      expect(closeTopOverlay()).toBe(true);
    });
    expect(popover()).not.toBeInTheDocument();
    // 表は残る = 閉じただけで画面ごと遷移していない。
    expect(viewportEl()).toBeInTheDocument();
    // 登録が外れている（次の Back は画面履歴へ進む）。
    expect(closeTopOverlay()).toBe(false);
  });

  it('Esc でポップオーバーだけが閉じる', () => {
    renderView();
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.flowDot}"]`)!);
    expect(popover()).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(popover()).not.toBeInTheDocument();
    expect(viewportEl()).toBeInTheDocument();
  });

  it('スクロールで閉じる（追従はしない）', () => {
    renderView();
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.flowDot}"]`)!);
    expect(popover()).toBeInTheDocument();

    fireEvent.scroll(viewportEl());
    expect(popover()).not.toBeInTheDocument();
  });

  it('外側タップで閉じる（ポップオーバーの中のタップでは閉じない）', () => {
    renderView();
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.flowDot}"]`)!);

    fireEvent.pointerDown(document.querySelector(`[data-ui="${UI.timeline.flowList}"]`)!);
    expect(popover()).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(popover()).not.toBeInTheDocument();
  });

  it('箱のアクセントは既存の色の正本を使う', () => {
    renderView();
    const first = document.querySelector(`[data-ui="${UI.timeline.boxRow}"]`) as HTMLElement;
    expect(first.style.getPropertyValue('--timeline-accent')).toBe(ACCOUNT_ACCENTS.assetFree);
  });

  it('生成ポッチは同じバケットのitemを表示し、実体のルールtargetを渡す', () => {
    const onOpenTarget = vi.fn();
    const recurringRule = {
      id: 'rule-1',
      name: '動画サービス',
      amount: 120000,
      dayOfMonth: 10,
      everyMonths: 1,
      debitAccountId: 'ledger',
      creditAccountId: cash.id,
      spreadExpenseAccountId: food.id,
      startMonth: '2026-01',
      startDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const generationModel = {
      buckets: model.buckets,
      boxes: [
        {
          key: 'continuingCost',
          spans: [{ from: '2026-01-01' }],
          dots: [],
          accounts: [],
          continuousCost: {
            rules: [
              {
                rule: recurringRule,
                spans: [{ from: recurringRule.startDate }],
                generationDots: [
                  {
                    id: 'generation-1',
                    bucketKey: '2026-02',
                    date: '2026-02-10',
                    items: [
                      {
                        id: 'item-1',
                        name: '動画サービス 2月分',
                        amount: 120000,
                        target: { kind: 'recurringRule' as const, recurringRuleId: 'rule-1' },
                      },
                    ],
                  },
                ],
                items: [],
              },
            ],
            unlinkedItems: [],
          },
        },
      ],
    };
    render(
      <LensView
        model={generationModel}
        zoom="month"
        today="2026-02-15"
        accounts={[cash, food]}
        currency="JPY"
        onOpenTarget={onOpenTarget}
      />,
    );

    // 行の識別は共通木のノード id（data-row-key）。継続コスト台帳の箱を開く。
    fireEvent.click(
      document.querySelector(
        `[data-ui="${UI.timeline.rowToggle}"][data-row-key="box:continuingCost"]`,
      )!,
    );
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.generationDot}"]`)!);
    expect(document.querySelector(`[data-ui="${UI.timeline.popover}"]`)).toHaveTextContent(
      '動画サービス 2月分',
    );
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.open}"]`)!);
    expect(onOpenTarget).toHaveBeenCalledWith({
      kind: 'recurringRule',
      recurringRuleId: 'rule-1',
    });
  });

  it('横スクロール位置から実際に見えている日付範囲を親へ返す', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(196);
    const onVisibleRangeChange = vi.fn();
    render(
      <LensView
        model={model}
        zoom="month"
        today="2026-01-15"
        focusDate="2026-01-15"
        accounts={[cash, food]}
        currency="JPY"
        onOpenTarget={() => undefined}
        onVisibleRangeChange={onVisibleRangeChange}
      />,
    );

    const viewport = document.querySelector(
      `[data-ui="${UI.timeline.viewport}"]`,
    ) as HTMLDivElement;
    viewport.scrollLeft = 80;
    fireEvent.scroll(viewport);
    expect(onVisibleRangeChange).toHaveBeenLastCalledWith({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('リサイズで新しく見える期間を親へ返し直す', () => {
    let width = 196;
    let triggerResize: (() => void) | undefined;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          triggerResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onVisibleRangeChange = vi.fn();
    render(
      <LensView
        model={model}
        zoom="month"
        today="2026-01-15"
        focusDate="2026-01-15"
        accounts={[cash, food]}
        currency="JPY"
        onOpenTarget={() => undefined}
        onVisibleRangeChange={onVisibleRangeChange}
      />,
    );

    width = 276;
    triggerResize?.();
    expect(onVisibleRangeChange).toHaveBeenLastCalledWith({
      from: '2026-01-01',
      to: '2026-02-28',
    });
  });

  it('終了分表示の範囲外線分を表示窓の端へ偽装しない', () => {
    render(
      <LensView
        model={{
          buckets: model.buckets,
          boxes: [{ ...model.boxes[0]!, spans: [{ from: '2024-01-01', to: '2024-12-31' }] }],
        }}
        zoom="month"
        today="2026-01-15"
        accounts={[cash, food]}
        currency="JPY"
        onOpenTarget={() => undefined}
      />,
    );

    expect(document.querySelectorAll(`[data-ui="${UI.timeline.band}"]`)).toHaveLength(0);
  });

  it('見えている期間が空でも横スクロール領域と時間軸を残す', () => {
    const onVisibleRangeChange = vi.fn();
    render(
      <LensView
        model={{ buckets: model.buckets, boxes: [] }}
        zoom="month"
        today="2026-01-15"
        accounts={[]}
        currency="JPY"
        onOpenTarget={() => undefined}
        onVisibleRangeChange={onVisibleRangeChange}
      />,
    );

    expect(document.querySelector(`[data-ui="${UI.timeline.viewport}"]`)).toBeInTheDocument();
    expect(document.body).toHaveTextContent('この期間に存在するものはありません。');
    expect(document.body).toHaveTextContent('2026年');
  });
});
