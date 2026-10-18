import CryptoKit
import FinanceKit
import SwiftUI

@MainActor final class AppleAccountSync: ObservableObject {
  static let shared = AppleAccountSync()
  @Published var working = false
  @Published var message = ""
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
  static func cents(_ value: CurrencyAmount) throws -> Int {
    guard value.currencyCode == "USD" else { throw NSError(domain: "Asset", code: 1, userInfo: [NSLocalizedDescriptionKey: "This Apple connection currently supports USD accounts."]) }
    var scaled = value.amount * 100, rounded = Decimal()
    NSDecimalRound(&rounded, &scaled, 0, .plain)
    guard scaled == rounded, rounded <= 100_000_000_000, rounded >= -100_000_000_000 else {
      throw NSError(domain: "Asset", code: 1, userInfo: [NSLocalizedDescriptionKey: "Apple returned an unsupported amount."])
    }
    return NSDecimalNumber(decimal: rounded).intValue
  }
  func sync(store: Store) async {
    guard Self.enabled, !working, store.mode == "remote", !store.isDemo, !store.verificationRequired else { return }
    working = true; message = ""; defer { working = false }
    guard let token = SessionKey.read() else { return }
    let generation = store.workspaceGeneration, server = store.baseURL
    func current() throws {
      try Task.checkCancellation()
      guard generation == store.workspaceGeneration, server == store.baseURL, token == SessionKey.read(), store.mode == "remote" else {
        throw CancellationError()
      }
    }
    do {
      let configuration = try await store.request("/apple", server: server, token: token)
      try current()
      guard configuration["available"] as? Bool == true else { return }
      let linked = (configuration["accounts"] as? [JSON] ?? []).filter { ($0["financekit"] as? JSON)?["deviceId"] as? String == Self.deviceID }
      guard !linked.isEmpty else { return }
      guard try await FinanceStore.shared.authorizationStatus() == .authorized else {
        message = "Apple access is paused. Reconnect in Apple accounts or remove the synced data."
        return
      }
      let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.timeZone = TimeZone(identifier: (store.state["settings"] as? JSON)?["timezone"] as? String ?? "America/Los_Angeles")
      formatter.dateFormat = "yyyy-MM-dd"
      for account in linked {
        try current()
        guard let accountID = account["id"] as? String, let provider = account["providerId"] as? String,
          let id = UUID(uuidString: provider) else { continue }
        let path = try checkpointURL(server + "|" + token + "|" + accountID + "|" + ((account["financekit"] as? JSON)?["consentAt"] as? String ?? ""))
        var checkpoint = (try? JSONDecoder().decode(Checkpoint.self, from: Data(contentsOf: path))) ?? Checkpoint()
        var sequence = (account["financekit"] as? JSON)?["sequence"] as? Int ?? 0
        func send(_ transactions: [JSON] = [], deleted: [UUID] = [], balances: [JSON] = [], deletedBalances: [UUID] = []) async throws {
          try current()
          _ = try await store.request("/apple/sync", body: ["accountId": accountID, "deviceId": Self.deviceID,
            "sequence": sequence + 1, "transactions": transactions, "deleted": deleted.map { $0.uuidString.lowercased() },
            "balances": balances, "deletedBalances": deletedBalances.map { $0.uuidString.lowercased() }], server: server, token: token)
          try current(); sequence += 1
        }
        // Checkpoint only after every chunk has reached the server. A crash replays IDs safely.
        do {
          for try await changes in FinanceStore.shared.transactionHistory(forAccountID: id, since: checkpoint.transactions, isMonitoring: false) {
            let all = changes.inserted + changes.updated
            let rows = try all.filter { $0.status != .rejected }.map { (transaction: FinanceKit.Transaction) -> JSON in
              let credit = transaction.creditDebitIndicator == .credit
              let liability = account["type"] as? String == "credit"
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
            for start in stride(from: 0, to: rows.count, by: 500) { try await send(Array(rows[start..<min(start+500,rows.count)])) }
            let removed = changes.deleted + all.filter { $0.status == .rejected }.map(\.id)
            for start in stride(from: 0, to: removed.count, by: 500) { try await send(deleted: Array(removed[start..<min(start+500,removed.count)])) }
            try current(); checkpoint.transactions = changes.newToken
            try JSONEncoder().encode(checkpoint).write(to: path, options: [.atomic, .completeFileProtection])
          }
          for try await changes in FinanceStore.shared.accountBalanceHistory(forAccountID: id, since: checkpoint.balances, isMonitoring: false) {
            // Available credit is not debt. Use only the booked balance for liabilities.
            let rows = try (changes.inserted + changes.updated).compactMap { (record: FinanceKit.AccountBalance) -> JSON? in
              let liability = account["type"] as? String == "credit"
              guard let balance = record.booked ?? (liability ? nil : record.available) else { return nil }
              let sign = (balance.creditDebitIndicator == .debit) == liability ? 1 : -1
              return ["providerId": record.id.uuidString.lowercased(), "date": formatter.string(from: balance.asOfDate),
                "asOf": ISO8601DateFormatter().string(from: balance.asOfDate),
                "balance": abs(try Self.cents(balance.amount)) * sign, "currency": balance.amount.currencyCode]
            }
            for start in stride(from: 0, to: rows.count, by: 500) { try await send(balances: Array(rows[start..<min(start+500,rows.count)])) }
            for start in stride(from: 0, to: changes.deleted.count, by: 500) { try await send(deletedBalances: Array(changes.deleted[start..<min(start+500,changes.deleted.count)])) }
            try current(); checkpoint.balances = changes.newToken
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
      try current(); await store.refresh(); message = "Apple accounts are up to date."
    } catch is CancellationError { } catch {
      if generation == store.workspaceGeneration { message = error.localizedDescription }
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
  @State private var message = ""
  @State private var removing: Row?
  var available: Bool { AppleAccountSync.enabled && configuration["available"] as? Bool == true }
  var secured: Bool { (configuration["security"] as? JSON)?["verified"] as? Bool == true }
  var body: some View {
    List {
      Section {
        Text("Connect Apple Card, Apple Cash, and Savings accounts available in Wallet on this iPhone.")
        if !available { Text("Apple account connections are awaiting Apple approval. Your imported Apple history remains available.").foregroundStyle(Color.assetSecondary) }
      }
      if available && !secured {
        Section { NavigationLink("Set up authenticator") { DeviceVerificationView(enrollment: true, onVerified: { Task { await load() } }) } }
      }
      if available && secured {
        Section {
          Text("Asset will read account names, balances, and transactions you select, including merchants, amounts, and dates. Selected data is stored in your private workspace and synced to the web app and your other devices. It is not sold or used for advertising.")
          Link("Privacy policy", destination: URL(string: "https://asset.gtfol.dev/privacy")!)
          Toggle("Sync selected Apple data to my Asset workspace and web app", isOn: $consent)
          Button("Choose Apple accounts") { perform { context in
            guard FinanceStore.isDataAvailable(.financialData) else { throw failure("Apple financial data is not available on this device.") }
            guard try await FinanceStore.shared.requestAuthorization() == .authorized else { throw failure("Apple access was not granted.") }
            try context.check(store)
            let sharedAccounts = try await FinanceStore.shared.accounts(query: AccountQuery())
            try context.check(store)
            accounts = sharedAccounts
            if accounts.isEmpty { message = "No accounts were shared. Check Wallet and your Apple financial data permissions." }
          } }.disabled(!consent)
        }
        ForEach(accounts) { account in
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
              _ = try await context.request(store, "/apple/connect", body: body)
              await store.refresh(); try context.check(store); await sync.sync(store: store); try context.check(store); await load()
            } }.disabled(!consent || account.currencyCode != "USD")
          }
        }
      }
      ForEach(store.accounts.filter { $0.text("source") == "financekit" }) { account in
        Section(account.text("name")) {
          Text("Synced from your iPhone. Imported history and edits are preserved.").foregroundStyle(Color.assetSecondary)
          Button("Disconnect and remove Apple data", role: .destructive) { removing = account }
        }
      }
      if available { Button(sync.working ? "Syncing…" : "Sync Apple accounts") { Task { await sync.sync(store: store) } }.disabled(sync.working) }
      if !message.isEmpty { Text(message).foregroundStyle(Color.assetSecondary) }
      if !sync.message.isEmpty { Text(sync.message).foregroundStyle(Color.assetSecondary) }
    }.disabled(working).navigationTitle("Apple accounts").task { await load() }
      .confirmationDialog("Remove synced Apple data? Your original CSV history is kept. You can also revoke access in iPhone Settings.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
        Button("Remove Apple data", role: .destructive) { if let account = removing { perform { context in
          _ = try await context.request(store, "/apple/disconnect", body: ["accountId": account.id]); await store.refresh(); removing = nil
        } } }
      }
  }
  private func load() async {
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
