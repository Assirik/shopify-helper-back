import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Order } from '../../models/Order';
import { backfillAttentionQueue } from './attentionBackfill.service';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('attention queue backfill', () => {
  it('runs classifications in priority order and reports aggregate changes', async () => {
    const updateMany = jest
      .spyOn(Order, 'updateMany')
      .mockResolvedValueOnce({ modifiedCount: 1 } as never)
      .mockResolvedValueOnce({ modifiedCount: 2 } as never)
      .mockResolvedValueOnce({ modifiedCount: 3 } as never)
      .mockResolvedValueOnce({ modifiedCount: 4 } as never);

    await expect(backfillAttentionQueue()).resolves.toEqual({
      lateConfirm: 1,
      freeText: 2,
      smsOnly: 3,
      invalidNumber: 4,
      total: 10
    });
    expect(updateMany).toHaveBeenCalledTimes(4);
  });
});
