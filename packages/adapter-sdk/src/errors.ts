/** Stable error categories that adapters expose to Remotish. */
export type RemotishErrorCode =
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'OFFLINE'
  | 'UNSUPPORTED'
  | 'INVALID_REQUEST'
  | 'CANCELLED'
  | 'UNKNOWN';

/** Structured adapter error suitable for framework-level handling. */
export class RemotishError extends Error {
  /** Stable error category. */
  readonly code: RemotishErrorCode;

  /** Original lower-level error, when one exists. */
  override readonly cause?: unknown;

  /** Creates a structured Remotish error. */
  constructor(code: RemotishErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'RemotishError';
    this.code = code;

    if (options && 'cause' in options) {
      this.cause = options.cause;
    }
  }
}
