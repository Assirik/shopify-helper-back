import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockAdd = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetJob = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSweepAdd = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// The sweep queue gets its own `add` so a test can tell which queue received a job.
jest.mock('bullmq', () => ({
  Queue: jest
    .fn()
    .mockImplementation((...args: unknown[]) =>
      args[0] === 'capi-purchase-sweep' ? { add: mockSweepAdd, getJob: mockGetJob } : { add: mockAdd, getJob: mockGetJob }
    )
}));

jest.mock('./notification.queue', () => ({
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 }))
}));

import {
  CAPI_PURCHASE_QUEUE_NAME,
  CAPI_PURCHASE_SWEEP_JOB,
  CAPI_PURCHASE_SWEEP_QUEUE_NAME,
  SEND_CAPI_PURCHASE_JOB,
  buildCapiPurchaseJobId,
  enqueueCapiPurchase,
  enqueueCapiPurchaseWithOutcome,
  scheduleCapiPurchaseSweep
} from './capi.queue';

const existingJob = (state: string) => ({
  id: 'capi-purchase-abc',
  getState: jest.fn(async () => state),
  remove: jest.fn(async () => undefined)
});

describe('capi purchase queue', () => {
  afterEach(() => {
    mockAdd.mockReset();
    mockGetJob.mockReset();
  });

  it('uses the capi-purchase queue name', () => {
    expect(CAPI_PURCHASE_QUEUE_NAME).toBe('capi-purchase');
  });

  it('builds a deterministic job id without ":" (rejected by BullMQ)', () => {
    const jobId = buildCapiPurchaseJobId('64b7f0c2a1b2c3d4e5f60718');

    expect(jobId).toBe('capi-purchase-64b7f0c2a1b2c3d4e5f60718');
    expect(jobId).not.toContain(':');
  });

  it('enqueues with the deterministic job id, 5 attempts, exponential backoff and bounded retention', async () => {
    mockGetJob.mockResolvedValueOnce(undefined);
    mockAdd.mockResolvedValueOnce({ id: 'capi-purchase-abc' });

    await enqueueCapiPurchase('abc');

    expect(mockGetJob).toHaveBeenCalledWith('capi-purchase-abc');
    expect(mockAdd).toHaveBeenCalledWith(
      SEND_CAPI_PURCHASE_JOB,
      { orderId: 'abc' },
      expect.objectContaining({
        jobId: 'capi-purchase-abc',
        attempts: 5,
        backoff: expect.objectContaining({ type: 'exponential' }),
        removeOnComplete: expect.any(Number),
        removeOnFail: expect.any(Number)
      })
    );
  });

  it.each(['completed', 'failed'])('removes a retained %s job before enqueueing again', async state => {
    const job = existingJob(state);
    mockGetJob.mockResolvedValueOnce(job);
    mockAdd.mockResolvedValueOnce({ id: 'capi-purchase-abc' });

    await enqueueCapiPurchase('abc');

    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(
      SEND_CAPI_PURCHASE_JOB,
      { orderId: 'abc' },
      expect.objectContaining({ jobId: 'capi-purchase-abc' })
    );
    expect(job.remove.mock.invocationCallOrder[0]).toBeLessThan(mockAdd.mock.invocationCallOrder[0]);
  });

  it.each(['waiting', 'delayed', 'active', 'prioritized'])(
    'reuses a %s job without enqueueing a duplicate',
    async state => {
      const job = existingJob(state);
      mockGetJob.mockResolvedValueOnce(job);

      await expect(enqueueCapiPurchase('abc')).resolves.toBe(job);

      expect(job.remove).not.toHaveBeenCalled();
      expect(mockAdd).not.toHaveBeenCalled();
    }
  );
});

describe('enqueue outcome (sweep counters)', () => {
  afterEach(() => {
    mockAdd.mockReset();
    mockGetJob.mockReset();
  });

  it('reports a job kept in the queue as reused, without adding one', async () => {
    const job = existingJob('delayed');
    mockGetJob.mockResolvedValueOnce(job);

    await expect(enqueueCapiPurchaseWithOutcome('abc')).resolves.toEqual({ job, reused: true });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it.each([undefined, 'completed', 'failed'])('reports a job added as not reused (existing job: %p)', async state => {
    mockGetJob.mockResolvedValueOnce(state ? existingJob(state) : undefined);
    mockAdd.mockResolvedValueOnce({ id: 'capi-purchase-abc' });

    await expect(enqueueCapiPurchaseWithOutcome('abc')).resolves.toEqual({
      job: { id: 'capi-purchase-abc' },
      reused: false
    });
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});

describe('capi purchase sweep scheduling', () => {
  afterEach(() => {
    mockAdd.mockReset();
    mockSweepAdd.mockReset();
  });

  it('uses a dedicated queue, distinct from the capi-purchase queue', () => {
    expect(CAPI_PURCHASE_SWEEP_QUEUE_NAME).toBe('capi-purchase-sweep');
    expect(CAPI_PURCHASE_SWEEP_QUEUE_NAME).not.toBe(CAPI_PURCHASE_QUEUE_NAME);
  });

  it('schedules a repeatable job every 5 min with a fixed repeat key and bounded retention', async () => {
    mockSweepAdd.mockResolvedValue({ id: 'repeat' });

    await scheduleCapiPurchaseSweep();
    await scheduleCapiPurchaseSweep();

    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockSweepAdd).toHaveBeenCalledTimes(2);
    const [first, second] = mockSweepAdd.mock.calls;
    expect(first).toEqual([
      CAPI_PURCHASE_SWEEP_JOB,
      {},
      {
        repeat: { every: 5 * 60 * 1000, key: 'capi-purchase-sweep-tick' },
        removeOnComplete: 50,
        removeOnFail: 100
      }
    ]);
    // Same key on every restart: BullMQ keeps a single repeatable job.
    expect(second).toEqual(first);
  });
});
