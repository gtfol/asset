import SwiftUI

struct RootView: View {
  enum AddAction: String, Identifiable {
    case transaction, account, apple, bitcoin, holding, category
    var id: String { rawValue }
  }
  @EnvironmentObject var store: Store
  @Environment(\.scenePhase) var scenePhase
  @State var page = "Dashboard"
  @State var month = String(dateToday().prefix(7))
  @State var settings = false
  @State private var addAction: AddAction?
  @State var notifications = false
  let pages = ["Dashboard", "Transactions", "Accounts", "Investments", "Categories", "Cash Flow"]
  var body: some View {
    Group {
      if store.mode.isEmpty {
        VStack(spacing: 16) {
          Text("Your saved data could not be opened.")
          Text(store.error).foregroundStyle(Color.assetSecondary)
        }.padding(20)
      } else {
        NavigationStack {
          VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 8) {
                ForEach(pages, id: \.self) { title in
                  Button {
                    page = title
                  } label: {
                    Text(title)
                      .font(
                        .custom(
                          page == title ? "Lato-Medium" : "Lato-Regular", size: 15,
                          relativeTo: .subheadline)
                      )
                      .foregroundStyle(page == title ? Color.assetBlue : Color.assetSecondary)
                      .padding(.horizontal, 14)
                      .padding(.vertical, 9)
                      .background(page == title ? Color.assetBlueWash : Color.clear, in: Capsule())
                      .frame(minHeight: 44)
                      .contentShape(Rectangle())
                  }.buttonStyle(.plain)
                    .accessibilityAddTraits(page == title ? .isSelected : [])
                }
              }.padding(.horizontal, 20).padding(.bottom, 8)
            }.background(Color.assetBackground)
            Group {
              switch page {
              case "Transactions": TransactionsView()
              case "Accounts": AccountsView()
              case "Investments": InvestmentsView()
              case "Categories": CategoriesView(month: $month)
              case "Cash Flow": CashFlowView(month: $month)
              default: DashboardView(month: $month)
              }
            }
          }.background(Color.assetBackground).assetTitle(page == "Dashboard" ? "asset" : page)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.assetBackground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
              ToolbarItem(placement: .topBarLeading) {
                Button {
                  settings = true
                } label: {
                  Image(systemName: "gearshape")
                }.accessibilityLabel("Settings and connections").tint(.assetBlue)
              }.quietBackground()
              ToolbarItem(placement: .topBarTrailing) {
                Button {
                  notifications = true
                } label: {
                  Image(
                    systemName: store.row.object("notifications").rows("items").contains(where: {
                      !$0.flag("read")
                    }) ? "bell.badge" : "bell")
                }.accessibilityLabel("Notifications").tint(.assetBlue)
              }.quietBackground()
              ToolbarItem(placement: .topBarTrailing) {
                Menu {
                  Button("Add transaction") { addAction = .transaction }
                  Button("Add account") { addAction = .account }
                  Button("Connect Apple accounts") { addAction = .apple }
                  Button("Add Bitcoin wallet") { addAction = .bitcoin }
                  Button("Add holding") { addAction = .holding }
                  Button("Add category") { addAction = .category }
                } label: {
                  Image(systemName: "plus")
                }.accessibilityLabel("Add").tint(.assetBlue)
              }.quietBackground()
            }
            .sheet(isPresented: $settings) { SettingsView() }
            .sheet(isPresented: $notifications) { NotificationInbox() }
            .sheet(item: $addAction) { action in
              switch action {
              case .account: AccountForm()
              case .apple: AppleAccountSetupView()
              case .bitcoin: BitcoinWalletSetupView()
              case .category: CategoryForm()
              case .holding: HoldingForm()
              case .transaction: TransactionSetupView()
              }
            }
            .task(id: scenePhase) {
              while scenePhase == .active && !Task.isCancelled {
                await store.refresh()
                await store.refreshBitcoin()
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
              }
            }
        }
      }
    }.onReceive(NotificationCenter.default.publisher(for: .assetOpenNotifications)) { _ in
      notifications = true
    }
    .alert(
      "Asset",
      isPresented: Binding(get: { !store.error.isEmpty }, set: { if !$0 { store.error = "" } })
    ) {
      Button("OK") { store.error = "" }
    } message: {
      Text(store.error)
    }
  }
}
struct DashboardView: View {
  @EnvironmentObject var store: Store
  @Binding var month: String
  @State private var addAccount = false
  @State private var addBitcoin = false
  @State private var showEstimate = false
  var body: some View {
    let d = store.calculation("dashboard", [month])
    let w = store.calculation("netWorth")
    ScrollView {
      VStack(spacing: 16) {
        if store.accounts.isEmpty {
          VStack(alignment: .leading, spacing: 16) {
            Menu {
              Button("Manual account") { addAccount = true }
              Button("Bitcoin wallet") { addBitcoin = true }
            } label: {
              Text("Add an account")
            }
            .buttonStyle(AssetBorderButtonStyle())
            NavigationLink("Import transactions") { ImportView() }
              .frame(minHeight: 44)
          }.font(.custom("Lato-Regular", size: 15, relativeTo: .subheadline))
            .frame(maxWidth: .infinity, alignment: .leading)
            .sheet(isPresented: $addAccount) { AccountForm() }
            .sheet(isPresented: $addBitcoin) { BitcoinWalletSetupView() }
        } else {
          MonthPicker(month: $month)
          Card(title: "Spending this month", spacing: 12) {
            HStack(alignment: .top) {
              Metric(title: "Spent", value: money(d.data["spending"], store.currency))
              Spacer()
              Metric(
                title: "Left to spend", value: money(d.data["left"], store.currency),
                color: d.number("left") < 0 ? .assetAmber : .assetText)
            }
            Text(
              d.missing("budget")
                ? "No monthly budget set" : "\(money(d.data["budget"], store.currency)) budgeted"
            )
            .font(.custom("Lato-Regular", size: 12, relativeTo: .caption2)).foregroundStyle(
              Color.assetSecondary)
            HistoryChart(
              points: d.rows("points").filter { !$0.missing("actual") }.map {
                PlotPoint(
                  id: $0.integer("day"), label: $0.text("date"), value: $0.number("actual"),
                  ideal: $0.missing("ideal") ? nil : $0.number("ideal"))
              }, currency: store.currency, color: .assetBlue,
              forecast: d.missing("projection") ? nil : d.number("projection"),
              finalDay: d.integer("days"), budget: d.missing("budget") ? nil : d.number("budget"),
              height: 115, showsLatestValue: false)
            HStack {
              Text(
                d.missing("projection") ? "Actual · Budget pace" : "Actual · Budget pace · Estimate"
              )
              .font(.custom("Lato-Regular", size: 11, relativeTo: .caption2)).foregroundStyle(
                Color.assetSecondary)
              Spacer()
              Button {
                showEstimate = true
              } label: {
                Image(systemName: "info.circle")
              }
              .foregroundStyle(Color.assetBlue).frame(width: 44, height: 44)
              .accessibilityLabel("About spending calculations")
            }
            if !d.missing("paceDifference") || !d.missing("projection") {
              HStack(alignment: .top) {
                if !d.missing("paceDifference") {
                  Text(
                    "\(money(abs(d.number("paceDifference")),store.currency)) \(d.number("paceDifference") < 0 ? "over" : "under") pace"
                  )
                  .foregroundStyle(
                    d.number("paceDifference") < 0 ? Color.assetAmber : Color.assetGreen)
                }
                Spacer(minLength: 8)
                if !d.missing("projection") {
                  Text("Est. \(money(d.data["projection"], store.currency))").monospacedDigit()
                    .foregroundStyle(Color.assetSecondary)
                }
              }.font(.custom("Lato-Regular", size: 12, relativeTo: .caption2))
            }
          }
          DashboardReviewQueue().id(store.workspaceGeneration)
          Card(title: "Net worth") {
            Metric(title: "Assets minus debt", value: money(w.data["total"], store.currency))
            HistoryChart(
              points: historyPoints(w.rows("history").filter { $0.flag("complete") }),
              currency: store.currency)
            HStack {
              Metric(title: "Assets", value: money(w.data["assets"], store.currency))
              Spacer()
              Metric(title: "Debt", value: money(w.data["debt"], store.currency))
            }
          }
          Card(title: "Category budgets") {
            ForEach(Array(d.rows("categories").prefix(6))) { c in
              NavigationLink {
                CategoryDetail(categoryID: c.id, month: month)
              } label: {
                CategoryBudgetLine(category: c)
              }.buttonStyle(.plain)
            }
          }
          Card(title: "Net this month") {
            let n = d.object("netThisMonth")
            Metric(
              title: "Income − actual spending", value: money(n.data["net"], store.currency),
              color: n.number("net") >= 0 ? .assetText : .assetAmber)
            Text(
              "Transfers, card payments, and pending transactions are excluded. Budget-excluded spending follows the Cash Flow setting."
            ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
              Color.assetSecondary)
            NavigationLink("View cash flow") { CashFlowView(month: $month) }
          }
        }
      }.padding(20)
    }.refreshable { await store.refresh() }
      .alert("Spending calculations", isPresented: $showEstimate) {
        Button("Done", role: .cancel) {}
      } message: {
        Text(
          "Solid: actual spending. Dotted: ideal budget pace. Dashed: month-end estimate, calculated as actual spending × days in month ÷ days elapsed. Estimates require complete history, can change with uneven spending, and do not deduct future bills."
        )
      }
  }
}

struct DashboardReviewQueue: View {
  @EnvironmentObject var store: Store
  @State private var undoIDs: [String] = []
  @State private var working = false
  @State private var editing: Row?
  private var review: [Row] { store.transactions.filter { !$0.flag("reviewed") } }
  private var day: [Row] { review.filter { $0.text("date") == review.first?.text("date") } }
  private var visible: [Row] { Array(day.prefix(6)) }
  private var dayLabel: String {
    guard let date = day.first?.text("date") else { return "" }
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.timeZone = TimeZone(identifier: store.row.object("settings").text("timezone"))
    guard let value = formatter.date(from: date) else { return date }
    var calendar = Calendar.current
    calendar.timeZone = formatter.timeZone
    if calendar.isDateInToday(value) { return "So far today" }
    if calendar.isDateInYesterday(value) { return "Yesterday" }
    formatter.dateFormat = "EEEE, MMM d"
    return formatter.string(from: value)
  }
  var body: some View {
    VStack(spacing: 12) {
      HStack {
        Text("To review").font(.custom("Lato-Medium", size: 13, relativeTo: .caption))
        Text("\(review.count)").font(.custom("Lato-Regular", size: 12, relativeTo: .caption2))
        Spacer()
        NavigationLink {
          TransactionsView(initialReview: true)
        } label: {
          HStack(spacing: 4) {
            Text("View all")
            Image(systemName: "chevron.right").font(.system(size: 10))
          }
        }.font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).frame(minHeight: 44)
      }.foregroundStyle(Color.assetSecondary).padding(.horizontal, 4)
      Card {
        if visible.isEmpty {
          HStack(spacing: 14) {
            Image(systemName: "checkmark.circle").font(.system(size: 24)).foregroundStyle(
              Color.assetGreen)
            VStack(alignment: .leading, spacing: 5) {
              Text("All caught up").font(.custom("Lato-Medium", size: 15, relativeTo: .subheadline))
              Text("Your next transactions will appear here.").font(
                .custom("Lato-Regular", size: 13, relativeTo: .caption)
              ).foregroundStyle(Color.assetSecondary)
            }
          }.padding(.vertical, 8)
        } else {
          Text(dayLabel + (day.count > 6 ? " · \(visible.count) of \(day.count)" : ""))
            .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
              Color.assetSecondary
            )
            .frame(maxWidth: .infinity)
          VStack(spacing: 2) {
            ForEach(visible) { transaction in
              Button {
                editing = transaction
              } label: {
                HStack(spacing: 10) {
                  VStack(alignment: .leading, spacing: 5) {
                    Text(transaction.text("name")).lineLimit(1).foregroundStyle(Color.assetText)
                    HStack(spacing: 5) {
                      CategoryBadge(
                        category: store.categories.first(where: {
                          $0.id == transaction.text("categoryId")
                        }) ?? Row(["id": "other", "name": "Other"]))
                      if transaction.flag("pending") {
                        Text("Pending").font(
                          .custom("Lato-Regular", size: 11, relativeTo: .caption2)
                        ).foregroundStyle(Color.assetSecondary)
                      }
                    }
                  }
                  Spacer(minLength: 0)
                  Text(money(transaction.data["amount"], transaction.text("currency")))
                    .font(.custom("Lato-Medium", size: 14, relativeTo: .subheadline))
                    .monospacedDigit()
                    .foregroundStyle(
                      ["income", "refund"].contains(transaction.text("kind"))
                        ? Color.assetGreen : Color.assetText)
                  Circle().fill(Color.assetBlue).frame(width: 5, height: 5)
                }.frame(minHeight: 52).contentShape(Rectangle())
              }.buttonStyle(.plain).accessibilityIdentifier("review-open-\(transaction.id)")
            }
          }
          Button {
            commit(visible.map(\.id), reviewed: true)
          } label: {
            Label(working ? "Saving…" : "Mark as reviewed", systemImage: "checkmark").frame(
              maxWidth: .infinity)
          }.buttonStyle(AssetPrimaryButtonStyle(soft: true)).disabled(working || store.busy)
        }
      }
      if !undoIDs.isEmpty {
        HStack(spacing: 12) {
          Text("\(undoIDs.count) reviewed").foregroundStyle(Color.assetSecondary)
          Button("Undo") {
            let current = Set(store.transactions.filter { $0.flag("reviewed") }.map(\.id))
            commit(undoIDs.filter { current.contains($0) }, reviewed: false)
          }.disabled(working).frame(minHeight: 44).foregroundStyle(Color.assetBlue)
        }.font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
      }
    }.font(.custom("Lato-Regular", size: 14, relativeTo: .subheadline))
      .sheet(item: $editing) { TransactionDetailSheet(transaction: $0) }
  }
  private func commit(_ ids: [String], reviewed: Bool) {
    guard !working, !ids.isEmpty else { return }
    let generation = store.workspaceGeneration
    working = true
    Task { @MainActor in
      defer { working = false }
      do {
        try await store.command("transactions.review", ["ids": ids, "reviewed": reviewed])
        guard generation == store.workspaceGeneration else { return }
        undoIDs = reviewed ? ids : []
      } catch {
        if generation == store.workspaceGeneration { store.error = error.localizedDescription }
      }
    }
  }
}
