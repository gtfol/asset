# Notifications and iPhone privacy

Asset supports the eight enabled preferences from the requested reference: bank fees, big expenses, credit utilization, income, recurring payments, daily spending, uncategorized transfers, and Venmo activity. Budget and low-balance alerts are not enabled or implemented in this release.

Preferences and the most recent 200 alerts sync with the workspace. Big expenses default to 500 units of the reporting currency; credit utilization defaults to 30%. Both thresholds are editable. Alerts contain links to the relevant transaction or account on the web. iOS transaction alerts open transaction detail.

## Rules

- New posted transactions on an existing account can generate alerts. Pending rows wait until posted. Removed rows, future activity, transactions more than seven days old, disabled accounts, demo data, CSV imports, restores, and the initial Plaid history sync do not generate transaction alerts.
- Bank fees use Plaid's BANK_FEES category or specific fee descriptions. Income and transfers follow the effective transaction classification. Transfer review alerts require an unreviewed, unexcluded transfer in Other.
- Recurring payments follow explicitly labeled transactions, including Copilot recurring labels. Future payments match a labeled merchant on the same account. These labels can be edited in transaction detail; recurrence is not inferred from arbitrary repeated purchases.
- Credit utilization requires a known balance and positive credit limit. An alert occurs when an existing card moves from below to at or above the configured threshold, at most once per card per day. Plaid-reported limits are preserved. Manual card limits can be entered in account settings.
- A daily spending summary is eligible after 7 pm in the workspace time zone. It uses posted spending less refunds, excluding budget-excluded spending. Incomplete coverage is labeled. The worker does not replay summaries from previous days.
- Venmo alerts match new activity on a Venmo account or a transaction explicitly identifying Venmo. This does not establish a live Venmo connection by itself.

## Delivery

The authenticated web and native clients show an inbox and refresh while open. The server writes an outbox in the same transaction as each financial update. The existing cron worker also checks daily summaries and sends registered iPhone deliveries. Local server mode runs the same notification worker.

iPhone push requires a signed app with Push Notifications enabled for `org.gtfol.asset`, an Apple team, and an APNs signing key. Configure these server environment variables through the deployment's secret management:

- `APPLE_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_PRIVATE_KEY` (the complete private P8 key; never a public client variable)

`CRON_SECRET` and the existing one-minute worker must also remain configured. Debug builds register against APNs sandbox; release/TestFlight builds use production. iOS explicitly requests notification permission. The app reports unavailable delivery until the server credentials exist; organization membership alone does not activate push.

Push payloads contain only “New financial activity. Unlock Asset to review.” Amounts, merchants, accounts, and transaction identifiers stay out of the lock-screen payload. Devices belong to authenticated sessions; logout or session deletion removes registration. Read, disabled, stale, and removed inbox events are skipped before sending. Temporary failures have bounded retries, and collapse IDs reduce duplicate delivery after retry. Inbox/outbox/device tables retain row-level security with backend-only access. Delivery records expire after 30 days.

## Native privacy

Private workspaces require LocalAuthentication on initial opening and after every interruption/reopen. Touch ID or Face ID is used when available, with the system device passcode as fallback. If neither authentication method is available, the workspace stays locked. There is no bypass button.

A separate UIKit window covers the entire scene, including presented sheets, synchronously on `willResignActive`. A thick material and near-opaque background prevent readable financial details in switcher snapshots. The content is also hidden from accessibility while covered. Backgrounding invalidates an in-flight authentication, so delayed success cannot unlock a later session. The LocalAuthentication prompt's own activation events do not start duplicate prompts. Demo and welcome screens contain no private workspace and do not require device authentication.

Automated lifecycle checks cover initial locking, app-switcher transitions, prompt interruption, cancellation, backgrounding, stale callbacks, and workspace changes. Actual APNs delivery requires configured credentials and a signed device build; simulator compilation does not establish production delivery.
