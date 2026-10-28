import CryptoKit
import FinanceKit
import SwiftUI

@MainActor final class AppleAccountSync: BackgroundSyncQueue {
  static let shared = AppleAccountSync()
  private var lastAutomaticSync: Date?
  override func reset() { super.reset(); lastAutomaticSync = nil }
  static var enabled: Bool {
    Bundle.main.object(forInfoDictionaryKey: "AssetFinanceKitEnabled") as? Bool == true
      && UIDevice.current.userInterfaceIdiom == .phone
  }
  static var deviceID: String {
    if let id = UserDefaults.standard.string(forKey: "apple-sync-device") { return id }
    let id = UUID().uuidString.lowercased()
    UserDefaults.standard.set(id, forKey: "apple-sync-device"); return id
  }
  struct Checkpoint: Codable { var transactions: FinanceStore.HistoryToken?; var balances: FinanceStore.HistoryToken? }
  private func checkpointURL(_ scope: String) throws -> URL {
    let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Asset/AppleSync")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
    var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
    var protectedDirectory = directory; try protectedDirectory.setResourceValues(excluded)
    let name = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appendingPathComponent(name + ".json")
  }
  nonisolated static func cents(_ value: CurrencyAmount) throws -> Int {
    guard value.currencyCode == "USD" else { throw NSError(domain: "Asset", code: 1, userInfo: [NSLocalizedDescriptionKey: "This Apple connection currently supports USD accounts."]) }
    var scaled = value.amount * 100, rounded = Decimal()
    NSDecimalRound(&rounded, &scaled, 0, .plain)
    guard scaled == rounded, rounded <= 100_000_000_000, rounded >= -100_000_000_000 else {
      throw NSError(domain: "Asset", code: 1, userInfo: [NSLocalizedDescriptionKey: "Apple returned an unsupported amount."])
    }
    return NSDecimalNumber(decimal: rounded).intValue
  }
  func sync(store: Store, accountID: String? = nil, automatic: Bool = false) {
    guard Self.enabled, store.mode == "remote", !store.isDemo, !store.verificationRequired else { return }
    if automatic {
      guard !working, lastAutomaticSync.map({ Date().timeIntervalSince($0) >= 300 }) ?? true else { return }
      lastAutomaticSync = Date()
    }
    let context = WorkspaceRequest(store)
    if let accountID {
      enqueueAccount(accountID, store: store, context: context, priority: true)
    } else {
      enqueue(key: "discover", label: "Apple accounts") { [weak self] progress in
        try progress.report("Checking Apple accounts…")
        let configuration = try await context.request(store, "/apple")
        try progress.check()
        guard configuration["available"] as? Bool == true else { throw failure("Apple sync is temporarily unavailable.") }
        for account in configuration["accounts"] as? [JSON] ?? [] {
          guard (account["financekit"] as? JSON)?["deviceId"] as? String == Self.deviceID,
            let id = account["id"] as? String else { continue }
          self?.enqueueAccount(id, store: store, context: context, label: account["name"] as? String ?? "Apple account")
        }
      }
    }
  }
  private func enqueueAccount(_ id: String, store: Store, context: WorkspaceRequest,
    label: String = "Apple account", priority: Bool = false) {
    enqueue(key: id, label: label, priority: priority) { [weak self] progress in
      try context.check(store)
      try await self?.syncAccount(store: store, accountID: id, progress: progress)
    }
  }
  private func syncAccount(store: Store, accountID selectedAccountID: String, progress: Progress) async throws {
    guard let token = SessionKey.read(), let owner = store.owner else { return }
    let generation = store.workspaceGeneration, server = store.baseURL
    func current() throws {
      try progress.check()
      guard generation == store.workspaceGeneration, server == store.baseURL, token == SessionKey.read(), store.mode == "remote" else {
        throw CancellationError()
      }
    }
    do {
      try current()
      let configuration = try await store.request("/apple", server: server, token: token)
      try current()
      guard configuration["available"] as? Bool == true else { throw failure("Apple sync is temporarily unavailable.") }
      let linked = (configuration["accounts"] as? [JSON] ?? []).filter {
        ($0["financekit"] as? JSON)?["deviceId"] as? String == Self.deviceID
          && $0["id"] as? String == selectedAccountID
      }
      guard !linked.isEmpty else { return }
      guard FinanceStore.isDataAvailable(.financialData) else { throw failure("Apple financial data is not available on this device.") }
      guard try await FinanceStore.shared.authorizationStatus() == .authorized else {
        throw failure("Apple access is paused. Choose Apple accounts to reconnect.")
      }
      let timezone = (store.state["settings"] as? JSON)?["timezone"] as? String ?? "America/Los_Angeles"
      for account in linked {
        try current()
        guard let accountID = account["id"] as? String, let provider = account["providerId"] as? String,
          let id = UUID(uuidString: provider) else { continue }
        let name = account["name"] as? String ?? "Apple account"
        var transactionCount = 0
        try progress.report("Updating \(name) balance…")
        let path = try checkpointURL(server + "|" + owner + "|" + accountID + "|" + ((account["financekit"] as? JSON)?["consentAt"] as? String ?? ""))
        var checkpoint = (try? JSONDecoder().decode(Checkpoint.self, from: Data(contentsOf: path))) ?? Checkpoint()
        var sequence = (account["financekit"] as? JSON)?["sequence"] as? Int ?? 0
        func send(_ transactions: [JSON] = [], deleted: [UUID] = [], balances: [JSON] = [], deletedBalances: [UUID] = []) async throws {
          try current()
          _ = try await store.request("/apple/sync", body: ["accountId": accountID, "deviceId": Self.deviceID,
            "sequence": sequence + 1, "transactions": transactions, "deleted": deleted.map { $0.uuidString.lowercased() },
            "balances": balances, "deletedBalances": deletedBalances.map { $0.uuidString.lowercased() }], server: server, token: token)
          try current(); sequence += 1
          try progress.report("Saving \(name) history…")
        }
        // Checkpoint only after every chunk has reached the server. A crash replays IDs safely.
        do {
          for try await changes in FinanceStore.shared.accountBalanceHistory(forAccountID: id, since: checkpoint.balances, isMonitoring: false) {
            try current()
            let rows = try await Self.balanceRows(changes.inserted + changes.updated,
              liability: account["type"] as? String == "credit", timezone: timezone)
            try current()
            for start in stride(from: 0, to: rows.count, by: 500) { try await send(balances: Array(rows[start..<min(start+500,rows.count)])) }
            for start in stride(from: 0, to: changes.deleted.count, by: 500) { try await send(deletedBalances: Array(changes.deleted[start..<min(start+500,changes.deleted.count)])) }
            try progress.report("Updating \(name) balance…")
            try current(); checkpoint.balances = changes.newToken
            try JSONEncoder().encode(checkpoint).write(to: path, options: [.atomic, .completeFileProtection])
          }
          try progress.report("Reading \(name) transactions…")
          for try await changes in FinanceStore.shared.transactionHistory(forAccountID: id, since: checkpoint.transactions, isMonitoring: false) {
            try current()
            let all = changes.inserted + changes.updated
            let rows = try await Self.transactionRows(all, liability: account["type"] as? String == "credit", timezone: timezone)
            try current()
            for start in stride(from: 0, to: rows.count, by: 500) {
              let chunk = Array(rows[start..<min(start+500,rows.count)])
              try await send(chunk)
              transactionCount += chunk.count
              try progress.report("Syncing \(name) · \(transactionCount) transactions")
            }
            let removed = changes.deleted + all.filter { $0.status == .rejected }.map(\.id)
            for start in stride(from: 0, to: removed.count, by: 500) { try await send(deleted: Array(removed[start..<min(start+500,removed.count)])) }
            try progress.report("Syncing \(name) · \(transactionCount) transactions")
            try current(); checkpoint.transactions = changes.newToken
            try JSONEncoder().encode(checkpoint).write(to: path, options: [.atomic, .completeFileProtection])
          }
        } catch FinanceError.historyTokenInvalid {
          try current()
          _ = try await store.request("/apple/reset", body: ["accountId": accountID, "deviceId": Self.deviceID], server: server, token: token)
          try current()
          try? FileManager.default.removeItem(at: path)
          await store.refresh()
          throw failure("Apple reset its history. Sync again to rebuild the checkpoint; existing transactions will be matched.")
        }
      }
      try current(); try progress.report("Updating your workspace…")
      await store.refresh(); try current()
    } catch {
      try current()
      throw error
    }
  }
  nonisolated private static func dateFormatter(_ timezone: String) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: timezone)
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter
  }
  nonisolated private static func balanceRows(_ records: [FinanceKit.AccountBalance],
    liability: Bool, timezone: String) async throws -> [JSON] {
    let formatter = dateFormatter(timezone), iso = ISO8601DateFormatter()
    // Available credit is not debt. Use only the booked balance for liabilities.
    return try records.compactMap { (record: FinanceKit.AccountBalance) -> JSON? in
      guard let balance = record.booked ?? (liability ? nil : record.available) else { return nil }
      let sign = (balance.creditDebitIndicator == .debit) == liability ? 1 : -1
      return ["providerId": record.id.uuidString.lowercased(), "date": formatter.string(from: balance.asOfDate),
        "asOf": iso.string(from: balance.asOfDate),
        "balance": abs(try Self.cents(balance.amount)) * sign, "currency": balance.amount.currencyCode]
    }
  }
  nonisolated private static func transactionRows(_ all: [FinanceKit.Transaction],
    liability: Bool, timezone: String) async throws -> [JSON] {
    let formatter = dateFormatter(timezone)
    return try all.filter { $0.status != .rejected }.map { (transaction: FinanceKit.Transaction) -> JSON in
      let credit = transaction.creditDebitIndicator == .credit
      let kind: String
      switch transaction.transactionType {
      case .transfer, .billPayment: kind = liability && credit ? "card_payment" : "transfer"
      case .refund: kind = "refund"
      case .deposit, .directDeposit, .dividend: kind = credit ? "income" : "spending"
      default: kind = credit ? (liability ? "refund" : "income") : "spending"
      }
      return ["providerId": transaction.id.uuidString.lowercased(),
        "name": String((transaction.merchantName ?? transaction.transactionDescription).prefix(160)),
        "date": formatter.string(from: transaction.postedDate ?? transaction.transactionDate),
        "authorizedDate": formatter.string(from: transaction.transactionDate),
        "amount": abs(try Self.cents(transaction.transactionAmount)), "currency": transaction.transactionAmount.currencyCode,
        "direction": credit ? "credit" : "debit", "type": kind, "pending": transaction.status != .booked]
    }
  }

}

struct AppleAccountsView: View {
  @EnvironmentObject var store: Store
  @ObservedObject private var sync = AppleAccountSync.shared
  @State private var accounts: [FinanceKit.Account] = []
  @State private var targets: [UUID: String] = [:]
  @State private var types: [UUID: String] = [:]
  @State private var configuration: JSON = [:]
  @State private var consent = false
  @State private var working = false
  @State private var loading = true
  @State private var message = ""
  @State private var removing: Row?
  var available: Bool { AppleAccountSync.enabled && configuration["available"] as? Bool == true }
  var linkedAccounts: [Row] { (configuration["accounts"] as? [JSON])?.map(Row.init) ?? store.accounts.filter { $0.text("source") == "financekit" } }
  var unlinkedAccounts: [FinanceKit.Account] { accounts.filter { account in !linkedAccounts.contains { $0.text("providerId") == account.id.uuidString.lowercased() } } }
  var secured: Bool { (configuration["security"] as? JSON)?["verified"] as? Bool == true }
  var body: some View {
    List {
      Section {
        Text("Connect Apple Card, Apple Cash, and Savings accounts available in Wallet on this iPhone.")
        if !AppleAccountSync.enabled {
          Text("Connect from an iPhone with Apple accounts in Wallet.").foregroundStyle(Color.assetSecondary)
        } else if !available && !loading && message.isEmpty {
          Text("Apple account syncing is not available right now.").foregroundStyle(Color.assetSecondary)
        }
      }
      if loading { Section { ProgressView("Loading Apple accounts…") } }
      if working { Section { ProgressView("Setting up your account…") } }
      if sync.working {
        Section {
          ProgressView(sync.message)
          Text("You can add another account or close this screen while syncing.").foregroundStyle(Color.assetSecondary)
          Button("Stop sync") { sync.stop(); Task { await store.refresh() } }
        }
      }
      ForEach(sync.failures.keys.sorted(), id: \.self) { key in
        Section {
          Text(sync.failures[key] ?? "").foregroundStyle(Color.assetSecondary)
          Button("Retry sync") { sync.sync(store: store, accountID: key == "discover" ? nil : key) }
        }
      }
      if available && !secured {
        Section { NavigationLink("Set up authenticator") { DeviceVerificationView(enrollment: true, onVerified: { Task { await load() } }) } }
      }
      if available && secured {
        Section {
          Text("Asset will read account names, balances, and transactions you select, including merchants, amounts, and dates. Selected data is stored in your private workspace and synced to the web app and your other devices. It is not sold or used for advertising.")
          Link("Privacy policy", destination: URL(string: "https://asset.gtfol.dev/privacy")!)
          Toggle("Sync selected Apple data to my Asset workspace and web app", isOn: $consent).disabled(working)
          Button("Choose Apple accounts") { perform { context in
            guard FinanceStore.isDataAvailable(.financialData) else { throw failure("Apple financial data is not available on this device.") }
            guard try await FinanceStore.shared.requestAuthorization() == .authorized else { throw failure("Apple access was not granted.") }
            try context.check(store)
            let sharedAccounts = try await FinanceStore.shared.accounts(query: AccountQuery())
            try context.check(store)
            accounts = sharedAccounts
            if accounts.isEmpty { message = "No accounts were shared. Check Wallet and your Apple financial data permissions." }
          } }.disabled(!consent || working)
        }
        ForEach(unlinkedAccounts) { account in
          Section(account.displayName) {
            let type = types[account.id] ?? (account.liabilityAccount != nil ? "credit" : account.displayName.localizedCaseInsensitiveContains("savings") ? "savings" : "checking")
            if account.liabilityAccount == nil {
              Picker("Account type", selection: Binding(get: { type }, set: { types[account.id] = $0; targets[account.id] = "" })) { Text("Checking / cash").tag("checking"); Text("Savings").tag("savings") }
            }
            Picker("Transaction history", selection: Binding(get: { targets[account.id] ?? "" }, set: { targets[account.id] = $0 })) {
              Text("Create a new account").tag("")
              ForEach(store.accounts.filter { ["csv", "manual"].contains($0.text("source")) && $0.text("connectionId").isEmpty && $0.text("currency") == account.currencyCode && [type,"manual"].contains($0.text("type")) }) { row in Text(row.text("name")).tag(row.id) }
            }
            Button("Connect and sync") { perform { context in
              var body: JSON = ["providerId": account.id.uuidString.lowercased(), "deviceId": AppleAccountSync.deviceID,
                "name": account.displayName, "type": type, "currency": account.currencyCode, "consent": consent]
              if let target = targets[account.id], !target.isEmpty { body["targetId"] = target }
              let linked = try await context.request(store, "/apple/connect", body: body)
              try context.check(store)
              guard let id = linked["accountId"] as? String else { throw failure("Apple did not finish connecting. Please try again.") }
              sync.sync(store: store, accountID: id)
              message = "Connected. Your history is syncing in the background."
              await load()
            } }.disabled(!consent || working || account.currencyCode != "USD")
          }
        }
      }
      ForEach(linkedAccounts) { account in
        Section(account.text("name")) {
          Text("Syncs when you open Asset on your iPhone. Imported history and edits are preserved.").foregroundStyle(Color.assetSecondary)
          Button("Disconnect and remove Apple data", role: .destructive) { removing = account }.disabled(working || sync.working)
        }
      }
      if available && !linkedAccounts.isEmpty { Button("Sync Apple accounts") { sync.sync(store: store) }.disabled(sync.working || working) }
      if !message.isEmpty { Text(message).foregroundStyle(Color.assetSecondary) }
      if !sync.working && sync.failures.isEmpty && !sync.message.isEmpty { Text(sync.message).foregroundStyle(Color.assetSecondary) }
    }.assetTitle("Apple accounts")
      .font(.custom("Lato-Regular", size: 15, relativeTo: .subheadline))
      .listStyle(.plain).scrollContentBackground(.hidden).background(Color.assetBackground)
      .task(id: store.workspaceGeneration) { accounts = []; targets = [:]; consent = false; configuration = [:]; message = ""; await load() }
      .confirmationDialog("Remove synced Apple data? Your original CSV history is kept. You can also revoke access in iPhone Settings.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
        Button("Remove Apple data", role: .destructive) { if let account = removing { perform { context in
          _ = try await context.request(store, "/apple/disconnect", body: ["accountId": account.id]); await load(); await store.refresh(); removing = nil
        } } }
      }
  }
  private func load() async {
    loading = true
    defer { loading = false }
    let generation = store.workspaceGeneration
    do { let result = try await store.request("/apple"); if generation == store.workspaceGeneration { configuration = result } }
    catch { if generation == store.workspaceGeneration { message = error.localizedDescription } }
  }
  private func perform(_ action: @escaping @MainActor (WorkspaceRequest) async throws -> Void) {
    guard !working else { return }; working = true; message = ""
    let generation = store.workspaceGeneration
    let context = WorkspaceRequest(store)
    Task { @MainActor in defer { working = false }; do { try context.check(store); try await action(context); try context.check(store) } catch { if generation == store.workspaceGeneration { message = error.localizedDescription } } }
  }
}

struct AppleAccountSetupView: View {
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  @State private var signIn = false
  var body: some View {
    NavigationStack {
      Group {
        if store.mode == "remote" && !store.isDemo {
          AppleAccountsView()
        } else {
          VStack(alignment: .leading, spacing: 16) {
            Text("Sign in to sync Apple accounts between your iPhone and Asset.")
              .foregroundStyle(Color.assetSecondary)
            Button("Sign in") { signIn = true }.buttonStyle(AssetBorderButtonStyle())
            Spacer()
          }.padding(20).assetTitle("Apple accounts")
        }
      }.navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }.quietBackground() }
        .sheet(isPresented: $signIn) { SyncSignInView() }
    }
  }
}
