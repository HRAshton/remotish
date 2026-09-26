import { RemotishError } from '@remotish/adapter-sdk';

type BridgeFailureCode =
  | 'OFFLINE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'UNSUPPORTED'
  | 'INVALID_REQUEST'
  | 'UNKNOWN';

export type BridgeFrame =
  | {
      readonly version: 1;
      readonly kind: 'hello-request';
      readonly hostId: string;
      readonly id: string;
    }
  | {
      readonly version: 1;
      readonly kind: 'hello';
      readonly hostId: string;
      readonly id: string;
      readonly sessionId: string;
    }
  | {
      readonly version: 1;
      readonly kind: 'request';
      readonly hostId: string;
      readonly id: string;
      readonly sessionId: string;
      readonly url: string;
      readonly method: string;
      readonly headers: Record<string, string>;
      readonly body: string;
    }
  | {
      readonly version: 1;
      readonly kind: 'response';
      readonly hostId: string;
      readonly id: string;
      readonly sessionId: string;
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: string;
    }
  | {
      readonly version: 1;
      readonly kind: 'failure';
      readonly hostId: string;
      readonly id: string;
      readonly sessionId: string;
      readonly code: BridgeFailureCode;
    }
  | {
      readonly version: 1;
      readonly kind: 'cancel';
      readonly hostId: string;
      readonly id: string;
      readonly sessionId: string;
    };

const ID = /^[0-9a-f]{32}$/u;

export function decodeBridgeFrame(value: unknown): BridgeFrame {
  const fields = requireRecord(value, 'Invalid Git HTTP bridge frame.');
  if (
    fields.version !== 1 ||
    typeof fields.kind !== 'string' ||
    typeof fields.hostId !== 'string' ||
    typeof fields.id !== 'string' ||
    !ID.test(fields.hostId) ||
    !ID.test(fields.id)
  ) {
    throw invalidFrame();
  }
  if (fields.kind === 'hello-request') {
    return { version: 1, kind: 'hello-request', hostId: fields.hostId, id: fields.id };
  }
  const hostId = fields.hostId;
  const id = fields.id;
  const sessionId = requireSession(fields.sessionId);
  switch (fields.kind) {
    case 'hello':
      return { version: 1, kind: 'hello', hostId, id, sessionId };
    case 'cancel':
      return { version: 1, kind: 'cancel', hostId, id, sessionId };
    case 'failure':
      if (!isFailureCode(fields.code)) {
        throw invalidFrame();
      }
      return { version: 1, kind: 'failure', hostId, id, sessionId, code: fields.code };
    case 'request':
      return decodeRequest(fields, hostId, id, sessionId);
    case 'response':
      return decodeResponse(fields, hostId, id, sessionId);
    default:
      throw invalidFrame();
  }
}

function decodeRequest(
  fields: Record<string, unknown>,
  hostId: string,
  id: string,
  sessionId: string,
): BridgeFrame {
  if (
    typeof fields.url !== 'string' ||
    typeof fields.method !== 'string' ||
    typeof fields.body !== 'string' ||
    !isHeaders(fields.headers)
  ) {
    throw invalidFrame();
  }
  return {
    version: 1,
    kind: 'request',
    hostId,
    id,
    sessionId,
    url: fields.url,
    method: fields.method,
    headers: fields.headers,
    body: fields.body,
  };
}

function decodeResponse(
  fields: Record<string, unknown>,
  hostId: string,
  id: string,
  sessionId: string,
): BridgeFrame {
  if (
    typeof fields.status !== 'number' ||
    !Number.isInteger(fields.status) ||
    fields.status < 100 ||
    fields.status > 599 ||
    typeof fields.body !== 'string' ||
    !isHeaders(fields.headers)
  ) {
    throw invalidFrame();
  }
  return {
    version: 1,
    kind: 'response',
    hostId,
    id,
    sessionId,
    status: fields.status,
    headers: fields.headers,
    body: fields.body,
  };
}

function requireSession(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge session.');
  }
  return value;
}

function isHeaders(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 32 &&
    Object.entries(value).every(
      ([key, entry]) => typeof entry === 'string' && key.length <= 64 && entry.length <= 4096,
    )
  );
}

function isFailureCode(value: unknown): value is BridgeFailureCode {
  return (
    value === 'OFFLINE' ||
    value === 'UNAUTHORIZED' ||
    value === 'FORBIDDEN' ||
    value === 'UNSUPPORTED' ||
    value === 'INVALID_REQUEST' ||
    value === 'UNKNOWN'
  );
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemotishError('INVALID_REQUEST', message);
  }
  return value as Record<string, unknown>;
}

function invalidFrame(): RemotishError {
  return new RemotishError('INVALID_REQUEST', 'Invalid Git HTTP bridge frame.');
}
