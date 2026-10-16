export const categoryIcons = [
  { key: 'home', label: 'Home' },
  { key: 'groceries', label: 'Groceries' },
  { key: 'restaurants', label: 'Dining' },
  { key: 'coffee', label: 'Coffee' },
  { key: 'transport', label: 'Transport' },
  { key: 'shopping', label: 'Shopping' },
  { key: 'health', label: 'Health' },
  { key: 'fun', label: 'Entertainment' },
  { key: 'travel', label: 'Travel' },
  { key: 'income', label: 'Income' },
  { key: 'utilities', label: 'Utilities' },
  { key: 'education', label: 'Education' },
  { key: 'other', label: 'Other' },
] as const;

export type CategoryIconKey = (typeof categoryIcons)[number]['key'];

// Older backups may contain emoji. Resolve their category identity without
// rewriting financial records or rendering arbitrary icon text.
export function categoryIconKey(category?: { id?: string; icon?: string }): CategoryIconKey {
  return (
    categoryIcons.find((item) => item.key === category?.icon)?.key ??
    categoryIcons.find((item) => item.key === category?.id)?.key ??
    'other'
  );
}
