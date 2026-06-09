import Foundation

/// Pure quota-gauge math: band selection, fill fraction, and reset-countdown
/// formatting. No SwiftUI dependency and no implicit clock — `now` is injected
/// for `resetCountdown` so the gauge is fully deterministic and testable. The
/// App layer renders a ring/bar from these values; all branch/color/countdown
/// logic lives here so the view stays a thin render.
public enum BarQuotaGauge {
  /// Severity band for the remaining-quota percentage. `.none` means the row
  /// has no live quota (unsupported provider, fetch error, or a nil percentage)
  /// and the gauge should not be drawn at all.
  public enum Band: String, Sendable, Equatable, CaseIterable {
    case green
    case yellow
    case orange
    case red
    case none
  }

  /// Map a remaining-quota percentage to a severity band. Only a status of "ok"
  /// with a real percentage yields a colored band; everything else is `.none`.
  /// Boundaries (remaining): >50 green, 21...50 yellow, 11...20 orange, <=10 red.
  public static func band(percentage pct: Double?, status: String) -> Band {
    guard status == "ok", let pct else { return .none }
    if pct > 50 { return .green }
    if pct > 20 { return .yellow }
    if pct > 10 { return .orange }
    return .red
  }

  /// Fraction of the ring/bar to fill: remaining/100 clamped to 0...1. Returns
  /// nil when there is no live quota (so the view can fall back to a text label
  /// instead of drawing an empty gauge).
  public static func fillFraction(percentage pct: Double?, status: String) -> Double? {
    guard status == "ok", let pct else { return nil }
    return min(1, max(0, pct / 100))
  }

  /// Human countdown to the next quota reset, e.g. "resets in 3h 12m",
  /// "resets in 12m", or "resets soon" when the reset time is at/in the past.
  /// Returns nil for a nil or unparseable timestamp. `now` is injected so the
  /// formatting is deterministic and unit-testable.
  public static func resetCountdown(nextReset: String?, now: Date) -> String? {
    guard let nextReset, let reset = BarFormatting.isoDate(nextReset) else { return nil }
    let secs = reset.timeIntervalSince(now)
    if secs <= 0 { return "resets soon" }
    let totalMinutes = Int(secs / 60)
    let hours = totalMinutes / 60
    let minutes = totalMinutes % 60
    if hours > 0 { return "resets in \(hours)h \(minutes)m" }
    return "resets in \(minutes)m"
  }
}
