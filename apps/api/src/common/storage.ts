import { Injectable, Logger } from '@nestjs/common';
import { createReadStream } from 'fs';
import { mkdir, rm, stat, writeFile } from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';

/** Where uploaded files live. The local-disk adapter is the only one implemented; an S3-compatible adapter slots in behind the same methods. */
export interface StorageAdapter {
  readonly kind: string;
  put(key: string, data: Buffer): Promise<void>;
  stream(key: string): Promise<Readable>;
  size(key: string): Promise<number>;
  delete(key: string): Promise<void>;
}

class LocalDiskStorage implements StorageAdapter {
  readonly kind = 'local';
  constructor(private readonly dir: string) {}
  private resolve(key: string) {
    const full = path.resolve(this.dir, key);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) throw new Error('Invalid storage key');
    return full;
  }
  async put(key: string, data: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  async stream(key: string) {
    const full = this.resolve(key);
    await stat(full);
    return createReadStream(full);
  }
  async size(key: string) {
    return (await stat(this.resolve(key))).size;
  }
  async delete(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}

@Injectable()
export class StorageService implements StorageAdapter {
  private readonly log = new Logger('Storage');
  private readonly adapter: StorageAdapter;
  constructor() {
    const dir = process.env.STORAGE_DIR || path.join(process.cwd(), 'uploads');
    this.adapter = new LocalDiskStorage(dir);
    this.log.log(`Files are stored on local disk at ${path.resolve(dir)}`);
  }
  get kind() { return this.adapter.kind; }
  put(key: string, data: Buffer) { return this.adapter.put(key, data); }
  stream(key: string) { return this.adapter.stream(key); }
  size(key: string) { return this.adapter.size(key); }
  delete(key: string) { return this.adapter.delete(key); }
}
