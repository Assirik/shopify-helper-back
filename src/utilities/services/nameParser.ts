export interface ParsedName {
  firstName?: string;
  lastName?: string;
}

// Convention métier Sénégal retenue pour Easysell: le dernier mot est le nom
// de famille, les mots précédents sont les prénoms. Les noms composés restent
// une limite connue et pourront nécessiter une correction helpdesk.
export const splitFullName = (fullName?: string): ParsedName => {
  const tokens = (fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return {};
  }

  if (tokens.length === 1) {
    return { firstName: '', lastName: tokens[0] };
  }

  return {
    firstName: tokens.slice(0, -1).join(' '),
    lastName: tokens[tokens.length - 1]
  };
};
