# Account connection coverage

Venmo supports receipt forwarding on web and iOS once incoming email is configured. Apple FinanceKit is the next connection milestone. Bitcoin address tracking is independent of Plaid.

| Account | Current path | Remaining work |
| --- | --- | --- |
| Bank accounts, credit cards | Each user's Plaid credentials; Transactions connection | Institution/product approval and account availability belong to the user's Plaid account. |
| Brokerage and retirement | Plaid Investments connection | Availability depends on institution and enabled products. Avoid importing the same account twice through banking and investment connections. |
| Bitcoin addresses | Public-address tracking, live polling and historical USD valuations | Resumable backfill for addresses over 500 transfers; exchange purchase-cost imports. |
| Venmo | Unique receipt-forwarding address, matching to imported history, review queue; see [setup](VENMO.md). | Configure Resend Receiving and verify the first real receipt. Wallet balances and a dedicated statement adapter remain separate. |
| Apple Card | Generic CSV import or manual credit account | FinanceKit on iPhone and a dedicated Apple Card statement adapter. |
| Apple Cash and Savings | Manual account | FinanceKit on iPhone. |
| Auto loan, physical cash, unsupported assets | Manual accounts and dated balance snapshots | No credentials needed. |

## Venmo receipt forwarding

The implementation follows Copilot's email-forwarding model, independently of Plaid. The server validates signed inbound events and authenticated senders, imports recognized completed payments once, preserves matching CSV history, and sends unfamiliar or manually forwarded receipts to review. See [Venmo setup and limits](VENMO.md).

Venmo also provides statement CSV downloads. Generic CSV imports remain available; a dedicated statement adapter is future work. Plaid lists Venmo - Personal (`ins_132083`), but its Trial/product compatibility has not been verified and is not required for receipt forwarding.

## Apple milestone

Apple's FinanceKit supplies consent-based on-device access to supported Apple Card, Apple Cash and Savings data in the US. It requires an approved managed entitlement for the app's bundle ID. Apple's current prerequisites include an organization-level Apple Developer membership, Finance category and iPhone App Store distribution in a supported region. Asset uses `org.gtfol.asset`; the repository does not yet specify a signing team or contain the approved FinanceKit entitlement.

After those prerequisites are confirmed, implement permission/availability states, account and transaction history queries, durable change tokens, deletion handling, balance snapshots and idempotent synchronization to the signed-in workspace. Keep authorization on the iPhone and expose synchronized records on web. Test consent revocation and sign-out boundaries. Do not show a working “Connect Apple” action until the entitlement and device flow are verified.

Sources: [Venmo statement exports](https://help.venmo.com/cs/articles/transaction-history-vhel281), [Apple Card exports](https://support.apple.com/en-us/102284), [FinanceKit prerequisites](https://developer.apple.com/financekit/), [FinanceKit framework](https://developer.apple.com/documentation/FinanceKit).
