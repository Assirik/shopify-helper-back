import { afterEach, describe, expect, it, jest } from '@jest/globals';

// Captures the queue name, processor and event handlers registered by the worker.
const mockWorkerRegistry: {
  queueName?: string;
  processor?: (job: unknown) => Promise<unknown>;
  handlers: Record<string, (...args: unknown[]) => unknown>;
  close: jest.Mock;
} = { handlers: {}, close: jest.fn() };

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((...args: unknown[]) => {
    mockWorkerRegistry.queueName = args[0] as string;
    mockWorkerRegistry.processor = args[1] as (job: unknown) => Promise<unknown>;
    return {
      on: (event: string, handler: (...handlerArgs: unknown[]) => unknown) => {
        mockWorkerRegistry.handlers[event] = handler;
      },
      close: mockWorkerRegistry.close
    };
  })
}));

jest.mock('../queues/capi.queue', () => ({
  CAPI_PURCHASE_SWEEP_JOB: 'capiPurchaseSweep',
  CAPI_PURCHASE_SWEEP_QUEUE_NAME: 'capi-purchase-sweep'
}));

jest.mock('../queues/notification.queue', () => ({
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 }))
}));

jest.mock('../utilities/services/capiPurchase.service', () => ({
  runCapiPurchaseSweep: jest.fn()
}));

// The real pino logger writes through a pino-pretty worker thread that keeps Jest alive.
jest.mock('../utilities/logger/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import log from '../utilities/logger/logger';
import { runCapiPurchaseSweep } from '../utilities/services/capiPurchase.service';
import {
  processCapiPurchaseSweepJob,
  startCapiPurchaseSweepWorker,
  stopCapiPurchaseSweepWorker
} from './capiPurchaseSweep.worker';

const sweep = jest.mocked(runCapiPurchaseSweep);

describe('capi purchase sweep worker', () => {
  afterEach(async () => {
    await stopCapiPurchaseSweepWorker();
  });

  it('runs the sweep for the sweep job and returns its counts', async () => {
    sweep.mockResolvedValueOnce({ candidates: 2, enqueued: 1, alreadyQueued: 1, failed: 0 });

    await expect(processCapiPurchaseSweepJob({ name: 'capiPurchaseSweep' } as never)).resolves.toEqual({
      candidates: 2,
      enqueued: 1,
      alreadyQueued: 1,
      failed: 0
    });
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('rejects any other job name without running the sweep', async () => {
    await expect(processCapiPurchaseSweepJob({ name: 'sendCapiPurchase' } as never)).rejects.toThrow(
      'Unsupported CAPI purchase sweep job: sendCapiPurchase'
    );
    expect(sweep).not.toHaveBeenCalled();
  });

  it('listens on the dedicated queue with the sweep processor, once, and logs failed jobs', async () => {
    const worker = startCapiPurchaseSweepWorker();

    expect(startCapiPurchaseSweepWorker()).toBe(worker);
    expect(mockWorkerRegistry.queueName).toBe('capi-purchase-sweep');
    expect(mockWorkerRegistry.processor).toBe(processCapiPurchaseSweepJob);

    mockWorkerRegistry.handlers.failed?.({ id: 'repeat:1' }, new Error('mongo down'));
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'repeat:1', err: expect.any(Error) }),
      'CAPI purchase sweep job failed'
    );

    await stopCapiPurchaseSweepWorker();
    expect(mockWorkerRegistry.close).toHaveBeenCalledTimes(1);
  });
});
