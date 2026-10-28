import SwiftUI

let transactionKinds = [
  "spending", "refund", "income", "transfer", "card_payment", "investment_transfer",
  "investment_trade",
]
private func transactionKindLabel(_ kind: String) -> String {
  let words = kind.replacingOccurrences(of: "_", with: " ")
  return words.prefix(1).uppercased() + String(words.dropFirst())
}
struct FormShell<Content: View>: View {
  @Environment(\.dismiss) var dismiss
  let title: String
  var saveTitle = "Save"
  var save: () async throws -> Void
  @ViewBuilder var content: Content
  @State var error = ""
  @State var saving = false
  var body: some View {
    NavigationStack {
      List {
        content
        if !error.isEmpty { Section { Text(error).foregroundStyle(Color.assetError) } }
      }.assetTitle(title).navigationBarTitleDisplayMode(.inline).navigationBarBackButtonHidden(true)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
            .quietBackground()
          ToolbarItem(placement: .confirmationAction) {
            Button(saving ? "Saving…" : saveTitle) {
              saving = true
              Task {
                do {
                  try await save()
                  dismiss()
                } catch { self.error = error.localizedDescription }
                saving = false
              }
            }.disabled(saving)
          }.quietBackground()
        }.listStyle(.plain).scrollContentBackground(.hidden).background(Color.assetBackground)
    }.navigationBarBackButtonHidden(true)
  }
}
struct CategoryPicker: View {
  @EnvironmentObject var store: Store
  @Binding var value: String
  var body: some View {
    Picker("Category", selection: $value) {
      ForEach(store.categories.filter { !$0.flag("archived") || $0.id == value }) { c in
        Label(c.text("name"), systemImage: CategorySymbol.name(CategorySymbol.key(c))).tag(c.id)
      }
    }
  }
}
struct SplitDraft: Identifiable {
  var id = uid()
  var category = "other"
  var amount = "0.00"
  var excluded = false
}
struct TransactionSetupView: View {
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  @State private var addAccount = false
  var body: some View {
    Group {
      if store.accounts.isEmpty {
        NavigationStack {
          VStack(alignment: .leading, spacing: 16) {
            Text("Add an account to record this transaction.").foregroundStyle(Color.assetSecondary)
            Button("Add account") { addAccount = true }.buttonStyle(AssetBorderButtonStyle())
            Spacer()
          }.font(.custom("Lato-Regular", size: 15, relativeTo: .subheadline))
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.assetBackground).assetTitle("Add transaction")
            .toolbar {
              ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
              }.quietBackground()
            }
        }
      } else {
        TransactionForm()
      }
    }.sheet(isPresented: $addAccount) { AccountForm() }
  }
}
struct TransactionForm: View {
  @EnvironmentObject var store: Store
  var transaction: Row?
  var reviewMode = false
  @State var name = ""
  @State var date = dateToday()
  @State var amount = ""
  @State var account = ""
  @State var category = "other"
  @State var kind = "spending"
  @State var notes = ""
  @State var recurring = ""
  @State var loanAccount = ""
  @State var excluded = false
  @State var reviewed = false
  @State var createRule = false
  @State var globalRule = false
  @State var splitting = false
  @State var reconciling = false
  @State var splits: [SplitDraft] = []
  @State var loaded = false
  var body: some View {
    FormShell(
      title: transaction == nil ? "Add transaction" : "Transaction detail",
      saveTitle: reviewMode ? "Review" : "Save", save: save
    ) {
      Section {
        TextField("Merchant or description", text: $name)
        TextField("Date · YYYY-MM-DD", text: $date).keyboardType(.numbersAndPunctuation)
        TextField("Amount", text: $amount).keyboardType(.decimalPad).disabled(transaction != nil)
        Picker("Type", selection: $kind) {
          ForEach(transactionKinds, id: \.self) {
            Text(transactionKindLabel($0)).tag($0)
          }
        }
        Picker("Account", selection: $account) {
          ForEach(store.accounts) { Text($0.text("name")).tag($0.id) }
        }.disabled(transaction != nil)
        CategoryPicker(value: $category)
      }
      Section {
        TextField("Notes", text: $notes, axis: .vertical).lineLimit(3...6)
        TextField("Recurring payment label (optional)", text: $recurring)
        if store.accounts.contains(where: { $0.text("type") == "loan" }) {
          Picker("Loan payment", selection: $loanAccount) {
            Text("Not linked to a loan").tag("")
            ForEach(store.accounts.filter { $0.text("type") == "loan" && $0.id != account && $0.text("currency") == (store.accounts.first { $0.id == account }?.text("currency") ?? "USD") }) {
              Text($0.text("name")).tag($0.id)
            }
          }
        }
        Toggle("Exclude from budget", isOn: $excluded)
        if !reviewMode { Toggle("Reviewed", isOn: $reviewed) }
      }
      if transaction != nil {
        Section("Future imports") {
          Toggle("Create exact merchant rule", isOn: $createRule)
          if createRule {
            Toggle("Apply to all accounts", isOn: $globalRule)
            Text(
              "Manual corrections always take priority. The rule does not rewrite old transactions."
            ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
              Color.assetSecondary)
          }
        }
      }
      Section {
        Toggle("Split transaction", isOn: $splitting)
        if splitting {
          ForEach($splits) { $p in
            VStack {
              CategoryPicker(value: $p.category)
              TextField("Split amount", text: $p.amount).keyboardType(.decimalPad)
              Toggle("Exclude this split", isOn: $p.excluded)
            }
          }
          Button("Add split") { splits.append(SplitDraft()) }
          Text("Split amounts must equal the transaction amount. Each part is counted once.").font(
            .custom("Lato-Regular", size: 13, relativeTo: .caption)
          ).foregroundStyle(Color.assetSecondary)
        }
      }
      if let t = transaction {
        Section("Original import") {
          Text("\(t.text("source")) · \(t.text("importedAt"))").font(
            .custom("Lato-Regular", size: 13, relativeTo: .caption))
          if t.flag("pending") { StatusLabel(text: "Pending") }
          if t.object("raw").flag("asset_split_conflict") {
            Text(
              "The provider amount changed. Your split is preserved. Reconcile the changed amount before accepting it."
            ).foregroundStyle(Color.assetAmber)
            Toggle("Accept updated amount and revise splits", isOn: $reconciling)
              .onChange(of: reconciling) { _, accept in
                amount =
                  accept
                  ? String(abs(t.object("raw").number("amount"))) : String(t.number("amount") / 100)
                splitting = true
              }
            Text(
              "New provider amount: \(abs(t.object("raw").number("amount")), format: .currency(code: t.text("currency")))"
            )
          }
        }
      }
    }.onAppear {
      guard !loaded else { return }
      loaded = true
      if let t = transaction {
        name = t.text("name")
        date = t.text("date")
        amount = String(t.number("amount") / 100)
        account = t.text("accountId")
        category = t.text("categoryId")
        kind = t.text("kind")
        notes = t.text("notes")
        recurring = t.text("recurring")
        loanAccount = t.text("loanAccountId")
        excluded = t.flag("excluded")
        reviewed = reviewMode || t.flag("reviewed")
        splits = t.rows("splits").map {
          SplitDraft(
            id: $0.id, category: $0.text("categoryId"), amount: String($0.number("amount") / 100),
            excluded: $0.flag("excluded"))
        }
        splitting = !splits.isEmpty
      } else {
        account = store.accounts.first?.id ?? ""
      }
      if splits.isEmpty {
        splits = [
          SplitDraft(category: category, amount: amount.isEmpty ? "0.00" : amount), SplitDraft(),
        ]
      }
    }
  }
  func save() async throws {
    guard let a = store.accounts.first(where: { $0.id == account }) else {
      throw failure("Add an account first")
    }
    let cents = try store.cents(amount)
    let parts: [JSON] =
      try splitting
      ? splits.map {
        [
          "id": $0.id, "categoryId": $0.category, "amount": try store.cents($0.amount),
          "excluded": $0.excluded,
        ]
      } : []
    if splitting
      && (parts.count < 2 || parts.reduce(0) { $0 + ($1["amount"] as? Int ?? 0) } != cents)
    {
      throw failure("Splits must add up to the original amount")
    }
    if let t = transaction {
      if t.rows("splits").count > 0 && !splitting {
        throw failure("Keep split mode enabled to edit an existing split")
      }
      if reconciling {
        try await store.command("transaction.reconcile", ["id": t.id, "splits": parts])
      }
      try await store.command(
        "transaction.update",
        [
          "id": t.id,
          "edits": [
            "name": name, "date": date, "categoryId": category, "kind": kind, "notes": notes,
            "excluded": excluded,
            "recurring": recurring, "loanAccountId": loanAccount.isEmpty ? NSNull() : loanAccount as Any,
          ], "reviewed": reviewMode ? t.flag("reviewed") : reviewed,
        ])
      if splitting && !reconciling {
        try await store.command("transaction.split", ["id": t.id, "splits": parts])
      }
      if createRule {
        try await store.command(
          "rule.save",
          [
            "id": uid(), "merchant": t.text("name"), "match": "exact",
            "accountId": globalRule ? NSNull() : account as Any, "categoryId": category,
          ])
      }
      if reviewMode {
        try await store.command("transactions.review", ["ids": [t.id], "reviewed": true])
      }
    } else {
      try await store.command(
        "transaction.create",
        [
          "id": uid(), "name": name, "date": date, "amount": cents, "kind": kind,
          "accountId": account, "currency": a.text("currency"), "categoryId": category,
          "source": "manual", "importedAt": isoNow(), "notes": notes, "excluded": excluded,
          "recurring": recurring, "loanAccountId": loanAccount.isEmpty ? NSNull() : loanAccount as Any,
          "reviewed": reviewed, "splits": parts,
        ])
    }
  }
}
struct BitcoinWalletSetupView: View {
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  @State private var signIn = false
  var body: some View {
    Group {
      if store.mode == "remote" && !store.isDemo {
        BitcoinAddressForm()
      } else {
        NavigationStack {
          VStack(alignment: .leading, spacing: 16) {
            Text("Sign in to track a Bitcoin wallet’s balance and history.")
              .foregroundStyle(Color.assetSecondary)
            Button("Sign in") { signIn = true }.buttonStyle(AssetBorderButtonStyle())
            Spacer()
          }.font(.custom("Lato-Regular", size: 15, relativeTo: .subheadline))
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.assetBackground).assetTitle("Bitcoin wallet")
            .toolbar {
              ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
              }.quietBackground()
            }
        }
      }
    }.sheet(isPresented: $signIn) {
      SyncSignInView().presentationDetents([.medium, .large])
    }
  }
}
struct BitcoinAddressForm: View {
  @EnvironmentObject var store: Store
  @State var name = ""
  @State var address = ""
  var body: some View {
    FormShell(
      title: "Add Bitcoin wallet",
      save: {
        try await store.bitcoinRequest(
          "/bitcoin/wallets", body: ["name": name, "address": address])
      }
    ) {
      Section {
        TextField("Name", text: $name)
        TextField("Public Bitcoin address", text: $address)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
      }
      Section {
        Text(
          "Read-only tracking. Never enter a private key or recovery phrase. Add each receiving or change address you want included; a single address may not cover your whole wallet."
        )
        Text(
          "The public address is sent to Blockstream for balances and history. USD prices come from Coinbase. No Plaid connection is used."
        )
      }.font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
        Color.assetSecondary)
    }
  }
}
struct AccountForm: View {
  @EnvironmentObject var store: Store
  var account: Row?
  @State var name = ""
  @State var type = "checking"
  @State var mask = ""
  @State var currency = "USD"
  @State var balance = ""
  @State var creditLimit = ""
  @State var included = true
  @State var start = ""
  @State var end = ""
  @State var complete = false
  @State var lender = "other"
  @State var rate = ""
  @State var rateType = "APR"
  @State var payment = ""
  @State var dueDate = ""
  @State var loaded = false
  var connected: Bool {
    ["plaid", "bitcoin", "venmo", "financekit"].contains(account?.text("source") ?? "")
  }
  var body: some View {
    FormShell(
      title: account == nil ? "Add manual account" : "Edit account",
      save: {
        var p = account?.data ?? [:]
        p["id"] = account?.id ?? uid()
        p["name"] = name
        if !connected { p["mask"] = mask }
        p["type"] = type
        p["currency"] = currency
        if !connected {
          p["balance"] = balance.isEmpty ? NSNull() : try store.cents(balance) as Any
          p["creditLimit"] = creditLimit.isEmpty ? NSNull() : try store.cents(creditLimit) as Any
        }
        if type == "loan" && !connected {
          var loan: JSON = [
            "lender": lender, "rateType": rateType,
            "ratePercent": rate.isEmpty ? NSNull() : (Double(rate) ?? -1) as Any,
            "paymentAmount": payment.isEmpty ? NSNull() : try store.cents(payment) as Any,
          ]
          if !dueDate.isEmpty { loan["nextPaymentDate"] = dueDate }
          p["loan"] = loan
        }
        p["includeInNetWorth"] = included
        p["enabled"] = account?.flag("enabled") ?? true
        p["source"] = account?.text("source") ?? "manual"
        p["updatedAt"] = isoNow()
        p["coverageComplete"] = complete
        if !start.isEmpty { p["coverageStart"] = start }
        if !end.isEmpty { p["coverageEnd"] = end }
        try await store.command("account.save", p)
      }
    ) {
      Section {
        TextField("Account name", text: $name)
        if !connected { TextField("Last four (optional)", text: $mask).onChange(of: mask) { _, value in mask = String(value.prefix(4)) } }
        Picker("Type", selection: $type) {
          ForEach(["checking", "savings", "credit", "investment", "loan", "manual"], id: \.self) {
            Text($0.capitalized)
          }
        }.disabled(connected)
        TextField("Balance", text: $balance).keyboardType(.numbersAndPunctuation).disabled(
          connected)
        if type == "credit" {
          TextField("Credit limit (optional)", text: $creditLimit).keyboardType(.decimalPad)
            .disabled(connected)
        }
        Picker("Currency", selection: $currency) {
          ForEach(["USD", "CAD", "EUR", "GBP"], id: \.self) { Text($0) }
        }.disabled(connected)
        Toggle("Include in net worth", isOn: $included)
        Text(
          "Enter debt as a positive amount owed. Saving a balance records a dated snapshot. Transactions do not silently change manual balances."
        ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
          Color.assetSecondary)
      }
      if type == "loan" && !connected {
        Section("Loan details") {
          Picker("Lender", selection: $lender) {
            Text("Santander Consumer USA").tag("santander")
            Text("Synchrony Pay Later").tag("synchrony")
            Text("Other lender").tag("other")
          }
          TextField("Annual rate (%)", text: $rate).keyboardType(.decimalPad)
          Picker("Rate label", selection: $rateType) {
            Text("APR").tag("APR")
            Text("APY").tag("APY")
          }
          TextField("Scheduled payment", text: $payment).keyboardType(.decimalPad)
          TextField("Next payment · YYYY-MM-DD", text: $dueDate)
          Text(
            "Use the balance and rate from your statement. Update the balance after payments; bank withdrawals do not reveal the principal and interest split. These details do not enable automatic lender syncing."
          ).foregroundStyle(Color.assetSecondary)
        }
      }
      if !connected {
        Section("Transaction history coverage") {
          TextField("Start · YYYY-MM-DD", text: $start)
          TextField("End · YYYY-MM-DD", text: $end)
          Toggle("All activity in this range is entered", isOn: $complete)
          Text(
            "Only mark complete after entering all activity. Incomplete history does not produce a forecast or percentage comparison."
          ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
            Color.assetSecondary)
        }
      }
    }.onAppear {
      guard !loaded else { return }
      loaded = true
      if let a = account {
        name = a.text("name")
        mask = a.text("mask")
        type = a.text("type")
        currency = a.text("currency")
        balance = a.missing("balance") ? "" : String(a.number("balance") / 100)
        creditLimit = a.missing("creditLimit") ? "" : String(a.number("creditLimit") / 100)
        included = a.flag("includeInNetWorth")
        start = a.text("coverageStart")
        end = a.text("coverageEnd")
        complete = a.flag("coverageComplete")
        let loan = a.object("loan")
        lender = loan.text("lender", "other")
        rateType = loan.text("rateType", "APR")
        rate = loan.missing("ratePercent") ? "" : String(loan.number("ratePercent"))
        payment = loan.missing("paymentAmount") ? "" : String(loan.number("paymentAmount") / 100)
        dueDate = loan.text("nextPaymentDate")
      }
    }
  }
}
struct CategoryForm: View {
  @EnvironmentObject var store: Store
  var category: Row?
  @State var name = ""
  @State var icon = "other"
  @State var group = "Everyday"
  @State var color = "#3e6fc6"
  @State var archived = false
  let chartColors = [
    "Blue": "#3e6fc6", "Slate": "#73849a", "Sage": "#8d9b8a", "Taupe": "#9d8f83",
    "Stone": "#91877c", "Steel": "#7e98a1", "Lavender gray": "#8b87a0",
    "Rose gray": "#a08c8c", "Blue gray": "#7b8faa", "Sea gray": "#829894", "Gray": "#92979e",
  ]
  var body: some View {
    FormShell(
      title: category == nil ? "New category" : "Edit category",
      save: {
        try await store.command(
          "category.save",
          [
            "id": category?.id ?? uid(), "name": name, "icon": icon, "group": group, "color": color,
            "archived": archived,
          ])
      }
    ) {
      Section {
        TextField("Name", text: $name)
        Picker("Symbol", selection: $icon) {
          ForEach(CategorySymbol.keys, id: \.self) { key in
            Label(CategorySymbol.label(key), systemImage: CategorySymbol.name(key)).tag(key)
          }
        }
        TextField("Group", text: $group)
        Picker("Chart color", selection: $color) {
          ForEach(chartColors.keys.sorted(), id: \.self) { name in
            Text(name).tag(chartColors[name]!)
          }
          if !chartColors.values.contains(color) { Text("Custom color").tag(color) }
        }
        Toggle("Archived", isOn: $archived)
        Text("Archiving preserves past spending and budgets.").font(
          .custom("Lato-Regular", size: 13, relativeTo: .caption)
        ).foregroundStyle(Color.assetSecondary)
      }
    }.onAppear {
      if let c = category {
        name = c.text("name")
        icon = CategorySymbol.key(c)
        group = c.text("group")
        color = c.text("color")
        archived = c.flag("archived")
      }
    }
  }
}
struct HoldingForm: View {
  @EnvironmentObject var store: Store
  var holding: Row?
  @State var symbol = ""
  @State var name = ""
  @State var account = ""
  @State var quantity = "0"
  @State var price = ""
  @State var value = ""
  @State var basis = ""
  @State var date = ""
  @State var type = "Equity"
  @State var loaded = false
  var body: some View {
    FormShell(
      title: holding == nil ? "Add holding" : "Edit holding",
      save: {
        guard
          let a = store.accounts.first(where: {
            $0.id == account && $0.text("type") == "investment" && $0.text("source") != "bitcoin"
          })
        else { throw failure("Add an investment account first") }
        @MainActor func optional(_ v: String) throws -> Any {
          v.isEmpty ? NSNull() : try store.cents(v)
        }
        try await store.command(
          "holding.save",
          [
            "id": holding?.id ?? uid(), "symbol": symbol, "name": name, "accountId": account,
            "quantity": quantity, "price": try optional(price), "marketValue": try optional(value),
            "costBasis": try optional(basis), "priceAt": date.isEmpty ? NSNull() : date as Any,
            "currency": a.text("currency"), "type": type, "source": "manual",
          ])
      }
    ) {
      Section {
        TextField("Ticker", text: $symbol)
        TextField("Security name", text: $name)
        Picker("Account", selection: $account) {
          ForEach(
            store.accounts.filter {
              $0.text("type") == "investment" && $0.text("source") != "bitcoin"
            }
          ) {
            Text($0.text("name")).tag($0.id)
          }
        }
        TextField("Quantity", text: $quantity).keyboardType(.decimalPad)
        TextField("Price", text: $price).keyboardType(.decimalPad)
        TextField("Market value", text: $value).keyboardType(.decimalPad)
        TextField("Cost basis", text: $basis).keyboardType(.decimalPad)
        TextField("Price date · YYYY-MM-DD", text: $date)
        Picker("Asset type", selection: $type) {
          ForEach(["Equity", "ETF", "Fixed income", "Cash", "Other"], id: \.self) { Text($0) }
        }
        Text("Leave unknown valuations empty. Holdings do not silently change account balances.")
          .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
            Color.assetSecondary)
      }
    }.onAppear {
      guard !loaded else { return }
      loaded = true
      account =
        store.accounts.first { $0.text("type") == "investment" && $0.text("source") != "bitcoin" }?
        .id ?? ""
      if let h = holding {
        symbol = h.text("symbol")
        name = h.text("name")
        account = h.text("accountId")
        quantity = h.text("quantity")
        price = h.missing("price") ? "" : String(h.number("price") / 100)
        value = h.missing("marketValue") ? "" : String(h.number("marketValue") / 100)
        basis = h.missing("costBasis") ? "" : String(h.number("costBasis") / 100)
        date = String(h.text("priceAt").prefix(10))
        type = h.text("type")
      }
    }
  }
}

struct TransactionDetailSheet: View {
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  let transaction: Row
  @State private var category = ""
  @State private var notes = ""
  @State private var remember = false
  @State private var choosing = false
  @State private var advanced = false
  @State private var working = false
  @State private var error = ""
  @State private var loaded = false
  @State private var contentHeight: CGFloat = 520
  private var current: Row {
    store.transactions.first(where: { $0.id == transaction.id }) ?? transaction
  }
  private var dateLabel: String {
    let parser = DateFormatter()
    parser.dateFormat = "yyyy-MM-dd"
    parser.locale = Locale(identifier: "en_US_POSIX")
    guard let date = parser.date(from: current.text("date")) else { return current.text("date") }
    return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day().year())
  }
  private var categoryRow: Row {
    store.categories.first(where: { $0.id == category }) ?? Row(["id": "other", "name": "Other"])
  }
  private var account: Row {
    store.accounts.first(where: { $0.id == current.text("accountId") }) ?? Row([:])
  }
  private var changed: Bool {
    category != current.text("categoryId") || notes != current.text("notes")
  }
  private var suggestion: Row { store.calculation("categorySuggestion", [current.data]) }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          VStack(spacing: 6) {
            Text(current.flag("reviewed") ? "Transaction" : "Transaction to review")
              .font(.custom("Lato-Medium", size: 12, relativeTo: .caption)).foregroundStyle(
                Color.assetBlue)
            Text(dateLabel + (current.flag("pending") ? " · Pending" : ""))
              .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
                Color.assetSecondary)
          }.padding(.top, 20)
          Text(current.text("name")).font(.custom("Lato-Medium", size: 21, relativeTo: .title2))
            .multilineTextAlignment(.center).padding(.top, 8)
          Text(money(current.data["amount"], current.text("currency")))
            .font(.custom("Lato-Medium", size: 32, relativeTo: .largeTitle)).monospacedDigit()
            .foregroundStyle(
              ["income", "refund"].contains(current.text("kind"))
                ? Color.assetGreen : Color.assetText)
          TextField("Add a note", text: $notes, axis: .vertical).lineLimit(1...4)
            .multilineTextAlignment(.center).font(
              .custom("Lato-Regular", size: 15, relativeTo: .subheadline)
            )
            .padding(.bottom, 6).accessibilityLabel("Transaction note")
          VStack(spacing: 8) {
            Text("CATEGORY").font(.custom("Lato-Medium", size: 11, relativeTo: .caption2))
              .foregroundStyle(Color.assetSecondary)
            Button {
              choosing = true
            } label: {
              CategoryBadge(category: categoryRow).padding(7)
            }.buttonStyle(.plain).accessibilityLabel("Category: \(categoryRow.text("name"))")
            if !suggestion.text("categoryId").isEmpty && suggestion.text("categoryId") != category,
              let match = store.categories.first(where: { $0.id == suggestion.text("categoryId") })
            {
              Button("Use \(match.text("name")) · \(suggestion.text("reason"))") {
                category = match.id
              }
              .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
                Color.assetBlue
              ).frame(minHeight: 44)
            }
          }
          if category != current.text("categoryId") {
            Toggle(isOn: $remember) {
              VStack(alignment: .leading, spacing: 3) {
                Text("Use this category next time")
                Text("Same merchant, same account").font(
                  .custom("Lato-Regular", size: 12, relativeTo: .caption)
                ).foregroundStyle(Color.assetSecondary)
              }
            }.font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).tint(.assetBlue)
          }
          AccountCard(account: account).frame(maxWidth: 240).padding(.top, 4)
          if current.flag("excluded") {
            Text("Excluded from budget").font(
              .custom("Lato-Regular", size: 12, relativeTo: .caption)
            ).foregroundStyle(Color.assetSecondary)
          }
          if !current.rows("splits").isEmpty {
            Text("Split across \(current.rows("splits").count) categories").font(
              .custom("Lato-Regular", size: 12, relativeTo: .caption)
            ).foregroundStyle(Color.assetSecondary)
          }
          if !error.isEmpty {
            Text(error).font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
              .foregroundStyle(Color.assetError)
          }
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
              moreButton
              Spacer(minLength: 0)
              if changed && !current.flag("reviewed") { saveButton }
              reviewButton
            }
            VStack(spacing: 10) {
              reviewButton
              HStack {
                moreButton
                Spacer()
                if changed && !current.flag("reviewed") { saveButton }
              }
            }
          }.padding(.top, 10)
        }.padding(.horizontal, 20).padding(.bottom, 18).frame(maxWidth: .infinity)
          .onGeometryChange(for: CGFloat.self) { ceil($0.size.height) } action: { contentHeight = $0 }
      }.scrollBounceBehavior(.basedOnSize)
        .background(Color.assetSurface).foregroundStyle(Color.assetText)
        .toolbar(.hidden, for: .navigationBar)
    }.presentationDetents([.height(contentHeight), .large]).presentationDragIndicator(.visible)
      .presentationCornerRadius(28).presentationBackground(Color.assetSurface)
      .interactiveDismissDisabled(working).disabled(working)
      .sheet(isPresented: $choosing) { TransactionCategorySheet(value: $category) }
      .sheet(isPresented: $advanced) { TransactionForm(transaction: current) }
      .onChange(of: advanced) { _, open in
        if !open {
          category = current.text("categoryId")
          notes = current.text("notes")
          remember = false
        }
      }
      .onAppear {
        if !loaded {
          category = current.text("categoryId")
          notes = current.text("notes")
          loaded = true
        }
      }
  }
  private var moreButton: some View {
    Button("More details") { commit(review: false, close: false) { advanced = true } }.buttonStyle(
      AssetBorderButtonStyle())
  }
  private var saveButton: some View {
    Button("Save") { commit(review: false) }.foregroundStyle(Color.assetBlue).frame(minHeight: 44)
  }
  private var reviewButton: some View {
    Button {
      commit(review: !current.flag("reviewed"))
    } label: {
      Label(
        working ? "Saving…" : current.flag("reviewed") ? "Save changes" : "Mark as reviewed",
        systemImage: "checkmark")
    }.buttonStyle(AssetPrimaryButtonStyle())
  }
  private func commit(review: Bool, close: Bool = true, after: @escaping () -> Void = {}) {
    guard !working else { return }
    working = true
    error = ""
    let generation = store.workspaceGeneration
    let original = current
    let chosenCategory = category
    let chosenNotes = notes
    let learn = remember
    Task { @MainActor in
      defer { working = false }
      do {
        var edits: JSON = ["notes": chosenNotes]
        if chosenCategory != original.text("categoryId") { edits["categoryId"] = chosenCategory }
        if chosenCategory != original.text("categoryId") || chosenNotes != original.text("notes") {
          try await store.command("transaction.update", ["id": original.id, "edits": edits])
        }
        guard generation == store.workspaceGeneration else { return }
        if learn && chosenCategory != original.text("categoryId") {
          let existingRule = store.row.rows("rules").first {
            $0.text("match") == "exact" && $0.text("accountId") == original.text("accountId")
              && $0.text("merchant").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                == original.text("name").trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
          }
          try await store.command(
            "rule.save",
            [
              "id": existingRule?.id ?? uid(), "merchant": original.text("name"), "match": "exact",
              "accountId": original.text("accountId"), "categoryId": chosenCategory,
            ])
        }
        guard generation == store.workspaceGeneration else { return }
        if review {
          try await store.command("transactions.review", ["ids": [original.id], "reviewed": true])
        }
        guard generation == store.workspaceGeneration else { return }
        if close { dismiss() } else { after() }
      } catch {
        if generation == store.workspaceGeneration { self.error = error.localizedDescription }
      }
    }
  }
}

struct TransactionCategorySheet: View {
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  @Binding var value: String
  @State private var search = ""
  var body: some View {
    NavigationStack {
      List {
        ForEach(
          store.categories.filter {
            !$0.flag("archived")
              && (search.isEmpty || $0.text("name").localizedCaseInsensitiveContains(search))
          }
        ) { category in
          Button {
            value = category.id
            dismiss()
          } label: {
            HStack {
              CategoryBadge(category: category)
              Spacer()
              if category.id == value {
                Image(systemName: "checkmark").foregroundStyle(Color.assetBlue)
              }
            }.frame(minHeight: 40).contentShape(Rectangle())
          }.listRowBackground(Color.assetSurface)
        }
      }.searchable(text: $search, prompt: "Search categories").navigationTitle("Category")
        .navigationBarTitleDisplayMode(.inline).scrollContentBackground(.hidden).background(
          Color.assetBackground
        )
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
    }.tint(.assetBlue).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
  }
}
