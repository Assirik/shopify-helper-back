import build from 'pino-abstract-transport';

// Home-made pino transport that ships log lines to Axiom's ingest API. It runs in the pino worker
// thread and is built so that a broken Axiom can never hurt the API:
//  - bounded memory: at most `maxQueue` events wait; beyond that the OLDEST are dropped and counted;
//  - batches of at most `maxBatch` events, sent every `flushIntervalMs` (at once when a full batch is
//    waiting), ONE request in flight; a batch gets `maxAttempts` tries, then it is dropped and counted;
//  - the event time is the log line's own time (`_time`, Axiom's default timestamp field), set once
//    when the line is received: a retried batch keeps its times;
//  - short request timeout; failures back off exponentially (capped) instead of hammering Axiom;
//  - nothing ever throws out of this file, and the token never appears in a message;
//  - `close` (called when the logger ends) takes at most `closeTimeoutMs`.

export interface AxiomTransportOptions {
  dataset: string;
  token: string;
  /** Base URL of the dataset's edge deployment (default: US East 1). */
  url?: string;
  /** Total tries for one batch after timeouts / 5xx, then the batch is dropped and counted. */
  maxAttempts?: number;
  maxQueue?: number;
  maxBatch?: number;
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  reportIntervalMs?: number;
  /** Where operational notices go (default: process.stderr). */
  report?: (message: string) => void;
}

const LEVELS: Array<[number, string]> = [
  [10, 'trace'],
  [20, 'debug'],
  [30, 'info'],
  [40, 'warn'],
  [50, 'error'],
  [60, 'fatal']
];

export const mapLevel = (level: unknown): unknown => {
  if (typeof level !== 'number') return level;
  return LEVELS.find(([max]) => level <= max)?.[1] ?? 'silent';
};

export const toAxiomEvent = (line: Record<string, unknown>) => {
  const { time, level, ...rest } = line;
  return { _time: time, level: mapLevel(level), ...rest };
};

// Only the kind of failure goes into notices: never an error message that could echo a URL or header.
const describeFailure = (err: any): string => {
  if (err?.status) return `HTTP ${err.status}`;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  return String(err?.cause?.code ?? err?.code ?? err?.name ?? 'error');
};

class SendError extends Error {
  constructor(public status: number, public retryable: boolean) {
    super(`HTTP ${status}`);
  }
}

export const DEFAULT_AXIOM_URL = 'https://us-east-1.aws.edge.axiom.co';

export class AxiomShipper {
  private readonly o: Required<Omit<AxiomTransportOptions, 'report'>> & { report: (m: string) => void };
  private queue: Record<string, unknown>[] = [];
  // The batch that failed transiently, kept as is so that its tries are counted and it is not mixed up.
  private retryBatch: { events: Record<string, unknown>[]; attempts: number } | null = null;
  private inFlight: Promise<boolean> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  private closing = false;
  private abort = new AbortController();
  // Counters since the last notice.
  private dropped = 0;
  private lostBatches = 0;
  private refusedEvents = 0;
  private failedSends = 0;
  private lastFailure = '';
  private lastReportAt = 0;
  totalDropped = 0;

  constructor(options: AxiomTransportOptions) {
    this.o = {
      url: DEFAULT_AXIOM_URL,
      maxAttempts: 3,
      maxQueue: 5000,
      maxBatch: 1000,
      flushIntervalMs: 2000,
      requestTimeoutMs: 5000,
      closeTimeoutMs: 1500,
      reportIntervalMs: 60_000,
      report: (message: string) => {
        try {
          process.stderr.write(`${message}\n`);
        } catch {
          // nothing to do: stderr is best effort
        }
      },
      ...options
    };
    this.o.url = this.o.url.replace(/\/+$/, '');
  }

  // Bounded by maxQueue (+ one retried batch of at most maxBatch).
  get queued(): number {
    return this.queue.length + (this.retryBatch?.events.length ?? 0);
  }

  enqueue(event: Record<string, unknown>): void {
    if (this.closing) return;
    this.queue.push(event);
    if (this.queue.length > this.o.maxQueue) {
      this.trim();
      this.maybeReport();
    }
    // A full batch does not wait for the timer (unless Axiom is backing off or a request is running).
    if (this.queue.length >= this.o.maxBatch && !this.inFlight && Date.now() >= this.nextAttemptAt) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      void this.flushOnce();
      return;
    }
    this.schedule();
  }

  // Over the cap: drop the OLDEST events, down to 90 % of the cap so that the (linear) removal does
  // not run again on every incoming line.
  private trim(): void {
    const over = this.queue.length - Math.floor(this.o.maxQueue * 0.9);
    this.queue.splice(0, over);
    this.dropped += over;
    this.totalDropped += over;
  }

  private schedule(): void {
    if (this.timer || this.inFlight || (this.queue.length === 0 && !this.retryBatch) || this.closing) return;
    const wait = Math.max(
      this.nextAttemptAt - Date.now(),
      this.queue.length >= this.o.maxBatch && !this.retryBatch ? 0 : this.o.flushIntervalMs
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushOnce();
    }, wait);
    this.timer.unref?.();
  }

  // Sends one batch. Resolves true if it went through (or was dropped for good), false otherwise. Never rejects.
  private flushOnce(timeoutMs = this.o.requestTimeoutMs): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const pending = this.retryBatch;
    if (!pending && this.queue.length === 0) return Promise.resolve(true);
    this.retryBatch = null;
    const batch = pending ? pending.events : this.queue.splice(0, this.o.maxBatch);
    const attempts = (pending?.attempts ?? 0) + 1;
    const run = this.send(batch, timeoutMs)
      .then(failed => {
        this.failures = 0;
        this.nextAttemptAt = 0;
        if (failed > 0) {
          // Axiom answered 200 but refused some events (e.g. malformed): counted, never retried.
          this.refusedEvents += failed;
          this.dropped += failed;
          this.totalDropped += failed;
          this.maybeReport();
        }
        return true;
      })
      .catch((err: any) => {
        this.failures++;
        this.failedSends++;
        this.lastFailure = describeFailure(err);
        this.nextAttemptAt = Date.now() + Math.min(30_000, this.o.flushIntervalMs * 2 ** Math.min(this.failures, 5));
        const retryable = !(err instanceof SendError) || err.retryable;
        if (retryable && attempts < this.o.maxAttempts) {
          // Transient failure: keep this very batch for the next try.
          this.retryBatch = { events: batch, attempts };
        } else {
          // Refused for good (bad token, unknown dataset, ingest limit...) or out of tries: drop and count.
          // Several tries on a timeout may already have delivered it: never retry without limit.
          this.dropped += batch.length;
          this.totalDropped += batch.length;
          this.lostBatches++;
        }
        this.maybeReport();
        return false;
      })
      .finally(() => {
        this.inFlight = null;
        if (this.queue.length > this.o.maxQueue) this.trim();
        this.schedule();
      });
    this.inFlight = run;
    return run;
  }

  // Resolves with the number of events Axiom refused inside an otherwise successful (2xx) answer.
  private async send(batch: Record<string, unknown>[], timeoutMs: number): Promise<number> {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), this.abort.signal]);
    const res = await fetch(`${this.o.url}/v1/ingest/${encodeURIComponent(this.o.dataset)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.o.token}`, 'Content-Type': 'application/x-ndjson' },
      body: batch.map(event => JSON.stringify(event)).join('\n'),
      signal
    });
    let text = '';
    try {
      text = await res.text(); // also releases the connection
    } catch {
      // body not needed
    }
    if (res.status >= 200 && res.status < 300) {
      try {
        const failed = Number(JSON.parse(text)?.failed);
        return Number.isFinite(failed) && failed > 0 ? Math.min(failed, batch.length) : 0;
      } catch {
        return 0;
      }
    }
    // 430 is the organisation's ingest limit: dropped like any other 4xx, followed by a backoff.
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new SendError(res.status, retryable);
  }

  private maybeReport(force = false): void {
    const now = Date.now();
    if (!force && this.lastReportAt && now - this.lastReportAt < this.o.reportIntervalMs) return;
    if (this.dropped === 0 && this.failedSends === 0 && this.refusedEvents === 0) return;
    this.lastReportAt = now;
    const message =
      `[axiom-log-transport] ${this.dropped} log event(s) dropped, ${this.failedSends} failed send(s)` +
      `${this.lostBatches ? `, ${this.lostBatches} batch(es) abandoned` : ''}` +
      `${this.refusedEvents ? `, ${this.refusedEvents} event(s) refused by Axiom` : ''}` +
      `${this.lastFailure ? ` (last failure: ${this.lastFailure})` : ''}; stdout is unaffected`;
    this.dropped = 0;
    this.failedSends = 0;
    this.lostBatches = 0;
    this.refusedEvents = 0;
    try {
      this.o.report(message);
    } catch {
      // best effort
    }
  }

  // Sends what is left, for at most `closeTimeoutMs` overall. Never rejects.
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const deadline = Date.now() + this.o.closeTimeoutMs;
    let timeout: NodeJS.Timeout | undefined;
    const expired = new Promise<void>(resolve => {
      timeout = setTimeout(resolve, this.o.closeTimeoutMs);
    });
    const drain = (async () => {
      while (this.queue.length > 0 || this.retryBatch || this.inFlight) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        if (this.inFlight) {
          await this.inFlight;
          continue;
        }
        if (!(await this.flushOnce(Math.min(this.o.requestTimeoutMs, remaining)))) return;
      }
    })().catch(() => undefined);
    await Promise.race([drain, expired]);
    clearTimeout(timeout);
    this.abort.abort(); // do not keep the worker alive for a request that no longer matters
    this.maybeReport(true);
  }
}

export default async function axiomTransport(options: AxiomTransportOptions) {
  const shipper = new AxiomShipper(options);
  return build(
    async function (source) {
      for await (const line of source) {
        try {
          shipper.enqueue(toAxiomEvent(line));
        } catch {
          // a malformed line must not stop the transport
        }
      }
    },
    { close: async () => shipper.close() }
  );
}
