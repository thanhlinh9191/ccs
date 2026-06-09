import SwiftUI

/// CCS Bar entry point. A menu-bar-only app (no dock icon) whose title shows
/// the leading account's quota and today's total cost, with a dropdown for
/// per-account detail and control.
@main
struct CCSBarApp: App {
  @StateObject private var viewModel = BarViewModel()

  init() {
    // Seed the registration domain BEFORE any pref read so absent Bool keys
    // resolve to their real defaults (true) instead of reading back as false,
    // which would silently disable every alert on a fresh install.
    BarPreferences().registerDefaults()
  }

  var body: some Scene {
    MenuBarExtra {
      BarMenuView(viewModel: viewModel)
    } label: {
      // The CCS mark + compact glance. The image re-renders when the style
      // preference changes because `iconStyle` is observed.
      Image(nsImage: MenuBarIcon.statusImage(viewModel.iconStyle))
      Text(viewModel.statusTitle)
    }
    .menuBarExtraStyle(.window)
  }
}
