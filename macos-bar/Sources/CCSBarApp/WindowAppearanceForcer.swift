import SwiftUI
import AppKit
import CCSBarCore

/// Zero-size bridge that walks up to the host `NSWindow` and:
///   1. Forces its `appearance` to match the user's chosen `BarAppearance`.
///   2. Fixes `collectionBehavior` to `.moveToActiveSpace` so the panel is
///      never visible on multiple Spaces / displays simultaneously (#1503).
///   3. Anchors the panel to the screen where the user clicked the status item
///      by reading `NSEvent.mouseLocation` at open-time (#1502).
///
/// Why (1) exists on top of `.preferredColorScheme`: that modifier only
/// rewrites the SwiftUI `\.colorScheme` environment for descendant views — it
/// does NOT change the host `NSWindow.effectiveAppearance`. So AppKit-level
/// surfaces keep reading the OS appearance and fight the chosen theme:
///   - system materials (the MenuBarExtra popover's backing material)
///   - semantic colors (`Color.primary` / `.secondary`, used by Chip text,
///     health dots, captions) which invert off the window appearance.
/// Setting `window.appearance` directly fixes the theme at the AppKit layer so
/// the whole surface flips, not just the custom RGB tokens.
///
/// Why (2): the default `NSPanel` created by SwiftUI `MenuBarExtra(.window)`
/// can carry `NSWindow.CollectionBehavior.canJoinAllSpaces`, which makes it
/// appear on every Space and every display simultaneously. Switching to
/// `.moveToActiveSpace` (the correct behavior for a transient panel) removes
/// the multi-display ghost (#1503).
///
/// Why (3): with "Displays have separate Spaces" on, the menu bar icon appears
/// on every display but the panel can open on the wrong screen when its initial
/// frame is computed relative to `NSScreen.main` instead of the clicked screen.
/// Reading `NSEvent.mouseLocation` at open-time gives the screen of interaction;
/// if the panel is on a different screen we reposition it to match (#1502).
///
/// Modeled on the proven `ScrollerHider` pattern (which already reaches the host
/// window inside this popover), proving cross-window AppKit access works here.
struct WindowAppearanceForcer: NSViewRepresentable {
  let appearance: BarAppearance

  func makeNSView(context: Context) -> NSView {
    let probe = NSView(frame: .zero)
    // Defer until the view is in the hierarchy; at make-time `view.window` is nil.
    DispatchQueue.main.async { apply(to: probe, isFirstOpen: true) }
    return probe
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    // Re-apply on every update: the popover's NSWindow can be rebuilt on content
    // changes, and the appearance pick itself changes mid-session. Screen
    // anchoring is skipped on updates (isFirstOpen: false) to avoid fighting
    // SwiftUI's own layout passes once the panel is already shown.
    DispatchQueue.main.async { apply(to: nsView, isFirstOpen: false) }
  }

  /// Apply all window fixes: appearance, collectionBehavior, and (on first open)
  /// screen anchoring.
  ///
  ///   .system -> nil   (follow the OS)
  ///   .light  -> aqua
  ///   .dark   -> darkAqua
  private func apply(to view: NSView, isFirstOpen: Bool) {
    guard let window = view.window else { return }

    // (1) Appearance.
    switch appearance {
    case .system:
      window.appearance = nil
    case .light:
      window.appearance = NSAppearance(named: .aqua)
    case .dark:
      window.appearance = NSAppearance(named: .darkAqua)
    }

    // (2) Collection behavior — fix #1503.
    // Remove canJoinAllSpaces so the panel does not ghost across all displays.
    // .moveToActiveSpace is the correct policy for a transient menu bar panel:
    // it stays on the Space where it was opened, moves with the user's active
    // Space on Space switches, and is never visible on multiple displays at once.
    var behavior = window.collectionBehavior
    behavior.remove(.canJoinAllSpaces)
    behavior.insert(.moveToActiveSpace)
    window.collectionBehavior = behavior

    // (3) Screen anchoring on first open — fix #1502.
    // NSEvent.mouseLocation reports the click position in global (screen)
    // coordinates at the time the panel opens. If the panel landed on a
    // different screen than the one that was clicked, move it there.
    // This is a no-op on a single-display setup or when the panel is already
    // on the correct screen.
    if isFirstOpen {
      anchorToClickedScreen(window: window)
    }
  }

  /// Repositions `window` to the screen that contains the current mouse cursor
  /// if that screen differs from the screen the panel currently occupies.
  ///
  /// The y-offset from the top of the screen is preserved so the panel still
  /// appears just below the menu bar on the correct display.
  private func anchorToClickedScreen(window: NSWindow) {
    let mouseGlobal = NSEvent.mouseLocation
    let screens = NSScreen.screens
    guard
      let clickedScreen = BarScreenPicker.screen(for: mouseGlobal, in: screens),
      let panelScreen = window.screen,
      clickedScreen != panelScreen
    else { return }

    // Compute the distance from the top of the panel's current screen to the
    // top of the panel frame. "Top" in macOS global coords = maxY (Y increases
    // upward). Preserve this offset when moving to the clicked screen.
    let currentMaxY = panelScreen.frame.maxY
    let panelFrame = window.frame
    let distanceFromTop = currentMaxY - panelFrame.maxY

    // Place the panel at the same relative position from the top of the clicked
    // screen, horizontally centered on that screen.
    let targetMaxY = clickedScreen.frame.maxY - distanceFromTop
    let targetX = clickedScreen.frame.midX - panelFrame.width / 2
    let targetOrigin = NSPoint(x: targetX, y: targetMaxY - panelFrame.height)

    window.setFrameOrigin(targetOrigin)
  }
}

/// Pure helper: given a list of screen frames and a point in global coordinates,
/// returns the screen whose frame contains the point. Falls back to the first
/// screen if no screen contains the point (e.g. the cursor is between displays).
///
/// Extracted from `WindowAppearanceForcer` so the decision logic can be
/// unit-tested headlessly in the `ccs-bar-check` assert harness without AppKit.
enum BarScreenPicker {
  /// Returns the element of `screens` whose `frame` contains `point`, or `nil`
  /// if `screens` is empty. When no screen contains `point` exactly (gap between
  /// displays), returns the closest screen by distance to frame center.
  static func screen(for point: NSPoint, in screens: [NSScreen]) -> NSScreen? {
    guard !screens.isEmpty else { return nil }
    // Exact hit first.
    if let exact = screens.first(where: { $0.frame.contains(point) }) {
      return exact
    }
    // Fallback: closest by Euclidean distance from frame center (handles gaps).
    return screens.min(by: { a, b in
      distanceSquared(from: point, to: a.frame) < distanceSquared(from: point, to: b.frame)
    })
  }

  // MARK: - Internal helpers (fileprivate for tests via same module)

  /// Squared Euclidean distance from a point to the nearest point on a rect.
  /// Zero when the point is inside the rect (handled by the caller first).
  static func distanceSquared(from point: NSPoint, to rect: NSRect) -> CGFloat {
    let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
    let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
    return dx * dx + dy * dy
  }
}
