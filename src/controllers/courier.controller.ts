import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Courier } from '../models/Courier';
import log from '../utilities/logger/logger';

const toTrimmedString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export class CourierController {
  public static async list(req: Request, res: Response) {
    const active = toTrimmedString(req.query.active);
    const filters: Record<string, unknown> = {};

    if (active === 'true' || active === 'false') {
      filters.isActive = active === 'true';
    }

    const couriers = await Courier.find(filters).sort({ isActive: -1, name: 1 });

    return res.status(200).json({ data: couriers });
  }

  public static async create(req: Request, res: Response) {
    const name = toTrimmedString(req.body?.name);
    const phoneE164 = toTrimmedString(req.body?.phoneE164);

    if (!name) {
      return res.status(400).json({ error: 'InvalidCourier', details: { name: 'Le nom est obligatoire' } });
    }

    const courier = await Courier.create({
      name,
      phoneE164: phoneE164 || undefined,
      createdBy: req.userId && Types.ObjectId.isValid(req.userId) ? new Types.ObjectId(req.userId) : undefined,
      updatedBy: req.userId && Types.ObjectId.isValid(req.userId) ? new Types.ObjectId(req.userId) : undefined
    });

    log.info({ courierId: courier._id, createdBy: req.userId }, 'Created courier');

    return res.status(201).json({ data: courier });
  }

  public static async update(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    if (!Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'CourierNotFound' });
    }

    const body = req.body || {};
    const set: Record<string, unknown> = {};
    const name = toTrimmedString(body.name);
    const phoneE164 = toTrimmedString(body.phoneE164);

    if ('name' in body) {
      if (!name) {
        return res.status(400).json({ error: 'InvalidCourier', details: { name: 'Le nom est obligatoire' } });
      }
      set.name = name;
    }

    if ('phoneE164' in body) {
      set.phoneE164 = phoneE164 || undefined;
    }

    if (Object.keys(set).length === 0) {
      return res.status(400).json({ error: 'InvalidCourier', details: { _global: 'Aucune valeur à mettre à jour' } });
    }

    if (req.userId && Types.ObjectId.isValid(req.userId)) {
      set.updatedBy = new Types.ObjectId(req.userId);
    }

    const courier = await Courier.findByIdAndUpdate(id, { $set: set }, { new: true });

    if (!courier) {
      return res.status(404).json({ error: 'CourierNotFound' });
    }

    log.info({ courierId: courier._id, updatedBy: req.userId }, 'Updated courier');

    return res.status(200).json({ data: courier });
  }

  public static async setStatus(req: Request, res: Response) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    if (!Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'CourierNotFound' });
    }

    if (typeof req.body?.isActive !== 'boolean') {
      return res.status(400).json({ error: 'InvalidCourierStatus' });
    }

    const set: Record<string, unknown> = { isActive: req.body.isActive };
    if (req.userId && Types.ObjectId.isValid(req.userId)) {
      set.updatedBy = new Types.ObjectId(req.userId);
    }

    const courier = await Courier.findByIdAndUpdate(id, { $set: set }, { new: true });

    if (!courier) {
      return res.status(404).json({ error: 'CourierNotFound' });
    }

    log.info({ courierId: courier._id, isActive: courier.isActive, updatedBy: req.userId }, 'Updated courier status');

    return res.status(200).json({ data: courier });
  }
}
