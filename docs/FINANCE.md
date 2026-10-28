# Calculations and backups

## Calculation conventions

Money is integer cents. Different currencies are never combined; reporting currency filters totals. Imported transaction dates remain date-only calendar values, and reporting boundaries use the configured timezone. Positive card/loan balances mean debt owed; negative liability balances mean a credit. Account balance and transaction activity are separate records.

Posted spending minus refunds counts once. Split parents are replaced by their parts. Pending/removed records, transfers, card payments, and investment trades/transfers do not count as ordinary spend or income. Budget-excluded activity stays out of budget pace; Cash Flow has a separate include-excluded toggle shared with Dashboard's net summary.

Projection = eligible spend to date × calendar days in month ÷ elapsed days. It is **Asset's transparent estimate**, not a claimed Copilot algorithm. It requires complete history, disappears for completed historical months, and can be distorted by early-month or lumpy spending. There is no recurring engine and no deduction for expected future bills.

Complete coverage must be established per account. CSV import alone does not prove completeness; confirm a known range in manual account settings. Plaid history may be shorter than requested. Projections require verified coverage. Cash Flow compares recorded activity when both periods have activity or verified coverage, with an explicit recorded-transactions label when coverage is unverified. No recorded history and a zero comparison amount are distinct states; neither produces a percentage. Balance-only loan accounts do not invalidate bank transaction coverage. Month cards identify their month, year cards identify the year-to-date cutoff, and annual charts do not plot future activity.

Portfolio balance growth is never labeled investment return. Complete contribution/valuation history is needed for cash-flow-adjusted return; until then, it is unavailable. Account balances can differ from holdings because of cash, missing securities, and timestamps.

## Backup and restore

Use Settings → Full backup for complete recovery, including splits, rules, budgets, balances, and holding snapshots. CSV is a readable transaction export, not a full-state backup. Provider secrets and raw provider payloads are not exported. Connected records restore as disconnected manual data.

Restore validates the schema, reference integrity, split sums, and demo/private separation. Disconnect active connections before restoring to avoid invalidating their cursors. Web downloads a recovery backup first; iOS saves `before-restore.json` locally before replacing the workspace and can share that recovery file. Preserve a separate external backup before uninstalling or clearing app data.
