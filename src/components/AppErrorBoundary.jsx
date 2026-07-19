import { Component } from 'react';

/**
 * Surfaces React render failures instead of leaving a blank WebView.
 */
export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    try {
      console.error('[AppErrorBoundary]', error, info?.componentStack);
      window.chrome?.webview?.postMessage?.({
        type: 'renderer-error',
        message: String(error?.message || error || 'React render error'),
        source: 'AppErrorBoundary',
        line: 0,
      });
    } catch {
      /* ignore */
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="grid h-full place-content-center gap-3 bg-gcal-page px-6 text-center text-gcal-heading">
          <p className="text-lg font-semibold">화면을 표시하지 못했습니다</p>
          <p className="max-w-lg text-sm text-gcal-muted">{String(this.state.error?.message || this.state.error)}</p>
          <button
            type="button"
            className="mx-auto mt-2 rounded bg-gcal-blue px-4 py-2 text-sm text-white"
            onClick={() => window.location.reload()}
          >
            다시 불러오기
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
