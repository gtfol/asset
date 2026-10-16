import SwiftUI

@main struct AssetApp: App {
  @StateObject private var store = Store()
  @AppStorage("appearance") var appearance = "system"
  var body: some Scene {
    WindowGroup {
      RootView().listStyle(.plain).scrollContentBackground(.hidden).environmentObject(store).tint(
        .assetText
      ).foregroundStyle(Color.assetText).font(
        .custom("Lato-Regular", size: 16, relativeTo: .body)
      ).preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
    }
  }
}
