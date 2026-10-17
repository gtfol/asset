# Account connection coverage

The next connection milestone is Venmo and Apple. Bitcoin address tracking is independent of Plaid.

| Account | Current path | Remaining work |
| --- | --- | --- |
| Bank accounts, credit cards | Each user's Plaid credentials; Transactions connection | Institution/product approval and account availability belong to the user's Plaid account. |
| Brokerage and retirement | Plaid Investments connection | Availability depends on institution and enabled products. Avoid importing the same account twice through banking and investment connections. |
| Bitcoin addresses | Public-address tracking, live polling and historical USD valuations | Resumable backfill for addresses over 500 transfers; exchange purchase-cost imports. |
| Venmo | Generic CSV import or manual account | Dedicated statement adapter and review flow; automated email forwarding needs an inbound-email service and verified sender handling. |
| Apple Card | Generic CSV import or manual credit account | FinanceKit on iPhone and a dedicated Apple Card statement adapter. |
| Apple Cash and Savings | Manual account | FinanceKit on iPhone. |
| Auto loan, physical cash, unsupported assets | Manual accounts and dated balance snapshots | No credentials needed. |

## Venmo milestone

Venmo officially provides statement CSV downloads from Settings → Statements in its app and from Statements on its website. Build a specific import adapter that recognizes the statement header and preamble, preserves transaction IDs, handles completed versus pending/failed payments, separates bank funding/withdrawals from spending, and deduplicates repeated/overlapping statements. Show a preview before committing any rows. Statements are historical imports and must not be presented as a live connection.

Automated email forwarding is a separate ingestion path. Before enabling it, provide per-workspace unguessable forwarding addresses, authenticated inbound webhooks, sender validation, bounded attachment parsing, durable deduplication and a review queue. Do not scrape Venmo sign-in or request a user's password. Verify an actual redacted statement/email format before claiming support for every variant.

## Apple milestone

Apple's FinanceKit supplies consent-based on-device access to supported Apple Card, Apple Cash and Savings data in the US. It requires an approved managed entitlement for the app's bundle ID. Apple's current prerequisites include an organization-level Apple Developer membership, Finance category and iPhone App Store distribution in a supported region. Asset uses `org.gtfol.asset`; the repository does not yet specify a signing team or contain the approved FinanceKit entitlement.

After those prerequisites are confirmed, implement permission/availability states, account and transaction history queries, durable change tokens, deletion handling, balance snapshots and idempotent synchronization to the signed-in workspace. Keep authorization on the iPhone and expose synchronized records on web. Test consent revocation and sign-out boundaries. Do not show a working “Connect Apple” action until the entitlement and device flow are verified.

Sources: [Venmo statement exports](https://help.venmo.com/cs/articles/transaction-history-vhel281), [Apple Card exports](https://support.apple.com/en-us/102284), [FinanceKit prerequisites](https://developer.apple.com/financekit/), [FinanceKit framework](https://developer.apple.com/documentation/FinanceKit).
