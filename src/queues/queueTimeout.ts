// Upper bound for adding a job from a request handler. The Redis connection uses
// `maxRetriesPerRequest: null` with an offline queue: with Redis unreachable, `queue.add`
// never settles, so a caller that must answer (webhook) bounds the wait itself.
export const QUEUE_ADD_TIMEOUT_MS = 3000;

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

// Rejects with a TimeoutError when the promise does not settle within `ms`; the timer never
// outlives the call. The wrapped promise keeps running: a late rejection is absorbed here,
// a late resolution is simply ignored.
export const withTimeout = <T>(promise: Promise<T>, ms: number = QUEUE_ADD_TIMEOUT_MS) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
