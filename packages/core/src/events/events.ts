/** Minimal structural disposable contract shared by core without depending on VS Code. */
export interface Disposable {
  dispose(): void;
}

/** Receives unexpected observer failures without changing the operation that emitted the event. */
export type EventListenerErrorHandler = (error: unknown) => void;

/**
 * Lightweight synchronous event source used by core without VS Code dependencies.
 *
 * Listeners are notifications, not transactional hooks: one listener throwing never prevents later
 * listeners from running and never turns an already-completed state transition into a failure.
 */
export class EventSource<T> {
  private readonly listeners = new Set<(event: T) => void>();

  constructor(private readonly onListenerError: EventListenerErrorHandler = reportListenerError) {}

  on(listener: (event: T) => void): Disposable {
    this.listeners.add(listener);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.listeners.delete(listener);
      },
    };
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.onListenerError(error);
    } catch (reportingError) {
      reportListenerError(reportingError);
    }
  }
}

function reportListenerError(error: unknown): void {
  console.error('Unexpected Remotish event listener failure.', error);
}
