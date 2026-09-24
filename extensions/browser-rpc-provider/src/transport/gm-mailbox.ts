import { RemotishError } from '@remotish/adapter-sdk';
import { MAX_PACKET_CHARS, randomTransportId } from './wire.js';

const PREFIX = 'remotish.browser-rpc.v1.';
const WAKE = `${PREFIX}wake`;
const CHUNK_CHARS = 256 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_PACKET_CHARS / CHUNK_CHARS);
const MAX_MESSAGES = 1024;
const MAX_KEYS = 2048;
const RETENTION_MS = 90_000;
const MAX_STORED_CHARS = 96 * 1024 * 1024;

/** The Tampermonkey GM_* functions must belong to the same configured userscript on every tab. */
export interface GmStorage {
  getValue(name: string): unknown | Promise<unknown>;
  setValue(name: string, value: unknown): void | Promise<void>;
  deleteValue(name: string): void | Promise<void>;
  listValues(): readonly string[] | Promise<readonly string[]>;
  addValueChangeListener(
    name: string,
    callback: (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void,
  ): number;
  removeValueChangeListener(id: number): void;
}

interface Manifest {
  readonly version: 1;
  readonly createdAt: number;
  readonly count: number;
  readonly size: number;
}

/** Reliable unique-key mailbox over GM storage; wake notifications only reduce polling latency. */
export class GmMailbox {
  private readonly seen = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly listenerId: number;
  private polling: boolean = false;
  private disposed: boolean = false;

  constructor(
    private readonly storage: GmStorage,
    private readonly onPacket: (packet: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.listenerId = storage.addValueChangeListener(WAKE, () => {
      // A missed wake is covered by the periodic scan; malformed storage is never logged.
      this.poll().catch(() => {});
    });
    this.timer = setInterval(() => {
      this.poll().catch(() => {});
    }, 500);
  }

  async send(packet: string): Promise<void> {
    if (this.disposed) {
      throw new RemotishError('OFFLINE', 'Browser RPC mailbox disconnected.');
    }
    if (typeof packet !== 'string' || packet.length > MAX_PACKET_CHARS) {
      throw new RemotishError('INVALID_REQUEST', 'Browser RPC packet exceeds the size limit.');
    }
    await this.poll();
    const names = (await this.storage.listValues()).filter((name) => name.startsWith(PREFIX));
    if (
      names.length >= MAX_KEYS ||
      names.filter((name) => name.startsWith(PREFIX) && name.endsWith('.manifest')).length >=
        MAX_MESSAGES
    ) {
      throw new RemotishError('RATE_LIMITED', 'Browser RPC mailbox is full.');
    }
    let storedChars = 0;
    for (const name of names.filter((name) => name.endsWith('.manifest'))) {
      const manifest = await this.storage.getValue(name);
      if (isManifest(manifest)) {
        storedChars += manifest.size;
      }
    }
    if (storedChars + packet.length > MAX_STORED_CHARS) {
      throw new RemotishError('RATE_LIMITED', 'Browser RPC mailbox storage limit reached.');
    }
    const id = `${this.now().toString(36)}-${randomTransportId()}`;
    const base = `${PREFIX}${id}`;
    const count = Math.max(1, Math.ceil(packet.length / CHUNK_CHARS));
    for (let index = 0; index < count; index += 1) {
      await this.storage.setValue(
        `${base}.${index}`,
        packet.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS),
      );
    }
    await this.storage.setValue(`${base}.manifest`, {
      version: 1,
      createdAt: this.now(),
      count,
      size: packet.length,
    } satisfies Manifest);
    this.seen.set(id, this.now());
    await this.storage.setValue(WAKE, id);
  }

  /** Exposed for deterministic tests; production also polls when wake notifications are lost. */
  async poll(): Promise<void> {
    if (this.disposed || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const names = (await this.storage.listValues()).filter((name) => name.startsWith(PREFIX));
      for (const [id, seenAt] of this.seen) {
        if (this.now() - seenAt > RETENTION_MS) {
          this.seen.delete(id);
        }
      }
      for (const name of names) {
        const id = messageId(name);
        if (!id) {
          continue;
        }
        const createdAt = parseInt(id.split('-')[0] ?? '', 36);
        if (
          !Number.isSafeInteger(createdAt) ||
          createdAt > this.now() + RETENTION_MS ||
          this.now() - createdAt > RETENTION_MS
        ) {
          await this.storage.deleteValue(name);
          this.seen.delete(id);
        }
      }
      const activeNames = (await this.storage.listValues()).filter((name) =>
        name.startsWith(PREFIX),
      );
      if (activeNames.length > MAX_KEYS) {
        throw new RemotishError('RATE_LIMITED', 'Browser RPC mailbox is full.');
      }
      const manifests = activeNames
        .filter((name) => name.startsWith(PREFIX) && name.endsWith('.manifest'))
        .slice(0, MAX_MESSAGES);
      for (const name of manifests) {
        const id = messageId(name);
        if (!id || this.seen.has(id)) {
          continue;
        }
        const manifest = await this.storage.getValue(name);
        if (!isManifest(manifest)) {
          this.seen.set(id, this.now());
          continue;
        }
        let packet = '';
        for (let index = 0; index < manifest.count; index += 1) {
          const chunk = await this.storage.getValue(`${PREFIX}${id}.${index}`);
          if (typeof chunk !== 'string' || chunk.length > CHUNK_CHARS) {
            packet = '';
            break;
          }
          packet += chunk;
        }
        if (packet.length !== manifest.size) {
          continue;
        }
        this.seen.set(id, this.now());
        this.onPacket(packet);
      }
    } finally {
      this.polling = false;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.timer);
    this.storage.removeValueChangeListener(this.listenerId);
    this.seen.clear();
  }
}

function messageId(name: string): string | undefined {
  if (!name.startsWith(PREFIX)) {
    return undefined;
  }
  const suffix = name.slice(PREFIX.length);
  const separator = suffix.lastIndexOf('.');
  const id = suffix.slice(0, separator);
  const part = suffix.slice(separator + 1);
  return /^[0-9a-z]+-[0-9a-f]{32}$/u.test(id) && (part === 'manifest' || /^\d+$/u.test(part))
    ? id
    : undefined;
}

function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).sort().join(',') === 'count,createdAt,size,version' &&
    data.version === 1 &&
    typeof data.createdAt === 'number' &&
    Number.isSafeInteger(data.createdAt) &&
    typeof data.count === 'number' &&
    Number.isSafeInteger(data.count) &&
    data.count >= 1 &&
    data.count <= MAX_CHUNKS &&
    typeof data.size === 'number' &&
    Number.isSafeInteger(data.size) &&
    data.size >= 0 &&
    data.size <= MAX_PACKET_CHARS
  );
}
