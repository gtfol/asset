import Charts
import SwiftUI

extension Color {
  init(hex: String) {
    let value =
      UInt64(hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted), radix: 16) ?? 0x8296ac
    self.init(
      .sRGB, red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255,
      blue: Double(value & 255) / 255, opacity: 1)
  }
  static let assetGreen = Color(
    uiColor: UIColor {
      $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.60, green: 0.78, blue: 0.64, alpha: 1)
        : UIColor(red: 0.21, green: 0.44, blue: 0.27, alpha: 1)
    })
  static let assetAmber = Color(
    uiColor: UIColor {
      $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.83, green: 0.70, blue: 0.42, alpha: 1)
        : UIColor(red: 0.52, green: 0.38, blue: 0.11, alpha: 1)
    })
  static let assetBlue = adaptive(light: 0x2774dc, dark: 0x83b5ff)
  static let assetText = adaptive(light: 0x203354, dark: 0xe5edfa)
  static let assetSecondary = adaptive(light: 0x75839a, dark: 0xa1b0c7)
  static let assetDivider = adaptive(light: 0xe2e8f1, dark: 0x2b3b51)
  static let assetError = adaptive(light: 0xac3030, dark: 0xef9696)
  static let assetBackground = adaptive(light: 0xf5f8fc, dark: 0x101927)
  static let assetSurface = adaptive(light: 0xffffff, dark: 0x1a2638)
  static let assetBlueWash = adaptive(light: 0xeaf2ff, dark: 0x233c60)
  static func adaptive(light: UInt, dark: UInt) -> Color {
    Color(
      uiColor: UIColor { traits in
        let value = traits.userInterfaceStyle == .dark ? dark : light
        return UIColor(
          red: CGFloat((value >> 16) & 255) / 255,
          green: CGFloat((value >> 8) & 255) / 255,
          blue: CGFloat(value & 255) / 255, alpha: 1)
      })
  }
}
struct AccountCard: View {
  @EnvironmentObject var store: Store
  let account: Row
  var body: some View {
    let identity = AccountIdentity(account, connections: store.connections)
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 6) {
        Text(identity.mark).font(.custom("Lato-Medium", size: 13, relativeTo: .caption))
          .frame(width: 23, height: 23).background(.white.opacity(0.18), in: RoundedRectangle(cornerRadius: 7))
        Text(identity.name).font(.custom("Lato-Medium", size: 12, relativeTo: .caption))
          .lineLimit(2).fixedSize(horizontal: false, vertical: true)
      }
      HStack(alignment: .bottom, spacing: 5) {
        Text(account.text("name")).font(.custom("Lato-Medium", size: 13, relativeTo: .caption))
          .lineLimit(2).fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        if !account.text("mask").isEmpty {
          Text(account.text("mask")).font(.custom("Lato-Regular", size: 11, relativeTo: .caption2))
            .monospacedDigit().fixedSize()
        }
      }
    }.padding(12).frame(maxWidth: .infinity, minHeight: 88, alignment: .leading)
      .foregroundStyle(.white)
      .background(LinearGradient(colors: [Color(hex: identity.color), Color(hex: identity.color).opacity(0.86)],
        startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 14))
      .accessibilityElement(children: .combine)
  }
}
struct AssetBorderButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) var isEnabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.padding(.horizontal, 16).frame(minHeight: 44)
      .foregroundStyle(Color.assetBlue)
      .background(
        configuration.isPressed ? Color.assetBlueWash : Color.assetSurface,
        in: RoundedRectangle(cornerRadius: 14)
      )
      .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.assetDivider, lineWidth: 1))
      .opacity(isEnabled ? 1 : 0.5)
  }
}
struct AssetPrimaryButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) var isEnabled
  var soft = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.custom("Lato-Medium", size: 15, relativeTo: .subheadline))
      .padding(.horizontal, 18).frame(minHeight: 48)
      .foregroundStyle(soft ? Color.assetBlue : Color.white)
      .background(soft ? Color.assetBlueWash : Color(hex: "2774dc"), in: Capsule())
      .opacity(!isEnabled ? 0.45 : configuration.isPressed ? 0.7 : 1)
  }
}
struct AssetMark: View {
  var body: some View {
    GeometryReader { geometry in
      let scale = geometry.size.width / 256
      let symbolTransform = CGAffineTransform(
        a: scale * 1.08, b: 0, c: 0, d: scale * 1.08,
        tx: scale * -10.24, ty: scale * -8.08)
      ZStack {
        RoundedRectangle(cornerRadius: scale * 58, style: .circular)
          .fill(LinearGradient(colors: [Color(hex: "3989f4"), Color(hex: "2265d5")],
                               startPoint: .topLeading, endPoint: .bottomTrailing))
        // Tangent circular corners match public/icon.svg and scripts/render-icon.swift.
        Path { p in
          p.move(to: CGPoint(x: 124.6575, y: 81.3370))
          p.addArc(tangent1End: CGPoint(x: 128, y: 80), tangent2End: CGPoint(x: 208, y: 112), radius: 9)
          p.addArc(tangent1End: CGPoint(x: 208, y: 112), tangent2End: CGPoint(x: 128, y: 144), radius: 9)
          p.addArc(tangent1End: CGPoint(x: 128, y: 144), tangent2End: CGPoint(x: 48, y: 112), radius: 9)
          p.addArc(tangent1End: CGPoint(x: 48, y: 112), tangent2End: CGPoint(x: 128, y: 80), radius: 9)
          p.closeSubpath()
        }.applying(symbolTransform).fill(.white)
        Path { p in
          p.move(to: CGPoint(x: 68, y: 144))
          p.addLine(to: CGPoint(x: 122, y: 165.6))
          p.addQuadCurve(to: CGPoint(x: 134, y: 165.6), control: CGPoint(x: 128, y: 168))
          p.addLine(to: CGPoint(x: 188, y: 144))
        }.applying(symbolTransform)
        .stroke(
          Color(hex: "c7efff"),
          style: StrokeStyle(lineWidth: scale * 1.08 * 11, lineCap: .round, lineJoin: .round))
      }
    }.accessibilityHidden(true)
  }
}
struct AssetEmptyState: View {
  let title: String
  let message: String
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.custom("Lato-Regular", size: 15, relativeTo: .subheadline))
        .foregroundStyle(Color.assetText)
      Text(message).font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
        .foregroundStyle(Color.assetSecondary).lineSpacing(3)
    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 24)
  }
}
struct Card<Content: View>: View {
  var title: String = ""
  var spacing: CGFloat = 16
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: spacing) {
      if !title.isEmpty {
        Text(title).font(.custom("Lato-Medium", size: 13, relativeTo: .caption))
          .foregroundStyle(Color.assetSecondary)
      }
      content
    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
      .background(Color.assetSurface, in: RoundedRectangle(cornerRadius: 22))
      .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.assetDivider, lineWidth: 0.7))
  }
}
struct Metric: View {
  let title: String
  let value: String
  var color: Color = .assetText
  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
        Color.assetSecondary)
      Text(value).font(.custom("Lato-Medium", size: 24, relativeTo: .title2)).monospacedDigit()
        .foregroundStyle(color).lineLimit(1).minimumScaleFactor(0.85)
    }.accessibilityElement(children: .combine)
  }
}
enum CategorySymbol {
  static let keys = [
    "home", "groceries", "restaurants", "coffee", "transport", "shopping", "health", "fun",
    "travel", "income", "utilities", "education", "other",
  ]
  static func key(_ category: Row) -> String {
    let saved = category.text("icon")
    if keys.contains(saved) { return saved }
    return keys.contains(category.id) ? category.id : "other"
  }
  static func name(_ key: String) -> String {
    switch key {
    case "home": "house"
    case "groceries": "basket"
    case "restaurants": "fork.knife"
    case "coffee": "cup.and.saucer"
    case "transport": "car"
    case "shopping": "bag"
    case "health": "heart"
    case "fun": "ticket"
    case "travel": "airplane"
    case "income": "arrow.down.left"
    case "utilities": "bolt"
    case "education": "book"
    default: "square.grid.2x2"
    }
  }
  static func color(_ category: Row) -> Color {
    switch key(category) {
    case "groceries", "income": Color.adaptive(light: 0x258465, dark: 0x76c7a9)
    case "restaurants", "coffee": Color.adaptive(light: 0xb45f25, dark: 0xeab07d)
    case "transport", "travel": Color.adaptive(light: 0x247e9b, dark: 0x77c4dc)
    case "shopping", "education": Color.adaptive(light: 0x8262be, dark: 0xbba1e7)
    case "fun", "health": Color.adaptive(light: 0xbc507e, dark: 0xe394b4)
    case "home", "utilities": Color.assetBlue
    default: Color.assetSecondary
    }
  }
  static func label(_ key: String) -> String {
    switch key {
    case "transport": "Transportation"
    case "fun": "Entertainment"
    default: key.capitalized
    }
  }
}
struct CategoryIcon: View {
  let category: Row
  var body: some View {
    Image(systemName: CategorySymbol.name(CategorySymbol.key(category)))
      .font(.system(size: 16, weight: .regular))
      .symbolRenderingMode(.monochrome)
      .foregroundStyle(CategorySymbol.color(category))
      .frame(width: 16)
      .accessibilityHidden(true)
  }
}
struct CategoryBadge: View {
  let category: Row
  var body: some View {
    HStack(spacing: 5) {
      CategoryIcon(category: category)
      Text(category.text("name", "Other")).lineLimit(1)
    }.font(.custom("Lato-Medium", size: 11, relativeTo: .caption2))
      .foregroundStyle(CategorySymbol.color(category)).padding(.horizontal, 9).padding(.vertical, 5)
      .background(CategorySymbol.color(category).opacity(0.10), in: Capsule())
  }
}
struct StatusLabel: View {
  let text: String
  private var color: Color {
    let value = text.lowercased()
    if ["over budget", "at risk", "stale", "incomplete", "error", "reauth"].contains(
      where: value.contains)
    {
      return .assetAmber
    }
    return .assetSecondary
  }
  var body: some View {
    Text(text.replacingOccurrences(of: "_", with: " "))
      .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
      .foregroundStyle(color)
  }
}
extension View {
  func assetTitle(_ title: String) -> some View {
    navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(Color.assetBackground, for: .navigationBar)
      .toolbarBackground(.visible, for: .navigationBar)
      .toolbar {
        ToolbarItem(placement: .principal) {
          HStack(spacing: 8) {
            if title == "asset" { AssetMark().frame(width: 26, height: 26) }
            Text(title).font(.custom("Lato-Medium", size: 17, relativeTo: .headline))
              .foregroundStyle(Color.assetText)
          }
        }.quietBackground()
      }
  }
}
extension ToolbarContent {
  @ToolbarContentBuilder func quietBackground() -> some ToolbarContent {
    if #available(iOS 26.0, *) { sharedBackgroundVisibility(.hidden) } else { self }
  }
}
struct MonthPicker: View {
  @EnvironmentObject var store: Store
  @Binding var month: String
  var body: some View {
    HStack {
      Button {
        shift(-1)
      } label: {
        Image(systemName: "chevron.left").frame(width: 44, height: 44)
      }.accessibilityLabel("Previous month")
      Text(monthLabel).font(.custom("Lato-Medium", size: 15, relativeTo: .subheadline)).frame(
        maxWidth: .infinity)
      Button {
        shift(1)
      } label: {
        Image(systemName: "chevron.right").frame(width: 44, height: 44)
      }.accessibilityLabel("Next month")
    }.buttonStyle(.plain).foregroundStyle(Color.assetText)
  }
  var monthLabel: String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM"
    guard let d = f.date(from: month) else { return month }
    f.dateFormat = "MMMM yyyy"
    return f.string(from: d)
  }
  func shift(_ n: Int) {
    if let value = try? store.engine.call("shiftMonth", [month, n]) as? String { month = value }
  }
}
struct PlotPoint: Identifiable {
  let id: Int
  let label: String
  let value: Double
  var ideal: Double? = nil
}
struct HistoryChart: View {
  let points: [PlotPoint]
  var currency = "USD"
  var color: Color = .assetBlue
  var forecast: Double? = nil
  var finalDay: Int? = nil
  var budget: Double? = nil
  var height: CGFloat = 185
  var showsLatestValue = true
  @State private var selection: Int?
  private var yDomain: ClosedRange<Double> {
    let values =
      points.map(\.value) + points.compactMap(\.ideal) + [forecast, budget].compactMap { $0 }
    return (min(0, values.min() ?? 0) / 100 * 1.1)...(max(100, values.max() ?? 100) / 100 * 1.12)
  }
  private var ticks: [Int] {
    guard let first = points.first, let last = points.last else { return [] }
    return Array(Set([first.id, (first.id + last.id) / 2, last.id, finalDay ?? last.id])).sorted()
  }
  private func label(_ id: Int) -> String {
    if let point = points.first(where: { $0.id == id }) { return String(point.label.suffix(5)) }
    return points.first.map { String($0.label.dropLast(2).suffix(3)) + String(format: "%02d", id) }
      ?? ""
  }
  var body: some View {
    VStack(spacing: 8) {
      if points.isEmpty {
        AssetEmptyState(
          title: "No history yet", message: "Recorded balances will appear here.")
      } else {
        Chart {
          ForEach(points) { p in
            LineMark(
              x: .value("Period", p.id), y: .value("Actual", p.value / 100),
              series: .value("Series", "Actual")
            ).foregroundStyle(color).lineStyle(StrokeStyle(lineWidth: 2.5))
            if points.count == 1 {
              PointMark(x: .value("Period", p.id), y: .value("Actual", p.value / 100))
                .foregroundStyle(color)
            }
            if let ideal = p.ideal {
              LineMark(
                x: .value("Period", p.id), y: .value("Budget pace", ideal / 100),
                series: .value("Series", "Budget pace")
              ).foregroundStyle(Color.assetSecondary).lineStyle(
                StrokeStyle(lineWidth: 1.2, dash: [4, 4]))
            }
          }
          if let last = points.last, let finalDay, let budget, let ideal = last.ideal {
            LineMark(
              x: .value("Period", last.id), y: .value("Budget pace", ideal / 100),
              series: .value("Series", "Budget pace")
            ).foregroundStyle(Color.assetSecondary).lineStyle(
              StrokeStyle(lineWidth: 1.2, dash: [4, 4]))
            LineMark(
              x: .value("Period", finalDay), y: .value("Budget pace", budget / 100),
              series: .value("Series", "Budget pace")
            ).foregroundStyle(Color.assetSecondary).lineStyle(
              StrokeStyle(lineWidth: 1.2, dash: [4, 4]))
          }
          if let last = points.last, finalDay != nil, last.label == dateToday() {
            RuleMark(x: .value("Today", last.id)).foregroundStyle(Color.assetSecondary.opacity(0.3))
              .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3])).annotation(position: .top) {
                Text("Today").font(.custom("Lato-Regular", size: 12, relativeTo: .caption2))
              }
          }
          if let last = points.last, let forecast, let finalDay {
            LineMark(
              x: .value("Period", last.id), y: .value("Projection", last.value / 100),
              series: .value("Series", "Projection")
            ).foregroundStyle(Color.assetSecondary).lineStyle(
              StrokeStyle(lineWidth: 2, dash: [5, 5]))
            LineMark(
              x: .value("Period", finalDay), y: .value("Projection", forecast / 100),
              series: .value("Series", "Projection")
            ).foregroundStyle(Color.assetSecondary).lineStyle(
              StrokeStyle(lineWidth: 2, dash: [5, 5]))
          }
          if let selection,
            let p = points.min(by: { abs($0.id - selection) < abs($1.id - selection) })
          {
            RuleMark(x: .value("Selected", p.id))
              .foregroundStyle(Color.assetSecondary)
              .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            PointMark(x: .value("Period", p.id), y: .value("Actual", p.value / 100))
              .foregroundStyle(color)
          }
        }.chartYScale(domain: yDomain)
          .chartOverlay { proxy in
            GeometryReader { geometry in
              if let plotFrame = proxy.plotFrame {
                let plot = geometry[plotFrame]
                Rectangle().fill(.clear).contentShape(Rectangle())
                  .frame(width: plot.width, height: plot.height)
                  .simultaneousGesture(
                    SpatialTapGesture().onEnded { gesture in
                      select(atX: gesture.location.x, proxy: proxy)
                    }
                  )
                  .simultaneousGesture(
                    DragGesture(minimumDistance: 12).onChanged { gesture in
                      guard abs(gesture.translation.width) > abs(gesture.translation.height) else {
                        return
                      }
                      select(atX: gesture.location.x, proxy: proxy)
                    }
                  )
                  .position(x: plot.midX, y: plot.midY)
                  .accessibilityHidden(true)
              }
            }
          }
          .chartXScale(range: .plotDimension(padding: 16)).chartXAxis {
            AxisMarks(values: ticks) { value in
              if let id = value.as(Int.self) {
                AxisValueLabel(label(id))
              }
            }
          }.chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
              AxisGridLine()
              AxisValueLabel {
                if let n = value.as(Double.self) {
                  Text(n.formatted(.number.notation(.compactName))).font(
                    .custom("Lato-Regular", size: 12, relativeTo: .caption2))
                }
              }
            }
          }.frame(height: height).padding(.top, finalDay == nil ? 8 : 24)
      }
      if let p = selectedPoint ?? (showsLatestValue ? points.last : nil) {
        Text(
          "\(selectedPoint == nil ? "Latest" : "Selected"): \(p.label) · \(money(p.value,currency))"
        ).font(
          .custom("Lato-Regular", size: 12, relativeTo: .caption2)
        ).foregroundStyle(selectedPoint == nil ? Color.assetSecondary : Color.assetText)
      }
    }.accessibilityElement(children: .combine).accessibilityLabel(
      "Recorded history. \(points.map{"\($0.label), \(money($0.value,currency))"}.joined(separator:"; "))"
    ).onChange(of: points.map(\.label)) { _, _ in selection = nil }
  }
  private var selectedPoint: PlotPoint? {
    guard let selection else { return nil }
    return points.first { $0.id == selection }
  }
  private func select(atX position: CGFloat, proxy: ChartProxy) {
    guard let value = proxy.value(atX: position, as: Int.self),
      let nearest = points.min(by: { abs($0.id - value) < abs($1.id - value) })
    else { return }
    selection = nearest.id
  }
}
struct RangePicker: View {
  @Binding var range: String
  var body: some View {
    HStack(spacing: 0) {
      ForEach(["1M", "3M", "6M", "1Y", "ALL"], id: \.self) { option in
        Button {
          range = option
        } label: {
          Text(option)
            .font(
              .custom(
                range == option ? "Lato-Medium" : "Lato-Regular", size: 13, relativeTo: .caption)
            )
            .foregroundStyle(range == option ? Color.assetText : Color.assetSecondary)
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
          .accessibilityLabel("History: \(option)")
          .accessibilityAddTraits(range == option ? .isSelected : [])
      }
    }
  }
}
func historyPoints(_ rows: [Row], key: String = "value", range: String = "ALL") -> [PlotPoint] {
  let months = ["1M": 1, "3M": 3, "6M": 6, "1Y": 12][range]
  let cutoff =
    months.flatMap { Calendar.current.date(byAdding: .month, value: -$0, to: Date()) }.map {
      let f = DateFormatter()
      f.dateFormat = "yyyy-MM-dd"
      return f.string(from: $0)
    } ?? "0000-01-01"
  return rows.filter { $0.text("date") >= cutoff }.sorted { $0.text("date") < $1.text("date") }
    .enumerated().map {
      PlotPoint(id: $0.offset, label: $0.element.text("date"), value: $0.element.number(key))
    }
}
struct TransactionLine: View {
  @EnvironmentObject var store: Store
  let tx: Row
  var showCategory = false
  var body: some View {
    HStack(spacing: 12) {
      let c = store.category(id: tx.text("categoryId")) ?? Row()
      CategoryIcon(category: c)
      VStack(alignment: .leading, spacing: 4) {
        Text(tx.text("name")).font(.custom("Lato-Regular", size: 15, relativeTo: .subheadline))
        Text(
          (store.account(id: tx.text("accountId"))?.text("name") ?? "Account")
            + (showCategory ? " · \(c.text("name", "Other"))" : "")
        )
        .font(.custom("Lato-Regular", size: 12, relativeTo: .caption2)).foregroundStyle(
          Color.assetSecondary)
        if tx.flag("pending") || tx.flag("excluded") {
          Text(tx.flag("pending") ? "Pending" : "Budget excluded").font(
            .custom("Lato-Regular", size: 12, relativeTo: .caption2)
          ).foregroundStyle(Color.assetSecondary)
        }
      }
      Spacer(minLength: 4)
      VStack(alignment: .trailing, spacing: 5) {
        Text(
          ((["income", "refund"].contains(tx.text("kind"))) ? "+" : "")
            + money(tx.data["amount"], tx.text("currency", "USD"))
        ).font(
          .custom("Lato-Regular", size: 15, relativeTo: .subheadline)
        ).monospacedDigit().foregroundStyle(
          Color.assetText)
        if !tx.flag("reviewed") {
          Circle().fill(Color.assetSecondary).frame(width: 6, height: 6).accessibilityLabel(
            "To review")
        }
      }
    }.padding(.vertical, 6).accessibilityElement(children: .combine)
  }
}
