# Bitcoin addresses

Signed-in web and iOS workspaces can track mainnet Bitcoin public addresses from **Accounts → Track Bitcoin address**. This is read-only. Never enter a private key, seed phrase, or extended private key. A receiving address is not an entire wallet: include any other receiving/change addresses you want counted. No Plaid Item or Plaid API credential is used.

The server sends each supplied public address to Blockstream's public Esplora API for confirmed balance and transfers. It uses Coinbase Exchange's public BTC-USD ticker and daily closing candles for USD valuation. No credentials are sent to either provider. Public addresses remain sensitive financial identifiers even though the blockchain is public; they are stored in the authenticated workspace and included in its backups. Stop tracking converts the account and saved values to manual records and removes its tracked address.

## Valuation and history

- Confirmed satoshis × BTC-USD price, rounded to USD cents with exact integer arithmetic. Pending incoming/outgoing transfers are shown separately and excluded from net worth.
- Prices refresh about every minute while a signed-in client is open and visible. Address balances refresh about every five minutes. This is periodic polling, not a streaming quote feed; closed apps retain the last saved values.
- Historical values use the confirmed balance at each UTC day's end and that day's closing price. Current holdings are never multiplied backwards across earlier dates. Price movements do not create income or spending transactions.
- Available Coinbase daily history starts July 20, 2015, as verified against the public API. There is no rolling two-year cutoff. The initial fetch covers 2015 onward in batches below Coinbase's 300-candle limit; the shared database cache fetches only new closed days thereafter. Missing price days remain unavailable.
- Each sync reads at most 500 confirmed transfers to bound external work within the hosted request deadline. If an address has more activity, the oldest reliable range is explicitly labeled partial. This is an activity limit, not an age limit. An address with a single receipt six years ago has six years of historical valuations. High-volume addresses require a future resumable background backfill.
- Blockchain transfers do not establish purchase cost or ownership. Cost basis and portfolio return remain unavailable when not explicitly recorded. Exchange custody history before a withdrawal is not visible at the receiving address.

The account's balance and BTC holding are the same asset. Net worth counts the account once. Manual account/holding edits cannot overwrite tracked balances or prices. Renaming and including/excluding the account from net worth remain available.

## Operations

Migration `007_bitcoin_market.sql` creates a shared public-price cache with row-level security enabled. The existing server migration mechanism applies it on startup; no new environment variable or paid API account is required. Requests use fixed HTTPS provider hosts, bounded timeouts, mainnet address checksums, authenticated ownership, session-change guards, and workspace revision checks. Provider failures retain saved values and surface an error.

Hosted workspaces share Vercel's existing response-size limit. Up to 20 addresses are accepted subject to workspace record/size limits. For large portfolios, server-side history paging and resumable address backfills are needed before increasing these limits.

References: [Esplora API](https://github.com/Blockstream/esplora/blob/master/API.md), [Coinbase candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles), [Bitcoin address checksums](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki).
