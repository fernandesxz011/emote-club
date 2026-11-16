const HOUR = 60 * 60 * 1000;

function addedDate(item) {
  const value = item?.createdAt;
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Recency is based on the date an emote entered this catalog. */
export function getRecency(item, now = Date.now()) {
  const date = addedDate(item);
  if (!date || !Number.isFinite(now)) return null;
  const age = now - date.getTime();
  if (age < 0 || age > 7 * 24 * HOUR) return null;
  return age <= 48 * HOUR
    ? {label: 'Novo', kind: 'new'}
    : {label: 'Recente', kind: 'recent'};
}

/** Uses the visitor's local timezone, as other browser date displays do. */
export function formatAddedDate(item) {
  const date = addedDate(item);
  return date ? date.toLocaleDateString('pt-BR') : 'Data de inclusão não informada';
}

/** Preserve catalog order and ignore saved IDs absent from the catalog. */
export function listSavedItems(items, saved) {
  return items.filter(item => saved.has(item.id));
}
