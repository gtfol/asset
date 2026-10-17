import LinkKit
import SwiftUI
import UniformTypeIdentifiers

struct ShareSheet: UIViewControllerRepresentable {
  let url: URL
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [url], applicationActivities: nil)
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
struct SharedFile: Identifiable {
  let id = UUID()
  let url: URL
}
struct ServerLoginView: View {
  @EnvironmentObject var store: Store
  @SwiftUI.Environment(\.dismiss) var dismiss
  @StateObject private var authentication = GoogleAuthentication()
  @State private var signInTask: Task<Void, Never>?
  @State var server = GoogleSignIn.defaultServer
  @State var error = ""
  @State var busy = false
  var body: some View {
    NavigationStack {
      List {
        Section {
          Text("Sign in to sync your workspace across devices.")
            .foregroundStyle(Color.assetSecondary)
          Button(busy ? "Signing in…" : "Continue with Google") {
            busy = true
            error = ""
            signInTask = Task {
              do {
                try await store.signInWithGoogle(server: server) { url in
                  try await authentication.authenticate(url)
                }
                dismiss()
              } catch is CancellationError {
              } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
              }
              busy = false
            }
          }.frame(minHeight: 44).disabled(busy)
        }
        Section {
          DisclosureGroup("Server") {
            TextField("HTTPS server address", text: $server).textInputAutocapitalization(.never)
              .autocorrectionDisabled().keyboardType(.URL).disabled(busy)
            Text("Use asset.gtfol.dev, or enter your own Asset server address.")
              .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
              .foregroundStyle(Color.assetSecondary)
          }
        }
        if !error.isEmpty { Text(error).foregroundStyle(Color.assetError) }
      }.assetTitle("Connect your workspace").toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            signInTask?.cancel()
            authentication.cancel()
            dismiss()
          }
        }
        .quietBackground()
      }
      .onAppear { server = store.baseURL }
      .onDisappear {
        signInTask?.cancel()
        authentication.cancel()
      }
    }
  }
}
struct SettingsView: View {
  @AppStorage("appearance") var appearance = "system"
  @EnvironmentObject var store: Store
  @SwiftUI.Environment(\.dismiss) var dismiss
  @State var share: SharedFile?
  @State var restorePicker = false
  @State var restore: JSON?
  @State var confirm = ""
  var body: some View {
    NavigationStack {
      List {
        Section {
          LabeledContent(
            "Workspace",
            value: store.isDemo
              ? "Synthetic demo"
              : store.mode == "remote" ? "Shared server" : "Private · this device")
        }
        Section("Your data") {
          NavigationLink("Import CSV") { ImportView() }
          Button("Export full backup") { export(true) }
          Button("Export transactions CSV") { export(false) }
          Button("Restore backup") { restorePicker = true }
          Text(
            "Full backups preserve all records and splits. Connection secrets are omitted. Exported files contain financial data; share only where you intend."
          ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
            Color.assetSecondary)
        }
        if let restore {
          Section("Replace this workspace") {
            Text(
              "\(Row(restore).rows("transactions").count) transactions and \(Row(restore).rows("accounts").count) accounts. Your current data will be preserved as a local recovery file first."
            )
            TextField("Type RESTORE", text: $confirm)
            Button("Back up and restore") {
              Task {
                do {
                  let before = try store.engine.call("backup", [store.state])
                  try JSONSerialization.data(withJSONObject: before).write(
                    to: store.fileURL("before-restore"),
                    options: [.atomic, .completeFileProtection])
                  try await store.command("backup.restore", ["state": restore])
                  self.restore = nil
                  confirm = ""
                } catch { store.error = error.localizedDescription }
              }
            }.disabled(confirm != "RESTORE")
            Button("Share recovery backup") {
              do { share = SharedFile(url: try store.fileURL("before-restore")) } catch {
                store.error = error.localizedDescription
              }
            }
          }
        }
        Section("Appearance") {
          Picker("Theme", selection: $appearance) {
            Text("System").tag("system")
            Text("Light").tag("light")
            Text("Dark").tag("dark")
          }
        }
        Section("Privacy") {
          Label("Touch ID or Face ID on reopen", systemImage: "lock")
          Text(
            "Your device passcode is available as a fallback. Financial information is covered in the app switcher."
          )
          .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
            Color.assetSecondary)
        }
        Section {
          NavigationLink("Notifications") { NotificationSettings() }
        }
        Section("Reporting") {
          Picker(
            "Currency",
            selection: Binding(
              get: { store.currency }, set: { store.perform("settings.save", ["currency": $0]) })
          ) { ForEach(["USD", "CAD", "EUR", "GBP"], id: \.self) { Text($0) } }
          Text("Other currencies remain visible on accounts; totals do not assume exchange rates.")
            .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
              Color.assetSecondary)
        }
        Section("Category rules") {
          ForEach(store.row.rows("rules")) { r in
            VStack(alignment: .leading) {
              Text(r.text("merchant"))
              Text(
                "\(r.text("match")) · \(r.missing("accountId") ? "All accounts" : "This account")"
              ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
                Color.assetSecondary)
              Button("Remove rule", role: .destructive) {
                store.perform("rule.delete", ["id": r.id])
              }
            }
          }
        }
        Section {
          NavigationLink("Connections") { ConnectionsView() }
          NavigationLink("Third-party licenses") {
            ScrollView {
              Text(
                Bundle.main.url(forResource: "third-party-notices", withExtension: "txt").flatMap {
                  try? String(contentsOf: $0, encoding: .utf8)
                } ?? "See the repository dependency notices."
              )
              .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).textSelection(.enabled)
              .padding()
            }.assetTitle("Licenses")
          }
          Button("Sign out") {
            store.signOut()
            dismiss()
          }
        }
      }.assetTitle("Settings & data").toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
          .quietBackground()
      }.sheet(
        item: $share
      ) { ShareSheet(url: $0.url) }.fileImporter(
        isPresented: $restorePicker, allowedContentTypes: [.json]
      ) { result in
        do {
          let url = try result.get()
          let access = url.startAccessingSecurityScopedResource()
          defer { if access { url.stopAccessingSecurityScopedResource() } }
          let data = try Data(contentsOf: url)
          guard data.count < 12 * 1024 * 1024 else { throw failure("Backup exceeds 12 MB") }
          let b = Row(try JSONSerialization.jsonObject(with: data) as? JSON ?? [:])
          guard b.text("format") == "asset-backup", b.integer("version") == 1 else {
            throw failure("Not an Asset v1 backup")
          }
          let s = try store.engine.call("validateState", [b.object("state").data]) as? JSON ?? [:]
          guard Row(s).object("settings").flag("demo") == store.isDemo else {
            throw failure("Demo and private data cannot be mixed")
          }
          restore = s
        } catch { store.error = error.localizedDescription }
      }
    }
  }
  func export(_ backup: Bool) {
    do { share = SharedFile(url: try store.export(backup: backup)) } catch {
      store.error = error.localizedDescription
    }
  }
}
struct ImportView: View {
  @EnvironmentObject var store: Store
  @State var choosing = false
  @State var text = ""
  @State var headers: [String] = []
  @State var mapping = [
    "date": "date", "name": "name", "amount": "amount", "category": "", "type": "", "currency": "",
  ]
  @State var account = ""
  @State var dateFormat = "YYYY-MM-DD"
  @State var convention = "outflow-positive"
  @State var preview: Row?
  @State var report = ""
  var isCopilot: Bool {
    ["account mask", "parent category", "excluded", "status"].allSatisfy(headers.contains)
  }
  var options: JSON {
    [
      "mapping": mapping, "accountId": account,
      "currency": store.accounts.first { $0.id == account }?.text("currency") ?? store.currency,
      "dateFormat": dateFormat, "amountConvention": convention,
    ]
  }
  var body: some View {
    List {
      Section {
        Button("Choose CSV file") { choosing = true }
        if !report.isEmpty { Text(report).foregroundStyle(Color.assetGreen) }
      }
      if isCopilot { CopilotImportSections(text: text).id(text) }
      if !headers.isEmpty && !isCopilot {
        Section("Map columns") {
          ForEach(["date", "name", "amount", "category", "type", "currency"], id: \.self) { key in
            Picker(
              key.capitalized,
              selection: Binding(
                get: { mapping[key] ?? "" },
                set: {
                  mapping[key] = $0
                  preview = nil
                })
            ) {
              Text("Select column").tag("")
              ForEach(headers, id: \.self) { Text($0) }
            }
          }
        }
        Section("Import conventions") {
          Picker("Account", selection: $account) {
            ForEach(store.accounts) { Text($0.text("name")).tag($0.id) }
          }
          Picker("Dates", selection: $dateFormat) {
            ForEach(["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY"], id: \.self) { Text($0) }
          }
          Picker("Amounts", selection: $convention) {
            Text("Positive spending, negative income").tag("outflow-positive")
            Text("Negative spending, positive income").tag("outflow-negative")
          }
          Text(
            "A mapped type overrides the sign. Use refund, transfer, or card_payment for those records. Decimal point: dot; thousands separator: comma."
          ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
            Color.assetSecondary)
          Button("Preview import") {
            do {
              preview = Row(
                try store.engine.call("previewCSV", [text, options, store.state]) as? JSON ?? [:])
            } catch { store.error = error.localizedDescription }
          }
        }
        if let p = preview {
          Section("Preview") {
            Text(
              "\(p.rows("transactions").count) ready · \(p.integer("duplicates")) duplicates · \(p.rows("errors").count) errors"
            )
            ForEach(Array(p.rows("transactions").prefix(8))) { t in
              VStack(alignment: .leading) {
                Text(t.text("name"))
                Text(
                  "\(t.text("date")) · \(t.text("kind")) · \(money(t.data["amount"],t.text("currency")))"
                ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
              }
            }
            ForEach(Array(p.rows("errors").enumerated()), id: \.offset) { _, e in
              Text("Row \(e.integer("row")): \(e.text("message"))").font(
                .custom("Lato-Regular", size: 13, relativeTo: .caption)
              ).foregroundStyle(Color.assetAmber)
            }
            Text(
              "Showing up to 8 valid rows. Invalid and duplicate rows will be skipped. Account coverage remains incomplete until you confirm it in account settings."
            ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
              Color.assetSecondary)
            Button("Import \(p.rows("transactions").count) valid rows") {
              Task {
                do {
                  try await store.command(
                    "import.commit", ["transactions": p.rows("transactions").map(\.data)])
                  report = "Imported \(p.rows("transactions").count) rows to To Review."
                  preview = nil
                  headers = []
                } catch { store.error = error.localizedDescription }
              }
            }.disabled(p.rows("transactions").isEmpty)
          }
        }
      }
    }.assetTitle("Import CSV").onAppear { account = store.accounts.first?.id ?? "" }.onChange(
      of: account
    ) { _, _ in preview = nil }.onChange(of: dateFormat) { _, _ in preview = nil }.onChange(
      of: convention
    ) { _, _ in preview = nil }.fileImporter(
      isPresented: $choosing, allowedContentTypes: [.commaSeparatedText, .plainText]
    ) { result in
      do {
        let url = try result.get()
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        guard data.count < 10 * 1024 * 1024, let str = String(data: data, encoding: .utf8) else {
          throw failure("Choose a UTF-8 CSV below 10 MB")
        }
        text = str
        let p = try store.engine.call("parseCSV", [text]) as? JSON ?? [:]
        headers = p["headers"] as? [String] ?? []
        for k in mapping.keys { mapping[k] = headers.first { $0.lowercased() == k } ?? "" }
        preview = nil
        report = ""
      } catch { store.error = error.localizedDescription }
    }
  }
}
struct CopilotImportSections: View {
  @EnvironmentObject var store: Store
  let text: String
  @State var groups: [Row] = []
  @State var mapping: JSON = [:]
  @State var currency = "USD"
  @State var preview: Row?
  @State var complete = false
  var options: JSON { ["currency": currency, "accounts": mapping] }
  var body: some View {
    Section("Copilot export") {
      Text(
        "Preserves accounts, categories, notes, exclusions, and recurring labels. Balances and holdings are not included."
      )
      .foregroundStyle(Color.assetSecondary)
      Picker("Currency", selection: $currency) {
        ForEach(["USD", "CAD", "EUR", "GBP"], id: \.self) { Text($0) }
      }.onChange(of: currency) { _, _ in preview = nil }
    }
    ForEach(groups, id: \.dataKey) { group in
      let key = group.text("key")
      let selected = Row(mapping[key] as? JSON ?? group.data)
      Section(group.text("name") + (group.text("mask").isEmpty ? "" : " · " + group.text("mask"))) {
        Picker(
          "Import into",
          selection: Binding(
            get: { selected.text("accountId") },
            set: {
              var value = selected.data
              value["accountId"] = $0.isEmpty ? nil : $0
              mapping[key] = value
              preview = nil
            })
        ) {
          Text("Create account").tag("")
          ForEach(
            store.accounts.filter {
              $0.text("source") != "bitcoin" && $0.text("currency") == currency
            }
          ) { a in
            Text(a.text("name") + " " + a.text("mask")).tag(a.id)
          }
        }
        if selected.text("accountId").isEmpty {
          Picker(
            "Type",
            selection: Binding(
              get: { selected.text("type", "manual") },
              set: {
                var value = selected.data
                value["type"] = $0
                mapping[key] = value
                preview = nil
              })
          ) {
            ForEach(["checking", "savings", "credit", "investment", "loan", "manual"], id: \.self) {
              Text($0.capitalized).tag($0)
            }
          }
        }
      }
    }
    Section {
      Button("Preview Copilot import") {
        do {
          preview = Row(
            try store.engine.call("previewCopilot", [text, options, store.state]) as? JSON ?? [:])
        } catch { store.error = error.localizedDescription }
      }.disabled(complete)
      if let p = preview {
        Text(
          "\(p.rows("transactions").count) ready · \(p.rows("updated").count) updated · \(p.integer("duplicates")) already imported"
        )
        Text(
          "\(p.rows("accounts").count) new accounts · \(p.integer("pending")) pending transactions")
        ForEach(Array(p.rows("errors").enumerated()), id: \.offset) { _, error in
          Text("Row \(error.integer("row")): \(error.text("message"))").foregroundStyle(
            Color.assetError)
        }
        Button(
          complete
            ? "Import complete"
            : "Import \(p.rows("transactions").count + p.rows("updated").count) transactions"
        )
        {
          Task {
            do {
              try await store.command("import.copilot", ["text": text, "options": options])
              complete = true
            } catch { store.error = error.localizedDescription }
          }
        }.disabled(
          complete || store.busy
            || (p.rows("transactions").isEmpty && p.rows("updated").isEmpty)
            || !p.rows("errors").isEmpty)
      }
    }.onAppear {
      currency = store.currency
      do {
        groups = (try store.engine.call("copilotAccounts", [text, store.state]) as? [JSON] ?? [])
          .map(Row.init)
      } catch { store.error = error.localizedDescription }
    }
  }
}
extension Row { fileprivate var dataKey: String { text("key") } }
struct NotificationSettings: View {
  @EnvironmentObject var store: Store
  @ObservedObject var delivery = NotificationDelivery.shared
  @State var amount = "500"
  @State var percent = "30"
  let kinds = [
    ("bankFee", "Bank fee alert"), ("bigExpense", "Big expense alert"),
    ("creditUtilization", "Credit utilization alert"), ("income", "Income update"),
    ("recurringPaid", "Recurring paid alert"), ("spending", "Spending update"),
    ("uncategorizedTransfer", "Uncategorized transfer alert"), ("venmo", "Venmo transaction alert"),
  ]
  var preferences: Row { store.calculation("notificationPreferences") }
  var body: some View {
    List {
      Section {
        ForEach(kinds, id: \.0) { key, title in
          Toggle(
            title,
            isOn: Binding(
              get: { preferences.flag(key) },
              set: {
                store.perform("notifications.preferences", [key: $0])
              })
          ).disabled(store.busy)
        }
      }
      Section("Thresholds") {
        TextField("Big expense (\(store.currency))", text: $amount).keyboardType(.decimalPad)
        TextField("Credit utilization (%)", text: $percent).keyboardType(.numberPad)
        Button("Save thresholds") {
          do {
            guard let value = Int(percent), (1...100).contains(value) else {
              throw failure("Enter a percentage from 1 to 100")
            }
            store.perform(
              "notifications.preferences",
              ["bigExpenseAmount": try store.cents(amount), "creditUtilizationPercent": value])
          } catch { store.error = error.localizedDescription }
        }.disabled(store.busy)
      }
      Section("Delivery") {
        Text(delivery.message).foregroundStyle(Color.assetSecondary)
        if delivery.available && !delivery.enabled {
          Button("Enable iPhone notifications") { Task { await delivery.enable() } }
          Button("Open notification settings") {
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
              UIApplication.shared.open(url)
            }
          }
        }
        Text(
          "Alerts follow newly posted activity. Imported history stays quiet. Credit alerts need a reported credit limit; recurring alerts follow labeled payments. Spending updates arrive after 7 pm in your workspace’s time zone. Venmo alerts begin when new activity is received."
        )
        .font(.custom("Lato-Regular", size: 13, relativeTo: .caption)).foregroundStyle(
          Color.assetSecondary)
      }
    }.assetTitle("Notifications").task {
      amount = String(preferences.integer("bigExpenseAmount") / 100)
      percent = String(preferences.integer("creditUtilizationPercent"))
      await delivery.prepare(store: store)
    }
  }
}
struct NotificationInbox: View {
  @EnvironmentObject var store: Store
  @SwiftUI.Environment(\.dismiss) var dismiss
  var items: [Row] { store.row.object("notifications").rows("items") }
  var body: some View {
    NavigationStack {
      List {
        if items.isEmpty {
          Text("You’re up to date. Alerts appear after new activity syncs.").foregroundStyle(
            Color.assetSecondary)
        }
        ForEach(items) { item in
          NavigationLink {
            if let id = item.data["transactionId"] as? String,
              let transaction = store.transactions.first(where: { $0.id == id })
            {
              TransactionForm(transaction: transaction)
            } else {
              Text(item.text("body")).padding().assetTitle(item.text("title"))
            }
          } label: {
            VStack(alignment: .leading, spacing: 8) {
              Text(item.text("title")).font(
                .custom(item.flag("read") ? "Lato-Regular" : "Lato-Medium", size: 16))
              Text(item.text("body")).foregroundStyle(Color.assetSecondary)
              Text(String(item.text("createdAt").prefix(10))).font(
                .custom("Lato-Regular", size: 12)
              ).foregroundStyle(Color.assetSecondary)
            }.padding(.vertical, 6)
          }.simultaneousGesture(
            TapGesture().onEnded { store.perform("notifications.read", ["ids": [item.id]]) })
        }
      }.assetTitle("Notifications").toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
          .quietBackground()
        ToolbarItem(placement: .topBarTrailing) {
          Button("Read all") { store.perform("notifications.read", ["ids": items.map(\.id)]) }
            .disabled(items.allSatisfy { $0.flag("read") })
        }.quietBackground()
      }
    }
  }
}
struct LinkImportedAccountsView: View {
  @EnvironmentObject var store: Store
  @State private var mapping: [String: String] = [:]
  @State private var preview: String?
  @State private var complete = ""
  private var imported: [Row] {
    store.accounts.filter { ["csv", "manual"].contains($0.text("source")) && $0.text("connectionId").isEmpty }
  }
  private func candidates(_ account: Row) -> [Row] {
    store.accounts.filter {
      $0.text("source") == "plaid" && $0.text("currency") == account.text("currency")
        && ($0.text("type") == account.text("type") || account.text("type") == "manual")
    }
  }
  private var links: [JSON] {
    imported.compactMap { account in
      guard let target = mapping[account.id], !target.isEmpty else { return nil }
      return ["importedId": account.id, "connectedId": target]
    }
  }
  var body: some View {
    Form {
      Section {
        Text("Link CSV history to the same connected account. Your account name, categories, notes, and older transactions stay with its live balance.")
          .foregroundStyle(Color.assetSecondary)
        if !complete.isEmpty { Text(complete) }
      }
      ForEach(imported) { account in
        Section(account.text("name") + " " + account.text("mask")) {
          Picker("Connected account", selection: Binding(
            get: { mapping[account.id] ?? "" },
            set: { mapping[account.id] = $0; preview = nil }
          )) {
            Text("Keep separate").tag("")
            ForEach(candidates(account)) { target in
              Text(target.text("name") + " " + target.text("mask")).tag(target.id)
            }
          }.disabled(store.busy)
        }
      }
      Section {
        Button("Preview links") {
          do {
            let targets = links.compactMap { $0["connectedId"] as? String }
            guard Set(targets).count == links.count else { throw failure("Choose each connected account only once.") }
            var matched = 0, possible = 0
            for link in links {
              let result = Row(try store.engine.call("previewAccountLink", [store.state, link["importedId"]!, link["connectedId"]!]) as? JSON ?? [:])
              matched += result.rows("pairs").count
              possible += result.integer("possible")
            }
            preview = "\(links.count) accounts selected · \(matched) matching transactions combined."
            if possible > 0 { preview! += " \(possible) other transactions share a date and amount. They remain separate for review." }
          } catch { store.error = error.localizedDescription }
        }.disabled(links.isEmpty || store.busy)
        if let preview {
          Text(preview)
          Button("Link selected accounts") {
            Task {
              do {
                let count = links.count
                try await store.command("import.link-accounts", ["links": links])
                complete = "\(count) accounts linked."
                mapping = [:]
                self.preview = nil
              } catch { store.error = error.localizedDescription }
            }
          }.disabled(store.busy)
        }
      }
    }
    .assetTitle("Link imported history")
    .onAppear {
      for account in imported {
        let matches = candidates(account).filter { !account.text("mask").isEmpty && $0.text("mask") == account.text("mask") }
        mapping[account.id] = matches.count == 1 ? matches[0].id : ""
      }
    }
    .onChange(of: store.workspaceGeneration) { _, _ in mapping = [:]; preview = nil; complete = "" }
  }
}
struct ConnectionsView: View {
  @EnvironmentObject var store: Store
  @State private var product = "transactions"
  @State private var session: PlaidLinkSession?
  @State private var lifecycle = PlaidLinkLifecycle()
  @State private var presenting = false
  @State private var presentedAttempt: UUID?
  @State private var working = false
  @State private var operationID: UUID?
  @State private var operation: Task<Void, Never>?
  @State private var configuration: Row?
  @State private var configurationLoading = false
  @State private var configurationLoadID: UUID?
  @State private var configurationError = ""
  @State private var clientID = ""
  @State private var secret = ""
  @State private var environment = "production"
  @State private var disconnecting: Row?
  @State private var remove = false
  @State private var confirm = ""

  private struct Workspace {
    let generation: Int
    let server: String
    let token: String
  }
  private var remote: Bool { store.mode == "remote" && !store.isDemo }
  private var locked: Bool {
    working || lifecycle.active || configurationLoading || presentedAttempt != nil
  }
  private var storageReady: Bool { configuration?.flag("storageReady") == true }
  private var activeConnections: Bool {
    store.connections.contains { $0.text("status") != "disconnected" }
  }
  private var environments: [String] {
    var values = configuration?.data["supportedEnvironments"] as? [String] ?? ["production"]
    if configuration?.flag("configured") == true, !values.contains(savedEnvironment) {
      values.append(savedEnvironment)
    }
    return values
  }
  private var savedEnvironment: String {
    configuration?.text("environment", "production") ?? "production"
  }
  private var testConnections: Bool {
    configuration?.flag("configured") == true && savedEnvironment == "sandbox"
  }

  private var connectionButtonTitle: String {
    if lifecycle.consumed { return "Saving connection…" }
    if lifecycle.ready { return "Connection ready" }
    if lifecycle.active { return "Preparing connection…" }
    return testConnections ? "Connect test institution" : "Connect institution"
  }

  var body: some View {
    List {
      Section {
        Text(
          testConnections
            ? "Your saved Plaid credentials use Sandbox. These connections use test institutions and test data, not real bank accounts."
            : "Connect bank and investment accounts using your Plaid credentials."
        ).font(.custom("Lato-Regular", size: 15, relativeTo: .subheadline))
      }
      if !remote {
        Text(
          "Sign in to connect your accounts. Local accounts and CSV work without a server."
        )
      } else {
        credentialsSection
        if configuration?.flag("configured") == true {
          if configuration?.flag("workerReady") != true {
            Text(
              "Your Plaid credentials are saved. Bank syncing is not available on this server yet."
            )
            .foregroundStyle(Color.assetSecondary)
          } else {
            Section {
              Picker("Connection type", selection: $product) {
                Text("Bank / card · Transactions").tag("transactions")
                Text("Brokerage · Investments").tag("investments")
              }.disabled(locked)
              Button(connectionButtonTitle) {
                prepare()
              }.disabled(locked)
              if lifecycle.ready {
                Button(testConnections ? "Open Plaid Sandbox" : "Open Plaid") {
                  presentedAttempt = lifecycle.attempt?.id
                  presenting = true
                }
              }
              if lifecycle.active && !lifecycle.consumed {
                Button("Cancel connection") { cancelLink() }
              }
              Text("Investment coverage varies by institution.").font(
                .custom("Lato-Regular", size: 13, relativeTo: .caption)
              ).foregroundStyle(Color.assetSecondary)
            }
          }
        }
      }
      if store.accounts.contains(where: { $0.text("source") == "plaid" }) {
        Section {
          NavigationLink("Link imported history") { LinkImportedAccountsView() }
            .disabled(locked)
        }
      }
      ForEach(store.connections) { c in
        Section(c.text("institution_name")) {
          StatusLabel(text: c.text("status"))
          if c.text("environment") == "sandbox" {
            Text("Sandbox test data")
              .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
              .foregroundStyle(Color.assetSecondary)
          }
          Text(
            "\(c.text("product").capitalized) · Last fetched \(c.text("last_synced_at", "not yet"))"
          )
          .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
          if !c.text("error_code").isEmpty {
            Text(c.text("error_code")).foregroundStyle(Color.assetAmber)
          }
          ForEach(store.accounts.filter { $0.text("connectionId") == c.id }) { a in
            Toggle(
              a.text("name"),
              isOn: Binding(
                get: { a.flag("enabled") },
                set: { value in
                  let ids = store.accounts.filter {
                    $0.text("connectionId") == c.id && ($0.id == a.id ? value : $0.flag("enabled"))
                  }.map { $0.text("providerId") }
                  perform("/plaid/\(c.id)/accounts", body: ["selected": ids])
                })
            ).disabled(locked || c.text("status") == "disconnected")
          }
          if c.text("status") != "disconnected" {
            Button("Check for updates") { perform("/plaid/\(c.id)/sync", body: [:]) }
              .disabled(locked || configuration?.flag("workerReady") != true)
            Button("Reauthenticate / add accounts") { prepare(c.id, product: c.text("product")) }
              .disabled(locked || configuration?.flag("workerReady") != true)
            Button("Disconnect", role: .destructive) {
              disconnecting = c
              remove = false
              confirm = ""
            }.disabled(locked)
          }
        }
      }
      if let c = disconnecting {
        Section("Disconnect \(c.text("institution_name"))") {
          Text("Future access stops. Imported data is retained unless you choose deletion.")
          Toggle("Also delete imported data", isOn: $remove).disabled(locked)
          if remove { TextField("Type DELETE", text: $confirm).disabled(locked) }
          Button("Confirm disconnect", role: .destructive) {
            perform("/plaid/\(c.id)/disconnect", body: ["deleteData": remove, "confirm": confirm]) {
              disconnecting = nil
              remove = false
              confirm = ""
            }
          }.disabled(locked || (remove && confirm != "DELETE"))
          Button("Cancel") { disconnecting = nil }.disabled(locked)
        }
      }
    }
    .assetTitle("Connections")
    .sheet(
      isPresented: $presenting,
      onDismiss: {
        let dismissed = presentedAttempt
        presentedAttempt = nil
        if dismissed == lifecycle.attempt?.id, !lifecycle.consumed { cancelLink() }
      }
    ) {
      session?.sheet().interactiveDismissDisabled()
    }
    .task(id: store.workspaceGeneration) { await loadConfiguration() }
    .onChange(of: store.workspaceGeneration) { _, _ in
      cancelLink()
      configuration = nil
      configurationLoading = false
      configurationLoadID = nil
      configurationError = ""
      clientID = ""
      secret = ""
      disconnecting = nil
    }
    .onDisappear {
      cancelLink()
      configurationLoadID = nil
      configurationLoading = false
      clientID = ""
      secret = ""
    }
  }

  private var credentialsSection: some View {
    Section("Your Plaid credentials") {
      if configurationLoading {
        Text("Loading configuration…").foregroundStyle(Color.assetSecondary)
      } else if !configurationError.isEmpty {
        Text(configurationError).foregroundStyle(Color.assetAmber)
        Button("Try again") { Task { await loadConfiguration() } }.disabled(locked)
      } else if let configuration {
        if configuration.flag("configured") {
          LabeledContent("Client ID", value: "•••• " + configuration.text("clientIdLast4"))
        }
        if !storageReady {
          Text("Secure credential storage is not available on this server yet.")
            .foregroundStyle(Color.assetSecondary)
        }
        if !configuration.text("redirectUri").isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            Text("Plaid redirect URI")
            Text(configuration.text("redirectUri")).textSelection(.enabled)
              .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
            Text("Add this URL to Allowed redirect URIs in your Plaid Dashboard.")
              .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
              .foregroundStyle(Color.assetSecondary)
          }
        }
        if environments.count > 1 {
          Picker("Environment", selection: $environment) {
            ForEach(environments, id: \.self) { value in
              Text(value == "sandbox" ? "Sandbox · Test data" : "Production").tag(value)
            }
          }.disabled(locked || activeConnections || !storageReady)
        }
        if environment == "sandbox" {
          Text(
            "Sandbox credentials connect only test institutions. Select Production and save its credentials to connect real accounts."
          )
          .font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
          .foregroundStyle(Color.assetSecondary)
        }
        TextField("Client ID", text: $clientID)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .disabled(locked || !storageReady)
        SecureField(
          environment == "sandbox" ? "Sandbox secret" : "Production secret", text: $secret
        )
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .disabled(locked || !storageReady)
        Button(configuration.flag("configured") ? "Update credentials" : "Save credentials") {
          let payload: JSON = [
            "clientId": clientID.trimmingCharacters(in: .whitespacesAndNewlines),
            "secret": secret.trimmingCharacters(in: .whitespacesAndNewlines),
            "environment": environment,
          ]
          secret = ""
          perform("/plaid/config", body: payload, method: "PUT", reloadConfiguration: true) {
            clientID = ""
          }
        }.disabled(
          locked || !storageReady
            || clientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        if configuration.flag("configured") {
          Button("Remove credentials", role: .destructive) {
            secret = ""
            perform("/plaid/config", method: "DELETE", reloadConfiguration: true) {
              clientID = ""
            }
          }.disabled(locked || activeConnections)
        }
        Text(
          activeConnections
            ? "To rotate your secret, enter the same full Client ID and the new secret. Disconnect your institutions before changing your Plaid account or environment, or removing credentials."
            : "Your server validates and encrypts these credentials. The secret is never saved on this device."
        ).font(.custom("Lato-Regular", size: 13, relativeTo: .caption))
          .foregroundStyle(Color.assetSecondary)
      }
    }
  }

  private func workspace() -> Workspace? {
    guard remote, let token = SessionKey.read() else { return nil }
    return Workspace(generation: store.workspaceGeneration, server: store.baseURL, token: token)
  }

  private func current(_ workspace: Workspace) -> Bool {
    remote && workspace.generation == store.workspaceGeneration && workspace.server == store.baseURL
      && workspace.token == SessionKey.read()
  }

  private func current(_ attempt: PlaidLinkAttempt) -> Bool {
    lifecycle.attempt?.id == attempt.id && remote
      && attempt.workspaceGeneration == store.workspaceGeneration && attempt.server == store.baseURL
      && attempt.token == SessionKey.read()
  }

  private func loadConfiguration() async {
    guard let workspace = workspace() else { return }
    let id = UUID()
    configurationLoadID = id
    configurationLoading = true
    configurationError = ""
    defer {
      if configurationLoadID == id {
        configurationLoading = false
        configurationLoadID = nil
      }
    }
    do {
      let result = try await store.request(
        "/plaid/config", server: workspace.server, token: workspace.token)
      try Task.checkCancellation()
      guard current(workspace), configurationLoadID == id else { return }
      configuration = Row(result)
      let supported = result["supportedEnvironments"] as? [String] ?? ["production"]
      let saved = result["environment"] as? String ?? "production"
      environment =
        result["configured"] as? Bool == true || supported.contains(saved)
        ? saved : (supported.first ?? "production")
    } catch is CancellationError {
    } catch {
      guard current(workspace), configurationLoadID == id, !Task.isCancelled else { return }
      configurationError = error.localizedDescription
    }
  }

  private func perform(
    _ path: String, body: JSON? = nil, method: String? = nil, reloadConfiguration: Bool = false,
    onSuccess: @escaping () -> Void = {}
  ) {
    guard !locked, let workspace = workspace() else { return }
    working = true
    let id = UUID()
    operationID = id
    operation = Task { @MainActor in
      defer {
        if operationID == id {
          working = false
          operationID = nil
        }
      }
      do {
        try Task.checkCancellation()
        guard current(workspace) else { return }
        _ = try await store.request(
          path, body: body, server: workspace.server, token: workspace.token, method: method)
        try Task.checkCancellation()
        guard current(workspace) else { return }
        onSuccess()
      } catch is CancellationError {
        return
      } catch {
        guard current(workspace), !Task.isCancelled else { return }
        store.error = error.localizedDescription
      }
      guard current(workspace), !Task.isCancelled else { return }
      if reloadConfiguration { await loadConfiguration() }
      await store.refresh()
    }
  }

  private func cancelLink() {
    operation?.cancel()
    operation = nil
    operationID = nil
    if let attempt = lifecycle.attempt { lifecycle.finish(attempt.id) }
    session = nil
    presenting = false
    working = false
  }

  private func prepare(_ id: String? = nil, product selectedProduct: String? = nil) {
    guard !locked, let workspace = workspace() else { return }
    let attempt = PlaidLinkAttempt(
      product: selectedProduct ?? product, connectionID: id,
      workspaceGeneration: workspace.generation, server: workspace.server, token: workspace.token)
    guard lifecycle.begin(attempt) else { return }
    operation = Task { @MainActor in
      do {
        var payload: JSON = ["product": attempt.product]
        if let id = attempt.connectionID { payload["connectionId"] = id }
        let response = try await store.request(
          "/plaid/link-token", body: payload, server: attempt.server, token: attempt.token)
        try Task.checkCancellation()
        guard current(attempt) else { return }
        guard let token = response["link_token"] as? String, !token.isEmpty else {
          throw failure("Link token unavailable. Please try again.")
        }
        let config = LinkTokenConfiguration(
          token: token,
          onSuccess: { success in
            Task { @MainActor in
              guard current(attempt), lifecycle.consume(attempt.id) else { return }
              presenting = false
              session = nil
              complete(
                attempt, publicToken: success.publicToken,
                selected: success.metadata.accounts.map(\.id))
            }
          },
          onExit: { exit in
            Task { @MainActor in
              guard current(attempt), !lifecycle.consumed else { return }
              lifecycle.finish(attempt.id)
              presenting = false
              session = nil
              if let error = exit.error {
                let display = error.displayMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
                if let display, !display.isEmpty {
                  store.error = display
                } else {
                  store.error = "Bank connection could not be completed. Please try again."
                }
              }
            }
          }, onEvent: nil,
          onLoad: {
            Task { @MainActor in
              guard current(attempt) else { return }
              _ = lifecycle.loaded(attempt.id)
            }
          })
        session = try Plaid.createPlaidLinkSession(configuration: config)
      } catch is CancellationError {
        if current(attempt) { lifecycle.finish(attempt.id) }
      } catch {
        guard current(attempt) else { return }
        lifecycle.finish(attempt.id)
        session = nil
        store.error = error.localizedDescription
      }
    }
  }

  private func complete(_ attempt: PlaidLinkAttempt, publicToken: String, selected: [String]) {
    operation = Task { @MainActor in
      defer { lifecycle.finish(attempt.id) }
      do {
        try Task.checkCancellation()
        guard current(attempt) else { return }
        if let id = attempt.connectionID {
          _ = try await store.request(
            "/plaid/\(id)/update-complete", body: ["selected": selected],
            server: attempt.server, token: attempt.token)
        } else {
          _ = try await store.request(
            "/plaid/exchange",
            body: ["publicToken": publicToken, "product": attempt.product, "selected": selected],
            server: attempt.server, token: attempt.token)
        }
        try Task.checkCancellation()
      } catch is CancellationError {
        return
      } catch {
        guard current(attempt) else { return }
        store.error = error.localizedDescription
      }
      if current(attempt), !Task.isCancelled { await store.refresh() }
    }
  }
}
