/** lightning-fs exports this browser-safe backend but omits its TypeScript declaration. */
declare module '@isomorphic-git/lightning-fs' {
  export class MemoryBackend {
    saveSuperblock(superblock: Uint8Array | Map<string | number, unknown>): void;
    loadSuperblock(): Map<string | number, unknown>;
    readFile(inode: number): Uint8Array;
    writeFile(inode: number, data: Uint8Array): void;
    unlink(inode: number): void;
    wipe(): Promise<void>;
    close(): void;
  }
}
