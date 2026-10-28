# Account connection coverage

Venmo supports receipt forwarding on web and iOS. Apple FinanceKit synchronization is enabled in production, with signed iPhone build 6 uploaded to TestFlight. Bitcoin address tracking is independent of Plaid.

| Account | Current path | Remaining work |
| --- | --- | --- |
| Bank accounts, credit cards | Each user's Plaid credentials; Transactions connection | Institution/product approval and account availability belong to the user's Plaid account. |
| Brokerage and retirement | Plaid Investments connection | Availability depends on institution and enabled products. Avoid importing the same account twice through banking and investment connections. |
| Bitcoin addresses | Public-address tracking, live polling and historical USD valuations | Resumable backfill for addresses over 500 transfers; exchange purchase-cost imports. |
| Venmo | `venmo@receipts.gtfol.dev` for verified source mailboxes, matching to imported history, review queue; see [setup](VENMO.md). | Wallet balances and a dedicated statement adapter remain separate. |
| Apple Card, Cash, Savings | iPhone FinanceKit connection with imported-account matching and incremental sync | Install build 6, set up authenticator verification, and verify consent/sync on a physical iPhone. |
| Santander Consumer USA, Synchrony Pay Later | Manual loan account, APR, scheduled payment, due date, dated statement balance, linked bank payment history | No exact matching Plaid institution was found in the October 17 dashboard check. Santander Personal and Synchrony Bank point to different portals. No direct portal scraping or credential storage. |
| Physical cash, unsupported assets | Manual accounts and dated balance snapshots | No credentials needed. |

## Venmo receipt forwarding

The implementation follows Copilot's email-forwarding model, independently of Plaid. The server validates signed inbound events and authenticated senders, imports recognized completed payments once, preserves matching CSV history, and sends unfamiliar or manually forwarded receipts to review. See [Venmo setup and limits](VENMO.md).

Venmo also provides statement CSV downloads. Generic CSV imports remain available; a dedicated statement adapter is future work. Plaid lists Venmo - Personal (`ins_132083`), but its Trial/product compatibility has not been verified and is not required for receipt forwarding.

## Apple milestone

Apple's FinanceKit supplies consent-based on-device access to supported Apple Card, Apple Cash and Savings data in the US. It requires an approved managed entitlement for `org.gtfol.asset`. The gtfol organization signing team and Finance-category App Store Connect record are configured. The agreement was accepted and request **739VT6P73Z** submitted on October 18, 2026. Following approval, FinanceKit was enabled for the App ID on October 25 with the user's permission. The refreshed provisioning profile grants `com.apple.developer.financekit` as the array `["financial-data"]`; the signed build uses that exact value.

The iPhone implementation requests consent before reading and uploading selected accounts, maps existing imported accounts, synchronizes transaction/balance changes with protected durable cursors, and removes synced Apple records on disconnect while restoring independently imported history. Sync runs on foreground unlock and explicit refresh. Cloud access requires authenticator verification on new sessions. Tests cover idempotency, imported edits, deletion, verification and owner isolation. No background extension or real Wallet sync is claimed. Build 6 includes `AssetFinanceKitEnabled` and the FinanceKit entitlement. Production `FINANCEKIT_ENABLED` is on; the live Apple endpoint returned `available: true` after redeployment on October 25. Physical-device consent and Wallet sync still need verification. Ordinary Apple updates read and transfer only changed records and matching import candidates. Cursors are scoped to the owner, device storage, account, and consent rather than a rotating session token. Expired cursors preserve transaction edits while rebuilding provider history.

## Copilot migration

The export contains posted/pending status, not reviewed/unreviewed status. The importer defaults to treating posted categorized transactions, income, transfers and excluded purchases as reviewed; users can opt out. Income exclusions in Copilot describe spending budgets, so income remains included in Asset cash flow. Original exclusion values are retained in import provenance. Transfers never count as spending or income.

Re-uploading an earlier export offers a separate “Update imported history” action. It repairs review flags and income exclusions only for exact import identities, including records matched to connected accounts. It preserves categories, notes, account links and excluded purchases; pending rows, unresolved split conflicts and unmatched bank records stay untouched. Ordinary re-imports continue to skip duplicates and preserve user edits.

Sources: [Venmo statement exports](https://help.venmo.com/cs/articles/transaction-history-vhel281), [Apple Card exports](https://support.apple.com/en-us/102284), [FinanceKit prerequisites](https://developer.apple.com/financekit/), [FinanceKit framework](https://developer.apple.com/documentation/FinanceKit).

## Loan payment history

Existing withdrawals can be linked to a loan from its Payments section. Suggestions require the lender and an account reference, or a unique loan with the same lender and scheduled payment amount. Transfers must have a signed source amount establishing that money left the paying account. The link preserves the original bank account, transaction edits, exclusions, and reviewed state. It does not create another transaction or deduct the whole payment from principal; statement balances remain separately recorded. Transaction details offer a Loan payment selector to correct or clear a link. The same payment appears in both account filters but is counted only once in reports.
