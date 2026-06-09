import SwiftUI
import CCSBarCore

/// Usage analytics block: spend rollups, a 30-day cost sparkline, surface
/// breakdown, and top models.
///
/// Pivots on `hasRecentData`: when the trailing 30 days carry no spend, the three
/// dead Today/7d/30d cells read as "broken", so they collapse into one honest
/// "No usage in N days" line with all-time + last-active promoted to the hero.
struct BarAnalyticsView: View {
  let analytics: BarAnalytics

  private var lastActive: String? {
    BarFormatting.lastActiveLabel(
      iso: analytics.lastActivityAt, daysSince: analytics.daysSinceLastActivity)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionLabel("Usage")

      if analytics.hasRecentData {
        recentGrid
      } else {
        idleHero
      }

      sparklineBlock

      // Surface breakdown: "how much Claude Code vs Codex" — only shown when
      // the backend supplies at least one surface entry. Top 5 keeps the section
      // compact; the full list is available in the dashboard.
      if !analytics.bySurface.isEmpty {
        SectionLabel("By surface")
        let peakSurface = analytics.bySurface.map(\.cost).max() ?? 1
        ForEach(analytics.bySurface.prefix(5)) { surface in
          SurfaceBar(surface: surface, peak: peakSurface)
        }
      }

      // Top models.
      if !analytics.topModels.isEmpty {
        let scope = analytics.topModelsWindow == "30d" ? "30d" : "all-time"
        SectionLabel("Top models · \(scope)")
        let peak = analytics.topModels.map(\.cost).max() ?? 1
        ForEach(analytics.topModels.prefix(4)) { model in
          ModelBar(model: model, peak: peak)
        }
      }
    }
  }

  /// Live spend grid (only when recent windows actually carry data).
  private var recentGrid: some View {
    VStack(spacing: 5) {
      HStack(spacing: 5) {
        StatCell(title: "Today", value: BarFormatting.money(analytics.today.cost))
        StatCell(title: "7 days", value: BarFormatting.money(analytics.last7d.cost))
      }
      HStack(spacing: 5) {
        StatCell(title: "30 days", value: BarFormatting.money(analytics.last30d.cost))
        StatCell(title: "All-time", value: BarFormatting.money(analytics.allTime.cost), accent: true)
      }
    }
  }

  /// Honest idle state: a single "No usage in N days" line, with all-time spend
  /// promoted to the hero and the last-active caption underneath.
  private var idleHero: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        Image(systemName: "moon.zzz")
          .font(.caption)
          .foregroundStyle(.secondary)
        Text(idleHeadline)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      StatCell(
        title: "All-time spend",
        value: BarFormatting.money(analytics.allTime.cost),
        accent: true)
      if let lastActive {
        Text(lastActive)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var idleHeadline: String {
    if let d = analytics.daysSinceLastActivity {
      return "No usage in \(d) days"
    }
    return "No usage in 30 days"
  }

  /// Sparkline over the 30-day series, with an honest placeholder when every day
  /// is zero (a flat line with no context reads as broken).
  private var sparklineBlock: some View {
    VStack(alignment: .leading, spacing: 4) {
      if sparklineIsEmpty {
        Text(idleHeadline)
          .font(.caption2).foregroundStyle(.secondary)
        if let lastActive {
          Text(lastActive).font(.caption2).foregroundStyle(.tertiary)
        }
      } else {
        HStack {
          Text("Last 30 days").font(.caption2).foregroundStyle(.secondary)
          Spacer()
          Text("\(BarFormatting.count(analytics.last30d.requests)) req")
            .font(.caption2).foregroundStyle(.secondary)
        }
        Sparkline(values: analytics.byDay.map(\.cost)).frame(height: 28)
      }
    }
  }

  private var sparklineIsEmpty: Bool {
    analytics.byDay.allSatisfy { $0.cost <= 0 }
  }
}

/// One usage-surface row: surface name + proportional accent bar + cost and
/// request count. Mirrors ModelBar visually so the two sections feel cohesive.
private struct SurfaceBar: View {
  let surface: BarAnalyticsSurface
  let peak: Double

  var body: some View {
    GeometryReader { geo in
      let fraction = peak > 0 ? CGFloat(surface.cost / peak) : 0
      ZStack(alignment: .leading) {
        RoundedRectangle(cornerRadius: 5)
          .fill(BarTheme.accent.opacity(0.16))
          .frame(width: max(8, geo.size.width * fraction))
        HStack {
          Text(surface.surface)
            .font(.caption)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer()
          HStack(spacing: 4) {
            Text(BarFormatting.count(surface.requests))
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(.tertiary)
            Text(BarFormatting.money(surface.cost))
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(.secondary)
          }
        }
        .padding(.horizontal, 8)
      }
    }
    .frame(height: 22)
  }
}

/// A small labelled stat tile.
private struct StatCell: View {
  let title: String
  let value: String
  var accent: Bool = false

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title.uppercased())
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(.secondary)
      Text(value)
        .font(.system(.callout, design: .rounded).weight(.semibold))
        .foregroundStyle(accent ? BarTheme.accent : .primary)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 5)
    .padding(.horizontal, 9)
    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
  }
}

/// One top-model row: name + spend with a proportional accent bar behind.
private struct ModelBar: View {
  let model: BarAnalytics.Model
  let peak: Double

  var body: some View {
    GeometryReader { geo in
      let fraction = peak > 0 ? CGFloat(model.cost / peak) : 0
      ZStack(alignment: .leading) {
        RoundedRectangle(cornerRadius: 5)
          .fill(BarTheme.accent.opacity(0.16))
          .frame(width: max(8, geo.size.width * fraction))
        HStack {
          Text(model.model)
            .font(.caption)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer()
          Text(BarFormatting.money(model.cost))
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
      }
    }
    .frame(height: 22)
  }
}

/// Uppercase section divider label.
struct SectionLabel: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text.uppercased())
      .font(.system(size: 10, weight: .bold))
      .foregroundStyle(.secondary)
      .padding(.top, 1)
  }
}
