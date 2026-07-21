import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { clientLog, flush, getClientLogs } from '../lib/logger';

// A render crash otherwise leaves a white screen and no trace of what happened.
// This records it (with the React component stack), ships the log immediately,
// and gives the user a way out plus a way to hand us the evidence.
type Props = { children: ReactNode };
type State = { error: Error | null; copied: boolean };

// This repo ships no @types/react, so `Component` arrives untyped and the
// inherited members (props/setState) would be invisible to tsc. Aliasing the
// base through an explicit constructor type restores them. Runtime is
// unchanged — Base *is* Component; this is the only class component we have.
const Base = Component as unknown as new (props: Props) => {
  props: Props;
  state: State;
  setState(next: Partial<State>): void;
};

export default class ErrorBoundary extends Base {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    clientLog.error('react.crash', error.message, { error, componentStack: info.componentStack || undefined });
    void flush();
  }

  private copyLogs = async () => {
    const text = getClientLogs()
      .map((e) => `${e.t} ${e.lvl.toUpperCase()} ${e.evt} ${e.msg || ''} ${e.data ? JSON.stringify(e.data) : ''}`)
      .join('\n');
    try { await navigator.clipboard.writeText(text); this.setState({ copied: true }); }
    catch { /* clipboard blocked — the log is on the server anyway */ }
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50 p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl border border-stone-200 shadow-sm p-6 text-center">
          <AlertTriangle className="h-8 w-8 text-red-600 mx-auto" />
          <h1 className="text-base font-semibold text-stone-900 mt-3">Da ist etwas schiefgelaufen</h1>
          <p className="text-xs text-stone-500 mt-2">Der Fehler wurde automatisch protokolliert.</p>
          <p className="text-[11px] text-stone-400 mt-1 break-words">{this.state.error.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="w-full mt-5 inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white font-semibold py-2.5 rounded-xl text-sm"
          >
            <RotateCw className="h-4 w-4" /> Neu laden
          </button>
          <button onClick={this.copyLogs} className="w-full mt-2 text-[11px] text-stone-400 hover:text-stone-600 underline">
            {this.state.copied ? 'Protokoll kopiert' : 'Protokoll kopieren'}
          </button>
        </div>
      </div>
    );
  }
}
