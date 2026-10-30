import { afterEach, describe, expect, it, jest } from '@jest/globals';

const queueAdd = jest.fn(async (name: string, data: unknown, opts: Record<string, unknown>) => ({
  id: opts.jobId || 'generated-id',
  name,
  data,
  queueName: 'notifications'
}));

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: queueAdd }))
}));

type QueueModule = typeof import('./notification.queue');

// Loads the queue module with a given environment (config is read at import time).
const loadQueue = (env: Record<string, string> = {}): QueueModule => {
  const previous = { ...process.env };
  delete process.env.CONFIRMATION_INITIAL_REQUEST_DELAY_MINUTES;
  Object.assign(process.env, env);
  let queueModule: QueueModule | undefined;
  jest.isolateModules(() => {
    queueModule = jest.requireActual<QueueModule>('./notification.queue');
  });
  process.env = previous;
  return queueModule as QueueModule;
};

const ORDER_ID = '6650f0c2a1b2c3d4e5f60718';

describe('scheduleInitialConfirmationRequest', () => {
  afterEach(() => {
    queueAdd.mockClear();
  });

  it('schedules one delayed job with a deterministic id and only the order id', async () => {
    const queue = loadQueue();

    const job = await queue.scheduleInitialConfirmationRequest(ORDER_ID);

    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queueAdd.mock.calls[0];
    expect(name).toBe(queue.SEND_INITIAL_CONFIRMATION_REQUEST_JOB);
    expect(name).toBe('sendInitialConfirmationRequest');
    expect(data).toEqual({ orderId: ORDER_ID });
    expect(opts).toEqual(expect.objectContaining({ delay: 5 * 60 * 1000, jobId: `confirm-initial-${ORDER_ID}` }));
    expect(String(opts.jobId)).not.toContain(':');
    expect(job.id).toBe(`confirm-initial-${ORDER_ID}`);
  });

  it('reuses the same job id when the same order is scheduled again', async () => {
    const queue = loadQueue();

    await queue.scheduleInitialConfirmationRequest(ORDER_ID);
    await queue.scheduleInitialConfirmationRequest(ORDER_ID);

    expect(queueAdd.mock.calls.map(call => call[2].jobId)).toEqual([
      `confirm-initial-${ORDER_ID}`,
      `confirm-initial-${ORDER_ID}`
    ]);
  });

  it('never schedules sooner than 5 minutes when a shorter delay is configured', async () => {
    const queue = loadQueue({ CONFIRMATION_INITIAL_REQUEST_DELAY_MINUTES: '2' });

    await queue.scheduleInitialConfirmationRequest(ORDER_ID);

    expect(queueAdd.mock.calls[0][2].delay).toBe(5 * 60 * 1000);
  });

  it('applies a longer configured delay', async () => {
    const queue = loadQueue({ CONFIRMATION_INITIAL_REQUEST_DELAY_MINUTES: '12' });

    await queue.scheduleInitialConfirmationRequest(ORDER_ID);

    expect(queueAdd.mock.calls[0][2].delay).toBe(12 * 60 * 1000);
  });
});

describe('enqueueOrderConfirmation', () => {
  it('stays immediate (used by the SMS fallback and the delayed request hand-over)', async () => {
    const queue = loadQueue({ CONFIRMATION_INITIAL_REQUEST_DELAY_MINUTES: '12' });

    await queue.enqueueOrderConfirmation({ orderId: ORDER_ID, messageId: 'm1', channel: 'sms' });

    const [name, , opts] = queueAdd.mock.calls[0];
    expect(name).toBe(queue.SEND_ORDER_CONFIRMATION_JOB);
    expect(opts).not.toHaveProperty('delay');
    expect(opts).not.toHaveProperty('jobId');
  });

  it('uses the deterministic send job id handed by the delayed initial request', async () => {
    const queue = loadQueue();

    await queue.enqueueOrderConfirmation(
      { orderId: ORDER_ID, messageId: 'm1', channel: 'whatsapp' },
      { jobId: queue.getInitialConfirmationSendJobId('m1') }
    );

    const [, , opts] = queueAdd.mock.calls[0];
    expect(opts).toEqual(expect.objectContaining({ jobId: 'confirm-send-m1', attempts: 3 }));
    expect(opts).not.toHaveProperty('delay');
  });
});
