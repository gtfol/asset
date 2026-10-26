# Asset interface direction

The October 25 direction combines Asset's Lato typography and content hierarchy with a warmer, rounded financial interface. The user's latest Copilot screenshots supersede the earlier monochrome, square-control direction. Category symbols remain line icons, without emoji.

- Pale blue canvas `#f5f8fc`, white surfaces, navy text `#203354`, and blue actions `#2774dc`.
- Dark mode uses a deep blue canvas, lighter navy surfaces, and accessible blue/semantic accents.
- Cards have 22px corners. Primary actions and selected navigation use rounded pills; secondary controls use soft bordered corners. Shadows are subtle and decorative only.
- Categories have compact colored labels and Lucide/SF Symbols: green groceries/income, orange dining/coffee, teal transport/travel, violet shopping/education, rose entertainment/health, blue home/utilities.
- Lato text is mostly regular or medium at 13–16px (native 13–17pt). Tabular financial values have more emphasis; large headings do not compete with the data.
- Use 20px mobile gutters and 32px desktop gutters, at least 44px touch targets, responsive wrapping, Dynamic Type, readable dark appearance, and reduced-motion support.
- The original Asset logo is a rounded, open A with an upward curved crossbar, white and pale blue on blue. The web SVG, native header, and generated app icon share its geometry.
- Chart estimates remain visibly distinguished from recorded history. Color always accompanies a label or value.

## Dashboard transaction review

The dashboard presents the latest unreviewed day as a card, showing up to six transactions with merchant, category, amount, and unread dot. There are no selection checkboxes. **Mark as reviewed** reviews only the visible rows, then presents the remaining rows from that day or the next day. Undo restores the most recent batch. View all opens the unreviewed transaction list.

Tapping a transaction opens a rounded detail sheet on iPhone and phone web, with a centered modal on desktop. Merchant, amount, notes, category, account, and review action come first. Category selection is searchable. More details retains the full editing controls, including splits, transaction type, exclusions, and tags. Saving edits does not implicitly mark the item reviewed; the explicit review action runs only after edits succeed.

Merchant suggestions fill uncategorized spending using recognizable merchant patterns and existing categories. Explicit merchant rules take priority. The optional **Use this category next time** action saves or updates an exact merchant rule scoped to the same account. Imported categories, manual category edits, and splits are preserved. There is no external AI classifier or automatic rewrite of existing history.

Web styles live in [style.css](../apps/web/src/style.css). Shared native colors, symbols and cards live in [Components.swift](../apps/ios/Asset/UI/Components.swift).

## Reference sources

Reviewed source on 2026-10-15 at these pinned revisions. Private source is not copied into this project.

- [Shared gtfol design standard](https://github.com/gtfol/ai/blob/4983727cd87fe92eda60ff36300e5a389cd4f00e/DESIGN.md): canvas, typography, spacing, accessible controls, and content-first hierarchy.
- [Freewrite navigation](https://github.com/gtfol/freewrite/blob/30a4f52acd177b31ca002f7c6ff85ca752109a66/apps/web/components/bottom-nav.tsx) and [native interface](https://github.com/gtfol/freewrite/blob/30a4f52acd177b31ca002f7c6ff85ca752109a66/apps/ios/Freewrite/UI/Interface.swift): quiet text controls, monochrome selection, and Lato type sizes.
- [Capsule web styles](https://github.com/gtfol/capsule/blob/cbce90163502a152306a4e6d9dc5ffaa61d50780/apps/web/src/app/globals.css) and [native interface](https://github.com/gtfol/capsule/blob/cbce90163502a152306a4e6d9dc5ffaa61d50780/apps/ios/CapsuleScan/UI/Interface.swift): open layouts, restrained dividers, neutral controls, and small button radii.
- [Motion native styles](https://github.com/gtfol/motion/blob/32e6a55ad16d403eab600427866b0c25c2d763d6/Vitals/UI/Style.swift) and [navigation](https://github.com/gtfol/motion/blob/32e6a55ad16d403eab600427866b0c25c2d763d6/Vitals/UI/RootView.swift): legible live numbers, text navigation, plain section headings, and explanations behind disclosure.
- [Flow home](https://github.com/gtfol/flow/blob/55970af4903a18bdb074b44565063be7666a4ef8/Flow/UI/HomeView.swift) and [styles](https://github.com/gtfol/flow/blob/55970af4903a18bdb074b44565063be7666a4ef8/Flow/UI/FlowStyle.swift): a focused primary task and accessible controls. Its meditation-specific atmosphere, serif headings, and rounded practice panel are not Asset styling rules.

## Deliberate differences from Copilot

Asset uses the provided references for daily review, progressive details, and readable financial hierarchy. It has its own palette, original logo, line icons, typography, and layout. It does not claim Copilot's proprietary classifier, recurring forecast engine, or transaction audit. Existing calculations and record-level sync remain unchanged.
