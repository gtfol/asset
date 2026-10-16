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
          NavigationLink("Plaid Sandbox connections") { ConnectionsView() }
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
      if !headers.isEmpty {
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
struct ConnectionsView: View {
  @EnvironmentObject var store: Store
  @State var product = "transactions"
  @State var session: PlaidLinkSession?
  @State var ready = false
  @State var presenting = false
  @State var loading = false
  @State var updating: String?
  @State var disconnecting: Row?
  @State var remove = false
  @State var confirm = ""
  var body: some View {
    List {
      Section {
        StatusLabel(text: "Sandbox only")
        Text("Sandbox uses test institutions and test data. It never connects a real bank.").font(
          .custom("Lato-Regular", size: 15, relativeTo: .subheadline))
      }
      if store.mode != "remote" || store.isDemo {
        Text(
          "Sign in to a private server workspace to connect Plaid Sandbox. Local accounts and CSV work without a server."
        )
      } else if !store.configured {
        Text(
          "Bank connections are not set up on this server yet."
        )
      } else {
        Section {
          Picker("Connection type", selection: $product) {
            Text("Bank / card · Transactions").tag("transactions")
            Text("Brokerage · Investments").tag("investments")
          }
          Button(loading ? "Preparing…" : "Connect test institution") { prepare() }.disabled(
            loading)
          if ready { Button("Open Plaid Sandbox") { presenting = true } }
          Text("Investment coverage varies by institution.").font(
            .custom("Lato-Regular", size: 13, relativeTo: .caption)
          ).foregroundStyle(Color.assetSecondary)
        }
      }
      ForEach(store.connections) { c in
        Section(c.text("institution_name")) {
          StatusLabel(text: c.text("status"))
          Text("\(c.text("product")) · Last fetched \(c.text("last_synced_at","not yet"))").font(
            .custom("Lato-Regular", size: 13, relativeTo: .caption))
          if !c.text("error_code").isEmpty {
            Text(c.text("error_code")).foregroundStyle(Color.assetAmber)
          }
          ForEach(store.accounts.filter { $0.text("connectionId") == c.id }) { a in
            Toggle(
              a.text("name"),
              isOn: Binding(
                get: { a.flag("enabled") },
                set: { v in
                  let ids = store.accounts.filter {
                    $0.text("connectionId") == c.id && ($0.id == a.id ? v : $0.flag("enabled"))
                  }.map { $0.text("providerId") }
                  Task {
                    do {
                      _ = try await store.request(
                        "/plaid/\(c.id)/accounts", body: ["selected": ids])
                      await store.refresh()
                    } catch { store.error = error.localizedDescription }
                  }
                })
            ).disabled(c.text("status") == "disconnected")
          }
          if c.text("status") != "disconnected" {
            Button("Check for updates") {
              Task {
                do {
                  _ = try await store.request("/plaid/\(c.id)/sync", body: [:])
                  await store.refresh()
                } catch {
                  store.error = error.localizedDescription
                  await store.refresh()
                }
              }
            }
            Button("Reauthenticate / add accounts") { prepare(c.id) }
            Button("Disconnect", role: .destructive) { disconnecting = c }
          }
        }
      }
      if let c = disconnecting {
        Section("Disconnect \(c.text("institution_name"))") {
          Text("Future access stops. Imported data is retained unless you choose deletion.")
          Toggle("Also delete imported data", isOn: $remove)
          if remove { TextField("Type DELETE", text: $confirm) }
          Button("Confirm disconnect", role: .destructive) {
            Task {
              do {
                _ = try await store.request(
                  "/plaid/\(c.id)/disconnect", body: ["deleteData": remove, "confirm": confirm])
                await store.refresh()
                disconnecting = nil
                remove = false
                confirm = ""
              } catch { store.error = error.localizedDescription }
            }
          }.disabled(remove && confirm != "DELETE")
        }
      }
    }.assetTitle("Connections").sheet(isPresented: $presenting) { session?.sheet() }
  }
  func prepare(_ id: String? = nil) {
    loading = true
    ready = false
    updating = id
    Task {
      do {
        var p: JSON = ["product": product]
        if let id { p["connectionId"] = id }
        let r = try await store.request("/plaid/link-token", body: p)
        guard let token = r["link_token"] as? String else {
          throw failure("Link token unavailable")
        }
        let configuration = LinkTokenConfiguration(
          token: token,
          onSuccess: { success in
            Task { @MainActor in
              presenting = false
              do {
                let selected = success.metadata.accounts.map(\.id)
                if let updating {
                  _ = try await store.request(
                    "/plaid/\(updating)/update-complete", body: ["selected": selected])
                } else {
                  _ = try await store.request(
                    "/plaid/exchange",
                    body: [
                      "publicToken": success.publicToken, "product": product, "selected": selected,
                    ])
                }
                ready = false
                session = nil
                await store.refresh()
              } catch { store.error = error.localizedDescription }
            }
          },
          onExit: { exit in
            Task { @MainActor in
              presenting = false
              ready = false
              session = nil
              if let error = exit.error { store.error = error.localizedDescription }
            }
          }, onEvent: nil, onLoad: { Task { @MainActor in ready = true } })
        session = try Plaid.createPlaidLinkSession(configuration: configuration)
      } catch { store.error = error.localizedDescription }
      loading = false
    }
  }
}
