const NAME_IGNORED_SPACING = /[\p{White_Space}\u200B\uFEFF]/gu;

/** Converts full-width characters with NFKC and removes every whitespace. */
export function normalizeStudentId(value: string): string {
  return value.normalize('NFKC').replace(NAME_IGNORED_SPACING, '');
}

/**
 * Names are compared after NFKC conversion and removal of every whitespace.
 * This accepts names separated by ideographic spaces as equivalent to unspaced names.
 */
export function normalizeName(value: string): string {
  return value.normalize('NFKC').replace(NAME_IGNORED_SPACING, '');
}
