import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// One append-only JSONL log.
//
// This shape had been copy-pasted five times inside main.ts and grown into two
// more classes (thought-history.ts, ledger-store.ts) besides. Every copy wants
// the same three things and they are easy to get subtly wrong on the sixth
// paste:
//
//   - writes serialize, so two records never interleave inside one line;
//   - a failed write does not poison the queue for every later record;
//   - a failure says which log it was, since the caller is fire-and-forget and
//     will never see the rejection.
//
// The copies also drifted: three of the five chained onto a queue belonging to
// a different log entirely, so four unrelated files were serialized behind one
// another for no reason. Giving each log its own queue is not a new feature,
// it is what each copy already meant to do.

export class JsonlLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    /** Names this log in the error line, since append() cannot report failure. */
    private readonly label: string,
    private readonly onError: (message: string, error: unknown) => void =
      (message, error) => console.error(message, error),
  ) {}

  /**
   * Queue one record. Fire-and-forget by design: a log write must never be the
   * reason the thing being logged fails.
   */
  append(record: unknown): void {
    this.queue = this.queue
      // Detach from any previous failure first, so one bad write does not make
      // every later write skip its own body.
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
      })
      .catch((error: unknown) => {
        this.onError(`Failed to write ${this.label}:`, error);
      });
  }

  /** Resolves once everything queued so far has been written or has failed. */
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }
}
