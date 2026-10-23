// The messages are already in the ledger. Retain only their routing metadata
// while compaction waits, then wake the serial event loop without reinjecting.
export class FocusContinuation<T> {
  private readonly pending: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly wake: () => void, private readonly retryMs: number) {}

  append(item: T): void {
    this.pending.push(item);
  }

  snapshot(): readonly T[] {
    return [...this.pending];
  }

  defer(): void {
    if (this.timer || this.pending.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, this.retryMs);
    this.timer.unref?.();
  }

  clear(): void {
    this.pending.length = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
