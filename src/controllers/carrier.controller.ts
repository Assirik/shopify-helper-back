import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Carrier } from '../models/Carrier';
import log from '../utilities/logger/logger';

const toTrimmedString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const parseDefaultPrice = (value: unknown): { value?: number } | { error: string } => {
  if (value === undefined || value === null || value === '') {
    return { value: undefined };
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { error: 'Le prix indicatif doit être un nombre positif ou nul' };
  }

  return { value: parsed };
};

export class CarrierController {
  public static async list(req: Request, res: Response) {
    const active = toTrimmedString(req.query.active);
    const filters: Record<string, unknown> = {};

    if (active === 'true' || active === 'false') {
      filters.isActive = active === 'true';
    }

    const carriers = await Carrier.find(filters).sort({ isActive: -1, name: 1 });

    return res.status(200).json({ data: carriers });
  }

  public static async create(req: Request, res: Response) {
    const name = toTrimmedString(req.body?.name);
    const phoneE164 = toTrimmedString(req.body?.phoneE164);

    if (!name) {
      return res.status(400).json({ error: 'InvalidCarrier', details: { name: 'Le nom est obligatoire' } });
    }

    const defaultPrice = parseDefaultPrice(req.body?.defaultPrice);
    if ('error' in defaultPrice) {
      return res.status(400).json({ error: 'InvalidCarrier', details: { defaultPrice: defaultPrice.error } });
    }

    const actorId = req.userId && Types.ObjectId.isValid(req.userId) ? new Types.ObjectId(req.userId) : undefined;
    const carrier = await Carrier.create({
      name,
      phoneE164: phoneE164 || undefined,
      defaultPrice: defaultPrice.value,
      createdBy: actorId,
      updatedBy: actorId
    });

    log.info({ carrierId: carrier._id, createdBy: req.userId }, 'Created carrier');

    return res.status(201).json({ data: carrier });
  }

  public static async update(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    if (!Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'CarrierNotFound' });
    }

    const body = req.body || {};
    const set: Record<string, unknown> = {};

    if ('name' in body) {
      const name = toTrimmedString(body.name);
      if (!name) {
        return res.status(400).json({ error: 'InvalidCarrier', details: { name: 'Le nom est obligatoire' } });
      }
      set.name = name;
    }

    if ('phoneE164' in body) {
      set.phoneE164 = toTrimmedString(body.phoneE164) || undefined;
    }

    if ('defaultPrice' in body) {
      const defaultPrice = parseDefaultPrice(body.defaultPrice);
      if ('error' in defaultPrice) {
        return res.status(400).json({ error: 'InvalidCarrier', details: { defaultPrice: defaultPrice.error } });
      }
      set.defaultPrice = defaultPrice.value;
    }

    if (Object.keys(set).length === 0) {
      return res.status(400).json({ error: 'InvalidCarrier', details: { _global: 'Aucune valeur à mettre à jour' } });
    }

    if (req.userId && Types.ObjectId.isValid(req.userId)) {
      set.updatedBy = new Types.ObjectId(req.userId);
    }

    const carrier = await Carrier.findByIdAndUpdate(id, { $set: set }, { new: true });

    if (!carrier) {
      return res.status(404).json({ error: 'CarrierNotFound' });
    }

    log.info({ carrierId: carrier._id, updatedBy: req.userId }, 'Updated carrier');

    return res.status(200).json({ data: carrier });
  }

  public static async setStatus(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    if (!Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'CarrierNotFound' });
    }

    if (typeof req.body?.isActive !== 'boolean') {
      return res.status(400).json({ error: 'InvalidCarrierStatus' });
    }

    const set: Record<string, unknown> = { isActive: req.body.isActive };
    if (req.userId && Types.ObjectId.isValid(req.userId)) {
      set.updatedBy = new Types.ObjectId(req.userId);
    }

    const carrier = await Carrier.findByIdAndUpdate(id, { $set: set }, { new: true });

    if (!carrier) {
      return res.status(404).json({ error: 'CarrierNotFound' });
    }

    log.info({ carrierId: carrier._id, isActive: carrier.isActive, updatedBy: req.userId }, 'Updated carrier status');

    return res.status(200).json({ data: carrier });
  }
}
