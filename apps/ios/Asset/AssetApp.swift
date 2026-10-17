import LocalAuthentication
import SwiftUI
import UIKit
import UserNotifications

@main struct AssetApp: App {
  @UIApplicationDelegateAdaptor(AssetAppDelegate.self) private var delegate
  @StateObject private var store = Store()
  @AppStorage("appearance") var appearance = "system"
  var body: some Scene {
    WindowGroup {
      PrivateAppRoot().listStyle(.plain).scrollContentBackground(.hidden).environmentObject(store)
        .tint(
          .assetText
        ).foregroundStyle(Color.assetText).font(
          .custom("Lato-Regular", size: 16, relativeTo: .body)
        ).preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
        .task(id: store.mode) { await NotificationDelivery.shared.prepare(store: store) }
    }
  }
}

@MainActor
final class AssetAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }
  func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    Task { await NotificationDelivery.shared.register(token) }
  }
  func application(
    _ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    NotificationDelivery.shared.message =
      "Push registration is unavailable. Your alerts are still available inside Asset."
  }
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    await MainActor.run {
      NotificationCenter.default.post(name: .assetOpenNotifications, object: nil)
    }
  }
}
extension Notification.Name {
  static let assetOpenNotifications = Notification.Name("assetOpenNotifications")
}
@MainActor final class NotificationDelivery: ObservableObject {
  static let shared = NotificationDelivery()
  @Published var message = "Checking push availability…"
  @Published var available = false
  @Published var enabled = false
  private weak var store: Store?
  func prepare(store: Store) async {
    self.store = store
    available = false
    enabled = false
    guard store.mode == "remote", !store.isDemo else {
      message = "Sign in to receive iPhone alerts while Asset is closed."
      return
    }
    let generation = store.workspaceGeneration
    do {
      let result = try await store.request("/notifications/status")
      guard generation == store.workspaceGeneration, store.mode == "remote" else { return }
      available = result["pushAvailable"] as? Bool ?? false
      if !available {
        message = "iPhone push delivery is awaiting setup. Alerts are available inside Asset."
        return
      }
      let settings = await UNUserNotificationCenter.current().notificationSettings()
      guard generation == store.workspaceGeneration else { return }
      enabled = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
      message =
        enabled
        ? "Notifications are allowed on this iPhone."
        : "Enable iPhone notifications to receive alerts while Asset is closed."
      if enabled { UIApplication.shared.registerForRemoteNotifications() }
    } catch { message = "Could not check push availability. Try again when connected." }
  }
  func enable() async {
    guard available else { return }
    do {
      enabled = try await UNUserNotificationCenter.current().requestAuthorization(options: [
        .alert, .sound, .badge,
      ])
      if enabled {
        UIApplication.shared.registerForRemoteNotifications()
      } else {
        message = "Allow notifications for Asset in iPhone Settings."
      }
    } catch { message = "Notifications could not be enabled. Try again in iPhone Settings." }
  }
  func register(_ token: String) async {
    guard let store, store.mode == "remote", !store.isDemo, available else { return }
    let generation = store.workspaceGeneration
    #if DEBUG
      let environment = "sandbox"
    #else
      let environment = "production"
    #endif
    do {
      _ = try await store.request(
        "/notifications/devices", body: ["token": token, "environment": environment])
      guard generation == store.workspaceGeneration else { return }
      message = "iPhone notifications are enabled. Lock-screen messages hide financial details."
    } catch { message = "Could not finish push setup. Alerts remain available inside Asset." }
  }
}

@MainActor final class AppPrivacy: ObservableObject {
  @Published private var lifecycle = AppLockLifecycle()
  var locked: Bool { lifecycle.locked }
  var inactive: Bool { lifecycle.inactive }
  var authenticating: Bool { lifecycle.authenticating }
  @Published private(set) var message = ""
  private var protected: Bool { lifecycle.protected }
  private var context: LAContext?
  private var observers: [NSObjectProtocol] = []
  private var cover: UIWindow?
  var hidden: Bool { lifecycle.hidden }

  init() {
    for name in [
      UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification,
      UIApplication.didBecomeActiveNotification,
    ] {
      observers.append(
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
          [weak self] note in
          MainActor.assumeIsolated { self?.transition(note.name) }
        })
    }
  }
  func attach(to scene: UIWindowScene) {
    if cover?.windowScene !== scene {
      cover?.isHidden = true
      let window = UIWindow(windowScene: scene)
      window.windowLevel = .alert + 1
      window.backgroundColor = .clear
      window.rootViewController = UIHostingController(rootView: PrivacyCover(privacy: self))
      window.rootViewController?.view.accessibilityViewIsModal = true
      cover = window
    }
    updateCover()
  }
  func configure(protected: Bool) {
    guard self.protected != protected else {
      updateCover()
      return
    }
    invalidate()
    lifecycle.configure(
      protected: protected, active: UIApplication.shared.applicationState == .active)
    updateCover()
    if protected && !inactive { authenticate() }
  }
  private func transition(_ name: Notification.Name) {
    if name == UIApplication.willResignActiveNotification {
      lifecycle.resign()
      cover?.windowScene?.windows.filter { $0 !== cover }.forEach { $0.endEditing(true) }
      // UIKit cover is installed synchronously, before iOS captures a switcher snapshot.
      updateCover()
    } else if name == UIApplication.didEnterBackgroundNotification {
      invalidate()
      lifecycle.background()
      updateCover()
    } else {
      lifecycle.activate()
      updateCover()
      if locked && protected && !authenticating { authenticate() }
    }
  }
  private func invalidate() {
    lifecycle.cancel()
    context?.invalidate()
    context = nil
    message = ""
  }
  private func updateCover() {
    cover?.isHidden = !hidden
  }
  func authenticate() {
    guard protected, locked, !inactive, !authenticating else { return }
    let next = LAContext()
    next.localizedCancelTitle = "Keep locked"
    next.touchIDAuthenticationAllowableReuseDuration = 0
    var error: NSError?
    guard next.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      message = "Set up a device passcode and Touch ID or Face ID in Settings to unlock Asset."
      updateCover()
      return
    }
    context = next
    guard let id = lifecycle.begin() else { return }
    message = ""
    Task {
      do {
        let success = try await next.evaluatePolicy(
          .deviceOwnerAuthentication, localizedReason: "Unlock your financial information in Asset."
        )
        guard lifecycle.finish(id, success: success) else { return }
      } catch {
        guard lifecycle.finish(id, success: false) else { return }
        message = "Asset is locked. Authenticate to continue."
      }
      context = nil
      updateCover()
    }
  }
}

private struct PrivacyCover: View {
  @ObservedObject var privacy: AppPrivacy
  var body: some View {
    ZStack {
      Rectangle().fill(.ultraThickMaterial).ignoresSafeArea()
      // An opaque layer prevents large balances from being readable through the blur.
      Color(uiColor: .systemBackground).opacity(0.97).ignoresSafeArea()
      VStack(spacing: 20) {
        Image(systemName: "lock").font(.system(size: 25, weight: .regular))
        Text("asset").font(.custom("Lato-Regular", size: 26))
        if !privacy.inactive {
          Text(privacy.message.isEmpty ? "Unlock to view your workspace." : privacy.message)
            .font(.custom("Lato-Regular", size: 16)).foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
          Button(privacy.authenticating ? "Unlocking…" : "Unlock Asset") { privacy.authenticate() }
            .buttonStyle(.borderedProminent).tint(.primary).disabled(privacy.authenticating)
        }
      }.padding(32).frame(maxWidth: 420)
    }.accessibilityIdentifier("asset-privacy-cover")
  }
}

private struct PrivacyWindowAnchor: UIViewRepresentable {
  let privacy: AppPrivacy
  final class Anchor: UIView {
    var onAttach: ((UIWindowScene) -> Void)?
    override func didMoveToWindow() {
      super.didMoveToWindow()
      if let scene = window?.windowScene { onAttach?(scene) }
    }
  }
  func makeUIView(context: Context) -> Anchor {
    let view = Anchor()
    view.onAttach = { privacy.attach(to: $0) }
    return view
  }
  func updateUIView(_ view: Anchor, context: Context) {
    if let scene = view.window?.windowScene { privacy.attach(to: scene) }
  }
}
private struct PrivateAppRoot: View {
  @EnvironmentObject var store: Store
  @StateObject private var privacy = AppPrivacy()
  var protected: Bool { !store.mode.isEmpty && !store.isDemo }
  var body: some View {
    RootView()
      .allowsHitTesting(!privacy.hidden)
      .accessibilityHidden(privacy.hidden)
      .background(PrivacyWindowAnchor(privacy: privacy).frame(width: 0, height: 0))
      .onChange(of: protected, initial: true) { _, value in privacy.configure(protected: value) }
  }
}
