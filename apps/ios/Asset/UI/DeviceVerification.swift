import SwiftUI

struct DeviceVerificationView: View {
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  var enrollment = false
  var onVerified: () -> Void = {}
  @State private var setup: JSON?
  @State private var code = ""
  @State private var message = ""
  @State private var working = false
  @State private var savedRecovery = false
  var body: some View {
    Form {
      Section {
        Text(enrollment ? "Use an authenticator app to protect your Apple account data. New sign-ins on web and iOS will require its code." : "Enter your authenticator code to unlock this device. A single-use recovery code also works.")
      }
      if enrollment && setup == nil {
        Button("Set up authenticator") { perform { context in
          setup = try await context.request(store, "/security/enroll", body: [:])
        } }
      }
      if let setup {
        Section("Add to your authenticator") {
          Text(setup["secret"] as? String ?? "").font(.system(.body, design: .monospaced)).textSelection(.enabled)
          if let value = setup["uri"] as? String, let url = URL(string: value) { Link("Open authenticator", destination: url) }
          Text("Or enter this setup key manually. Use a time-based, six-digit code.").foregroundStyle(.secondary)
        }
        Section("Save your recovery code") {
          Text(setup["recovery"] as? String ?? "").font(.system(.body, design: .monospaced)).textSelection(.enabled)
          Text("Keep this outside Asset. It can unlock your account once if you lose your authenticator.")
          Toggle("I saved the recovery code", isOn: $savedRecovery)
        }
      }
      if !enrollment || setup != nil {
        Section {
          TextField("Authenticator code", text: $code).textContentType(.oneTimeCode).textInputAutocapitalization(.never).autocorrectionDisabled()
          Button(working ? "Verifying…" : "Verify device") { perform { context in
            _ = try await context.request(store, "/security/verify", body: ["code": code])
            store.verificationRequired = false
            onVerified()
            if enrollment { dismiss() }
            await store.refresh()
          } }.disabled(code.count < 6 || (enrollment && !savedRecovery))
        }
      }
      if !message.isEmpty { Text(message).foregroundStyle(Color.assetSecondary) }
      if !enrollment { Button("Sign out", role: .destructive) { store.signOut() } }
    }.disabled(working).navigationTitle(enrollment ? "Authenticator" : "Verify this device")
  }
  private func perform(_ action: @escaping @MainActor (WorkspaceRequest) async throws -> Void) {
    guard !working else { return }; working = true; message = ""
    let generation = store.workspaceGeneration
    let context = WorkspaceRequest(store)
    Task { @MainActor in
      defer { working = false }
      do { try context.check(store); try await action(context); try context.check(store) } catch { if generation == store.workspaceGeneration { message = error.localizedDescription } }
    }
  }
}
