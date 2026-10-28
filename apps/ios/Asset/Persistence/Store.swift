import CryptoKit
import JavaScriptCore
import Security
import SwiftUI

typealias JSON = [String: Any]
struct AppLockLifecycle {
  private(set) var protected = false
  private(set) var locked = true
  private(set) var inactive = true
  private(set) var authenticating = false
  private(set) var attempt = 0
  var hidden: Bool { protected && (locked || inactive) }
  mutating func configure(protected: Bool, active: Bool) {
    guard self.protected != protected else { return }
    self.protected = protected
    cancel()
    locked = protected
    inactive = !active
  }
  mutating func resign() {
    inactive = true
    if !authenticating { locked = protected }
  }
  mutating func background() {
    cancel()
    inactive = true
    locked = protected
  }
  mutating func activate() { inactive = false }
  mutating func cancel() {
    attempt += 1
    authenticating = false
  }
  mutating func begin() -> Int? {
    guard protected, locked, !inactive, !authenticating else { return nil }
    attempt += 1
    authenticating = true
    return attempt
  }
  @discardableResult mutating func finish(_ id: Int, success: Bool) -> Bool {
    guard protected, id == attempt, authenticating else { return false }
    authenticating = false
    locked = !success
    return true
  }
}
struct Row: Identifiable {
  var data: JSON
  let id: String
  init(_ data: JSON = [:]) {
    self.data = data
    id =
      (data["id"] as? String) ?? (data["date"] as? String) ?? (data["month"] as? String)
      ?? UUID().uuidString
  }
  func text(_ key: String, _ fallback: String = "") -> String { data[key] as? String ?? fallback }
  func number(_ key: String) -> Double { (data[key] as? NSNumber)?.doubleValue ?? 0 }
  func integer(_ key: String) -> Int { (data[key] as? NSNumber)?.intValue ?? 0 }
  func flag(_ key: String) -> Bool { data[key] as? Bool ?? false }
  func missing(_ key: String) -> Bool { data[key] == nil || data[key] is NSNull }
  func rows(_ key: String) -> [Row] { (data[key] as? [JSON] ?? []).map(Row.init) }
  func object(_ key: String) -> Row { Row(data[key] as? JSON ?? [:]) }
}
struct TransactionFilters: Equatable {
  var query = ""
  var account = ""
  var category = ""
  var kind = ""
  var reviewOnly = false
  var start = ""
  var end = ""
  func matches(_ transaction: Row) -> Bool {
    if !query.isEmpty && !transaction.text("name").localizedCaseInsensitiveContains(query)
      && !transaction.text("notes").localizedCaseInsensitiveContains(query)
    {
      return false
    }
    if !account.isEmpty && transaction.text("accountId") != account { return false }
    if !category.isEmpty {
      let splits = transaction.rows("splits")
      if splits.isEmpty {
        if transaction.text("categoryId") != category { return false }
      } else if !splits.contains(where: { $0.text("categoryId") == category }) {
        return false
      }
    }
    return (kind.isEmpty || transaction.text("kind") == kind)
      && (!reviewOnly || !transaction.flag("reviewed"))
      && (start.isEmpty || transaction.text("date") >= start)
      && (end.isEmpty || transaction.text("date") <= end)
  }
}
struct TransactionDateGroup: Identifiable {
  let id: String
  var rows: [Row]
}
struct TransactionListPage {
  static let pageSize = 80
  private(set) var matching: [Row] = []
  private(set) var groups: [TransactionDateGroup] = []
  private(set) var loadedCount = 0
  var total: Int { matching.count }
  var hasMore: Bool { loadedCount < total }
  var loadedIDs: Set<String> { Set(matching.prefix(loadedCount).map(\.id)) }
  mutating func reload(transactions: [Row], filters: TransactionFilters, reset: Bool) {
    matching = transactions.filter(filters.matches)
    loadedCount = min(total, reset ? Self.pageSize : max(Self.pageSize, loadedCount))
    groupLoadedRows()
  }
  mutating func loadMore() {
    guard hasMore else { return }
    loadedCount = min(total, loadedCount + Self.pageSize)
    groupLoadedRows()
  }
  private mutating func groupLoadedRows() {
    var result: [TransactionDateGroup] = []
    for transaction in matching.prefix(loadedCount) {
      let date = transaction.text("date")
      if result.last?.id == date {
        result[result.count - 1].rows.append(transaction)
      } else {
        result.append(TransactionDateGroup(id: date, rows: [transaction]))
      }
    }
    groups = result
  }
}
func uid() -> String { UUID().uuidString }
func failure(_ text: String) -> NSError {
  NSError(domain: "Asset", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
}
func money(_ value: Any?, _ currency: String = "USD") -> String {
  guard let value = value as? NSNumber else { return "Unavailable" }
  return (value.doubleValue / 100).formatted(.currency(code: currency))
}
func dateToday(timezone: String? = nil) -> String {
  let f = DateFormatter()
  f.dateFormat = "yyyy-MM-dd"
  f.locale = Locale(identifier: "en_US_POSIX")
  if let timezone { f.timeZone = TimeZone(identifier: timezone) }
  return f.string(from: Date())
}
func isoNow() -> String { ISO8601DateFormatter().string(from: Date()) }

enum GoogleSignIn {
  static let defaultServer = "https://asset.gtfol.dev"
  static let callbackScheme = "org.gtfol.asset"

  private static func base64URL(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  static func verifier() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw failure("Unable to start secure sign-in. Please try again.")
    }
    return base64URL(Data(bytes))
  }

  static func challenge(for verifier: String) -> String {
    base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
  }

  static func callbackCode(from url: URL) throws -> String {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      parts.scheme?.lowercased() == callbackScheme, parts.host?.lowercased() == "auth", parts.path == "/callback",
      parts.user == nil, parts.password == nil, parts.port == nil, (parts.fragment ?? "").isEmpty
    else { throw failure("Google sign-in returned an invalid response. Please try again.") }
    let items = parts.queryItems ?? []
    guard !items.contains(where: { $0.name == "error" }) else {
      throw failure("Google sign-in could not be completed. Please try again.")
    }
    let codes = items.filter { $0.name == "code" }
    guard codes.count == 1, let code = codes.first?.value, !code.isEmpty,
      items.allSatisfy({ $0.name == "code" })
    else { throw failure("Google sign-in did not return a code. Please try again.") }
    return code
  }
}

struct PlaidLinkAttempt: Equatable {
  let id = UUID()
  let product: String
  let connectionID: String?
  let workspaceGeneration: Int
  let server: String
  let token: String
}

struct PlaidLinkLifecycle {
  private(set) var attempt: PlaidLinkAttempt?
  private(set) var ready = false
  private(set) var consumed = false
  var active: Bool { attempt != nil }

  mutating func begin(_ next: PlaidLinkAttempt) -> Bool {
    guard attempt == nil else { return false }
    attempt = next
    return true
  }

  mutating func loaded(_ id: UUID) -> Bool {
    guard attempt?.id == id, !consumed else { return false }
    ready = true
    return true
  }

  mutating func consume(_ id: UUID) -> Bool {
    guard attempt?.id == id, !consumed else { return false }
    consumed = true
    ready = false
    return true
  }

  @discardableResult mutating func finish(_ id: UUID) -> Bool {
    guard attempt?.id == id else { return false }
    self = PlaidLinkLifecycle()
    return true
  }
}

enum APIRequest {
  static func make(
    _ path: String, body: JSON? = nil, server: String, token: String?, method: String? = nil
  ) throws -> URLRequest {
    guard let root = URL(string: server), let scheme = root.scheme,
      scheme == "https"
        || (scheme == "http" && ["localhost", "127.0.0.1"].contains(root.host ?? "")),
      let url = URL(string: server + "/api" + path)
    else { throw failure("Use an HTTPS server, or localhost in the simulator") }
    var request = URLRequest(url: url)
    request.httpMethod = method ?? (body == nil ? "GET" : "POST")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("ios", forHTTPHeaderField: "x-asset-client")
    if !["/auth/google/start", "/auth/google/exchange"].contains(path), let token {
      request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    }
    if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
    return request
  }
}

// Each instance belongs to one serialized executor: the UI Store or its worker.
final class Engine {
  private let context = JSContext()!
  private var exception: String?
  init() {
    context.exceptionHandler = { [weak self] _, error in self?.exception = error?.toString() }
    guard let url = Bundle.main.url(forResource: "CalculationEngine", withExtension: "js"),
      let source = try? String(contentsOf: url, encoding: .utf8)
    else { fatalError("Missing shared engine; run npm run native:resources") }
    context.evaluateScript(source)
    context.evaluateScript("var assetInvokeJSON = function(name, args) { return JSON.stringify(AssetCore[name].apply(null, JSON.parse(args))); };")
  }
  func call(_ function: String, _ args: [Any] = []) throws -> Any {
    exception = nil
    // JSON crosses the JavaScriptCore boundary in two strings instead of
    // bridging every property of thousands of nested Foundation dictionaries.
    let data = try JSONSerialization.data(withJSONObject: args)
    let value = context.objectForKeyedSubscript("assetInvokeJSON")?
      .call(withArguments: [function, String(decoding: data, as: UTF8.self)])
    if let exception { throw failure(exception) }
    guard let result = value?.toString(), let output = result.data(using: .utf8) else {
      throw failure("Calculation unavailable: \(function)")
    }
    return try JSONSerialization.jsonObject(with: output, options: [.fragmentsAllowed])
  }
}

private struct PreparedWorkspace {
  let document: JSON
  let data: Data
}
private actor WorkspaceProcessor {
  private lazy var engine = Engine()
  func command(_ document: JSON, _ type: String, _ payload: JSON, _ id: String) throws -> PreparedWorkspace {
    let next = try engine.call("localCommand", [document, ["type": type, "payload": payload], id]) as? JSON ?? [:]
    return PreparedWorkspace(document: next, data: try JSONSerialization.data(withJSONObject: next))
  }
  func receive(_ document: JSON, _ result: JSON, _ acknowledged: String?) throws -> PreparedWorkspace {
    let args: [Any] = acknowledged.map { [document, result, $0] } ?? [document, result]
    let next = try engine.call("receiveWorkspace", args) as? JSON ?? [:]
    return PreparedWorkspace(document: next, data: try JSONSerialization.data(withJSONObject: next))
  }
}

private enum WorkspaceTransport {
  // Encoding outgoing edits and decoding downloaded history must not block gestures.
  static func request(_ path: String, body: JSON?, server: String, token: String?,
    method: String?, session: URLSession) async throws -> (JSON, Int) {
    let request = try APIRequest.make(path, body: body, server: server, token: token, method: method)
    let (data, response) = try await session.data(for: request)
    let result = try JSONSerialization.jsonObject(with: data) as? JSON ?? [:]
    return (result, (response as? HTTPURLResponse)?.statusCode ?? 0)
  }
}

enum SessionKey {
  private static let base: JSON = [
    kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "org.gtfol.asset",
    kSecAttrAccount as String: "session",
  ]
  static func read() -> String? {
    var q = base
    q[kSecReturnData as String] = true
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else {
      return nil
    }
    return String(data: d, encoding: .utf8)
  }
  static func save(_ token: String?) throws {
    guard let token else {
      let status = SecItemDelete(base as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw failure("Unable to clear the saved session")
      }
      return
    }
    let attributes: JSON = [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    var status = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      let item = base.merging(attributes) { _, new in new }
      status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw failure("Unable to store session securely")
    }
  }
}

@MainActor final class Store: ObservableObject {
  @Published var state: JSON = [:] {
    didSet {
      stateGeneration += 1
      cachedAccounts = nil
      cachedCategories = nil
      cachedTransactions = nil
      cachedAccountsByID = nil
      cachedCategoriesByID = nil
      cachedCalculations.removeAll()
    }
  }
  private(set) var stateGeneration = 0
  private var cachedAccounts: [Row]?
  private var cachedCategories: [Row]?
  private var cachedTransactions: [Row]?
  private var cachedAccountsByID: [String: Row]?
  private var cachedCategoriesByID: [String: Row]?
  private var cachedCalculations: [String: Row] = [:]
  @Published var mode = ""
  @Published var error = ""
  @Published var verificationRequired = false
  @Published var bitcoinError = ""
  @Published var busy = false
  @Published var connections: [Row] = []
  @Published var configured = false
  @Published var revision = 0
  @Published var syncStatus = "Saved on this device"
  @Published var syncConflict = false
  private var document: JSON = [:]
  private var documentGeneration = 0
  private let processor = WorkspaceProcessor()
  private var syncing = false
  private let storageDirectory: URL?
  var pendingCount: Int { (document["pending"] as? [JSON] ?? []).count }
  var owner: String? { document["owner"] as? String }
  let engine = Engine()
  private(set) var workspaceGeneration = 0
  private let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    return URLSession(configuration: configuration)
  }()
  var baseURL: String {
    UserDefaults.standard.string(forKey: "server") ?? GoogleSignIn.defaultServer
  }
  var row: Row { Row(state) }
  var currency: String { row.object("settings").text("currency", "USD") }
  var isDemo: Bool { row.object("settings").flag("demo") }
  var accounts: [Row] {
    if let cachedAccounts { return cachedAccounts }
    let rows = row.rows("accounts")
    cachedAccounts = rows
    return rows
  }
  var categories: [Row] {
    if let cachedCategories { return cachedCategories }
    let rows = row.rows("categories")
    cachedCategories = rows
    return rows
  }
  func account(id: String) -> Row? {
    if cachedAccountsByID == nil {
      cachedAccountsByID = Dictionary(uniqueKeysWithValues: accounts.map { ($0.id, $0) })
    }
    return cachedAccountsByID?[id]
  }
  func category(id: String) -> Row? {
    if cachedCategoriesByID == nil {
      cachedCategoriesByID = Dictionary(uniqueKeysWithValues: categories.map { ($0.id, $0) })
    }
    return cachedCategoriesByID?[id]
  }
  var transactions: [Row] {
    if let cachedTransactions { return cachedTransactions }
    let rows = row.rows("transactions").filter { !$0.flag("removed") }.map { raw in
      var transaction = raw.data
      for (key, value) in raw.object("edits").data { transaction[key] = value }
      return Row(transaction)
    }.sorted {
      let leftDate = $0.text("date")
      let rightDate = $1.text("date")
      return leftDate == rightDate ? $0.id < $1.id : leftDate > rightDate
    }
    cachedTransactions = rows
    return rows
  }
  init(directory: URL? = nil) {
    storageDirectory = directory
    do {
      let url = try fileURL("workspace")
      if FileManager.default.fileExists(atPath: url.path) {
        document = try engine.call("validateLocalWorkspace", [JSONSerialization.jsonObject(with: Data(contentsOf: url))]) as? JSON ?? [:]
      } else {
        document = try engine.call("createLocalWorkspace", [uid()]) as? JSON ?? [:]
        let oldMode = directory == nil ? UserDefaults.standard.string(forKey: "mode") ?? "private" : "private"
        if oldMode == "private" || oldMode == "remote" {
          let legacy = try fileURL(oldMode)
          if FileManager.default.fileExists(atPath: legacy.path) {
            let oldState = try engine.call("validateState", [JSONSerialization.jsonObject(with: Data(contentsOf: legacy))]) as? JSON ?? [:]
            if !Row(oldState).object("settings").flag("demo") {
              document["state"] = oldState
              if oldMode == "remote" { document["owner"] = "legacy" }
            }
          }
        }
        try persistDocument(document)
      }
      publishDocument()
      if directory == nil, SessionKey.read() != nil, UserDefaults.standard.string(forKey: "mode") == "remote" { mode = "remote" }
    } catch {
      self.error = "Saved data could not be opened. It has been preserved. \(error.localizedDescription)"
    }
  }
  private func publishDocument() {
    state = document["state"] as? JSON ?? [:]
    revision = document["revision"] as? Int ?? 0
    mode = owner == nil ? "private" : "remote"
  }
  private func persistDocument(_ next: JSON, encoded: Data? = nil) throws {
    let data = try encoded ?? JSONSerialization.data(withJSONObject: next)
    #if os(iOS)
      try data.write(to: fileURL("workspace"), options: [.atomic, .completeFileProtection])
    #else
      try data.write(to: fileURL("workspace"), options: .atomic)
    #endif
    document = next
    documentGeneration += 1
  }
  func receive(_ result: JSON, acknowledged: String? = nil) async throws {
    let generation = workspaceGeneration
    while true {
      if let incoming = result["revision"] as? Int, incoming < revision {
        guard acknowledged == nil else { throw failure("A newer update arrived. Your saved edit will sync again.") }
        return
      }
      let version = documentGeneration
      let prepared = try await processor.receive(document, result, acknowledged)
      try Task.checkCancellation()
      guard generation == workspaceGeneration else { throw CancellationError() }
      // An edit can finish while the sync is prepared. Replay it against the
      // downloaded revision instead of replacing the user's latest work.
      guard version == documentGeneration else { continue }
      try persistDocument(prepared.document, encoded: prepared.data)
      publishDocument()
      return
    }
  }
  func fileURL(_ name: String) throws -> URL {
    let dir = try storageDirectory ?? FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("Asset", isDirectory: true)
    #if os(iOS)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.complete])
    #else
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    #endif
    var url = dir
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    return dir.appendingPathComponent(name + ".json")
  }
  func persist(_ next: JSON, workspace: String? = nil) throws {
    if let workspace {
      try JSONSerialization.data(withJSONObject: next).write(to: fileURL(workspace), options: [.atomic, .completeFileProtection])
    } else {
      var doc = document; doc["state"] = next
      try persistDocument(doc)
    }
  }
  func calculation(_ name: String, _ args: [Any] = []) -> Row {
    do {
      let data = try JSONSerialization.data(withJSONObject: args, options: [.sortedKeys])
      // Date-sensitive summaries must expire at midnight even without new data.
      let key = name + "|" + dateToday(timezone: row.object("settings").text("timezone")) + "|" + String(decoding: data, as: UTF8.self)
      if let result = cachedCalculations[key] { return result }
      let result = Row(try engine.call(name, [state] + args) as? JSON ?? [:])
      if cachedCalculations.count >= 64 { cachedCalculations.removeAll() }
      cachedCalculations[key] = result
      return result
    } catch {
      return Row(["error": error.localizedDescription])
    }
  }
  func cents(_ text: String) throws -> Int {
    (try engine.call("parseMoney", [text]) as? NSNumber)?.intValue ?? 0
  }
  func request(
    _ path: String, body: JSON? = nil, server: String? = nil, token: String? = nil,
    method: String? = nil
  ) async throws -> JSON {
    let address = server ?? baseURL, credential = token ?? SessionKey.read()
    let (result, status) = try await WorkspaceTransport.request(path, body: body,
      server: address, token: credential, method: method, session: session)
    guard (200..<300).contains(status) else {
      if result["code"] as? String == "DEVICE_VERIFICATION_REQUIRED",
        address == baseURL, credential == SessionKey.read() { verificationRequired = true }
      throw NSError(domain: "AssetHTTP", code: status,
        userInfo: [NSLocalizedDescriptionKey: result["error"] as? String ?? "Sync is unavailable", "code": result["code"] as? String ?? ""])
    }
    return result
  }
  func refresh() async {
    guard mode == "remote", !syncing, SessionKey.read() != nil else { return }
    syncing = true
    defer { syncing = false }
    let generation = workspaceGeneration
    let token = SessionKey.read()
    do {
      let known: JSON = ["owner": owner as Any? ?? NSNull(), "revision": revision]
      let deltaReady = document["base"] as? JSON != nil || pendingCount == 0
      let path = owner != nil && owner != "legacy"
        ? "/state?ownerId=\(owner!)&revision=\(revision)\(deltaReady ? "&delta=1" : "")" : "/state"
      let r = try await request(path, token: token)
      guard generation == workspaceGeneration, token == SessionKey.read() else { return }
      let unchanged = try engine.call("workspaceUnchanged", [known, r]) as? Bool == true
      guard let remoteOwner = r["ownerId"] as? String else { throw failure("Sync is updating. Your changes are saved here.") }
      if owner != remoteOwner {
        guard !unchanged else { throw failure("Your sign-in changed. Refresh this workspace.") }
        guard owner == nil || owner == "legacy" || pendingCount == 0 else {
          throw failure("Sign in with the same Google account to sync your saved changes.")
        }
        let guest = owner == nil ? document : nil
        var next = try engine.call("createLocalWorkspace", [uid()]) as? JSON ?? [:]
        next["owner"] = remoteOwner; next["state"] = r["state"]; next["revision"] = r["revision"]
        if let guest, let guestState = guest["state"] as? JSON,
          try engine.call("hasLocalRecords", [guestState]) as? Bool == true {
          let id = guest["id"] as? String ?? uid()
          try persist(guestState, workspace: "before-sync-" + id)
          next = try engine.call("localCommand", [next, ["type": "workspace.merge", "payload": ["state": guestState, "id": id]], id]) as? JSON ?? [:]
        }
        try persistDocument(next); publishDocument()
      } else if !unchanged && pendingCount == 0 && (r["revision"] as? Int ?? 0) >= revision { try await receive(r) }
      connections = (r["connections"] as? [JSON] ?? []).map(Row.init)
      configured = r["plaidConfigured"] as? Bool ?? false
      while let operation = (document["pending"] as? [JSON])?.first {
        var body: JSON = ["ownerId": remoteOwner, "operation": operation]
        if document["base"] as? JSON != nil || pendingCount == 0 {
          body["revision"] = revision; body["delta"] = true
        }
        let result = try await request("/sync/command", body: body)
        guard generation == workspaceGeneration, token == SessionKey.read() else { return }
        try await receive(result, acknowledged: operation["id"] as? String)
      }
      syncConflict = false; syncStatus = "Synced"
    } catch {
      guard generation == workspaceGeneration, token == SessionKey.read() else { return }
      let http = error as NSError
      syncConflict = http.domain == "AssetHTTP" && (http.code == 409 || (http.code == 400 && pendingCount > 0))
      syncStatus = syncConflict ? error.localizedDescription : http.code == 401
        ? "Saved here · sign in to sync" : "Saved here · sync paused"
    }
  }
  func useSyncedChanges() async throws {
    let r = try await request("/state")
    guard r["ownerId"] as? String == owner else { throw failure("Sign in with the same Google account.") }
    try persist(state, workspace: "before-sync-resolution-" + uid())
    var next = document; next["state"] = r["state"]; next["base"] = r["state"]; next["revision"] = r["revision"]; next["pending"] = [JSON]()
    try persistDocument(next); publishDocument(); syncConflict = false; syncStatus = "Synced"
  }
  func signInWithGoogle(
    server: String, authenticate: @MainActor (URL) async throws -> URL
  ) async throws {
    workspaceGeneration += 1
    let generation = workspaceGeneration
    let address = server.trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let verifier = try GoogleSignIn.verifier()
    let start = try await request(
      "/auth/google/start",
      body: ["client": "ios", "challenge": GoogleSignIn.challenge(for: verifier)],
      server: address)
    try Task.checkCancellation()
    guard generation == workspaceGeneration else {
      throw failure("Workspace changed during sign-in")
    }
    guard let value = start["url"] as? String, let url = URL(string: value),
      url.host != nil, url.user == nil, url.password == nil,
      url.scheme == "https"
        || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? ""))
    else { throw failure("Server did not provide a secure Google sign-in address") }
    let callback = try await authenticate(url)
    try Task.checkCancellation()
    guard generation == workspaceGeneration else {
      throw failure("Workspace changed during sign-in")
    }
    let code = try GoogleSignIn.callbackCode(from: callback)
    let login = try await request(
      "/auth/google/exchange", body: ["code": code, "verifier": verifier], server: address)
    try Task.checkCancellation()
    guard generation == workspaceGeneration else {
      throw failure("Workspace changed during sign-in")
    }
    guard let token = login["token"] as? String, !token.isEmpty else {
      throw failure("Server did not issue a session")
    }
    let security = try await request("/security/status", server: address, token: token)
    try Task.checkCancellation()
    guard generation == workspaceGeneration else { throw failure("Workspace changed during sign-in") }
    try SessionKey.save(token)
    UserDefaults.standard.set(address, forKey: "server")
    UserDefaults.standard.set("remote", forKey: "mode")
    mode = "remote"
    if security["enabled"] as? Bool == true && security["verified"] as? Bool != true {
      verificationRequired = true
      return
    }
    await refresh()
  }
  func command(_ type: String, _ payload: JSON) async throws {
    if owner == "legacy" {
      await refresh()
      guard owner != "legacy" else { throw failure("Connect once to finish updating this synced workspace before editing. Your records are still saved here.") }
    }
    guard !busy, !document.isEmpty else { throw failure("Your workspace is still opening") }
    busy = true
    defer { busy = false }
    if type == "backup.restore" && owner != nil {
      await refresh()
      guard pendingCount == 0 else { throw failure("Sync saved changes before restoring a backup.") }
      let r = try await request("/command", body: ["type": type, "payload": payload, "revision": revision])
      try await receive(r)
      return
    }
    let generation = workspaceGeneration, operationID = uid()
    while true {
      let version = documentGeneration
      let prepared = try await processor.command(document, type, payload, operationID)
      guard generation == workspaceGeneration else { throw failure("Workspace changed while saving") }
      // A sync may finish while the worker runs. Reapply to its confirmed state
      // instead of overwriting the update or saving an operation for another user.
      guard version == documentGeneration else { continue }
      try persistDocument(prepared.document, encoded: prepared.data)
      publishDocument()
      break
    }
    syncStatus = owner == nil ? "Saved on this device" : "Changes saved · syncing"
    if mode == "remote" { Task { await refresh() } }
  }
  func perform(_ type: String, _ payload: JSON) {
    Task {
      do { try await command(type, payload) } catch { self.error = error.localizedDescription }
    }
  }
  func bitcoinRequest(_ path: String, body: JSON = [:]) async throws {
    guard mode == "remote", !isDemo else {
      throw failure("Sign in to track a real Bitcoin address")
    }
    let generation = workspaceGeneration
    let server = baseURL
    let token = SessionKey.read()
    await refresh()
    guard pendingCount == 0 else { throw failure("Finish syncing saved changes before updating connected accounts.") }
    let r = try await request(path, body: body, server: server, token: token)
    guard mode == "remote", generation == workspaceGeneration, server == baseURL,
      token == SessionKey.read()
    else { throw failure("Workspace changed during Bitcoin sync") }
    let nextRevision = r["revision"] as? Int ?? 0
    guard nextRevision >= revision else { return }
    let next = try engine.call("validateState", [r["state"] as? JSON ?? [:]]) as? JSON ?? [:]
    try await receive(["state": next, "revision": nextRevision])
  }
  func refreshBitcoin() async {
    guard mode == "remote", !isDemo, !busy,
      accounts.contains(where: { $0.text("source") == "bitcoin" })
    else { return }
    let generation = workspaceGeneration
    do {
      try await bitcoinRequest("/bitcoin/refresh")
      for a in accounts.filter({ $0.text("source") == "bitcoin" }) {
        try Task.checkCancellation()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let checked = formatter.date(from: a.object("bitcoin").text("syncedAt")) ?? .distantPast
        if Date().timeIntervalSince(checked) >= 300 {
          try await bitcoinRequest("/bitcoin/wallets/\(a.id)/sync")
        }
      }
      if generation == workspaceGeneration { bitcoinError = "" }
    } catch is CancellationError {
    } catch {
      if generation == workspaceGeneration { bitcoinError = error.localizedDescription }
    }
  }
  func export(backup: Bool) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      backup ? "asset-backup.json" : "asset-transactions.csv")
    let data: Data
    if backup {
      data = try JSONSerialization.data(
        withJSONObject: engine.call("backup", [state]), options: [.prettyPrinted, .sortedKeys])
    } else {
      data = Data((try engine.call("exportCSV", [state]) as? String ?? "").utf8)
    }
    try data.write(to: url, options: [.atomic, .completeFileProtection])
    return url
  }
  func signOut() {
    guard pendingCount == 0 else { error = "Sync saved changes before signing out. You can export a backup in Settings."; return }
    let token = SessionKey.read()
    let server = baseURL
    do {
      let next = try engine.call("createLocalWorkspace", [uid()]) as? JSON ?? [:]
      try SessionKey.save(nil)
      do { try persistDocument(next) } catch {
        try? SessionKey.save(token)
        throw error
      }
      workspaceGeneration += 1
      verificationRequired = false; connections = []; configured = false; syncConflict = false
      syncStatus = "Saved on this device"
      publishDocument()
      UserDefaults.standard.set("private", forKey: "mode")
      if let token { Task { _ = try? await request("/auth/logout", body: [:], server: server, token: token) } }
    } catch { self.error = error.localizedDescription }
  }

}

/// A suspended connection task must never resume against a different signed-in workspace.
@MainActor struct WorkspaceRequest {
  let generation: Int
  let server: String
  let token: String?
  init(_ store: Store) { generation = store.workspaceGeneration; server = store.baseURL; token = SessionKey.read() }
  func check(_ store: Store) throws {
    try Task.checkCancellation()
    guard store.mode == "remote", store.workspaceGeneration == generation,
      store.baseURL == server, SessionKey.read() == token else { throw CancellationError() }
  }
  func request(_ store: Store, _ path: String, body: JSON? = nil) async throws -> JSON {
    try check(store)
    let result = try await store.request(path, body: body, server: server, token: token)
    try check(store); return result
  }
}
