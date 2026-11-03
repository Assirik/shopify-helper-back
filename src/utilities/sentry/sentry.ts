import * as Sentry from '@sentry/node';
import type { NodeOptions } from '@sentry/node';
import { sanitizeEvent } from './scrub';

const DSN_SHAPE = /^https?:\/\/[^@\s/]+@[^/\s]+\/(?:[^\s]*\/)?\d+$/;

// Sentry is for code errors only: no (or malformed) DSN means no init and every helper below is a no-op.
export const initSentry = (env: NodeJS.ProcessEnv = process.env, overrides: Partial<NodeOptions> = {}): boolean => {
  const dsn = (env.SENTRY_DSN || '').trim();
  if (!dsn) return false;
  if (!DSN_SHAPE.test(dsn)) {
    console.error('SENTRY_DSN is malformed; error reporting is disabled');
    return false;
  }

  try {
    Sentry.init({
      dsn,
      environment: env.NODE_ENV,
      release: env.SENTRY_RELEASE?.trim() || undefined,
      // No `tracesSampleRate`: in v11 any value (even 0) turns tracing on. No performance monitoring,
      // and no sentry-trace/baggage headers on outgoing calls (Meta, WhatsApp, Chatwoot...).
      tracePropagationTargets: [],
      // v11 replaced `sendDefaultPii` by `dataCollection`: collect no personal data at all.
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
      integrations: [
        // Errors are captured explicitly by errorHandler (one capture per error): switch the automatic one off.
        Sentry.expressIntegration({ shouldHandleError: () => false }),
        // Keep Node's default: an unhandled rejection is captured, flushed, then the process exits with code 1.
        Sentry.onUnhandledRejectionIntegration({ mode: 'strict' })
      ],
      beforeSend: sanitizeEvent,
      ...overrides
    });
    return Sentry.isEnabled();
  } catch (err) {
    console.error('Sentry initialisation failed; error reporting is disabled', err instanceof Error ? err.message : err);
    return false;
  }
};

// Reports an unexpected API error (the ones that end as a 500). Client errors raised by body-parser
// (invalid JSON, payload too large: `expose` with a 4xx status) are not code errors and are ignored.
export const captureApiError = (err: unknown, requestId: unknown): void => {
  try {
    if (!Sentry.isEnabled()) return;
    const { expose, status } = (err ?? {}) as { expose?: boolean; status?: number };
    if (expose && typeof status === 'number' && status < 500) return;

    Sentry.withScope(scope => {
      if (requestId !== undefined && requestId !== null) scope.setTag('request_id', String(requestId));
      Sentry.captureException(err, { mechanism: { type: 'auto.middleware.express', handled: false } });
    });
  } catch {
    // Reporting must never disturb the response.
  }
};

interface FailedJobLike {
  id?: string;
  attemptsMade: number;
  opts: { attempts?: number };
  data?: { orderId?: unknown };
}

// Called from BullMQ `failed` listeners: reports only the definitive failure (last attempt or
// UnrecoverableError), never an attempt that will be retried.
export const captureJobFailure = (queue: string, job: FailedJobLike | undefined, err: unknown): void => {
  try {
    if (!job || !Sentry.isEnabled()) return;
    const attemptsAllowed = job.opts.attempts || 1;
    const isFinal = (err as Error | undefined)?.name === 'UnrecoverableError' || job.attemptsMade >= attemptsAllowed;
    if (!isFinal) return;

    Sentry.withScope(scope => {
      scope.setTag('queue', queue);
      if (job.id !== undefined) scope.setTag('jobId', String(job.id));
      const orderId = job.data?.orderId;
      if (orderId !== undefined && orderId !== null) scope.setTag('orderId', String(orderId));
      Sentry.captureException(err);
    });
  } catch {
    // Reporting must never disturb the worker.
  }
};

export const flushSentry = async (timeoutMs = 2000): Promise<void> => {
  if (!Sentry.isEnabled()) return;
  await Sentry.flush(timeoutMs);
};

export { Sentry };
