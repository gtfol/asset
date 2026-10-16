import AuthenticationServices
import SwiftUI

@MainActor
final class GoogleAuthentication: NSObject, ObservableObject,
  ASWebAuthenticationPresentationContextProviding
{
  private var session: ASWebAuthenticationSession?
  private var continuation: CheckedContinuation<URL, Error>?
  private var activeID: UUID?
  private var anchor = ASPresentationAnchor()

  func authenticate(_ url: URL) async throws -> URL {
    guard session == nil else { throw failure("Google sign-in is already open") }
    guard
      let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
        .filter({ $0.activationState == .foregroundActive })
        .flatMap(\.windows).first(where: \.isKeyWindow)
    else { throw failure("Unable to open Google sign-in. Please try again.") }
    anchor = window
    let id = UUID()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        guard !Task.isCancelled else {
          continuation.resume(throwing: CancellationError())
          return
        }
        self.continuation = continuation
        activeID = id
        let session = ASWebAuthenticationSession(
          url: url, callback: .customScheme(GoogleSignIn.callbackScheme)
        ) { [weak self] callback, error in
          Task { @MainActor in
            if let error {
              let systemError = error as NSError
              let cancelled =
                systemError.domain == ASWebAuthenticationSessionError.errorDomain
                && systemError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue
              self?.finish(.failure(cancelled ? CancellationError() : error), id: id)
            } else if let callback {
              self?.finish(.success(callback), id: id)
            } else {
              self?.finish(
                .failure(failure("Google sign-in did not complete. Please try again.")), id: id)
            }
          }
        }
        session.presentationContextProvider = self
        self.session = session
        if !session.start() {
          finish(.failure(failure("Unable to open Google sign-in. Please try again.")), id: id)
        }
      }
    } onCancel: {
      Task { @MainActor in
        if self.activeID == id { self.cancel() }
      }
    }
  }

  func cancel() {
    guard let id = activeID else { return }
    let previous = session
    finish(.failure(CancellationError()), id: id)
    previous?.cancel()
  }

  private func finish(_ result: Result<URL, Error>, id: UUID) {
    guard activeID == id else { return }
    let pending = continuation
    continuation = nil
    session = nil
    activeID = nil
    pending?.resume(with: result)
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    anchor
  }
}
