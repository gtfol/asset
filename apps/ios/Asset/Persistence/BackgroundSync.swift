import Foundation
import Combine

/// One account at a time, with a fence for providers that ignore cancellation.
@MainActor class BackgroundSyncQueue: ObservableObject {
  @MainActor final class Progress {
    fileprivate var valid = true
    fileprivate var lastUpdate = ContinuousClock.now
    fileprivate var update: ((String) -> Void)?
    func check() throws {
      try Task.checkCancellation()
      guard valid else { throw CancellationError() }
    }
    func report(_ message: String) throws {
      try check()
      lastUpdate = .now
      update?(message)
    }
  }
  private struct Job {
    let key: String
    let label: String
    let action: @MainActor (Progress) async throws -> Void
  }
  @Published private(set) var activeKey: String?
  @Published private(set) var message = ""
  @Published private(set) var failures: [String: String] = [:]
  var working: Bool { activeKey != nil }
  private var pending: [Job] = []
  private var progress: Progress?
  private var worker: Task<Void, Never>?
  private var watchdog: Task<Void, Never>?
  private let idleTimeout: Duration
  init(idleTimeout: Duration = .seconds(60)) { self.idleTimeout = idleTimeout }

  func enqueue(key: String, label: String, priority: Bool = false,
    action: @escaping @MainActor (Progress) async throws -> Void) {
    guard activeKey != key, !pending.contains(where: { $0.key == key }) else { return }
    let job = Job(key: key, label: label, action: action)
    if priority { pending.insert(job, at: 0) } else { pending.append(job) }
    startNext()
  }
  func stop() {
    pending.removeAll()
    progress?.valid = false
    progress?.update = nil
    progress = nil
    worker?.cancel(); worker = nil
    watchdog?.cancel(); watchdog = nil
    activeKey = nil
    message = "Sync paused. Already saved data is kept."
  }
  func reset() {
    stop()
    failures.removeAll()
    message = ""
  }
  private func startNext() {
    guard !working, !pending.isEmpty else { return }
    let job = pending.removeFirst(), context = Progress()
    activeKey = job.key
    failures[job.key] = nil
    message = "Updating \(job.label)…"
    progress = context
    context.update = { [weak self] text in self?.message = text }
    worker = Task { [weak self] in
      do {
        try await job.action(context)
        self?.finish(job, context, error: nil)
      } catch {
        self?.finish(job, context, error: error)
      }
    }
    watchdog = Task { [weak self, idleTimeout] in
      while !Task.isCancelled {
        do { try await Task.sleep(for: min(idleTimeout, .seconds(1))) } catch { return }
        guard context.valid else { return }
        if context.lastUpdate.duration(to: .now) >= idleTimeout {
          self?.worker?.cancel()
          self?.finish(job, context, error: failure("\(job.label) stopped responding. Retry sync to continue from saved progress."))
          return
        }
      }
    }
  }
  private func finish(_ job: Job, _ context: Progress, error: Error?) {
    guard progress === context, context.valid else { return }
    context.valid = false
    context.update = nil
    progress = nil
    worker = nil
    watchdog?.cancel(); watchdog = nil
    activeKey = nil
    if let error {
      if !(error is CancellationError) { failures[job.key] = error.localizedDescription }
      message = error is CancellationError ? "Sync paused. Already saved data is kept." : error.localizedDescription
    } else {
      message = failures.isEmpty ? "Apple accounts are up to date." : "Sync finished. Some accounts need attention."
    }
    startNext()
  }
}
