import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Object storage. Production: S3-compatible bucket in the London region with
 * signed URLs. The DB stores only the storage_key (attachments table).
 */
export interface FileStore {
  put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

/** Local-disk store for development and tests. */
export class LocalFileStore implements FileStore {
  constructor(private root: string) {}
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root))) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
}

export function storageKeyFor(tenantId: string, kind: string, fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  return join(tenantId, kind, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
}
