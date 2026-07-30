/*
 * 描画時例外の最終防波堤。データは IndexedDB にあるので、リロード導線だけ出す。
 */
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, maxWidth: 480, margin: '0 auto' }}>
          <h1 style={{ fontSize: '1.1rem' }}>画面の描画に失敗しました</h1>
          <p style={{ color: '#64748b', fontSize: '0.9rem' }}>
            データは端末内に保存されています。再読み込みで復帰しない場合は、この画面の
            スクリーンショットを添えて報告してください。
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', color: '#991b1b' }}>
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <button type="button" onClick={() => location.reload()}>
            再読み込み
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
