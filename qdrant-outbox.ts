import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export type DurableOutboxEntry<T> = {
  version: 1;
  id: string;
  createdAt: string;
  value: T;
};

const OUTBOX_ID_PATTERN = /^[0-9a-f-]+$/i;

function parseEntry<T>(raw: string, path: string): DurableOutboxEntry<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Corrupt outbox entry ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Corrupt outbox entry ${path}: expected an object.`);
  }
  const entry = parsed as Record<string, unknown>;
  if (
    entry.version !== 1 ||
    typeof entry.id !== "string" ||
    !entry.id ||
    typeof entry.createdAt !== "string" ||
    !Number.isFinite(Date.parse(entry.createdAt)) ||
    !("value" in entry)
  ) {
    throw new Error(`Corrupt outbox entry ${path}: invalid envelope.`);
  }
  return entry as DurableOutboxEntry<T>;
}

/**
 * A small disk-backed at-least-once queue. Each item is a separate atomically
 * renamed file, so a process crash cannot truncate the rest of the queue. The
 * caller supplies stable, idempotent values (Qdrant points use their point id),
 * making a crash after remote delivery but before local acknowledgement safe.
 */
export class DurableOutbox<T> {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  private schedule<R>(operation: () => Promise<R>): Promise<R> {
    const run = this.operationQueue.catch(() => undefined).then(operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private entryPath(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  enqueue(value: T, id: string = randomUUID()): Promise<DurableOutboxEntry<T>> {
    return this.schedule(async () => {
      if (!OUTBOX_ID_PATTERN.test(id)) {
        throw new Error(`Invalid outbox id: ${id}`);
      }
      await mkdir(this.directory, { recursive: true });
      const entry: DurableOutboxEntry<T> = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        value,
      };
      const finalPath = this.entryPath(id);
      const tempPath = join(this.directory, `.${id}.${randomUUID()}.tmp`);
      const handle = await open(tempPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf-8");
        // Flush the record before exposing it via the final filename. This is
        // resilient to a process crash and greatly narrows the power-loss gap.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, finalPath);
      const directoryHandle = await open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return entry;
    });
  }

  list(): Promise<DurableOutboxEntry<T>[]> {
    return this.schedule(() => this.readEntries());
  }

  pendingCount(): Promise<number> {
    return this.schedule(async () => (await this.entryNames()).length);
  }

  drain(
    deliver: (values: readonly T[]) => Promise<void>,
    batchSize = 64,
  ): Promise<number> {
    return this.schedule(async () => {
      const entries = await this.readEntries();
      const normalizedBatchSize = Math.max(1, Math.floor(batchSize));
      let delivered = 0;
      for (let index = 0; index < entries.length; index += normalizedBatchSize) {
        const batch = entries.slice(index, index + normalizedBatchSize);
        // Deliver before unlinking. If the process dies between these steps, the
        // same stable Qdrant ids are replayed and overwrite rather than duplicate.
        await deliver(batch.map((entry) => entry.value));
        await Promise.all(batch.map((entry) => unlink(this.entryPath(entry.id))));
        delivered += batch.length;
      }
      return delivered;
    });
  }

  private async entryNames(): Promise<string[]> {
    await mkdir(this.directory, { recursive: true });
    return (await readdir(this.directory))
      .filter((name) => /^[0-9a-f-]+\.json$/i.test(name))
      .sort();
  }

  private async readEntries(): Promise<DurableOutboxEntry<T>[]> {
    const names = await this.entryNames();
    const entries = await Promise.all(names.map(async (name) => {
      const path = join(this.directory, name);
      const entry = parseEntry<T>(await readFile(path, "utf-8"), path);
      if (`${entry.id}.json` !== name) {
        throw new Error(`Corrupt outbox entry ${path}: envelope id does not match filename.`);
      }
      return entry;
    }));
    return entries.sort((left, right) => {
      const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
      return byCreatedAt !== 0 ? byCreatedAt : left.id.localeCompare(right.id);
    });
  }
}
