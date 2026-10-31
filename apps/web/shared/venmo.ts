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
export type VenmoReceiptDraft = Partial<VenmoReceipt>;

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

function calendarDay(value: string): string | undefined {
  const clean = value
    .trim()
    .replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i, '');
  if (dateSchema.safeParse(clean).success) return clean;
  const match = clean.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!match) return;
  const months = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];
  const month = months.findIndex(
    (m) => m === match[1].toLowerCase() || m.slice(0, 3) === match[1].toLowerCase(),
  );
  if (month < 0) return;
  const day = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  return dateSchema.safeParse(day).success ? day : undefined;
}

// Only completed, identifiable payments are imported automatically. Partial
// results still populate the review form, without guessing missing fields.
export function parseVenmoReceipt(input: {
  subject: string;
  text: string;
  date?: string;
  timeZone?: string;
}): { receipt?: VenmoReceipt; draft?: VenmoReceiptDraft; reason?: string } {
  const text = input.text
    .replace(/\r/g, '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\$\s*((?:\d+|\d{1,3}(?:,\d{3})+))\s*\.\s*(\d{2})(?!\d)/g, '$$$1.$2');
  const subject = input.subject.replace(/^(?:(?:fwd?|re):\s*)+/i, '').trim();
  const valueAfter = (label: string) =>
    text
      .match(
        new RegExp(`(?:^|\\n)[ \\t]*(?:${label})[ \\t]*:?[ \\t]*(?:\\n[ \\t]*)*([^\\n]+)`, 'i'),
      )?.[1]
      ?.trim();
  const receiptId =
    text.match(
      /\b(?:transaction|payment)\s*(?:id|number|#)\s*:?\s*((?=[A-Z0-9]*\d)[A-Z0-9]{8,30})\b/i,
    )?.[1] ?? text.match(/https:\/\/(?:www\.)?venmo\.com\/transaction\/(\d{8,30})\b/i)?.[1];
  const printedDate = valueAfter('date|payment date|initiated on');
  const date = printedDate
    ? calendarDay(printedDate)
    : receiptDay(input.date ?? '', input.timeZone);
  const transfer = /^Your Venmo (?:Standard|Instant) transfer has been initiated[.!]?$/i.test(
    subject,
  );
  if (transfer) {
    const amountText = valueAfter('transfer amount');
    const amount = amountText?.match(/^\$((?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2})$/);
    const destination = valueAfter('destination');
    return {
      draft: {
        ...(receiptId ? { receiptId } : {}),
        ...(date ? { date } : {}),
        ...(amount ? { amount: Math.round(Number(amount[1].replace(/,/g, '')) * 100) } : {}),
        name: destination ? `Transfer to ${destination}`.slice(0, 160) : 'Venmo bank transfer',
        kind: 'transfer',
        notes: 'Venmo transfer initiated; arrival is not yet confirmed.',
      },
      reason:
        'Transfer details filled in. This email confirms initiation, not arrival at your bank.',
    };
  }
  if (
    /\b(request(?:ed)?|reminder|cancel(?:ed|led)?|declined|failed|pending|statement)\b/i.test(
      subject,
    )
  )
    return { reason: 'This is not a completed payment receipt.' };
  const bodyLines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const headings = [subject, ...bodyLines.slice(0, 25)];
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
  if (!name)
    return {
      draft: { ...(date ? { date } : {}), ...(receiptId ? { receiptId } : {}) },
      reason: 'Review the payment direction, person, and amount.',
    };
  const amount = Math.round(Number(dollars.replace(/,/g, '')) * 100);
  const transactionLink = bodyLines.findIndex((line) => /^See transaction(?:\s|$)/i.test(line));
  const noteAboveLink = transactionLink > 0 ? bodyLines[transactionLink - 1] : '';
  const notes =
    text.match(/(?:^|\n)(?:Note|Payment note|For)\s*:?\s*\n([^\n]{1,5000})/i)?.[1]?.trim() ??
    (noteAboveLink && !/^(?:\$|You paid\b)|\bpaid you\b/i.test(noteAboveLink)
      ? noteAboveLink.slice(0, 5000)
      : '');
  const draft: VenmoReceiptDraft = {
    name,
    amount,
    kind,
    notes,
    ...(date ? { date } : {}),
    ...(receiptId ? { receiptId } : {}),
  };
  const status = valueAfter('status');
  if (status && !/^completed$/i.test(status))
    return {
      draft,
      reason: 'This payment is not marked completed. Check its status before importing.',
    };
  if (!receiptId)
    return {
      draft,
      reason: 'Details filled in. Confirm this payment because its transaction ID is missing.',
    };
  if (!date) return { draft, reason: 'Details filled in. Add the original payment date.' };
  const result = venmoReceiptSchema.safeParse(draft);
  return result.success
    ? { receipt: result.data }
    : { draft, reason: 'Review the payment details.' };
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
