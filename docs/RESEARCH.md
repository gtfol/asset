# Asset reference research

Accessed 2026-10-15. Repository `gtfol/asset` was public and empty; no existing code, stack, or repository instructions. User selected **web and native iOS** after this research. This record distinguishes observed product behavior from Asset's intentional changes. Images remain owned by their publishers; use them as references, not shipped app assets.

## Reference targets

Web: the coherent light desktop interface in Copilot's [official web guide](https://help.copilot.money/en/articles/11780342-copilot-money-for-web), updated August 20, 2026. Its screenshots contain December 2025 data; exact app build is unspecified. The [September 8 web FAQ](https://help.copilot.money/en/articles/13157382-web-faq) still lists Cash Flow, demo mode, category archiving, and name rules as missing. Asset implements these requested features as explicit extensions. Cash Flow uses the documented native composition inside the same web surfaces, rather than claiming an existing Copilot web Cash Flow screen.

iOS: current official iOS product/help images, with native navigation, sheets, touch charts, and Dynamic Type. Older native Cash Flow illustrations are labeled below. Do not import the desktop inspector layout wholesale onto the phone. Product identity is Asset; no Copilot branding, logos, bank logos, or proprietary assets are shipped.

## Inspected visual record

All links below were opened and the actual image pixels inspected in a browser at a 1280×720 viewport. Desktop sources are roughly 3K wide and were fitted to the viewport; the close-ups provide readable interaction details. Source article links are durable fallbacks for CDN links that may later require a refreshed signature.

| Area | Inspected reference image | Observation / implementation target |
| --- | --- | --- |
| Web dashboard | [Full screen](https://downloads.intercomcdn.com/i/o/gw2wbwl7/1884658624/0a5ef274373ea74384cf6d61b9a5/image.png) | Narrow persistent sidebar with grouped accounts, slim top header, two-column main grid. Spending and net worth charts occupy the first row; review rows and category bars sit beneath. Rounded white cards on a very light cool-gray canvas. Large values sit inside charts, not oversized disconnected KPI tiles. |
| Dashboard quick edit | [Category popover](https://downloads.intercomcdn.com/i/o/gw2wbwl7/1884657051/3bab05094f1df0a5118aa8d48220/image.png) | Date group, checkbox, merchant, pastel emoji category pill, right-aligned amount and blue review dot. Category popover contains search and compact results. Pagination and review button identify the visible scope. |
| Web transactions | [List and inspector](https://downloads.intercomcdn.com/i/o/gw2wbwl7/1884658495/b146d7e551a761e6cd27fddfbf55/image.png) | Three areas: navigation, dense list, right inspector. Search and add controls in header; filter chips then matching totals. Month heading and date groups. Account text is secondary beside merchant. Selected rows have pale blue fill. Inspector shows type, date, pending status, merchant, amount, account, category, and notes. |
| Bulk review | [Selected rows/action bar](https://downloads.intercomcdn.com/i/o/gw2wbwl7/1884653263/63bf5dbcea011ebb7703ef99cae8/image.png) | Checkmarks and selection fill align across whole rows. Floating bottom action bar gives an explicit selected count. Asset keeps selection limited to the visible filtered set and announces the action scope. |
| Accounts | [Overview and account inspector](https://downloads.intercomcdn.com/i/o/gw2wbwl7/1884658919/82cbf4cab9e9e97a5ab3717791b7/image.png) | Net worth chart above grouped account rows. Discreet range selector under chart. Account rows contain institution marker, name/mask, update age/manual label, delta badge, and balance. Right panel repeats account-specific history and related transactions. |
| Investments | [Overview and security inspector](https://downloads.intercomcdn.com/i/o/gw2wbwl7/1884656485/fb671cceac0351abef5ea9ea04e6/image.png) | Broad total-balance plot with ranges, followed by account rows. Security inspector separates ticker/name, price/timestamp, plot, metrics, and positions with quantity and valuation. Asset omits top movers and unsupported live estimates. |
| Categories | [Overview and detail](https://downloads.intercomcdn.com/i/o/gw2wbwl7/1884656865/6eb3be25c1829886e3b5d654d2c8/image.png) | Small multicolor ring between spent and budget totals. Expandable category groups, emoji/name, spent, slender horizontal progress, budget aligned in columns. Detail has spending history, budget reference, yearly metrics, and a compact spent/budget/left table. |
| Native Cash Flow | [Hover category breakdown](https://downloads.intercomcdn.com/i/o/1154010289/0f203319e96436fb962c2d02/image.png) | Native desktop illustration, 2024 data, current help article. Spending is stacked category-colored monthly bars, not a cumulative line. Hover emphasizes one month and fades others; popover lists category amounts and exact total. |
| Native Cash Flow | [Annual spend card](https://downloads.intercomcdn.com/i/o/1154011190/d3b2a10ca1726f5e490e6b84/image.png) | Title and view-more control, period, large actual value, comparison badge, then chart. Thin horizontal grid, separated stacked segments, latest-bar marker. Asset uses January–December and Month/Year controls only. |
| iOS Cash Flow | [Selected monthly net income](https://downloads.intercomcdn.com/i/o/1154016711/094de77bf5bdf63d400f5f9b/image.png) | Native phone illustration, 2024 data. Centered metric and period over green bars with selected bar darker. Asset replaces the displayed 999% against zero with a meaningful unavailable/no-baseline label. |
| iOS dashboard | [Official phone screenshot](https://framerusercontent.com/images/GS6bAr5Nqr5wILZXp19y1EglI8.png?height=1748&width=804) | Dark navy phone surface, horizontal section navigation, centered budget left above compact pace line, review card with two rows and a full-width reviewed action, then category rings. This is a phone reference, not the web theme. |
| iOS transaction | [Current detail sheet](https://downloads.intercomcdn.com/i/o/gw2wbwl7/2646670624/9868def38249a1aafd8704b24ee5/image.png) | September 2026 article, August 2026 sample data. Rounded native sheet with drag handle, centered date/name/value, original info, note, category pill and account card. Bottom actions include split. Omit goals/recurring controls. |
| Mac/iPad transaction | [Native wide detail](https://downloads.intercomcdn.com/i/o/gw2wbwl7/2646672978/c1bb6f14791d3f64c7779e7f01fd/image.png) | Supporting comparison only: top type/split actions, left-aligned fields, large notes area and similar transactions. Do not mix this with the iOS sheet or web inspector. |
| iOS categories | [Phone overview](https://downloads.intercomcdn.com/i/o/1170269952/ce2a324b3bd1112abe25a1e9/image.png), [metrics/ring detail](https://downloads.intercomcdn.com/i/o/1116568556/b53258856c71b9892163659c/image.png) | September 2024 example: blue header navigation, spent/budget metrics around a compact ring, grouped categories with slim green/amber progress and right-aligned amounts. Asset retains this hierarchy with gtfol surfaces and explicit status text. |
| Native accounts | [Assets and debts history](https://downloads.intercomcdn.com/i/o/gw2wbwl7/2201095644/5116cf72dcc97845ab4720d718c6/image.png) | Separate blue asset/orange debt history, compact range control, readable balances. Asset labels its net-worth series and separately reports asset/debt totals rather than implying debt adds to wealth. |
| Native investments | [Display options](https://downloads.intercomcdn.com/i/o/1278107724/422d42c1a2cc5a603149e5e64cf2/image.png), [allocation](https://downloads.intercomcdn.com/i/o/1293455512/9cbc494828bd570f8615e2459215/image.png), [wide account detail](https://downloads.intercomcdn.com/i/o/1293450947/89f0fcba59bc55b5690184ed8e23/image.png) | Account selection changes the scope; allocation uses colored proportions and labeled amounts; details separate quantity, valuation, and price. Unsupported quote history/return is omitted or explicitly unavailable in Asset. |

## Behavior and sources

### Dashboard

[Dashboard overview](https://help.copilot.money/en/articles/6045480-dashboard-tab-overview), April 14, 2026: solid line is actual spending; dotted line is ideal pace. Review opens editable details and saves changes. Trending budgets and net-this-month lead into their tabs. The source excludes expected recurring spending. Asset has no recurring engine: all eligible posted non-transfer spending is counted, refunds reduce spending, and explicit exclusions apply consistently. Asset adds a separate dashed estimate from MTD spend / elapsed days × days in month. Label it an estimate; disclose early-month/lumpy-spending limitations. Completed months show results without forecast.

### Transactions

[Transactions overview](https://help.copilot.money/en/articles/9554412-transactions-tab-overview), September 8, 2026: search, filters, manual entry, detail editing and splits. The web guide documents arrow navigation, X selection, R review, C category, and bulk actions. Asset supports merchant, account, category, date, type and review filtering; account context and review state remain visible. Safe cancel, integer split conservation, rule scopes, and preservation of manual edits are requirements rather than inferred behavior. No AI service is required.

### Categories

[Categories overview](https://help.copilot.money/en/articles/9504513-categories-tab-overview), April 29, 2025: spending versus budget at top, list organized by spend, nested groups and editable budget line in detail. Green indicates on pace, yellow/orange risk, red over budget; completed months use under/over results. Distinguish those statuses from stable identity colors on emoji badges and composition charts. Asset adds text labels. Budgets belong to individual months, so changing October must not rewrite September.

### Accounts

[Accounts overview](https://help.copilot.money/en/articles/6213732-accounts-tab-overview), April 14, 2026: chart timeframe also changes account comparisons; hover on desktop and press-and-hold on iOS expose points. Net-worth exclusion does not remove the account from grouped totals. Asset defines debt as a positive magnitude subtracted from assets and labels provenance/update age. No pre-link balances are fabricated. Account exclusion never changes spending eligibility.

### Investments

[Investments overview](https://help.copilot.money/en/articles/5377645-investments-tab-overview), April 14, 2026: account selection governs portfolio, accounts, allocation, holdings; detail separates price/equity/quantity. Deposits are excluded from return calculations. Copilot has a separate quote service and live-estimate behavior; Asset's Plaid holdings alone do not establish this. Asset displays price timestamps, missing/stale data, and unavailable return when cash-flow-adjusted history is insufficient. No benchmarks, trading, or top-mover feed is required.

### Cash Flow

[Cash Flow overview](https://help.copilot.money/en/articles/9682232-cash-flow-tab-overview), February 20, 2026: net income, spending, income cards, category-stacked spend bars, hover/tap drill-down and prior-period comparison. Only actual activity enters cash flow. Its excluded-spending option also affects Dashboard net-this-month. Asset narrows navigation to calendar Month/Year and matches partial periods. Missing history differs from zero; no infinite percentages. [Apple's Swift Charts case study](https://developer.apple.com/articles/copilot-money/) corroborates the native chart approach.

## Image search and walkthrough audit

Separate image searches performed for `Copilot Money Dashboard screen app`, `Copilot Money Transactions review detail screen`, `Copilot Money Categories budget screen`, `Copilot Money Accounts net worth screen`, `Copilot Money Investments holdings screen`, and `Copilot Money Cash Flow screen`. Search results contained Microsoft Copilot, unofficial redesigns, old light/dark iOS releases and unrelated products; these were excluded as implementation references. The official screenshots above supersede low-resolution mirrors.

Public walkthrough found: [official web walkthrough](https://www.youtube.com/watch?v=vLIsgqrF_y8), December 15, 2025; chapters Dashboard 0:37, Transactions 1:07, filters 1:26, Accounts 1:49, Investments 2:05, Categories 2:15. This video was located; do not claim it was fully watched. Supporting older [October 2024 iPad/Cash Flow review](https://9to5mac.com/2024/10/31/copilot-money-review-ipad-cash-flow-tags/) is dated and not used as the current web reference.

## Visual rules and known differences

The initial Copilot reference measurements suggested system sans-serif, 220–240 px sidebar, 48 px header, 13–14 px body, compact rows, and rounded cards. These are visual estimates, not proprietary tokens. **The user's subsequent direction supersedes the surface treatment:** use the `gtfol/ai` design language, with Copilot-like blue permitted. Asset therefore uses bundled Lato, white/black canvas, open sections, fine dividers, and blue `#3e6fc6` / `#8aadef`. Category identity colors, chart relationships, review rows, and inspector hierarchy remain grounded in the references. See [design decisions](DESIGN.md).

Asset intentionally omits recurring, upcoming, goals, referrals, AI assistant/insights and model categorization. It adds manual/CSV/backup workflows, safe unknown-data states, deterministic projection, accessible labels, responsive phone web layouts, and requested Cash Flow/rules/archive functions beyond current web parity. Copilot's desktop web FAQ says its mobile browser experience is not optimized; Asset's phone web layout is an explicit adaptation, separate from native iOS.

Native category/account/holdings references were inspected during implementation. Actual browser and simulator checks, screenshots, remaining limits, and feature status are recorded in [verification](VERIFICATION.md). No private account access was used.
