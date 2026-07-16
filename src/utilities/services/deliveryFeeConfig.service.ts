import { Types } from 'mongoose';
import {
  DELIVERY_FEE_CONFIG_KEY,
  DeliveryFeeConfig,
  IDeliveryFeeConfig,
  IRegionDeliveryFee
} from '../../models/DeliveryFeeConfig';
import config from '../config/env.config';
import { SENEGAL_REGIONS } from '../reference/senegalRegions';

const REGION_CODES = new Set(SENEGAL_REGIONS.map(region => region.code));

export type DeliveryFeeConfigUpdate = {
  defaultFee?: number;
  regionFees?: IRegionDeliveryFee[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isValidAmount = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
};

export const validateDeliveryFeeConfigUpdate = (
  raw: unknown
): { update: DeliveryFeeConfigUpdate } | { errors: Record<string, string> } => {
  if (!isPlainObject(raw)) {
    return { errors: { _global: 'Le body doit être un objet JSON' } };
  }

  const errors: Record<string, string> = {};
  const update: DeliveryFeeConfigUpdate = {};

  for (const key of Object.keys(raw)) {
    if (!['defaultFee', 'regionFees'].includes(key)) {
      errors[key] = 'Champ inconnu';
    }
  }

  if ('defaultFee' in raw) {
    if (!isValidAmount(raw.defaultFee)) {
      errors.defaultFee = 'Le montant par défaut doit être un nombre positif ou nul';
    } else {
      update.defaultFee = raw.defaultFee;
    }
  }

  if ('regionFees' in raw) {
    if (!Array.isArray(raw.regionFees)) {
      errors.regionFees = 'Le barème régional doit être une liste';
    } else {
      const seen = new Set<string>();
      const regionFees: IRegionDeliveryFee[] = [];

      raw.regionFees.forEach((item, index) => {
        if (!isPlainObject(item)) {
          errors[`regionFees.${index}`] = 'La ligne de barème doit être un objet';
          return;
        }

        const regionCode = typeof item.regionCode === 'string' ? item.regionCode.trim().toUpperCase() : '';
        if (!REGION_CODES.has(regionCode)) {
          errors[`regionFees.${index}.regionCode`] = 'Code région inconnu';
        }

        if (seen.has(regionCode)) {
          errors[`regionFees.${index}.regionCode`] = 'Code région dupliqué';
        }
        seen.add(regionCode);

        if (!isValidAmount(item.amount)) {
          errors[`regionFees.${index}.amount`] = 'Le montant doit être un nombre positif ou nul';
        }

        if (REGION_CODES.has(regionCode) && isValidAmount(item.amount)) {
          regionFees.push({ regionCode, amount: item.amount });
        }
      });

      update.regionFees = regionFees;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  if (Object.keys(update).length === 0) {
    return { errors: { _global: 'Aucune valeur à mettre à jour' } };
  }

  return { update };
};

export class DeliveryFeeConfigService {
  public static getConfig() {
    return DeliveryFeeConfig.findOne({ key: DELIVERY_FEE_CONFIG_KEY });
  }

  // `updatedBy` est peuplé (userName) sur les chemins exposés à l'admin, pas sur
  // `getConfig` utilisé par la résolution interne des frais.
  public static async getOrCreateConfig() {
    return DeliveryFeeConfig.findOneAndUpdate(
      { key: DELIVERY_FEE_CONFIG_KEY },
      { $setOnInsert: { defaultFee: config.delivery.defaultFee, regionFees: [] } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).populate('updatedBy', 'userName');
  }

  public static async updateConfig(
    raw: unknown,
    updatedBy: string
  ): Promise<{ config: IDeliveryFeeConfig } | { errors: Record<string, string> }> {
    const validated = validateDeliveryFeeConfigUpdate(raw);

    if ('errors' in validated) {
      return validated;
    }

    if (!Types.ObjectId.isValid(updatedBy)) {
      return { errors: { _global: 'Administrateur invalide' } };
    }

    const set: Record<string, unknown> = {
      updatedBy: new Types.ObjectId(updatedBy)
    };

    if (validated.update.defaultFee !== undefined) {
      set.defaultFee = validated.update.defaultFee;
    }

    if (validated.update.regionFees !== undefined) {
      set.regionFees = validated.update.regionFees;
    }

    const configDocument = await DeliveryFeeConfig.findOneAndUpdate(
      { key: DELIVERY_FEE_CONFIG_KEY },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).populate('updatedBy', 'userName');

    return { config: configDocument };
  }

  public static async resolveDeliveryFee(regionCode?: string) {
    const normalizedRegionCode = regionCode?.trim().toUpperCase();
    const configDocument = await DeliveryFeeConfigService.getConfig();

    if (!configDocument) {
      return config.delivery.defaultFee;
    }

    const regionalFee = normalizedRegionCode
      ? configDocument.regionFees.find(item => item.regionCode === normalizedRegionCode)
      : undefined;

    return regionalFee?.amount ?? configDocument.defaultFee;
  }
}
