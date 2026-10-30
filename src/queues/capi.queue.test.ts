import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockAdd = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetJob = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockAdd, getJob: mockGetJob }))
}));

jest.mock('./notification.queue', () => ({
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 }))
}));

import { CAPI_PURCHASE_QUEUE_NAME, SEND_CAPI_PURCHASE_JOB, buildCapiPurchaseJobId, enqueueCapiPurchase } from './capi.queue';

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
