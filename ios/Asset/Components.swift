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
  static let assetBlue = Color(
    uiColor: UIColor {
      $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.54, green: 0.68, blue: 0.94, alpha: 1)
        : UIColor(red: 0.24, green: 0.44, blue: 0.78, alpha: 1)
    })
  static let assetText = adaptive(light: 0x111111, dark: 0xeeeeee)
  static let assetSecondary = adaptive(light: 0x686868, dark: 0xaaaaaa)
  static let assetDivider = adaptive(light: 0xe5e5e5, dark: 0x2c2c2c)
  static let assetError = adaptive(light: 0xac3030, dark: 0xef9696)
  static let assetBackground = adaptive(light: 0xffffff, dark: 0x000000)
  private static func adaptive(light: UInt, dark: UInt) -> Color {
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
struct Card<Content: View>: View {
  var title: String = ""
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if !title.isEmpty {
        Text(title).font(.custom("Lato-Regular", size: 17, relativeTo: .headline))
          .foregroundStyle(Color.assetSecondary)
      }
      content
    }.padding(.vertical, 16).frame(maxWidth: .infinity, alignment: .leading).overlay(
      alignment: .bottom
    ) { Rectangle().fill(Color.assetDivider).frame(height: 0.5) }
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
      .foregroundStyle(Color.assetSecondary)
      .frame(width: 24)
      .accessibilityHidden(true)
  }
}
struct CategoryBadge: View {
  let category: Row
  var body: some View {
    HStack(spacing: 8) {
      CategoryIcon(category: category)
      Text(category.text("name", "Other"))
    }.font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).padding(.vertical, 4)
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
          Text(title).font(.custom("Lato-Regular", size: 17, relativeTo: .headline))
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
        ContentUnavailableView(
          "History not available", systemImage: "chart.xyaxis.line",
          description: Text("Recorded snapshots will appear here.")
        ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).frame(height: 170)
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
          }.frame(height: 185).padding(.top, finalDay == nil ? 8 : 24)
      }
      if let p = selectedPoint ?? points.last {
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
  var body: some View {
    HStack(spacing: 12) {
      let c = store.category(id: tx.text("categoryId")) ?? Row()
      CategoryIcon(category: c)
      VStack(alignment: .leading, spacing: 4) {
        Text(tx.text("name")).font(.custom("Lato-Medium", size: 15, relativeTo: .subheadline))
        Text(store.account(id: tx.text("accountId"))?.text("name") ?? "Account")
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
