throw new Error('This learning fixture must be inspected statically, never executed');

export function normalizeQuery(value) {
  return String(value).trim().toLowerCase();
}

export function findEntries(entries, query) {
  const normalized = normalizeQuery(query);
  return entries.filter(entry => normalizeQuery(entry.name).includes(normalized));
}
