import { z } from 'zod';
import { dateSchema, centsSchema, type State, type Transaction } from './schema.js';

export const venmoReceiptSchema = z.object({
  receiptId: z.string().min(1).max(100),
  date: dateSchema,
  name: z.string().trim().min(1).max(160),
  amount: centsSchema.positive(),
  kind: z.enum(['spending', 'refund', 'income', 'transfer']),
  notes: z.string().max(5000).default(''),
  categoryId: z.string().optional(),
});
export type VenmoReceipt = z.infer<typeof venmoReceiptSchema>;

export function mailbox(value: string): string {
  const match = value.trim().match(/^(?:[^<>]*<)?([^<>\s]+@[^<>\s]+)>?$/);
  return match?.[1].toLowerCase() ?? '';
}

export function receiptDay(value: string, timeZone = 'America/Los_Angeles'): string | undefined {
  const date = new Date(value);
  if (!value || !Number.isFinite(+date)) return;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return;
  }
}

// Deliberately accepts completed payment receipts only. Requests, statements,
// withdrawals and unfamiliar templates go to review instead of becoming spending.
export function parseVenmoReceipt(input: {
  subject: string;
  text: string;
  date?: string;
  timeZone?: string;
}): { receipt?: VenmoReceipt; reason?: string } {
  const text = input.text.replace(/\r/g, '').replace(/\u00a0/g, ' ');
  const subject = input.subject.replace(/^(?:(?:fwd?|re):\s*)+/i, '').trim();
  if (
    /\b(request(?:ed)?|reminder|cancel(?:ed|led)?|declined|failed|pending|statement)\b/i.test(
      subject,
    )
  )
    return { reason: 'This is not a completed payment receipt.' };
  const headings = [
    subject,
    ...text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 25),
  ];
  let name = '',
    dollars = '',
    kind: 'spending' | 'refund' = 'spending';
  for (let i = 0; i < headings.length; i++) {
    const lines = [headings[i]];
    if (headings[i + 1]?.startsWith('$')) lines.push(`${headings[i]} ${headings[i + 1]}`);
    for (const line of lines) {
      const outgoing = line.match(
        /^You paid (.{1,160}?)\s+\$((?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2})[.!]?$/i,
      );
      const incoming = line.match(
        /^(.{1,160}?) paid you\s+\$((?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2})[.!]?$/i,
      );
      if (outgoing || incoming) {
        const m = outgoing ?? incoming!;
        name = m[1].trim();
        dollars = m[2];
        kind = outgoing ? 'spending' : 'refund';
        break;
      }
    }
    if (name) break;
  }
  if (!name) return { reason: 'Review the payment direction, person, and amount.' };
  const receiptId =
    text.match(
      /\b(?:transaction|payment)\s*(?:id|number|#)\s*:?\s*((?=[A-Z0-9]*\d)[A-Z0-9]{8,30})\b/i,
    )?.[1] ?? text.match(/https:\/\/(?:www\.)?venmo\.com\/transaction\/(\d{8,30})\b/i)?.[1];
  if (!receiptId)
    return { reason: 'This receipt has no recognized transaction ID. Review it before importing.' };
  const date = receiptDay(input.date ?? '', input.timeZone);
  if (!date) return { reason: 'Review the original payment date.' };
  const amount = Math.round(Number(dollars.replace(/,/g, '')) * 100);
  const notes =
    text.match(/(?:^|\n)(?:Note|Payment note|For)\s*:?\s*\n([^\n]{1,5000})/i)?.[1]?.trim() ?? '';
  const result = venmoReceiptSchema.safeParse({ receiptId, date, name, amount, kind, notes });
  return result.success ? { receipt: result.data } : { reason: 'Review the payment details.' };
}

export function venmoBankTransfer(t: Transaction, state: State): Transaction {
  if (
    t.source !== 'plaid' ||
    t.edits.kind ||
    !state.accounts.some((a) => a.source === 'venmo' && a.venmo?.bankTransfers)
  )
    return t;
  const description = String(t.raw?.original_description ?? t.raw?.name ?? t.name);
  // Venmo-branded merchant/card purchases are not bank funding transfers.
  if (
    !/\bVENMO\b/i.test(description) ||
    !/\b(?:PAYMENT|CASHOUT|CASH OUT|TRANSFER)\b/i.test(description) ||
    /\b(?:CARD|PURCHASE)\b/i.test(description)
  )
    return t;
  return { ...t, kind: 'transfer' };
}
