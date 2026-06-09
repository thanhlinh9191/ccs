import SwiftUI
import CCSBarCore

/// A compact bar sparkline for daily values (e.g. cost per day over 7 days).
/// Zero-value days render as faint placeholders so the cadence stays readable.
struct Sparkline: View {
  let values: [Double]
  // Default is the dark preset's accent: a default argument can't read the
  // environment, so this is the static fallback. Live callers pass the themed
  // `theme.accent` from the parent so the rendered bar follows the chosen theme.
  var accent: Color = BarTheme.dark.accent

  var body: some View {
    GeometryReader { geo in
      let peak = max(values.max() ?? 0, 0.0001)
      HStack(alignment: .bottom, spacing: 3) {
        ForEach(Array(values.enumerated()), id: \.offset) { _, value in
          let height = CGFloat(value / peak) * geo.size.height
          RoundedRectangle(cornerRadius: 2)
            .fill(value > 0 ? accent : Color.secondary.opacity(0.2))
            .frame(height: max(2, height))
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }
  }
}
