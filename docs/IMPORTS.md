# Importing Copilot transactions

Choose **Import** in the web app, or **Settings → Import CSV** on iPhone. Asset recognizes Copilot's account/mask/status/category columns and offers a combined preview. Generic single-account CSV import remains available for other exports.

Review each account mapping and account type. Match an existing account when its history is already connected. Otherwise Asset creates an account with an unknown balance. Account names plus masks distinguish multiple cards with the same name. Currency is chosen explicitly because Copilot's export has no currency column.

The importer preserves dates, descriptions, exact cents, categories and parent groups, notes, exclusions, pending status, tags, and recurring labels. Copilot Regular amounts become spending when positive and refunds when negative. Income remains income; Internal Transfer remains a transfer excluded from income/spending totals. Source review status is not exported, so imported transactions await review.

Imports are atomic and additive. Invalid rows block the entire Copilot import. Identical purchases within a file remain separate records. A full import identity plus occurrence number prevents replaying the same export, even after user display edits. Pending records with the same identity can settle on a later export. Re-import does not overwrite category/notes edits or resurrect deleted rows. Existing non-Copilot transactions are matched one-to-one by account, date, amount, type, currency, and normalized name. Records whose bank descriptions, posted dates, amounts, or transfer classifications differ need review because the export does not include provider IDs.

Balances, investments, budgets, and complete account coverage are not inferred from the transaction export. Pending records remain excluded from spending totals until settled. Historical imports do not generate transaction notifications.

Files are limited to 10 MB and 10,000 rows. The hosted workspace still has a 4 MB response safety limit; parsing stores the normalized fields without a redundant copy of every CSV cell. Full backups preserve import identity and metadata. The source file is not written to the repository or transmitted to analytics or AI services by the app.
