export interface SenegalRegion {
  code: string;
  label: string;
  aliases: string[];
  isHomeDeliveryZone: boolean;
}

export const SENEGAL_REGIONS: SenegalRegion[] = [
  { code: 'SN_DK', label: 'Dakar', aliases: ['Région de Dakar', 'Dakar Region', 'Ville de Dakar'], isHomeDeliveryZone: true },
  { code: 'SN_DB', label: 'Diourbel', aliases: ['Diourbel Region', 'Région de Diourbel'], isHomeDeliveryZone: false },
  { code: 'SN_FK', label: 'Fatick', aliases: ['Fatick Region', 'Région de Fatick'], isHomeDeliveryZone: false },
  { code: 'SN_KA', label: 'Kaffrine', aliases: ['Kaffrine Region', 'Région de Kaffrine'], isHomeDeliveryZone: false },
  { code: 'SN_KL', label: 'Kaolack', aliases: ['Kaolack Region', 'Région de Kaolack'], isHomeDeliveryZone: false },
  { code: 'SN_KE', label: 'Kédougou', aliases: ['Kedougou', 'Kédougou Region', 'Région de Kédougou'], isHomeDeliveryZone: false },
  { code: 'SN_KD', label: 'Kolda', aliases: ['Kolda Region', 'Région de Kolda'], isHomeDeliveryZone: false },
  { code: 'SN_LG', label: 'Louga', aliases: ['Louga Region', 'Région de Louga'], isHomeDeliveryZone: false },
  { code: 'SN_MT', label: 'Matam', aliases: ['Matam Region', 'Région de Matam'], isHomeDeliveryZone: false },
  { code: 'SN_SL', label: 'Saint-Louis', aliases: ['Saint Louis', 'Saint-Louis Region', 'Région de Saint-Louis'], isHomeDeliveryZone: false },
  { code: 'SN_SE', label: 'Sédhiou', aliases: ['Sedhiou', 'Sédhiou Region', 'Région de Sédhiou'], isHomeDeliveryZone: false },
  { code: 'SN_TC', label: 'Tambacounda', aliases: ['Tambacounda Region', 'Région de Tambacounda'], isHomeDeliveryZone: false },
  { code: 'SN_TH', label: 'Thiès', aliases: ['Thies', 'Thiès Region', 'Région de Thiès'], isHomeDeliveryZone: false },
  { code: 'SN_ZG', label: 'Ziguinchor', aliases: ['Ziguinchor Region', 'Région de Ziguinchor'], isHomeDeliveryZone: false }
];

export const normalizeRegion = (value?: string) =>
  (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ region$/, '')
    .trim();

const REGION_BY_CODE = new Map(SENEGAL_REGIONS.map(region => [region.code.toUpperCase(), region]));
const REGION_BY_ALIAS = new Map<string, SenegalRegion>();

for (const region of SENEGAL_REGIONS) {
  for (const value of [region.label, ...region.aliases]) {
    REGION_BY_ALIAS.set(normalizeRegion(value), region);
  }
}

export const resolveRegion = (rawValue?: string): SenegalRegion | undefined => {
  const trimmed = rawValue?.trim();

  if (!trimmed) {
    return undefined;
  }

  return REGION_BY_CODE.get(trimmed.toUpperCase()) || REGION_BY_ALIAS.get(normalizeRegion(trimmed));
};

export const isHomeDeliveryRegion = (rawValue?: string) => Boolean(resolveRegion(rawValue)?.isHomeDeliveryZone);
