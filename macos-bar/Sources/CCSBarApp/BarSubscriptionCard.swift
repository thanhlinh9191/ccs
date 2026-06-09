import SwiftUI
import CCSBarCore

/// Dedicated, detailed card for a native first-party subscription (Claude Code /
/// Codex). Replaces the cramped generic `BarRowView` for native rows so the
/// user's own plan quota reads as the cockpit hero: a single-column vertical
/// stack, one fact per line, no 2-column flex wrap.
///
/// Why this exists separately from `BarRowView`: the generic row double-labelled
/// the product, showed a confusing "no data" cost cell, and carried pause/solo +
/// tier-lock controls that make no sense for a non-routable flat-rate
/// subscription. Stripping those four elements and stacking the windows
/// vertically is the de-cramping fix. All binding/burn math is pulled fresh at
/// render from `BarQuotaGauge` (pure Core) so the pace clause reflects `now`.
struct BarSubscriptionCard: View {
  let row: BarSummaryRow
  /// Injected so the pace/countdown math is deterministic; defaults to the live
  /// clock in production and is pinned in previews.
  var now: Date = Date()

  /// Windows decoded from the row; empty for error/reauth rows (no hero gauge).
  private var windows: [QuotaWindowDetail] { row.quotaWindows ?? [] }

  /// The window the subscription runs out of first (lowest remaining). Drives the
  /// hero gauge; nil when there is no quota data (error/reauth row).
  private var binding: QuotaWindowDetail? {
    BarQuotaGauge.selectBindingWindow(windows)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      titleRow
      if let binding {
        heroBlock(binding)
        if let secondary = secondaryWindow(excluding: binding) {
          secondaryLine(secondary)
        }
        opusSonnetLines
        staleFootnote
      } else {
        emptyState
      }
    }
    .padding(.vertical, 9)
    .padding(.horizontal, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      BarTheme.subscription.opacity(0.07),
      in: RoundedRectangle(cornerRadius: 9))
  }

  // MARK: Title

  /// Product name + tier chip. No provider-chip echo, no "subscription" badge
  /// (the section header carries that), no pause toggle, no overflow menu —
  /// those four removals are the de-cramping fix.
  private var titleRow: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(healthColor)
        .frame(width: 8, height: 8)
      Text(BarFormatting.providerLabel(row.provider))
        .font(.system(.body, design: .default).weight(.semibold))
        .lineLimit(1)
      if row.needsReauth {
        Chip("reauth", tint: .red)
      }
      Spacer(minLength: 4)
      if let tier = row.tier {
        Chip(tier, tint: BarTheme.subscription)
      }
    }
  }

  // MARK: Hero (binding window)

  private func heroBlock(_ w: QuotaWindowDetail) -> some View {
    let band = BarQuotaGauge.band(percentage: w.remainingPercent, status: "ok")
    let fill = BarQuotaGauge.fillFraction(percentage: w.remainingPercent, status: "ok") ?? 0
    return VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .center, spacing: 8) {
        heroGauge(fill: fill, color: color(for: band))
        Text("\(Int(w.remainingPercent.rounded()))% left")
          .font(.system(.callout, design: .rounded).weight(.semibold))
          .foregroundStyle(color(for: band))
      }
      Text(heroFacts(w))
        .font(.caption2)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// Full-width hero gauge bar, filled by the remaining fraction and tinted by
  /// the severity band (reuses Core band/fill math).
  private func heroGauge(fill: Double, color: Color) -> some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(Color.primary.opacity(0.12))
        Capsule()
          .fill(color)
          .frame(width: max(3, geo.size.width * fill))
      }
    }
    .frame(height: 7)
    .frame(maxWidth: .infinity)
  }

  /// One wrapped facts line: "<label> window · resets <countdown> · <pace>".
  /// When pace is nil the line ends after the reset countdown; when the limit is
  /// reached the pace clause replaces the bare countdown.
  private func heroFacts(_ w: QuotaWindowDetail) -> String {
    let pace = BarQuotaGauge.paceClause(
      usedPercent: w.usedPercent,
      remainingPercent: w.remainingPercent,
      resetAt: w.resetAt,
      windowMinutes: w.windowMinutes,
      status: row.quotaStatus,
      now: now)
    // The limit-reached pace clause already carries "resets in ...", so it
    // stands in for the countdown rather than appending to it.
    if let pace, pace.hasPrefix("limit reached") {
      return "\(w.label) window · \(pace)"
    }
    var parts = ["\(w.label) window"]
    if let countdown = BarQuotaGauge.resetCountdown(nextReset: w.resetAt, now: now) {
      parts.append(countdown)
    }
    if let pace { parts.append(pace) }
    return parts.joined(separator: " · ")
  }

  // MARK: Secondary window

  /// The other core window (the non-binding of five_hour / seven_day) shown as a
  /// thin inline bar plus a compact remaining + reset line. Opus/Sonnet are NOT
  /// secondary candidates — they have their own split lines.
  private func secondaryWindow(excluding binding: QuotaWindowDetail) -> QuotaWindowDetail? {
    let core = windows.filter { $0.key == "five_hour" || $0.key == "seven_day" }
    return core.first { $0.key != binding.key }
  }

  private func secondaryLine(_ w: QuotaWindowDetail) -> some View {
    let band = BarQuotaGauge.band(percentage: w.remainingPercent, status: "ok")
    let fill = BarQuotaGauge.fillFraction(percentage: w.remainingPercent, status: "ok") ?? 0
    return HStack(spacing: 6) {
      thinBar(fill: fill, color: color(for: band))
      Text("\(w.label)  \(Int(w.remainingPercent.rounded()))%")
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(.secondary)
      if let countdown = BarQuotaGauge.resetCountdown(nextReset: w.resetAt, now: now) {
        Text("· \(countdown)")
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
  }

  // MARK: Opus / Sonnet split (Claude Max only)

  /// Indented Opus/Sonnet weekly sub-lines, present only when the row carries the
  /// seven_day_opus / seven_day_sonnet windows (Claude Max). Omitted gracefully
  /// for Pro / Codex.
  @ViewBuilder private var opusSonnetLines: some View {
    let opus = windows.first { $0.key == "seven_day_opus" }
    let sonnet = windows.first { $0.key == "seven_day_sonnet" }
    if opus != nil || sonnet != nil {
      VStack(alignment: .leading, spacing: 2) {
        if let opus { splitLine(title: "Opus", w: opus) }
        if let sonnet { splitLine(title: "Sonnet", w: sonnet) }
      }
    }
  }

  private func splitLine(title: String, w: QuotaWindowDetail) -> some View {
    HStack(spacing: 4) {
      Text("└ \(title)")
        .font(.caption2)
        .foregroundStyle(.tertiary)
      Text("\(Int(w.remainingPercent.rounded()))%")
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(.secondary)
      if let short = BarCardFormatting.shortReset(iso: w.resetAt, now: now) {
        Text("· resets \(short)")
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
  }

  // MARK: Stale footnote (Codex only)

  /// Muted "as of <HH:mm> (older session)" caption when the Codex reading came
  /// from an older session. The gauge/percent still render normally — the data is
  /// real, only its freshness is qualified. Never fakes a "live" badge.
  @ViewBuilder private var staleFootnote: some View {
    if let stale = row.staleAsOf, let clock = BarCardFormatting.clockTime(iso: stale) {
      HStack(spacing: 4) {
        Image(systemName: "clock.arrow.circlepath")
          .font(.system(size: 9))
          .foregroundStyle(.tertiary)
        Text("as of \(clock) (older session)")
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
    }
  }

  // MARK: Empty / error

  /// No quota windows (reauth / error row): no hero gauge, just the honest
  /// tri-state quota label. Never shows a "no data" cost cell.
  private var emptyState: some View {
    Text(
      row.needsReauth
        ? "reauth needed"
        : BarFormatting.quotaLabel(percentage: row.quotaPercentage, status: row.quotaStatus)
    )
    .font(.caption)
    .foregroundStyle(.secondary)
  }

  // MARK: Shared visuals

  private func thinBar(fill: Double, color: Color) -> some View {
    ZStack(alignment: .leading) {
      Capsule().fill(Color.primary.opacity(0.10))
      Capsule().fill(color).frame(width: max(2, 40 * fill))
    }
    .frame(width: 40, height: 4)
  }

  private var healthColor: Color {
    switch row.health {
    case "error": return .red
    case "warning": return .orange
    default: return .green
    }
  }

  private func color(for band: BarQuotaGauge.Band) -> Color {
    switch band {
    case .green: return .green
    case .yellow: return .yellow
    case .orange: return .orange
    case .red: return .red
    case .none: return .secondary
    }
  }
}
