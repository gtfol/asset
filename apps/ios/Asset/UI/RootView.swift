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
              HStack(spacing: 24) {
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
                      .foregroundStyle(page == title ? Color.assetText : Color.assetSecondary)
                      .frame(minHeight: 44)
                      .contentShape(Rectangle())
                  }.buttonStyle(.plain)
                    .accessibilityAddTraits(page == title ? .isSelected : [])
                }
              }.padding(.horizontal, 20).padding(.bottom, 8)
            }.background(Color(uiColor: .systemBackground))
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
                }.accessibilityLabel("Settings and connections").tint(.assetText)
              }.quietBackground()
              ToolbarItem(placement: .topBarTrailing) {
                Button {
                  notifications = true
                } label: {
                  Image(
                    systemName: store.row.object("notifications").rows("items").contains(where: {
                      !$0.flag("read")
                    }) ? "bell.badge" : "bell")
                }.accessibilityLabel("Notifications").tint(.assetText)
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
                }.accessibilityLabel("Add").tint(.assetText)
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
            } label: { Text("Add an account") }
              .buttonStyle(AssetBorderButtonStyle())
            NavigationLink("Import transactions") { ImportView() }
              .frame(minHeight: 44)
          }.font(.custom("Lato-Regular", size: 15, relativeTo: .subheadline))
            .frame(maxWidth: .infinity, alignment: .leading)
            .sheet(isPresented: $addAccount) { AccountForm() }
            .sheet(isPresented: $addBitcoin) { BitcoinWalletSetupView() }
        } else {
        MonthPicker(month: $month)
        Card(title: "Spending this month") {
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
          .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
            Color.assetSecondary)
          HistoryChart(
            points: d.rows("points").filter { !$0.missing("actual") }.map {
              PlotPoint(
                id: $0.integer("day"), label: $0.text("date"), value: $0.number("actual"),
                ideal: $0.missing("ideal") ? nil : $0.number("ideal"))
            }, currency: store.currency,
            color: .assetBlue,
            forecast: d.missing("projection") ? nil : d.number("projection"),
            finalDay: d.integer("days"), budget: d.missing("budget") ? nil : d.number("budget"))
          Text(
            d.missing("projection")
              ? "Solid: actual · Dotted: ideal budget pace"
              : "Solid: actual · Dotted: ideal pace · Dashed: estimate"
          )
          .font(.custom("Lato-Regular", size: 12, relativeTo: .caption2)).foregroundStyle(
            Color.assetSecondary)
          if !d.missing("paceDifference") {
            Text(
              "\(money(abs(d.number("paceDifference")),store.currency)) \(d.number("paceDifference")<0 ? "above" : "below") budget pace"
            ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
              d.number("paceDifference") < 0 ? Color.assetAmber : Color.assetSecondary)
          }
          if !d.flag("historical") {
            HStack {
              Text("Month-end projection").font(
                .custom("Lato-Regular", size: 13, relativeTo: .caption))
              Spacer()
              Text(money(d.data["projection"], store.currency)).font(
                .custom("Lato-Medium", size: 15, relativeTo: .subheadline)
              ).monospacedDigit()
            }
          }
          if !d.flag("historical") && d.flag("complete") {
            DisclosureGroup("About this estimate") {
              Text(
                "Actual spending × days in month ÷ days elapsed. Early-month or uneven spending can distort the estimate. Expected future bills are not deducted."
              )
              .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
              .foregroundStyle(Color.assetSecondary)
            }.font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
          } else if !d.flag("historical") {
            Text("Projection unavailable until this month’s history is complete.")
              .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
              .foregroundStyle(Color.assetSecondary)
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
  }
}

struct DashboardReviewQueue: View {
  @EnvironmentObject var store: Store
  @State private var selected = Set<String>()
  @State private var undoIDs: [String] = []
  @State private var working = false
  @State private var editing: Row?
  private var review: [Row] { store.transactions.filter { !$0.flag("reviewed") } }
  private var visible: [Row] { Array(review.prefix(6)) }
  private var chosen: [String] { visible.filter { selected.contains($0.id) }.map(\.id) }
  var body: some View {
    Card {
      HStack {
        Text("To review · \(review.count)")
          .font(.custom("Lato-Regular", size: 17, relativeTo: .headline))
          .foregroundStyle(Color.assetSecondary)
        Spacer()
        NavigationLink("View all") { TransactionsView(initialReview: true) }
          .frame(minHeight: 44)
      }
      if visible.isEmpty {
        Text("All caught up.").foregroundStyle(Color.assetSecondary).padding(.vertical, 12)
      }
      ForEach(Array(visible.enumerated()), id: \.element.id) { index, transaction in
        if index == 0 || visible[index - 1].text("date") != transaction.text("date") {
          Text(transaction.text("date"))
            .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
            .foregroundStyle(Color.assetSecondary).padding(.top, 8)
        }
        HStack(spacing: 4) {
          Button {
            if selected.contains(transaction.id) { selected.remove(transaction.id) }
            else { selected.insert(transaction.id) }
          } label: {
            Image(systemName: selected.contains(transaction.id) ? "checkmark.square" : "square")
              .frame(width: 44, height: 44)
          }.accessibilityLabel("Select \(transaction.text("name")) for review")
            .accessibilityIdentifier("review-select-\(transaction.id)")
            .accessibilityValue(selected.contains(transaction.id) ? "Selected" : "Not selected")
            .disabled(working)
          Button { editing = transaction } label: { TransactionLine(tx: transaction, showCategory: true) }
            .frame(minHeight: 44).buttonStyle(.plain)
            .accessibilityIdentifier("review-open-\(transaction.id)")
        }
        Divider()
      }
      if !visible.isEmpty {
        ViewThatFits(in: .horizontal) {
          HStack { reviewCount; Spacer(); reviewButton }
          VStack(alignment: .leading, spacing: 8) { reviewCount; reviewButton }
        }
        if !chosen.isEmpty { Button("Clear selection") { selected = [] }.frame(minHeight: 44) }
      }
      if !undoIDs.isEmpty {
        HStack {
          Text("\(undoIDs.count) reviewed").foregroundStyle(Color.assetSecondary)
          Button("Undo") {
            let current = Set(store.transactions.filter { $0.flag("reviewed") }.map(\.id))
            commit(undoIDs.filter { current.contains($0) }, reviewed: false)
          }.disabled(working).frame(minHeight: 44)
        }.font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
      }
    }.font(.custom("Lato-Regular", size: 15, relativeTo: .subheadline)).buttonStyle(.plain)
      .sheet(item: $editing) { TransactionForm(transaction: $0, reviewMode: true) }
  }
  private var reviewCount: some View {
    Text(chosen.isEmpty ? "\(visible.count) of \(review.count)" : "\(chosen.count) selected")
      .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(Color.assetSecondary)
  }
  private var reviewButton: some View {
    Button(working ? "Saving…" : "Review \(chosen.isEmpty ? visible.count : chosen.count) \(chosen.isEmpty ? "shown" : "selected")") {
      commit(chosen.isEmpty ? visible.map(\.id) : chosen, reviewed: true)
    }.buttonStyle(AssetBorderButtonStyle()).disabled(working || store.busy)
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
        selected = []; undoIDs = reviewed ? ids : []
      } catch { if generation == store.workspaceGeneration { store.error = error.localizedDescription } }
    }
  }
}
