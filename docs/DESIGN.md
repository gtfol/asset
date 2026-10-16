# Asset interface direction

Asset uses the gtfol Freewrite/Capsule design language with a restrained blue accent for financial charts. The six finance workflows and their information hierarchy come from the inspected Copilot references; surfaces, typography, navigation, and controls follow the user's requested gtfol style.

- White canvas, near-black text, bundled Lato, thin dividers, and open sections.
- Main navigation is plain text. The selected section changes from secondary text to primary text, with no colored stripe, selected background, border, shadow, or pill.
- Blue `#3e6fc6` is used for financial plots and keyboard focus. Dark mode uses `#8aadef`. Reference and estimate lines use neutral colors and different dash patterns; multiseries charts use a restrained blue/slate scale.
- Primary actions use a neutral text-colored fill and contrasting label. Other actions favor plain text or simple line icons. Controls use a small 2px corner radius instead of rounded pills.
- Categories use semantic line icons: Lucide on web and monochrome SF Symbols on iOS. Emoji and colored icon badges are not part of the interface. Legacy category icon values resolve to a supported symbol rather than rendering raw emoji.
- Budget progress bars are neutral. Caution, error, and positive states include readable labels or values, so color is never the only signal.
- Interface text is generally 13–16px, with secondary labels at 12–13px. Native body, heading, and caption styles start at 15, 17, and 13pt and support Dynamic Type. Normal weight does most of the work; larger tabular numbers serve the financial data.
- Use 20px mobile gutters and 32px desktop gutters, with consistent spacing and approximately 44px touch targets. Content takes priority over decorative framing.
- Native controls, Dynamic Type, Swift Charts, and a horizontally accessible six-section navigator on iOS; sidebar and inspector on desktop, drawer and full-width editor on phone.
- The desktop sidebar is 224px wide. At 850px and below, navigation becomes a drawer and transaction editing uses the available screen width.
- No ornamental gradients, glass or blur effects, shadows, oversized hero headings, nested dashboard card framing, or remote font service. Native toolbar controls suppress the shared glass background where the platform permits it.
- Light/dark themes change controls and diagrams; reduced motion disables optional web transitions.

Web styles live in one canonical [stylesheet](../apps/web/src/style.css), including theme tokens and responsive rules. There is no second override stylesheet. Native shared colors, icons, and section treatments live in [Components.swift](../apps/ios/Asset/UI/Components.swift).

## Reference sources

Reviewed source on 2026-10-15 at these pinned revisions. Private source is not copied into this project.

- [Shared gtfol design standard](https://github.com/gtfol/ai/blob/4983727cd87fe92eda60ff36300e5a389cd4f00e/DESIGN.md): canvas, typography, spacing, accessible controls, and content-first hierarchy.
- [Freewrite navigation](https://github.com/gtfol/freewrite/blob/30a4f52acd177b31ca002f7c6ff85ca752109a66/apps/web/components/bottom-nav.tsx) and [native interface](https://github.com/gtfol/freewrite/blob/30a4f52acd177b31ca002f7c6ff85ca752109a66/apps/ios/Freewrite/UI/Interface.swift): quiet text controls, monochrome selection, and Lato type sizes.
- [Capsule web styles](https://github.com/gtfol/capsule/blob/cbce90163502a152306a4e6d9dc5ffaa61d50780/apps/web/src/app/globals.css) and [native interface](https://github.com/gtfol/capsule/blob/cbce90163502a152306a4e6d9dc5ffaa61d50780/apps/ios/CapsuleScan/UI/Interface.swift): open layouts, restrained dividers, neutral controls, and small button radii.
- [Motion native styles](https://github.com/gtfol/motion/blob/32e6a55ad16d403eab600427866b0c25c2d763d6/Vitals/UI/Style.swift) and [navigation](https://github.com/gtfol/motion/blob/32e6a55ad16d403eab600427866b0c25c2d763d6/Vitals/UI/RootView.swift): legible live numbers, text navigation, plain section headings, and explanations behind disclosure.
- [Flow home](https://github.com/gtfol/flow/blob/55970af4903a18bdb074b44565063be7666a4ef8/Flow/UI/HomeView.swift) and [styles](https://github.com/gtfol/flow/blob/55970af4903a18bdb074b44565063be7666a4ef8/Flow/UI/FlowStyle.swift): a focused primary task and accessible controls. Its meditation-specific atmosphere, serif headings, and rounded practice panel are not Asset styling rules.

## Deliberate differences from Copilot

The recurring engine and its special forecast adjustments are omitted. Asset counts all eligible posted spend, then provides its own disclosed extrapolation beside ideal budget pace. Only calendar Month/Year are available in Cash Flow. Unsupported portfolio return is shown as unavailable. The web Cash Flow composition adapts the inspected native source because the inspected Copilot web FAQ said it was not yet available on web. The gtfol visual treatment intentionally replaces Copilot's card surfaces and decorative styling while retaining useful row, inspector, budget, and chart relationships.
