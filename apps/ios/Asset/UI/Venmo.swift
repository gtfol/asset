import SwiftUI

struct VenmoConnectionView: View {
  @EnvironmentObject var store: Store
  @State private var inbox: JSON = [:]
  @State private var email = ""
  @State private var account = ""
  @State private var transfers = true
  @State private var busy = false
  @State private var error = ""
  @State private var selected: Row?
  @State private var active = true
  private var routes: [Row] { (inbox["routes"] as? [JSON] ?? []).map(Row.init) }
  private var receipts: [Row] { (inbox["receipts"] as? [JSON] ?? []).map(Row.init) }
  private var available: [Row] {
    store.accounts.filter { a in
      a.text("type") == "checking" && a.text("currency") == "USD"
        && ["manual", "csv", "venmo"].contains(a.text("source"))
        && !routes.contains { $0.flag("active") && $0.text("accountId") == a.id }
    }
  }
  var body: some View {
    List {
      Section {
        Text("Forward payment receipts to track Venmo payments and reimbursements. No Venmo password or inbox access needed.")
      }
      if inbox["configured"] as? Bool == false {
        Text("Email receiving is being set up. Your imported Venmo history is available in Transactions.")
      }
      ForEach(routes) { route in
        Section(store.accounts.first { $0.id == route.text("accountId") }?.text("name") ?? "Venmo") {
          Text(route.flag("active") ? "Forwarding enabled" : "Paused")
          Text("Receipts for \(route.text("sourceEmail"))")
          if route.flag("active") {
            Text(route.text("address")).font(.footnote).textSelection(.enabled)
            Button("Copy forwarding address") { UIPasteboard.general.string = route.text("address") }
            Text("1. In Gmail settings, open Forwarding and POP/IMAP and add this address.\n\n2. Return here and tap Refresh. Enter the confirmation code in Gmail.\n\n3. Create a filter for mail from venmo@venmo.com and forward matching messages to this address. Leave forwarding for all other mail off.")
              .font(.subheadline)
            if !route.text("verificationCode").isEmpty {
              Text("Gmail confirmation code: \(route.text("verificationCode"))").textSelection(.enabled)
            }
            Text("Other email providers can use a forwarding rule for the same sender. Manually forward older receipts from your receipt email address for review.").font(.footnote)
            Text("Last received: \(route.text("lastReceivedAt", "not yet"))").font(.footnote)
            Button("Pause receipt forwarding") { perform("/\(route.id)/pause", body: [:]) }
          }
        }
      }
      if inbox["configured"] as? Bool == true {
        Section("Add or reconnect a Venmo account") {
          TextField("Email receiving Venmo receipts", text: $email).keyboardType(.emailAddress)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          Picker("Save payments to", selection: $account) {
            Text("New Venmo account").tag("")
            ForEach(available) { Text($0.text("name")).tag($0.id) }
          }
          Toggle("Treat bank funding and cash-outs as transfers", isOn: $transfers)
          Text("This also updates matching Plaid bank entries. Your own classifications are preserved.").font(.footnote)
          Button("Create forwarding address") {
            var body: JSON = ["sourceEmail": email, "bankTransfers": transfers]
            if !account.isEmpty { body["accountId"] = account }
            perform("/", body: body)
          }.disabled(email.isEmpty)
          Text("Receipts do not sync the Venmo balance. Incoming payments start as reimbursements; change them to income when appropriate.").font(.footnote)
        }
      }
      if !receipts.isEmpty {
        Section("Recent receipts") {
          ForEach(receipts) { receipt in
            if receipt.text("status") == "review" {
              Button { selected = receipt } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(receipt.text("subject", "Receipt"))
                  Text("Review needed").font(.footnote).foregroundStyle(Color.assetSecondary)
                }
              }
            } else {
              Text(receipt.text("status") == "duplicate" ? "Matched existing transaction" : receipt.text("status").capitalized)
            }
          }
        }
      }
      if !error.isEmpty { Text(error).foregroundStyle(Color.assetAmber) }
    }
    .font(.custom("Lato-Regular", size: 16, relativeTo: .body))
    .navigationTitle("Venmo").disabled(busy)
    .toolbar { Button(busy ? "Loading…" : "Refresh") { perform() }.disabled(busy) }
    .onAppear {
      active = true
      if account.isEmpty { account = available.first { $0.text("name").localizedCaseInsensitiveContains("venmo") }?.id ?? "" }
      perform()
    }
    .onDisappear { active = false; busy = false }
    .onChange(of: store.workspaceGeneration) { _, _ in
      inbox = [:]; selected = nil; email = ""; account = ""; error = ""; busy = false
      perform()
    }
    .sheet(item: $selected) { receipt in
      NavigationStack {
        VenmoReceiptView(receipt: receipt,
          accountId: routes.first { $0.id == receipt.text("routeId") }?.text("accountId") ?? "") { path, body in
            selected = nil
            perform(path, body: body)
          }
      }.environmentObject(store)
    }
  }
  private func perform(_ path: String? = nil, body: JSON? = nil) {
    guard !busy, store.mode == "remote", !store.isDemo else { return }
    let generation = store.workspaceGeneration, server = store.baseURL, token = SessionKey.read()
    func current() -> Bool {
      active && store.mode == "remote" && store.workspaceGeneration == generation
        && store.baseURL == server && SessionKey.read() == token
    }
    busy = true; error = ""
    Task { @MainActor in
      defer { if current() { busy = false } }
      do {
        if let path { _ = try await store.request("/venmo" + (path == "/" ? "" : path), body: body, server: server, token: token) }
        guard current() else { return }
        let result = try await store.request("/venmo", server: server, token: token)
        guard current() else { return }
        inbox = result
        if let _ = path { await store.refresh() }
      } catch { if current() { self.error = error.localizedDescription } }
    }
  }
}

private struct VenmoReceiptView: View {
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  let receipt: Row
  let accountId: String
  let save: (String, JSON) -> Void
  @State private var name = ""
  @State private var date = ""
  @State private var amount = ""
  @State private var kind = "spending"
  @State private var category = "other"
  @State private var notes = ""
  @State private var receiptID = ""
  @State private var existing = ""
  private var cents: Int? {
    guard amount.range(of: #"^\d+(\.\d{1,2})?$"#, options: .regularExpression) != nil,
      let n = Decimal(string: amount, locale: Locale(identifier: "en_US_POSIX")), n > 0, n < 1_000_000_000 else { return nil }
    return NSDecimalNumber(decimal: n * 100).intValue
  }
  private var matches: [Row] {
    store.transactions.filter {
      !$0.flag("removed") && $0.text("providerId").isEmpty
        && ["manual", "csv"].contains($0.text("source"))
        && $0.text("accountId") == accountId && $0.text("date") == date
        && ($0.data["amount"] as? Int) == cents
    }
  }
  var body: some View {
    Form {
      Section {
        Text(receipt.text("reason"))
        if !receipt.text("text").isEmpty {
          DisclosureGroup("Receipt text") { Text(receipt.text("text")).font(.footnote).textSelection(.enabled) }
        }
      }
      if !receipt.text("text").isEmpty {
        Section("Payment details") {
          TextField("Person or merchant", text: $name)
          TextField("Date (YYYY-MM-DD)", text: $date).keyboardType(.numbersAndPunctuation)
          TextField("Amount (USD)", text: $amount).keyboardType(.decimalPad)
          Picker("Type", selection: $kind) {
            Text("Payment sent").tag("spending")
            Text("Reimbursement received").tag("refund")
            Text("Income received").tag("income")
            Text("Transfer").tag("transfer")
          }
          Picker("Category", selection: $category) { ForEach(store.categories) { Text($0.text("name")).tag($0.id) } }
          TextField("Note", text: $notes, axis: .vertical)
          TextField("Venmo transaction ID (if shown)", text: $receiptID)
          Picker("Existing imported payment", selection: $existing) {
            Text("Check automatically or add").tag("")
            ForEach(matches) { Text($0.text("name")).tag($0.id) }
          }
          Button("Confirm payment") {
            var body: JSON = ["receipt": ["receiptId": receiptID.isEmpty ? "email:\(receipt.id)" : receiptID,
              "date": date, "name": name, "amount": cents ?? 0, "kind": kind,
              "categoryId": category, "notes": notes]]
            if !existing.isEmpty { body["existingId"] = existing }
            save("/receipts/\(receipt.id)/confirm", body)
          }.disabled(name.isEmpty || date.count != 10 || cents == nil)
        }
      } else { Text("The receipt preview has expired. Add the payment manually in Transactions if needed.") }
      Button("Ignore receipt") { save("/receipts/\(receipt.id)/ignore", [:]) }
    }
    .navigationTitle("Review receipt")
    .toolbar { Button("Cancel") { dismiss() } }
    .onChange(of: date) { _, _ in existing = "" }
    .onChange(of: amount) { _, _ in existing = "" }
    .onAppear {
      let value = Row(receipt.data["receipt"] as? JSON ?? [:])
      name = value.text("name"); date = value.text("date"); kind = value.text("kind", "spending")
      category = value.text("categoryId", "other"); notes = value.text("notes"); receiptID = value.text("receiptId")
      if let cents = value.data["amount"] as? Int { amount = String(format: "%.2f", Double(cents) / 100) }
    }
  }
}
