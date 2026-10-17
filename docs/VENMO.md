# Venmo receipt forwarding

Asset uses a unique email forwarding address per Venmo account, following the same general approach described by [Copilot](https://help.copilot.money/en/articles/3971255-venmo-integration-faq). No Venmo password, inbox OAuth grant, scraping, or Plaid connection is involved.

## Deployment

1. In the existing Resend team, enable Receiving on a dedicated inbound subdomain, or use the team's assigned `*.resend.app` receiving domain. Do not replace the MX records serving the team's ordinary inboxes. No outgoing email is required by this feature.
2. Configure an `email.received` webhook to `https://asset.gtfol.dev/api/venmo/webhook`.
3. Set `VENMO_RECEIVING_DOMAIN`, `RESEND_API_KEY` (with receiving read access), and `RESEND_WEBHOOK_SECRET` on the server. The existing `TOKEN_ENCRYPTION_KEY` encrypts routing tokens, confirmation codes, and temporary receipt previews. Keep secrets out of client builds and Git.
4. Migration `009_venmo_email.sql` runs through the existing migration runner. Both tables enable RLS; browser clients never access them directly. Redeploy after environment configuration.
5. The existing authenticated cron worker purges receipt previews after seven days and expired Gmail codes. The local worker does the same. Ensure the existing worker schedule is active.
6. In Asset's Connections → Venmo, select the existing imported Venmo account, enter the email that receives Venmo receipts, and create a forwarding address. Configure an email rule forwarding only `venmo@venmo.com`. Gmail's forwarding confirmation code appears after Refresh in Asset; leave global inbox forwarding disabled.

## Data behavior

- Recognized completed “You paid … $…” and “… paid you $…” receipts with a transaction ID and original Date are imported. Requests, failures, statements, unknown formats, missing IDs/dates and manually forwarded receipts require review. Current fixtures are synthetic; validate the first actual receipt before claiming coverage of every Venmo template.
- Outgoing payments start as spending. Incoming payments start as reimbursements (`refund`), with income/transfer classification available in review and transaction editing.
- Venmo receipt IDs, received-email IDs and message IDs provide durable deduplication. Existing removed provider transactions are not resurrected. A new receipt can match an unconnected CSV/manual transaction by account, date, amount, currency and name. Existing category, name, notes, splits, tags, review state, exclusions and import identity are retained. Ambiguous date/amount overlap goes to review. Manual matching requires the same account/date/amount/currency.
- The optional bank-transfer classification applies to existing and future Plaid entries explicitly describing Venmo PAYMENT, CASHOUT or TRANSFER. It excludes CARD/PURCHASE entries and preserves user kind overrides. Review the option before enabling; descriptions cannot prove a particular funding match.
- Receipts do **not** establish a wallet balance or complete statement history. Existing balances are retained, new Venmo balances are unknown. A payment may use a card or bank directly. No guessed running balance or historical balances are created.
- Web and iOS support setup, confirmation codes, pause/reconnect, and receipt review. Reconnecting rotates the address; old addresses stop accepting receipts. Pausing retains imported data and stops new receipts. Pause active routes before restoring a backup.
- Receipt review displays up to 50 messages, prioritizing pending reviews ahead of recent completed receipts. Completing or ignoring a review makes room for older pending receipts. Preview text is limited to 12 KB, encrypted at rest, withheld after seven days, and deleted by the worker. Imported receipts keep only minimal transaction data and deduplication metadata. No attachments or remote images are fetched. Resend has its own retention and usage limits.
- Webhook signature and timestamp verification happens before provider access. Resend-computed aligned DKIM must pass; explicit DMARC failure is rejected. Auto-forwarded Venmo receipts must reference the configured original recipient. Manual forwards must come from the configured source mailbox and always require user confirmation. User-supplied Authentication-Results headers are never trusted.
- Current new-payment alerts use the existing Venmo notification preference; historical/manual confirmations do not replay old alerts. APNs still requires production signing and push configuration.

Sources: [Resend receiving](https://resend.com/docs/dashboard/receiving/introduction), [received-email API and authentication results](https://resend.com/docs/api-reference/emails/retrieve-received-email), [webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests).
