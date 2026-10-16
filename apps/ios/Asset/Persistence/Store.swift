import CryptoKit
import JavaScriptCore
import Security
import SwiftUI

typealias JSON = [String: Any]
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
func dateToday() -> String {
  let f = DateFormatter()
  f.dateFormat = "yyyy-MM-dd"
  f.locale = Locale(identifier: "en_US_POSIX")
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
      parts.scheme == callbackScheme, parts.host == "auth", parts.path == "/callback",
      parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil
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

@MainActor final class Engine {
  private let context = JSContext()!
  private var exception: String?
  init() {
    context.exceptionHandler = { [weak self] _, error in self?.exception = error?.toString() }
    guard let url = Bundle.main.url(forResource: "CalculationEngine", withExtension: "js"),
      let source = try? String(contentsOf: url, encoding: .utf8)
    else { fatalError("Missing shared engine; run npm run native:resources") }
    context.evaluateScript(source)
  }
  func call(_ function: String, _ args: [Any] = []) throws -> Any {
    exception = nil
    let value = context.objectForKeyedSubscript("AssetCore")?.objectForKeyedSubscript(function)?
      .call(withArguments: args)
    if let exception { throw failure(exception) }
    guard let result = value?.toObject() else {
      throw failure("Calculation unavailable: \(function)")
    }
    return result
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
    }
  }
  private(set) var stateGeneration = 0
  private var cachedAccounts: [Row]?
  private var cachedCategories: [Row]?
  private var cachedTransactions: [Row]?
  private var cachedAccountsByID: [String: Row]?
  private var cachedCategoriesByID: [String: Row]?
  @Published var mode = ""
  @Published var error = ""
  @Published var busy = false
  @Published var connections: [Row] = []
  @Published var configured = false
  @Published var revision = 0
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
  init() {
    mode = UserDefaults.standard.string(forKey: "mode") ?? ""
    if mode == "remote" && SessionKey.read() == nil { mode = "" }
    if !mode.isEmpty {
      do {
        state =
          try JSONSerialization.jsonObject(with: Data(contentsOf: fileURL(mode))) as? JSON ?? [:]
        _ = try engine.call("validateState", [state])
      } catch {
        self.error =
          "Saved data could not be opened. It has been preserved. \(error.localizedDescription)"
        mode = ""
      }
    }
  }
  func fileURL(_ name: String) throws -> URL {
    let dir = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("Asset", isDirectory: true)
    try FileManager.default.createDirectory(
      at: dir, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    var url = dir
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    return dir.appendingPathComponent(name + ".json")
  }
  func persist(_ next: JSON, workspace: String? = nil) throws {
    let data = try JSONSerialization.data(withJSONObject: next, options: [.sortedKeys])
    try data.write(to: fileURL(workspace ?? mode), options: [.atomic, .completeFileProtection])
  }
  func openLocal(demo: Bool) {
    workspaceGeneration += 1
    do {
      mode = demo ? "demo" : "private"
      let url = try fileURL(mode)
      if FileManager.default.fileExists(atPath: url.path) {
        state = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? JSON ?? [:]
        _ = try engine.call("validateState", [state])
      } else {
        state = try engine.call(demo ? "createDemo" : "emptyState") as? JSON ?? [:]
        if !demo { state["categories"] = (try engine.call("createDemo") as? JSON)?["categories"] }
        try persist(state)
      }
      connections = []
      configured = false
      revision = 0
      UserDefaults.standard.set(mode, forKey: "mode")
    } catch {
      self.error = error.localizedDescription
      mode = ""
    }
  }
  func calculation(_ name: String, _ args: [Any] = []) -> Row {
    do { return Row(try engine.call(name, [state] + args) as? JSON ?? [:]) } catch {
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
    let req = try APIRequest.make(
      path, body: body, server: server ?? baseURL, token: token ?? SessionKey.read(), method: method
    )
    let (data, response) = try await session.data(for: req)
    let result = try JSONSerialization.jsonObject(with: data) as? JSON ?? [:]
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw failure(result["error"] as? String ?? "Server request failed")
    }
    return result
  }
  func refresh() async {
    guard mode == "remote" else { return }
    let generation = workspaceGeneration
    let server = baseURL
    let token = SessionKey.read()
    do {
      let r = try await request("/state", server: server, token: token)
      guard mode == "remote", generation == workspaceGeneration,
        server == baseURL, token == SessionKey.read()
      else { return }
      let nextRevision = r["revision"] as? Int ?? 0
      guard nextRevision >= revision else { return }
      let next = try engine.call("validateState", [r["state"] as? JSON ?? [:]]) as? JSON ?? [:]
      try persist(next)
      state = next
      revision = nextRevision
      connections = (r["connections"] as? [JSON] ?? []).map(Row.init)
      configured = r["plaidConfigured"] as? Bool ?? false
    } catch {
      guard mode == "remote", generation == workspaceGeneration,
        server == baseURL, token == SessionKey.read()
      else { return }
      self.error = "Could not refresh. Showing saved data. \(error.localizedDescription)"
    }
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
    let result = try await request("/state", server: address, token: token)
    try Task.checkCancellation()
    guard generation == workspaceGeneration else {
      throw failure("Workspace changed during sign-in")
    }
    let next = try engine.call("validateState", [result["state"] as? JSON ?? [:]]) as? JSON ?? [:]
    let previousToken = SessionKey.read()
    try SessionKey.save(token)
    do { try persist(next, workspace: "remote") } catch {
      try? SessionKey.save(previousToken)
      throw error
    }
    UserDefaults.standard.set(address, forKey: "server")
    UserDefaults.standard.set("remote", forKey: "mode")
    state = next
    revision = result["revision"] as? Int ?? 0
    connections = (result["connections"] as? [JSON] ?? []).map(Row.init)
    configured = result["plaidConfigured"] as? Bool ?? false
    mode = "remote"
  }
  func command(_ type: String, _ payload: JSON) async throws {
    guard !busy else { throw failure("A change is still saving") }
    busy = true
    defer { busy = false }
    if mode == "remote" {
      let generation = workspaceGeneration
      do {
        let r = try await request(
          "/command", body: ["type": type, "payload": payload, "revision": revision])
        guard mode == "remote", generation == workspaceGeneration else {
          throw failure("Workspace changed while the update was saving")
        }
        let next = try engine.call("validateState", [r["state"] as? JSON ?? [:]]) as? JSON ?? [:]
        try persist(next)
        state = next
        revision = r["revision"] as? Int ?? 0
      } catch {
        if generation == workspaceGeneration { await refresh() }
        throw error
      }
    } else {
      let next =
        try engine.call("applyCommand", [state, ["type": type, "payload": payload]]) as? JSON ?? [:]
      try persist(next)
      state = next
    }
  }
  func perform(_ type: String, _ payload: JSON) {
    Task {
      do { try await command(type, payload) } catch { self.error = error.localizedDescription }
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
    let wasRemote = mode == "remote"
    let server = baseURL
    let token = SessionKey.read()
    workspaceGeneration += 1
    if wasRemote {
      try? SessionKey.save(nil)
      if let url = try? fileURL("remote") { try? FileManager.default.removeItem(at: url) }
    }
    state = [:]
    mode = ""
    connections = []
    configured = false
    revision = 0
    UserDefaults.standard.removeObject(forKey: "mode")
    if wasRemote, let token {
      Task { _ = try? await request("/auth/logout", body: [:], server: server, token: token) }
    }
  }
}
