import { Request, Response } from 'express';
import { Customer } from '../models/Customer';
import log from '../utilities/logger/logger';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const toPositiveInteger = (value: unknown, fallback: number) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
};

const escapeRegExp = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

export class CustomerController {
  public static async list(req: Request, res: Response) {
    const page = toPositiveInteger(req.query.page, 1);
    const limit = Math.min(toPositiveInteger(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const skip = (page - 1) * limit;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';

    const filters: Record<string, unknown> = {};

    if (search) {
      filters.$text = { $search: search };
    }

    if (phone) {
      filters.$or = [
        { phoneE164: { $regex: escapeRegExp(phone), $options: 'i' } },
        { phoneRaw: { $regex: escapeRegExp(phone), $options: 'i' } }
      ];
    }

    if (email) {
      filters.email = email.toLowerCase();
    }

    const [customers, total] = await Promise.all([
      Customer.find(filters).sort({ updatedAt: -1 }).skip(skip).limit(limit),
      Customer.countDocuments(filters)
    ]);

    log.info(
      {
        page,
        limit,
        total,
        returned: customers.length,
        hasSearch: Boolean(search),
        hasPhoneFilter: Boolean(phone),
        hasEmailFilter: Boolean(email)
      },
      'Listed customers'
    );

    return res.status(200).json({
      data: customers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  }
}
