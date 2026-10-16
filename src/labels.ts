import { kindSchema, type Kind } from '../shared/schema';

export const transactionKinds = kindSchema.options;

export function transactionKindLabel(kind: Kind): string {
  const words = kind.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
