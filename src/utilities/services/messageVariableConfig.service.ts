import { Types } from 'mongoose';
import {
  IMessageVariableConfig,
  MESSAGE_VARIABLE_CONFIG_KEY,
  MessageVariableConfig
} from '../../models/MessageVariableConfig';
import { normalizeRegion, resolveRegion } from '../reference/senegalRegions';
import { validateTemplateText } from '../validation/templateText';

const CONFIGURABLE_FIELDS = ['shippingNote', 'paymentMethod'] as const;
const REGION_VARIANTS = ['dakar', 'nonDakar'] as const;

type ConfigurableField = (typeof CONFIGURABLE_FIELDS)[number];
type RegionVariant = (typeof REGION_VARIANTS)[number];
export type DeliveryRegionClassification = RegionVariant | 'unknown';
export type MessageVariableUpdate = Partial<Record<ConfigurableField, Partial<Record<RegionVariant, string | null>>>>;

export interface ResolvedMessageVariables {
  shippingNote?: string;
  paymentMethod?: string;
}

type ValidatedUpdate = { update: MessageVariableUpdate } | { errors: Record<string, string> };

const EXPLICIT_NON_DAKAR_ALIASES = new Set(['hors dakar', 'non dakar', 'en dehors de dakar']);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const classifyDeliveryRegion = (region?: string): DeliveryRegionClassification => {
  const normalized = normalizeRegion(region);

  if (!normalized) {
    return 'unknown';
  }

  if (EXPLICIT_NON_DAKAR_ALIASES.has(normalized)) {
    return 'nonDakar';
  }

  const canonicalRegion = resolveRegion(region);

  if (!canonicalRegion) {
    return 'unknown';
  }

  return canonicalRegion.isHomeDeliveryZone ? 'dakar' : 'nonDakar';
};

export const isDakarRegion = (region?: string) => classifyDeliveryRegion(region) === 'dakar';

export const validateMessageVariableUpdate = (raw: unknown): ValidatedUpdate => {
  if (!isPlainObject(raw)) {
    return { errors: { _global: 'Le body doit être un objet JSON' } };
  }

  const errors: Record<string, string> = {};
  const update: MessageVariableUpdate = {};

  for (const key of Object.keys(raw)) {
    if (!CONFIGURABLE_FIELDS.includes(key as ConfigurableField)) {
      errors[key] = 'Champ inconnu';
    }
  }

  for (const field of CONFIGURABLE_FIELDS) {
    if (!(field in raw)) {
      continue;
    }

    const variants = raw[field];

    if (!isPlainObject(variants)) {
      errors[field] = 'La configuration doit être un objet';
      continue;
    }

    for (const key of Object.keys(variants)) {
      if (!REGION_VARIANTS.includes(key as RegionVariant)) {
        errors[`${field}.${key}`] = 'Variante inconnue';
      }
    }

    const validatedVariants: Partial<Record<RegionVariant, string | null>> = {};

    for (const variant of REGION_VARIANTS) {
      if (!(variant in variants)) {
        continue;
      }

      const value = variants[variant];
      const path = `${field}.${variant}`;

      if (value === null || (typeof value === 'string' && value.trim() === '')) {
        validatedVariants[variant] = null;
        continue;
      }

      const result = validateTemplateText(value);

      if ('error' in result) {
        errors[path] = result.error;
      } else {
        validatedVariants[variant] = result.value;
      }
    }

    if (Object.keys(validatedVariants).length > 0) {
      update[field] = validatedVariants;
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

export class MessageVariableConfigService {
  public static getConfig() {
    return MessageVariableConfig.findOne({ key: MESSAGE_VARIABLE_CONFIG_KEY });
  }

  // Variante pour l'API admin : `updatedBy` peuplé (userName). `getConfig` reste
  // sans populate car `resolveForRegion` tourne aussi dans le worker, où le
  // modèle User n'est pas forcément enregistré.
  public static getConfigWithEditor() {
    return MessageVariableConfigService.getConfig().populate('updatedBy', 'userName');
  }

  public static async updateConfig(
    raw: unknown,
    updatedBy: string
  ): Promise<{ config: IMessageVariableConfig } | { errors: Record<string, string> }> {
    const validated = validateMessageVariableUpdate(raw);

    if ('errors' in validated) {
      return validated;
    }

    if (!Types.ObjectId.isValid(updatedBy)) {
      return { errors: { _global: 'Administrateur invalide' } };
    }

    const set: Record<string, string | Types.ObjectId> = {
      updatedBy: new Types.ObjectId(updatedBy)
    };
    const unset: Record<string, ''> = {};

    for (const field of CONFIGURABLE_FIELDS) {
      const variants = validated.update[field];

      if (!variants) {
        continue;
      }

      for (const variant of REGION_VARIANTS) {
        const value = variants[variant];

        if (value === undefined) {
          continue;
        }

        const path = `${field}.${variant}`;

        if (value === null) {
          unset[path] = '';
        } else {
          set[path] = value;
        }
      }
    }

    const config = await MessageVariableConfig.findOneAndUpdate(
      { key: MESSAGE_VARIABLE_CONFIG_KEY },
      {
        $set: set,
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {})
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).populate('updatedBy', 'userName');

    return { config };
  }

  public static async resolveForRegion(region?: string): Promise<ResolvedMessageVariables> {
    const classification = classifyDeliveryRegion(region);

    if (classification === 'unknown') {
      return {};
    }

    const config = await MessageVariableConfigService.getConfig();

    if (!config) {
      return {};
    }

    return {
      shippingNote: config.shippingNote?.[classification],
      paymentMethod: config.paymentMethod?.[classification]
    };
  }
}
