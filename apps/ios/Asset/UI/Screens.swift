import Charts
import SwiftUI

struct TransactionsView: View {
  @EnvironmentObject var store: Store
  var initialAccount = ""
  var initialCategory = ""
  var initialStart = ""
  var initialEnd = ""
  @State var query = ""
  @State var account = ""
  @State var category = ""
  @State var kind = ""
  @State var reviewOnly = false
  @State var showFilters = false
  @State var start = ""
  @State var end = ""
  @State var selected = Set<String>()
  @State var selecting = false
  @State private var reviewing = false
  @State private var page = TransactionListPage()
  @State private var initialized = false
  @State private var appliedFilters: TransactionFilters?
  @State private var snapshotGeneration = -1
  private var filters: TransactionFilters {
    TransactionFilters(
      query: query, account: account, category: category, kind: kind,
      reviewOnly: reviewOnly, start: start, end: end)
  }
  var body: some View {
    let loadedCount = page.loadedCount
    List {
      Section {
        HStack {
          Button(reviewOnly ? "To Review" : "All transactions") {
            reviewOnly.toggle()
          }
          Spacer()
          Button {
            showFilters = true
          } label: {
            Image(systemName: "line.3.horizontal.decrease")
          }.accessibilityLabel("Filter transactions")
          Button(selecting ? "Done" : "Select") {
            selecting.toggle()
            selected = []
          }
        }.buttonStyle(.borderless)
        Text("\(page.total) matching transactions").font(
          .custom("Lato-Regular", size: 13, relativeTo: .caption)
        ).foregroundStyle(Color.assetSecondary)
      }
      if selecting {
        Section {
          Button("Select \(page.loadedCount) loaded transactions") {
            selected = page.loadedIDs
          }.disabled(page.loadedCount == 0)
          Button(reviewing ? "Reviewing selected…" : "Review selected (\(selected.count))") {
            reviewSelected()
          }.disabled(selected.isEmpty || reviewing || store.busy)
        }
      }
      ForEach(page.groups) { group in
        Section {
          ForEach(group.rows) { t in
            if selecting {
              Button {
                if selected.contains(t.id) { selected.remove(t.id) } else { selected.insert(t.id) }
              } label: {
                HStack {
                  Image(systemName: selected.contains(t.id) ? "checkmark.circle.fill" : "circle")
                  TransactionLine(tx: t)
                }
              }.buttonStyle(.plain)
            } else {
              NavigationLink {
                TransactionForm(transaction: t)
              } label: {
                TransactionLine(tx: t)
              }.swipeActions {
                Button("Review", systemImage: "checkmark") {
                  store.perform("transactions.review", ["ids": [t.id], "reviewed": true])
                }.tint(.assetText)
              }
            }
          }
        } header: {
          Text(group.id)
            .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
            .foregroundStyle(Color.assetSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.vertical, 8)
            .background(Color.assetBackground)
            .listRowInsets(EdgeInsets())
            .textCase(nil)
        }
      }
      if page.hasMore {
        ProgressView("Loading more transactions…")
          .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
          .foregroundStyle(Color.assetSecondary)
          .frame(maxWidth: .infinity, minHeight: 44)
          .id(loadedCount)
          .task {
            await Task.yield()
            guard !Task.isCancelled, loadedCount == page.loadedCount,
              appliedFilters == filters, snapshotGeneration == store.stateGeneration
            else { return }
            page.loadMore()
          }
      }
      if initialized && page.total == 0 {
        ContentUnavailableView(
          "No matching transactions", systemImage: "magnifyingglass",
          description: Text("Try another filter, import a CSV, or add a transaction."))
      }
    }.listStyle(.plain).scrollContentBackground(.hidden).background(Color.assetBackground)
      .searchable(text: $query, prompt: "Search merchants and notes")
      .assetTitle("Transactions")
      .onAppear {
        if !initialized {
          account = initialAccount
          category = initialCategory
          start = initialStart
          end = initialEnd
          initialized = true
        }
        refreshSnapshot()
      }
      .onChange(of: filters) { _, _ in refreshSnapshot() }
      .onChange(of: store.stateGeneration) { _, _ in refreshSnapshot() }
      .sheet(isPresented: $showFilters) {
        NavigationStack {
          List {
            Picker("Account", selection: $account) {
              Text("All accounts").tag("")
              ForEach(store.accounts) { Text($0.text("name")).tag($0.id) }
            }
            Picker("Category", selection: $category) {
              Text("All categories").tag("")
              ForEach(store.categories) { Text($0.text("name")).tag($0.id) }
            }
            Picker("Type", selection: $kind) {
              Text("All types").tag("")
              ForEach(transactionKinds, id: \.self) {
                Text($0.replacingOccurrences(of: "_", with: " ")).tag($0)
              }
            }
            TextField("From YYYY-MM-DD", text: $start)
            TextField("Through YYYY-MM-DD", text: $end)
            Toggle("To review only", isOn: $reviewOnly)
            Button("Clear filters") {
              account = ""
              category = ""
              kind = ""
              start = ""
              end = ""
              reviewOnly = false
            }
          }.assetTitle("Filters").toolbar {
            ToolbarItem(placement: .confirmationAction) {
              Button("Done") {
                showFilters = false
              }
            }.quietBackground()
          }
        }
      }
  }
  private func reviewSelected() {
    guard !reviewing, !store.busy, !selected.isEmpty else { return }
    let ids = selected.sorted()
    let workspace = store.workspaceGeneration
    reviewing = true
    Task {
      defer { reviewing = false }
      do {
        for start in stride(from: 0, to: ids.count, by: 10_000) {
          guard workspace == store.workspaceGeneration else { return }
          let batch = Array(ids[start..<min(start + 10_000, ids.count)])
          try await store.command("transactions.review", ["ids": batch, "reviewed": true])
          selected.subtract(batch)
          await Task.yield()
        }
      } catch {
        store.error = error.localizedDescription
      }
    }
  }
  private func refreshSnapshot() {
    guard initialized else { return }
    let nextFilters = filters
    let filtersChanged = appliedFilters != nextFilters
    guard filtersChanged || snapshotGeneration != store.stateGeneration else { return }
    page.reload(transactions: store.transactions, filters: nextFilters, reset: filtersChanged)
    if filtersChanged { selected = [] } else { selected.formIntersection(page.loadedIDs) }
    appliedFilters = nextFilters
    snapshotGeneration = store.stateGeneration
  }
}
struct CategoryBudgetLine: View {
  @EnvironmentObject var store: Store
  let category: Row
  var body: some View {
    VStack(spacing: 9) {
      HStack {
        CategoryBadge(category: category)
        Spacer()
        Text(money(category.data["spent"], store.currency)).font(
          .custom("Lato-Regular", size: 15, relativeTo: .subheadline)
        ).monospacedDigit()
      }
      ProgressView(
        value: max(0, min(1, category.number("spent") / max(1, category.number("budget"))))
      ).tint(.assetSecondary)
      HStack {
        StatusLabel(text: category.text("status"))
        Spacer()
        Text("of \(money(category.data["budget"],store.currency))").font(
          .custom("Lato-Regular", size: 13, relativeTo: .caption)
        ).foregroundStyle(Color.assetSecondary)
      }
    }.padding(.vertical, 8)
  }
}
struct CategoriesView: View {
  @EnvironmentObject var store: Store
  @Binding var month: String
  var body: some View {
    let d = store.calculation("dashboard", [month])
    let categories = d.rows("categories")
    ScrollView {
      VStack(spacing: 16) {
        MonthPicker(month: $month)
        Card {
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 24) {
              Metric(title: "Spent", value: money(d.data["spending"], store.currency))
              spendingChart(categories)
              Metric(title: "Budget", value: money(d.data["budget"], store.currency))
            }.fixedSize(horizontal: true, vertical: false)
            VStack(alignment: .leading, spacing: 16) {
              Metric(title: "Spent", value: money(d.data["spending"], store.currency))
              Metric(title: "Budget", value: money(d.data["budget"], store.currency))
              spendingChart(categories)
            }
          }
        }
        ForEach(Array(Set(categories.map { $0.text("group") })).sorted(), id: \.self) { group in
          Card(title: group) {
            ForEach(categories.filter { $0.text("group") == group }) { c in
              NavigationLink {
                CategoryDetail(categoryID: c.id, month: month)
              } label: {
                CategoryBudgetLine(category: c)
              }.buttonStyle(.plain)
            }
          }
        }
      }.padding(20)
    }
  }
  private func spendingChart(_ categories: [Row]) -> some View {
    Chart(categories.filter { $0.number("spent") > 0 }) { c in
      SectorMark(angle: .value("Spending", c.number("spent")), innerRadius: .ratio(0.7))
        .foregroundStyle(Color(hex: c.text("color")))
    }.frame(width: 84, height: 84).accessibilityLabel("Spending by category")
  }
}
struct CategoryDetail: View {
  @EnvironmentObject var store: Store
  let categoryID: String
  let month: String
  @State var amount = ""
  @State var edit = false
  var body: some View {
    let c =
      store.calculation("dashboard", [month]).rows("categories").first { $0.id == categoryID }
      ?? Row()
    List {
      Section {
        CategoryBadge(category: c)
        Metric(title: "Spent · \(month)", value: money(c.data["spent"], store.currency))
        StatusLabel(text: c.text("status"))
      }
      Section("Monthly budget") {
        TextField("Amount", text: $amount).keyboardType(.decimalPad)
        Button("Save budget for \(month)") {
          do {
            store.perform(
              "budget.save",
              ["month": month, "categoryId": categoryID, "amount": try store.cents(amount)])
          } catch { store.error = error.localizedDescription }
        }
        Text("Changes apply only to this month.").font(
          .custom("Lato-Regular", size: 13, relativeTo: .caption)
        ).foregroundStyle(Color.assetSecondary)
      }
      Section {
        NavigationLink("Category transactions") {
          TransactionsView(
            initialCategory: categoryID, initialStart: month + "-01",
            initialEnd: (try? store.engine.call("monthEnd", [month]) as? String) ?? month + "-31")
        }
        Button("Edit category") { edit = true }
      }
    }.assetTitle(c.text("name")).onAppear { amount = String(c.number("budget") / 100) }.sheet(
      isPresented: $edit
    ) { CategoryForm(category: c) }
  }
}
struct AccountsView: View {
  @EnvironmentObject var store: Store
  @State var range = "1Y"
  @State var addBitcoin = false
  var body: some View {
    let w = store.calculation("netWorth")
    ScrollView {
      VStack(spacing: 16) {
        Button("Track Bitcoin address") { addBitcoin = true }
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
          .disabled(store.mode != "remote" || store.isDemo)
        if store.mode != "remote" { Text("Sign in to track live Bitcoin balances.").font(.caption).foregroundStyle(Color.assetSecondary) }
        if !store.bitcoinError.isEmpty { Text(store.bitcoinError).foregroundStyle(Color.assetError) }
        Card(title: "Net worth") {
          Metric(
            title: "\(store.currency) · assets minus debt",
            value: money(w.data["total"], store.currency))
          HistoryChart(
            points: historyPoints(w.rows("history").filter { $0.flag("complete") }, range: range),
            currency: store.currency)
          RangePicker(range: $range)
          HStack {
            Metric(title: "Assets", value: money(w.data["assets"], store.currency))
            Spacer()
            Metric(title: "Debt", value: money(w.data["debt"], store.currency))
          }
          if !w.flag("complete") {
            Text("Some included account balances are unavailable.").font(
              .custom("Lato-Regular", size: 13, relativeTo: .caption)
            ).foregroundStyle(Color.assetAmber)
          }
          if store.accounts.contains(where: { $0.text("currency") != store.currency }) {
            Text("Other currencies are excluded from this total. No conversion is assumed.").font(
              .custom("Lato-Regular", size: 13, relativeTo: .caption)
            ).foregroundStyle(Color.assetSecondary)
          }
        }
        ForEach(["checking", "savings", "credit", "investment", "loan", "manual"], id: \.self) {
          type in
          let accounts = store.accounts.filter { $0.text("type") == type }
          if !accounts.isEmpty {
            Card(title: type == "credit" ? "Credit cards" : type.capitalized) {
              ForEach(accounts) { a in
                NavigationLink {
                  AccountDetail(accountID: a.id)
                } label: {
                  HStack {
                    Image(systemName: "building.columns").foregroundStyle(Color.assetSecondary)
                      .frame(
                        width: 30)
                    VStack(alignment: .leading, spacing: 5) {
                      Text(a.text("name")).font(
                        .custom("Lato-Regular", size: 15, relativeTo: .subheadline))
                      Text("\(a.text("source")) · \(a.text("mask",a.text("currency")))").font(
                        .custom("Lato-Regular", size: 12, relativeTo: .caption2)
                      ).foregroundStyle(Color.assetSecondary)
                    }
                    Spacer()
                    Text(money(a.data["balance"], a.text("currency"))).font(
                      .custom("Lato-Regular", size: 15, relativeTo: .subheadline)
                    ).monospacedDigit()
                  }.padding(.vertical, 8)
                }.buttonStyle(.plain)
              }
            }
          }
        }
        if store.accounts.isEmpty {
          ContentUnavailableView(
            "No accounts yet", systemImage: "building.columns",
            description: Text("Tap + to add a manual account, or open Connections in Settings."))
        }
      }.padding(20)
    }.sheet(isPresented: $addBitcoin) { BitcoinAddressForm() }
  }
}
struct AccountDetail: View {
  @EnvironmentObject var store: Store
  let accountID: String
  @State var range = "1Y"
  @State var edit = false
  var body: some View {
    let a = store.accounts.first { $0.id == accountID } ?? Row()
    ScrollView {
      VStack(spacing: 16) {
        Card {
          Metric(title: a.text("name"), value: money(a.data["balance"], a.text("currency")))
          Text("\(a.text("source")) · as of \(a.text("updatedAt"))").font(
            .custom("Lato-Regular", size: 13, relativeTo: .caption)
          ).foregroundStyle(Color.assetSecondary)
          if !a.missing("loan") {
            let loan = a.object("loan")
            let lender = loan.text("lender")
            Text(lender == "santander" ? "Santander Consumer USA" : lender == "synchrony" ? "Synchrony Pay Later" : "Loan details")
            if !loan.missing("ratePercent") { Text("\(loan.number("ratePercent").formatted())% \(loan.text("rateType", "APR"))") }
            Text("Scheduled payment: \(money(loan.data["paymentAmount"], a.text("currency")))")
            Text("Next payment: \(loan.text("nextPaymentDate", "Not entered"))")
            if lender == "santander" { Link("Open lender account", destination: URL(string: "https://myaccount.santanderconsumerusa.com/")!) }
            if lender == "synchrony" { Link("Open lender account", destination: URL(string: "https://www.synchrony.com/quickaccess/signin/paylater")!) }
            Text("Updated from your statements. Balance changes are recorded separately from bank payments.").font(.footnote).foregroundStyle(Color.assetSecondary)
          }
          HistoryChart(
            points: historyPoints(
              store.row.rows("snapshots").filter { $0.text("accountId") == accountID },
              key: "balance", range: range), currency: a.text("currency"))
          RangePicker(range: $range)
          Toggle(
            "Include in net worth",
            isOn: Binding(
              get: { a.flag("includeInNetWorth") },
              set: { v in
                var p = a.data
                p["includeInNetWorth"] = v
                store.perform("account.save", p)
              }))
          Text("This does not change spending totals.").font(
            .custom("Lato-Regular", size: 13, relativeTo: .caption)
          ).foregroundStyle(Color.assetSecondary)
        }
        if a.text("source") == "bitcoin" { BitcoinAccountDetail(account: a) }
        if a.text("source") != "bitcoin" {
        Card(title: "History coverage") {
          Text(a.text("coverageStart", "Unknown") + " to " + a.text("coverageEnd", "unknown"))
          StatusLabel(
            text: a.flag("coverageComplete") ? "Complete for recorded range" : "Incomplete history")
          Text("Balance history contains recorded snapshots only.").font(
            .custom("Lato-Regular", size: 13, relativeTo: .caption)
          ).foregroundStyle(Color.assetSecondary)
        }
        }
        NavigationLink("Related transactions") { TransactionsView(initialAccount: accountID) }
          .frame(minHeight: 44)
        Button("Edit account") { edit = true }.frame(minHeight: 44)
      }.padding(20)
    }.assetTitle(a.text("name")).sheet(isPresented: $edit) { AccountForm(account: a) }
  }
}
struct BitcoinAccountDetail: View {
  @EnvironmentObject var store: Store
  let account: Row
  @State var range = "1Y"
  @State var busy = false
  @State var error = ""
  var body: some View {
    let wallet = account.object("bitcoin")
    let market = store.row.object("bitcoinMarket")
    Card(title: "Bitcoin address") {
      Text(wallet.text("address")).textSelection(.enabled).font(.caption)
      LabeledContent("Confirmed BTC", value: String(format: "%.8f", wallet.number("satoshis") / 100000000))
      LabeledContent("Pending BTC", value: String(format: "%.8f", wallet.number("pendingSatoshis") / 100000000))
      LabeledContent("BTC / USD", value: money(market.data["price"], "USD"))
      let quoteDate: Date = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: market.text("updatedAt")) ?? .distantPast
      }()
      if Date().timeIntervalSince(quoteDate) > 900 {
        Text("Saved price is out of date. Refresh to update the valuation.").font(.caption).foregroundStyle(Color.assetError)
      }
      Text("Balance checked \(wallet.text("syncedAt")). Pending transfers are excluded from net worth.")
        .font(.caption).foregroundStyle(Color.assetSecondary)
      Button(busy ? "Refreshing…" : "Refresh Bitcoin") {
        busy = true
        Task {
          do {
            try await store.bitcoinRequest("/bitcoin/wallets/\(account.id)/sync")
            try await store.bitcoinRequest("/bitcoin/refresh")
            error = ""
          } catch { self.error = error.localizedDescription }
          busy = false
        }
      }.disabled(busy || store.mode != "remote").frame(minHeight: 44)
      if !error.isEmpty { Text(error).foregroundStyle(Color.assetError) }
      Text("Bitcoin price history").font(.custom("Lato-Medium", size: 15, relativeTo: .subheadline))
      HistoryChart(points: historyPoints(market.rows("history"), key: "price", range: range), currency: "USD")
      RangePicker(range: $range)
      Text("Coinbase daily closes in UTC, including available history back to 2015. Quote: \(market.text("updatedAt")). Quotes refresh every minute while Asset is open; balances every five minutes.")
        .font(.caption).foregroundStyle(Color.assetSecondary)
      Text("Wallet history uses the confirmed BTC held on each date. \(wallet.flag("historyComplete") ? "Loaded" : "Partial") history starts \(wallet.text("historyStart")). Missing prices are omitted. A transfer does not establish your purchase cost.")
        .font(.caption).foregroundStyle(Color.assetSecondary)
      Button("Stop tracking and keep saved balances") { store.perform("bitcoin.disconnect", ["id": account.id]) }
        .frame(minHeight: 44)
    }
  }
}
struct InvestmentsView: View {
  @EnvironmentObject var store: Store
  @State var account = "all"
  @State var range = "1Y"
  var body: some View {
    let v = store.calculation("investmentOverview", [account])
    let alloc = v.object("allocation")
    ScrollView {
      VStack(spacing: 16) {
        Picker("Investment account", selection: $account) {
          Text("All investment accounts").tag("all")
          ForEach(store.accounts.filter { $0.text("type") == "investment" }) {
            Text($0.text("name")).tag($0.id)
          }
        }.pickerStyle(.menu)
        Card(title: "Portfolio value") {
          Metric(
            title: "Recorded account balances",
            value: money(v.data["accountBalance"], store.currency))
          HistoryChart(
            points: historyPoints(v.rows("history").filter { $0.flag("complete") }, range: range),
            currency: store.currency)
          RangePicker(range: $range)
          Text("Investment return unavailable").font(
            .custom("Lato-Medium", size: 15, relativeTo: .subheadline))
          Text(v.text("returnReason")).font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
            .foregroundStyle(Color.assetSecondary)
        }
        Card(title: "Allocation · known holdings") {
          ForEach(alloc.data.keys.sorted(), id: \.self) { key in
            HStack {
              Text(key.caseInsensitiveCompare("ETF") == .orderedSame ? "ETF" : key.capitalized)
                .font(
                  .custom("Lato-Regular", size: 15, relativeTo: .subheadline)
                ).frame(width: 95, alignment: .leading)
              ProgressView(value: max(0, min(1, alloc.number(key) / max(1, v.number("value")))))
                .tint(.assetBlue)
              Text(
                (alloc.number(key) / max(1, v.number("value")) * 100).formatted(
                  .number.precision(.fractionLength(1))) + "%"
              ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).monospacedDigit()
            }
          }
          Text(
            "Holdings: \(money(v.data["value"],store.currency)). Balance difference: \(money(v.number("accountBalance")-v.number("value"),store.currency)). Cash, missing positions, or different timestamps may explain the difference."
          ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
            Color.assetSecondary)
        }
        Card(title: "Holdings") {
          ForEach(v.rows("holdings")) { h in
            NavigationLink {
              HoldingDetail(holdingID: h.id)
            } label: {
              HStack {
                VStack(alignment: .leading, spacing: 4) {
                  Text(h.text("symbol")).font(
                    .custom("Lato-Medium", size: 15, relativeTo: .subheadline))
                  Text(h.text("name")).font(
                    .custom("Lato-Regular", size: 12, relativeTo: .caption2)
                  ).foregroundStyle(Color.assetSecondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                  Text(money(h.data["marketValue"], h.text("currency"))).font(
                    .custom("Lato-Regular", size: 15, relativeTo: .subheadline))
                  Text(h.flag("stale") ? "Stale price" : String(h.text("priceAt").prefix(10))).font(
                    .custom("Lato-Regular", size: 12, relativeTo: .caption2)
                  ).foregroundStyle(h.flag("stale") ? Color.assetAmber : Color.assetSecondary)
                }
              }.padding(.vertical, 6)
            }.buttonStyle(.plain)
          }
          if v.rows("holdings").isEmpty {
            Text("Add a manual holding or connect a supported brokerage.")
              .foregroundStyle(Color.assetSecondary)
          }
        }
      }.padding(20)
    }
  }
}
struct HoldingDetail: View {
  @EnvironmentObject var store: Store
  let holdingID: String
  @State var edit = false
  var body: some View {
    let h =
      store.calculation("investmentOverview").rows("holdings").first { $0.id == holdingID } ?? Row()
    List {
      Section {
        Text(h.text("name")).font(.custom("Lato-Medium", size: 17, relativeTo: .headline))
        Metric(title: "Price", value: money(h.data["price"], h.text("currency")))
        Text("Price as of \(h.text("priceAt","unavailable"))").font(
          .custom("Lato-Regular", size: 13, relativeTo: .caption))
        if h.flag("stale") { StatusLabel(text: "Stale price") }
      }
      Section {
        LabeledContent("Quantity", value: h.text("quantity"))
        LabeledContent("Market value", value: money(h.data["marketValue"], h.text("currency")))
        LabeledContent("Cost basis", value: money(h.data["costBasis"], h.text("currency")))
        LabeledContent("Unrealized gain", value: money(h.data["gain"], h.text("currency")))
        Text(h.text("source") == "bitcoin" ? "Bitcoin quotes refresh every minute while Asset is open. Address details and historical prices are in Accounts." : "Position gain is not your cash-flow-adjusted portfolio return. Prices are not live.")
          .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
            Color.assetSecondary)
      }
      if !["plaid", "bitcoin"].contains(h.text("source")) { Button("Edit holding") { edit = true } }
    }.assetTitle(h.text("symbol")).sheet(isPresented: $edit) { HoldingForm(holding: h) }
  }
}
struct CashFlowView: View {
  @EnvironmentObject var store: Store
  @Binding var month: String
  @State var mode = "month"
  @State var year = Int(dateToday().prefix(4)) ?? 2026
  @State var selectedMonth: String?
  var body: some View {
    let c = store.calculation("cashflow", [mode, mode == "month" ? month : String(year)])
    ScrollView {
      VStack(spacing: 16) {
        HStack(spacing: 24) {
          ForEach(["month", "year"], id: \.self) { option in
            Button {
              mode = option
            } label: {
              Text(option.capitalized)
                .font(
                  .custom(
                    mode == option ? "Lato-Medium" : "Lato-Regular", size: 15,
                    relativeTo: .subheadline)
                )
                .foregroundStyle(mode == option ? Color.assetText : Color.assetSecondary)
                .frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityAddTraits(mode == option ? .isSelected : [])
          }
          Spacer()
        }
        if mode == "month" {
          MonthPicker(month: $month)
        } else {
          HStack {
            Button {
              year -= 1
            } label: {
              Image(systemName: "chevron.left").frame(width: 44, height: 44)
            }.accessibilityLabel("Previous year")
            Spacer()
            Text(String(year)).font(.custom("Lato-Medium", size: 17, relativeTo: .headline))
            Spacer()
            Button {
              year += 1
            } label: {
              Image(systemName: "chevron.right").frame(width: 44, height: 44)
            }.accessibilityLabel("Next year")
          }.padding(.horizontal)
        }
        Text("\(c.text("start")) – \(c.text("end"))\(c.flag("current") ? " · to date" : "")").font(
          .custom("Lato-Regular", size: 13, relativeTo: .caption)
        ).foregroundStyle(Color.assetSecondary)
        Toggle(
          "Include budget-excluded spending",
          isOn: Binding(
            get: { store.row.object("settings").flag("includeExcludedCashflow") },
            set: { store.perform("settings.save", ["includeExcludedCashflow": $0]) })
        ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
        ForEach(["net", "spending", "income"], id: \.self) { key in
          Card(title: key == "net" ? "Net income" : key.capitalized) {
            Metric(
              title: c.flag("complete") ? "Actual activity" : "Known activity · incomplete history",
              value: money(c.data[key], store.currency),
              color: key == "net" && c.number(key) < 0 ? .assetAmber : .assetText)
            let comparison = c.object("comparison")
            if !comparison.missing(key) {
              Text(
                "\(comparison.number(key).formatted(.number.precision(.fractionLength(1))))% vs \(money(c.object("prior").data[key],store.currency))"
              ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
                Color.assetSecondary)
            } else {
              Text("Comparison unavailable: missing history or a zero prior value.").font(
                .custom("Lato-Regular", size: 13, relativeTo: .caption)
              ).foregroundStyle(Color.assetSecondary)
            }
            CashFlowChart(
              months: c.rows("months"), categories: store.categories, metric: key,
              currency: store.currency,
              selectedMonth: $selectedMonth)
            if let selectedMonth,
              let selected = c.rows("months").first(where: {
                $0.text("month").hasSuffix("-" + selectedMonth)
              })
            {
              Button {
                month = selected.text("month")
                mode = "month"
                self.selectedMonth = nil
              } label: {
                Text("Open \(selected.text("month")) · \(money(selected.data[key],store.currency))")
                  .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
                  .frame(minHeight: 44).contentShape(Rectangle())
              }
            }
            NavigationLink {
              TransactionsView(initialStart: c.text("start"), initialEnd: c.text("end"))
            } label: {
              Text("View transactions")
                .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
                .frame(minHeight: 44).contentShape(Rectangle())
            }

            Text("Previous: \(c.text("priorStart")) – \(c.text("priorEnd"))").font(
              .custom("Lato-Regular", size: 12, relativeTo: .caption2)
            ).foregroundStyle(Color.assetSecondary)
          }
        }
        Card(title: "Spending by category") {
          ForEach(c.object("categories").data.keys.sorted(), id: \.self) { id in
            let category = store.categories.first { $0.id == id } ?? Row()
            NavigationLink {
              TransactionsView(
                initialCategory: id, initialStart: c.text("start"), initialEnd: c.text("end"))
            } label: {
              HStack {
                CategoryBadge(category: category)
                Spacer()
                Text(money(c.object("categories").data[id], store.currency)).font(
                  .custom("Lato-Regular", size: 15, relativeTo: .subheadline))
              }
            }
          }
        }
      }.padding(20)
    }.onChange(of: year) { _, _ in selectedMonth = nil }
      .onChange(of: mode) { _, _ in selectedMonth = nil }
      .onChange(of: month) { _, _ in selectedMonth = nil }
  }
}

private struct CashFlowChart: View {
  let months: [Row]
  let categories: [Row]
  let metric: String
  let currency: String
  @Binding var selectedMonth: String?
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .caption2) private var axisLabelWidth = 32.0
  private let calendarMonths = (1...12).map { String(format: "%02d", $0) }
  var body: some View {
    Chart {
      ForEach(months.filter { !$0.flag("future") }) { month in
        if metric == "spending" {
          ForEach(month.object("categories").data.keys.sorted(), id: \.self) { id in
            BarMark(
              x: .value("Month", String(month.text("month").suffix(2))),
              y: .value("Spending", month.object("categories").number(id) / 100)
            ).foregroundStyle(
              Color(hex: categories.first { $0.id == id }?.text("color") ?? "#999999"))
          }
        } else {
          BarMark(
            x: .value("Month", String(month.text("month").suffix(2))),
            y: .value("Actual", month.number(metric) / 100)
          ).foregroundStyle(month.number(metric) < 0 ? Color.assetAmber : Color.assetBlue)
        }
      }
      if let selectedMonth,
        let selected = months.first(where: {
          $0.text("month").hasSuffix("-" + selectedMonth) && !$0.flag("future")
        })
      {
        RuleMark(x: .value("Selected month", selectedMonth))
          .foregroundStyle(Color.assetText)
          .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
        PointMark(
          x: .value("Month", selectedMonth),
          y: .value("Selected value", selected.number(metric) / 100)
        )
        .foregroundStyle(Color.assetText).symbolSize(30)
      }
    }.chartXScale(domain: calendarMonths)
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
      .frame(height: 150).chartXAxis {
        AxisMarks(
          values: dynamicTypeSize.isAccessibilitySize
            ? ["01", "04", "07", "10", "12"] : calendarMonths
        ) {
          AxisValueLabel()
        }
      }.chartYAxis {
        AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
          AxisGridLine()
          AxisValueLabel {
            if let number = value.as(Double.self) {
              Text(number.formatted(.number.notation(.compactName)))
                .font(.custom("Lato-Regular", size: 12, relativeTo: .caption2))
                .frame(width: axisLabelWidth, alignment: .trailing)
            }
          }
        }
      }.accessibilityLabel("Monthly actual \(metric). Future periods have no bars.")
      .accessibilityValue(selectionDescription)
      .accessibilityHint("Adjust to select a month, then use Open month.")
      .accessibilityAdjustableAction { direction in
        let available = months.filter { !$0.flag("future") }
        guard !available.isEmpty else { return }
        let current = available.firstIndex {
          $0.text("month").hasSuffix("-" + (selectedMonth ?? ""))
        }
        let index: Int
        switch direction {
        case .increment: index = min((current ?? -1) + 1, available.count - 1)
        case .decrement: index = max((current ?? available.count) - 1, 0)
        @unknown default: return
        }
        selectedMonth = String(available[index].text("month").suffix(2))
      }
  }
  private var selectionDescription: String {
    guard let selectedMonth,
      let selected = months.first(where: {
        $0.text("month").hasSuffix("-" + selectedMonth) && !$0.flag("future")
      })
    else { return "No month selected" }
    return "\(selected.text("month")), \(money(selected.data[metric], currency))"
  }
  private func select(atX position: CGFloat, proxy: ChartProxy) {
    guard let value = proxy.value(atX: position, as: String.self) else { return }
    selectedMonth =
      months.contains { $0.text("month").hasSuffix("-" + value) && !$0.flag("future") }
      ? value : nil
  }
}
