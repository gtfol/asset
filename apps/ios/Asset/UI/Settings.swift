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
        SecureField(environment == "sandbox" ? "Sandbox secret" : "Production secret", text: $secret)
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
