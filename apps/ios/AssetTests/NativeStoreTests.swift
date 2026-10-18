import Foundation

private struct RegressionFailure: Error, CustomStringConvertible {
  let description: String
}

@main
@MainActor
private enum NativeStoreTests {
  private static var checks = 0

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    checks += 1
    if !condition() { throw RegressionFailure(description: message) }
  }

  private static func measure(_ operation: () throws -> Void) rethrows -> Double {
    let start = ContinuousClock.now
    try operation()
    let duration = start.duration(to: .now).components
    return Double(duration.seconds) * 1_000 + Double(duration.attoseconds) / 1e15
  }

  private static func fixture(
    _ id: String, date: String = "2026-10-15", name: String = "Little Bird", notes: String = "",
    account: String = "checking", category: String = "groceries", kind: String = "spending",
    reviewed: Bool = false, splits: [JSON] = [], removed: Bool = false, edits: JSON = [:]
  ) -> JSON {
    [
      "id": id, "date": date, "name": name, "notes": notes, "accountId": account,
      "categoryId": category, "kind": kind, "reviewed": reviewed, "splits": splits,
      "removed": removed, "edits": edits, "amount": 1_000, "currency": "USD",
      "source": "manual", "importedAt": "2026-10-15T12:00:00Z",
    ]
  }

  static func main() async throws {
    // The executable has its own preferences domain. Do not open/persist an app workspace.
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = Store(directory: directory)
    try expect(store.mode == "private" && store.accounts.isEmpty, "First launch opens an empty local workspace: \(store.error)")
    try await store.command("account.save", ["id": "local-account", "name": "Local", "type": "checking", "currency": "USD", "balance": 12345, "source": "manual", "updatedAt": "2026-10-18T12:00:00Z"])
    let reopened = Store(directory: directory)
    try expect(reopened.accounts.first?.integer("balance") == 12345, "A local account survives a Store restart without signing in")
    let demo = try store.engine.call("createDemo", ["2026-10-15"]) as? JSON ?? [:]
    try expect(!demo.isEmpty, "Production calculation engine must load from the temporary bundle")
    try checkGoogleSignIn()
    try checkAppLock()
    try checkPlaidLifecycle()
    try checkAPIRequests()
    try checkIdentitiesAndTransactions(store: store, demo: demo)
    try checkFiltersAndPaging(store: store, demo: demo)
    try checkInvalidation(store: store, demo: demo)
    try measureLargeLedger(store: store, demo: demo)
    print(
      "PASS: \(checks) native sign-in, Plaid lifecycle, API requests, Store identity, filtering, paging, and cache invalidation checks."
    )
  }

  private static func checkAppLock() throws {
    var lock = AppLockLifecycle()
    lock.configure(protected: true, active: true)
    try expect(lock.hidden && lock.locked, "Private workspaces start locked")
    let first = lock.begin()!
    lock.resign()
    try expect(
      lock.hidden && lock.authenticating,
      "Biometric system prompt keeps the privacy cover without cancelling authentication")
    lock.activate()
    try expect(
      lock.begin() == nil, "Activation during authentication must not create a second prompt")
    try expect(
      lock.finish(first, success: true) && !lock.hidden,
      "Successful authentication reveals only the active workspace")
    lock.resign()
    try expect(
      lock.hidden && lock.locked, "Opening the switcher immediately hides and relocks the workspace"
    )
    lock.activate()
    let second = lock.begin()!
    lock.background()
    try expect(
      !lock.finish(second, success: true) && lock.hidden,
      "A delayed success after backgrounding cannot unlock the app")
    lock.activate()
    let third = lock.begin()!
    try expect(
      lock.finish(third, success: false) && lock.hidden,
      "Cancelled or failed authentication stays locked")
    let fourth = lock.begin()!
    lock.configure(protected: false, active: true)
    try expect(
      !lock.finish(fourth, success: true) && !lock.hidden,
      "Workspace changes invalidate an in-flight unlock")
    lock.configure(protected: true, active: true)
    try expect(
      lock.locked && lock.hidden, "Reopening a private workspace requires fresh authentication")
  }

  private static func checkGoogleSignIn() throws {
    let verifier = try GoogleSignIn.verifier()
    let second = try GoogleSignIn.verifier()
    let allowed = CharacterSet(
      charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    try expect(
      verifier.count == 43 && verifier.unicodeScalars.allSatisfy(allowed.contains),
      "PKCE verifier is 32 random bytes encoded as unpadded base64url")
    try expect(verifier != second, "Every Google sign-in receives a new verifier")
    try expect(
      GoogleSignIn.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      "PKCE S256 challenge matches the RFC 7636 reference vector")
    let code = try GoogleSignIn.callbackCode(
      from: URL(string: "org.gtfol.asset://auth/callback?code=one-time_code")!)
    try expect(code == "one-time_code", "Exact callback returns its one-time exchange code")
    let emptyFragment = try GoogleSignIn.callbackCode(from: URL(string: "org.gtfol.asset://auth/callback?code=one-time_code#")!)
    try expect(emptyFragment == "one-time_code", "OAuth redirects may carry an empty fragment without changing the callback")
    for invalid in [
      "org.gtfol.asset://auth/callback?error=auth_failed",
      "org.gtfol.asset://auth/callback?code=one&error=auth_failed",
      "org.gtfol.asset://auth/callback?token=bearer",
      "org.gtfol.asset://auth/callback?code=one&token=bearer",
      "org.gtfol.asset://auth/callback?code=one&code=two",
      "org.gtfol.asset://auth/callback?code=",
      "org.gtfol.asset://auth/callback",
      "other://auth/callback?code=one",
      "org.gtfol.asset://other/callback?code=one",
      "org.gtfol.asset://auth/other?code=one",
      "org.gtfol.asset://auth/callback?code=one#token=bearer",
      "org.gtfol.asset://user@auth/callback?code=one",
      "org.gtfol.asset://auth:123/callback?code=one",
    ] {
      var rejected = false
      do { _ = try GoogleSignIn.callbackCode(from: URL(string: invalid)!) } catch {
        rejected = true
      }
      try expect(
        rejected, "Invalid, ambiguous, or token-bearing callback must be rejected: \(invalid)")
    }
  }

  private static func checkPlaidLifecycle() throws {
    var lifecycle = PlaidLinkLifecycle()
    let original = PlaidLinkAttempt(
      product: "investments", connectionID: "existing", workspaceGeneration: 3,
      server: "https://asset.example", token: "session-a")
    let replacement = PlaidLinkAttempt(
      product: "transactions", connectionID: nil, workspaceGeneration: 4,
      server: "https://other.example", token: "session-b")
    try expect(lifecycle.begin(original), "A fresh Link attempt starts")
    try expect(!lifecycle.begin(replacement), "An active Link attempt rejects overlapping starts")
    try expect(
      lifecycle.attempt == original,
      "An overlap cannot change captured product, connection, or workspace")
    try expect(
      !lifecycle.loaded(replacement.id), "Stale load callbacks cannot ready another session")
    try expect(lifecycle.loaded(original.id) && lifecycle.ready, "Current session can become ready")
    try expect(
      lifecycle.consume(original.id), "Success consumes the current session before exchange")
    try expect(
      !lifecycle.ready && lifecycle.active, "Consumed sessions stay locked while exchanging")
    try expect(!lifecycle.consume(original.id), "Duplicate success callbacks cannot exchange twice")
    try expect(
      !lifecycle.loaded(original.id), "Late load callbacks cannot reopen a consumed session")
    try expect(
      !lifecycle.finish(replacement.id), "Stale completion cannot clear the current attempt")
    try expect(
      lifecycle.finish(original.id) && !lifecycle.active, "Completion or failure releases the lock")
    try expect(lifecycle.begin(replacement), "Retry creates a new session after a failed exchange")
    try expect(!lifecycle.consume(original.id), "An old success cannot consume the retry session")
    try expect(!lifecycle.finish(original.id), "An old exit cannot cancel the retry session")
    try expect(lifecycle.attempt == replacement, "Retry retains its own immutable context")
    try expect(lifecycle.finish(replacement.id), "Cancellation clears the current session")
  }

  private static func checkAPIRequests() throws {
    let server = "https://asset.example"
    let payload: JSON = [
      "clientId": "sample-client", "secret": "sample-secret", "environment": "sandbox",
    ]
    let put = try APIRequest.make(
      "/plaid/config", body: payload, server: server, token: "session", method: "PUT")
    try expect(put.httpMethod == "PUT", "Credential writes use PUT")
    try expect(
      put.value(forHTTPHeaderField: "Authorization") == "Bearer session",
      "PUT retains bearer authentication")
    try expect(
      put.value(forHTTPHeaderField: "x-asset-client") == "ios",
      "Native requests identify their platform")
    let decoded = try JSONSerialization.jsonObject(with: put.httpBody!) as? JSON
    try expect(
      decoded?["secret"] as? String == "sample-secret", "Credentials are sent in the request body")
    try expect(
      put.url?.query == nil && put.url?.path == "/api/plaid/config",
      "Credentials never enter the URL")
    let delete = try APIRequest.make(
      "/plaid/config", server: server, token: "session", method: "DELETE")
    try expect(
      delete.httpMethod == "DELETE" && delete.httpBody == nil, "Removal uses DELETE without a body")
    try expect(
      delete.value(forHTTPHeaderField: "Authorization") == "Bearer session",
      "DELETE retains bearer authentication")
    let get = try APIRequest.make("/plaid/config", server: server, token: "session")
    try expect(get.httpMethod == "GET", "Existing bodyless requests remain GET")
    let post = try APIRequest.make("/plaid/link-token", body: [:], server: server, token: "session")
    try expect(post.httpMethod == "POST", "Existing body requests remain POST")
    for path in ["/auth/google/start", "/auth/google/exchange"] {
      let auth = try APIRequest.make(path, body: [:], server: server, token: "old-session")
      try expect(
        auth.value(forHTTPHeaderField: "Authorization") == nil,
        "Google sign-in does not receive a previous bearer session")
    }
  }

  private static func checkIdentitiesAndTransactions(store: Store, demo: JSON) throws {
    let anonymous = Row(["name": "No identity field"])
    try expect(anonymous.id == anonymous.id, "A Row's fallback identity must be stable")
    try expect(Row(["month": "2026-10"]).id == "2026-10", "Month rows have calendar identities")
    try expect(Row(["date": "2026-10-15"]).id == "2026-10-15", "Date rows have calendar identities")
    var state = demo
    state["transactions"] = [
      fixture("b"), fixture("a"), fixture("removed", removed: true),
      fixture("older", date: "2026-10-14"),
      fixture(
        "edited", date: "2026-09-01", edits: ["name": "Edited merchant", "date": "2026-10-16"]),
    ]
    store.state = state
    let ordered = store.transactions
    try expect(
      ordered.map(\.id) == ["edited", "a", "b", "older"],
      "Sort is date descending, ID ascending for ties; removed rows are absent")
    try expect(
      ordered.first?.text("name") == "Edited merchant", "Transaction snapshots include manual edits"
    )
    try expect(
      store.transactions.map(\.id) == ordered.map(\.id),
      "Repeated transaction reads keep stable order")
    try expect(
      (state["transactions"] as? [JSON])?.first?["name"] as? String == "Little Bird",
      "Materializing display rows must not change imported records")
  }

  private static func checkFiltersAndPaging(store: Store, demo: JSON) throws {
    let split = Row(
      fixture(
        "split", category: "home",
        splits: [
          ["id": "part-a", "categoryId": "coffee", "amount": 400],
          ["id": "part-b", "categoryId": "groceries", "amount": 600],
        ]))
    try expect(
      TransactionFilters(category: "coffee").matches(split), "Category search includes split parts")
    try expect(
      !TransactionFilters(category: "home").matches(split),
      "Split parents do not also match their original category")
    let noted = Row(
      fixture(
        "note", date: "2026-10-14", name: "Corner Store", notes: "Lunch with BIRD team",
        reviewed: true))
    try expect(
      TransactionFilters(query: "bird").matches(noted), "Search includes notes and ignores case")
    try expect(TransactionFilters(query: "little").matches(split), "Search includes merchant names")
    try expect(
      !TransactionFilters(account: "card").matches(noted), "Account filters exclude other accounts")
    try expect(
      !TransactionFilters(kind: "income").matches(noted),
      "Kind filters preserve stored enum matching")
    try expect(
      !TransactionFilters(reviewOnly: true).matches(noted),
      "Review filters exclude reviewed transactions")
    try expect(
      TransactionFilters(start: "2026-10-14", end: "2026-10-14").matches(noted),
      "Date bounds are inclusive")
    try expect(
      !TransactionFilters(start: "2026-10-15").matches(noted), "Start bound excludes earlier dates")
    try expect(
      !TransactionFilters(end: "2026-10-13").matches(noted), "End bound excludes later dates")
    var state = demo
    state["transactions"] = (0..<171).reversed().map { index in
      fixture(
        String(format: "page-%03d", index), date: index < 90 ? "2026-10-15" : "2026-10-14",
        reviewed: index.isMultiple(of: 2))
    }
    store.state = state
    let ordered = store.transactions
    var page = TransactionListPage()
    page.reload(transactions: ordered, filters: TransactionFilters(), reset: true)
    try expect(
      page.total == 171 && page.loadedCount == 80 && page.hasMore,
      "Initial page loads 80 of 171 matching rows")
    try expect(
      page.groups.flatMap(\.rows).map(\.id) == Array(ordered.prefix(80)).map(\.id),
      "First page preserves transaction order")
    page.loadMore()
    try expect(
      page.loadedCount == 160 && page.groups.count == 2,
      "Second page crosses a date boundary without losing rows")
    try expect(
      page.groups.map(\.id) == ["2026-10-15", "2026-10-14"],
      "Groups are ordered and use date identities")
    try expect(
      page.groups.flatMap(\.rows).map(\.id) == Array(ordered.prefix(160)).map(\.id),
      "Grouped second page contains exactly the loaded prefix")
    page.loadMore()
    try expect(
      page.loadedCount == 171 && !page.hasMore, "Final partial page stops at the exact count")
    page.loadMore()
    try expect(
      page.loadedCount == 171 && page.loadedIDs.count == 171,
      "Loading after the last page creates no duplicates")
    page.reload(transactions: ordered, filters: TransactionFilters(reviewOnly: true), reset: true)
    try expect(
      page.total == 85 && page.loadedCount == 80,
      "A filter change resets the page and counts matching rows")
    try expect(
      page.groups.flatMap(\.rows).allSatisfy { !$0.flag("reviewed") },
      "Every displayed row satisfies its active filter")
    page.loadMore()
    let removedID = page.groups[0].rows[0].id
    page.reload(
      transactions: ordered.filter { $0.id != removedID },
      filters: TransactionFilters(reviewOnly: true), reset: false)
    try expect(
      page.total == 84 && page.loadedCount == 84 && !page.loadedIDs.contains(removedID),
      "Reload after mutation retains page depth and prunes removed IDs")
    page.reload(
      transactions: ordered, filters: TransactionFilters(query: "no matching name"), reset: true)
    try expect(
      page.total == 0 && page.loadedCount == 0 && page.groups.isEmpty && !page.hasMore,
      "No matches produce a complete empty page")
  }

  private static func checkInvalidation(store: Store, demo: JSON) throws {
    store.state = demo
    let generation = store.stateGeneration
    let before = store.calculation("dashboard", ["2026-10", "2026-10-15"])
    try expect(before.text("error").isEmpty, "Dashboard must calculate successfully")
    _ = store.accounts
    _ = store.categories
    _ = store.transactions
    _ = store.account(id: "checking")
    _ = store.category(id: "coffee")
    let added = fixture("cache-mutation", name: "Regression expense", category: "coffee")
    let changed =
      try store.engine.call(
        "applyCommand", [demo, ["type": "transaction.create", "payload": added]]) as? JSON ?? [:]
    store.state = changed
    try expect(
      store.stateGeneration > generation, "State replacement advances the cache generation")
    try expect(
      store.transactions.contains { $0.id == "cache-mutation" },
      "Transaction cache invalidates after a command result")
    let after = store.calculation("dashboard", ["2026-10", "2026-10-15"])
    try expect(
      after.integer("spending") == before.integer("spending") + 1_000,
      "Financial calculations read the current state after a real transaction command")
    let warm = store.calculation("dashboard", ["2026-10", "2026-10-15"])
    try expect(
      warm.integer("spending") == after.integer("spending"),
      "Repeated calculation returns the current result")
    let earlier = store.calculation("dashboard", ["2026-09", "2026-09-30"])
    try expect(
      earlier.text("month") == "2026-09", "Financial calculations distinguish requested periods")
    let generationBeforeNestedWrite = store.stateGeneration
    var accounts = store.accounts.map(\.data)
    accounts[0]["name"] = "Renamed checking"
    store.state["accounts"] = accounts
    try expect(
      store.stateGeneration > generationBeforeNestedWrite,
      "Dictionary writeback invalidates state caches")
    try expect(
      store.account(id: "checking")?.text("name") == "Renamed checking",
      "Account lookup invalidates after in-place state mutation")
    var categories = store.categories.map(\.data)
    let coffee = categories.firstIndex { $0["id"] as? String == "coffee" }!
    categories[coffee]["name"] = "Espresso"
    store.state["categories"] = categories
    try expect(
      store.category(id: "coffee")?.text("name") == "Espresso",
      "Category lookup invalidates after in-place state mutation")
    store.state = try store.engine.call("emptyState") as? JSON ?? [:]
    try expect(
      store.transactions.isEmpty && store.accounts.isEmpty,
      "Workspace replacement clears materialized ledger and account caches")
    try expect(
      store.account(id: "checking") == nil, "Workspace replacement clears old account lookups")
    let empty = store.calculation("dashboard", ["2026-10", "2026-10-15"])
    try expect(
      empty.integer("spending") == 0, "Financial calculations use the replaced workspace")
  }

  private static func measureLargeLedger(store: Store, demo: JSON) throws {
    let seed = Row(demo).rows("transactions").first { $0.text("kind") == "spending" }!.data
    var state = demo
    state["transactions"] = (0..<25_000).map { index -> JSON in
      var transaction = seed
      transaction["id"] = String(format: "large-%05d", index)
      transaction["date"] = "2026-10-\(String(format: "%02d", index % 15 + 1))"
      transaction["name"] = index.isMultiple(of: 10) ? "Needle merchant" : "Everyday merchant"
      return transaction
    }
    store.state = state
    let materialize = measure { _ = store.transactions }
    let warmRows = measure { for _ in 0..<1_000 { _ = store.transactions.count } }
    var page = TransactionListPage()
    let firstPage = measure {
      page.reload(transactions: store.transactions, filters: TransactionFilters(), reset: true)
    }
    try expect(
      page.total == 25_000 && page.loadedCount == 80,
      "Large ledger starts with only one page materialized for display")
    let loadAll = measure {
      while page.hasMore { page.loadMore() }
    }
    try expect(
      page.loadedCount == 25_000 && page.loadedIDs.count == 25_000,
      "Loading every page preserves the entire large ledger without duplicates")
    print(String(format: "TIMING load all 25,000 rows through 80-row pages: %.2fms.", loadAll))
    let search = measure {
      page.reload(
        transactions: store.transactions, filters: TransactionFilters(query: "needle"), reset: true)
    }
    try expect(page.total == 2_500, "Large-ledger query returns the expected matching count")
    let generation = store.stateGeneration
    let changed =
      try store.engine.call(
        "applyCommand",
        [
          state,
          [
            "type": "transaction.update",
            "payload": [
              "id": "large-00000", "edits": ["name": "Renamed merchant", "date": "2026-10-16"],
            ],
          ],
        ]) as? JSON ?? [:]
    let reload = measure {
      store.state = changed
      page.reload(
        transactions: store.transactions, filters: TransactionFilters(query: "needle"), reset: false
      )
    }
    try expect(
      store.stateGeneration > generation && store.transactions.count == 25_000,
      "A large-ledger edit invalidates the cache while retaining every transaction")
    try expect(
      store.transactions.first?.id == "large-00000"
        && store.transactions.first?.text("name") == "Renamed merchant",
      "The edited date changes sort order while preserving transaction identity")
    try expect(
      page.total == 2_499 && page.loadedCount == 80 && !page.loadedIDs.contains("large-00000"),
      "Reload after editing rechecks query membership and removes the old match")
    print(
      String(format: "TIMING cache invalidation and filtered reload after an edit: %.2fms.", reload)
    )
    let calculation = measure { _ = store.calculation("dashboard", ["2026-10", "2026-10-15"]) }
    let repeatedCalculations = measure {
      for _ in 0..<5 { _ = store.calculation("dashboard", ["2026-10", "2026-10-15"]) }
    }
    print(
      String(
        format:
          "TIMING 25,000 rows (macOS, optimized build): materialize %.2fms; 1,000 cached row reads %.2fms; first page %.2fms; filtered page %.2fms; first Dashboard %.2fms; 5 repeated uncached Dashboards %.2fms.",
        materialize, warmRows, firstPage, search, calculation, repeatedCalculations))
    print(
      "Timings describe Store computation on this machine; they do not measure simulator rendering or scrolling frame rate."
    )
  }
}
