import SwiftUI
import AppKit
import CCSBarCore

/// Dropdown content for the menu bar: a CCS-branded header, usage analytics,
/// per-account rows + actions, an offline state when CCS isn't running, and
/// footer controls.
struct BarMenuView: View {
  @ObservedObject var viewModel: BarViewModel
  /// Drives the preferences sheet from the footer gear.
  @State private var showingPrefs = false
  /// The prefs adapter the sheet edits; shares the standard suite with the
  /// view model so a write-through is visible on the next poll.
  private let prefs = BarPreferences()

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      Divider()

      if viewModel.offline {
        offlineState.padding(14)
      } else {
        // The scroll indicator is suppressed (.never, not just .hidden) AND the
        // enclosing NSScrollView's scroller is hard-disabled via ScrollerHider:
        // inside a MenuBarExtra popover the SwiftUI preference alone is sometimes
        // ignored and a scroller track steals width + misaligns content. With the
        // reorder + collapsed spend strip the important rows fit without scrolling
        // for the common 1-4 subscription setup; the scroll only engages for
        // genuine pool/model overflow.
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            // (1) ALERTS first — urgent quota crossings surface above everything.
            // Spend-cap alerts are opt-in OFF by default, so by default only
            // quota/reauth/cooldown conditions appear here.
            if !viewModel.activeAlerts.isEmpty {
              VStack(alignment: .leading, spacing: 6) {
                SectionLabel("Alerts")
                ForEach(viewModel.activeAlerts) { alert in
                  AlertRow(alert: alert)
                }
              }
            }

            // (2) SUBSCRIPTIONS — the dominant section, opens here.
            accountsSection

            // (3) SPEND — demoted to a thin informational strip below the cockpit.
            if let analytics = viewModel.analytics {
              Divider()
              BarAnalyticsView(analytics: analytics, section: .spend)
            }

            // (4) POOL ACCOUNTS — compact generic rows, subordinate.
            poolSection

            // (5) BY-SURFACE / TOP MODELS — tightened detail, below the pool.
            if let analytics = viewModel.analytics,
              BarAnalyticsView(analytics: analytics, section: .breakdown).hasBreakdown
            {
              BarAnalyticsView(analytics: analytics, section: .breakdown)
            }

            // Zero-size AppKit bridge that disables the popover's NSScrollView
            // scroller at runtime (belt-and-suspenders with .scrollIndicators).
            ScrollerHider().frame(width: 0, height: 0)
          }
          .padding(12)
        }
        .scrollIndicators(.never)
        // 580 fits the full reordered layout (subscription cards + spend strip +
        // pool rows + surface/models) without wasted whitespace for a typical
        // 1-4 account setup. Scroll engages gracefully only on real overflow.
        .frame(maxHeight: 580)
      }

      Divider()
      footer
    }
    .frame(width: 340)
    .onAppear { viewModel.onOpen() }
    .sheet(isPresented: $showingPrefs) {
      BarPreferencesView(viewModel: viewModel, prefs: prefs)
    }
  }

  /// The cockpit. Native subscriptions (Claude Code / Codex) render as detailed
  /// `BarSubscriptionCard`s at the very top, ordered tightest-binding-first
  /// (closest to empty on top) so the window the user is about to run out of
  /// leads. CLIProxy pool accounts keep the compact generic `BarRowView` below,
  /// subordinate. The two-section split is suppressed when only one kind is
  /// present, preserving the single "Accounts" header for a CLIProxy-only setup.
  @ViewBuilder private var accountsSection: some View {
    let parts = BarFormatting.partitionSubscriptions(viewModel.rows)
    VStack(alignment: .leading, spacing: 6) {
      if let error = viewModel.lastError {
        ErrorBanner(message: error)
      }
      if viewModel.rows.isEmpty {
        SectionLabel("Accounts")
        Text("No accounts configured")
          .font(.caption)
          .foregroundStyle(.secondary)
      } else if parts.subscriptions.isEmpty {
        // CLIProxy-only setup: keep the single established header + generic rows.
        SectionLabel("Accounts")
        ForEach(parts.pool) { row in
          BarRowView(row: row, viewModel: viewModel)
        }
      } else {
        subscriptionsHeader(parts.subscriptions)
        ForEach(orderedSubscriptions(parts.subscriptions)) { row in
          BarSubscriptionCard(row: row)
        }
      }
    }
  }

  /// CLIProxy pool accounts as compact generic rows — subordinate, rendered below
  /// the spend strip. Suppressed entirely when there are no pool accounts, or
  /// when there are no subscriptions (the CLIProxy-only path renders pool rows
  /// under the single "Accounts" header in `accountsSection` instead).
  @ViewBuilder private var poolSection: some View {
    let parts = BarFormatting.partitionSubscriptions(viewModel.rows)
    if !parts.subscriptions.isEmpty && !parts.pool.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        SectionLabel("Pool accounts")
        ForEach(parts.pool) { row in
          BarRowView(row: row, viewModel: viewModel)
        }
      }
    }
  }

  /// "SUBSCRIPTIONS" header, with a right-aligned cross-tool headroom hint
  /// ("most room: <X> NN%") when there are >=2 subscriptions with quota data.
  /// Falls back to the bare label otherwise.
  @ViewBuilder private func subscriptionsHeader(_ subs: [BarSummaryRow]) -> some View {
    HStack(alignment: .firstTextBaseline) {
      SectionLabel("Subscriptions")
      Spacer()
      if let leader = BarQuotaGauge.headroomLeader(subs) {
        Text("most room: \(leader.label) \(Int(leader.remainingPercent.rounded()))%")
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
  }

  /// Order subscription cards by tightest binding window ascending (closest to
  /// empty on top). Rows with no binding window (error/reauth) sink to the bottom
  /// so the actionable quota always leads.
  private func orderedSubscriptions(_ subs: [BarSummaryRow]) -> [BarSummaryRow] {
    subs.sorted { a, b in
      let ra = BarQuotaGauge.selectBindingWindow(a.quotaWindows ?? [])?.remainingPercent
      let rb = BarQuotaGauge.selectBindingWindow(b.quotaWindows ?? [])?.remainingPercent
      switch (ra, rb) {
      case let (.some(x), .some(y)):
        if x != y { return x < y }
        return (a.displayName ?? a.provider) < (b.displayName ?? b.provider)
      case (.some, .none):
        return true  // a has quota, b doesn't → a first
      case (.none, .some):
        return false
      case (.none, .none):
        return (a.displayName ?? a.provider) < (b.displayName ?? b.provider)
      }
    }
  }

  private var header: some View {
    HStack(spacing: 8) {
      Image(nsImage: MenuBarIcon.headerImage())
      VStack(alignment: .leading, spacing: 0) {
        Text("CCS").font(.headline)
        Text("usage & accounts").font(.caption2).foregroundStyle(.secondary)
      }
      Spacer()
      if viewModel.isRefreshing {
        ProgressView().controlSize(.small)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }

  private var offlineState: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("CCS is not running", systemImage: "bolt.slash.fill")
        .font(.body)
      Text("Start CCS, then reopen this menu.")
        .font(.caption)
        .foregroundStyle(.secondary)
      Button("Retry") { viewModel.reconnect(); viewModel.onOpen() }
        .controlSize(.small)
    }
  }

  private var footer: some View {
    HStack(spacing: 10) {
      Button {
        openDashboard()
      } label: {
        Label("Dashboard", systemImage: "chart.bar.xaxis")
      }
      Button {
        viewModel.toggleIconStyle()
      } label: {
        Label(
          "Icon",
          systemImage: viewModel.iconStyle == .color ? "paintpalette" : "circle.lefthalf.filled"
        )
      }
      .help("Toggle the menu-bar icon between color and monochrome (does not change the bar theme)")
      Button {
        showingPrefs = true
      } label: {
        Label("Alerts", systemImage: "bell.badge")
      }
      .help("Configure alerts and the menu-bar glance")
      Spacer()
      Button {
        viewModel.onOpen()
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      .help("Refresh")
      Button {
        NSApplication.shared.terminate(nil)
      } label: {
        Image(systemName: "power")
      }
      .help("Quit CCS Bar")
    }
    .buttonStyle(.borderless)
    .font(.caption)
    .padding(.horizontal, 14)
    .padding(.vertical, 9)
  }

  private func openDashboard() {
    // Open the dashboard if the server is up; otherwise start it via `ccs config`.
    Task { await DashboardLauncher.openOrStart() }
  }
}

/// One account row — the strongest section of the glance.
///
/// Top line: health dot, name, default/paused/reauth badges. Subline: provider +
/// tier chips, the honest tri-state quota label (NN% / "no quota" / "quota ?"),
/// and a per-account "Last active <date>" caption. Trailing: today's cost (or a
/// muted "no data" when unknown vs a real "$0.00"), a visible pause/resume
/// toggle, and the overflow menu (set-default / solo / tier-lock).
struct BarRowView: View {
  @Environment(\.barTheme) private var theme
  let row: BarSummaryRow
  @ObservedObject var viewModel: BarViewModel

  /// A native first-party subscription (Claude Code / Codex) — drives the
  /// distinct "subscription" badge + indigo provider chip.
  private var isNativeSubscription: Bool {
    BarFormatting.isNativeSubscription(provider: row.provider)
  }

  var body: some View {
    HStack(alignment: .top, spacing: 9) {
      Circle()
        .fill(healthColor)
        .frame(width: 8, height: 8)
        .padding(.top, 5)

      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(row.displayName ?? row.accountId)
            .font(.system(.body, design: .default).weight(.medium))
            .lineLimit(1)
            .truncationMode(.middle)
          if row.isDefault {
            Chip("default", tint: theme.accent)
          }
          if row.paused {
            Chip("paused", tint: .secondary)
          }
          if row.needsReauth {
            Chip("reauth", tint: theme.bandRed)
          }
          if isNativeSubscription {
            Chip("subscription", tint: theme.subscription)
          }
        }
        HStack(spacing: 6) {
          Chip(
            BarFormatting.providerLabel(row.provider),
            tint: isNativeSubscription ? theme.subscription : theme.accent)
          if let tier = row.tier { Chip(tier, tint: .secondary) }
          QuotaGaugeView(
            percentage: row.quotaPercentage,
            status: row.quotaStatus,
            nextReset: row.nextReset)
        }
        if let lastActive = BarFormatting.lastActiveLabel(
          iso: row.lastActivityAt, daysSince: nil)
        {
          Text(lastActive)
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
      }

      Spacer(minLength: 4)

      VStack(alignment: .trailing, spacing: 3) {
        costView
        HStack(spacing: 2) {
          pauseToggle
          overflowMenu
        }
      }
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 8)
    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
  }

  /// Today's cost: a real "$x.xx" when known (including a genuine $0.00), a muted
  /// "no data" when the value is null (no usage record on a possibly-stale snapshot).
  @ViewBuilder private var costView: some View {
    if let cost = row.todayCost {
      Text(BarFormatting.money(cost))
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(.secondary)
    } else {
      Text("no data")
        .font(.caption2)
        .foregroundStyle(.tertiary)
    }
  }

  /// Visible primary action: one tap to pause or resume the account.
  private var pauseToggle: some View {
    Button {
      if row.paused { viewModel.resume(row) } else { viewModel.pause(row) }
    } label: {
      Image(systemName: row.paused ? "play.circle" : "pause.circle")
    }
    .buttonStyle(.borderless)
    .help(row.paused ? "Resume account" : "Pause account")
  }

  private var overflowMenu: some View {
    Menu {
      Button("Set as default") { viewModel.setDefault(row) }
      Button("Solo (pause others)") { viewModel.solo(row) }
      Divider()
      if let tier = row.tier {
        Button("Lock to \(tier)") { viewModel.tierLock(row, tier: tier) }
      }
      Button("Clear tier lock") { viewModel.tierLock(row, tier: nil) }
    } label: {
      Image(systemName: "ellipsis.circle")
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .frame(width: 24)
  }

  /// Health dot. With the corrected backend, "unsupported" providers (ghcp/kiro)
  /// arrive as health "ok" (green) — no permanent orange dot. Orange is reserved
  /// for genuine transient fetch failures, red for accounts needing reauth.
  private var healthColor: Color {
    // Use the themed band ramp (not raw system .red/.orange/.green) so the dot
    // matches the rest of the dropdown and stays legible on both plates.
    switch row.health {
    case "error": return theme.bandRed
    case "warning": return theme.bandAmber
    default: return theme.bandGreen
    }
  }
}

/// Per-account quota gauge. When the row has a live "ok" quota with a percentage,
/// renders a thin colored bar (filled by the remaining fraction, tinted by the
/// severity band) plus a "resets in …" caption. When there is no live quota it
/// falls back to the honest text label ("no quota" / "quota ?"). All branch,
/// color, and countdown logic lives in the pure Core `BarQuotaGauge`; this view
/// is a thin render.
struct QuotaGaugeView: View {
  @Environment(\.barTheme) private var theme
  let percentage: Double?
  let status: String
  let nextReset: String?

  var body: some View {
    let band = BarQuotaGauge.band(percentage: percentage, status: status)
    if band != .none, let fill = BarQuotaGauge.fillFraction(percentage: percentage, status: status) {
      HStack(spacing: 5) {
        gaugeBar(fill: fill, color: color(for: band))
        Text(BarFormatting.quotaLabel(percentage: percentage, status: status))
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(color(for: band))
        if let countdown = BarQuotaGauge.resetCountdown(nextReset: nextReset, now: Date()) {
          Text(countdown)
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
      }
    } else {
      // No live quota: keep the existing honest text ("no quota" / "quota ?").
      Text(BarFormatting.quotaLabel(percentage: percentage, status: status))
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
  }

  private func gaugeBar(fill: Double, color: Color) -> some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule()
          .fill(Color.primary.opacity(0.12))
        Capsule()
          .fill(color)
          .frame(width: max(2, geo.size.width * fill))
      }
    }
    .frame(width: 44, height: 5)
  }

  private func color(for band: BarQuotaGauge.Band) -> Color {
    // Themed band ramp for whole-dropdown consistency. .orange maps to the coral
    // band (the warning step in the green→amber→coral→red ramp) so it stays
    // distinct from the brand accent orange on both plates.
    switch band {
    case .green: return theme.bandGreen
    case .yellow: return theme.bandAmber
    case .orange: return theme.bandCoral
    case .red: return theme.bandRed
    case .none: return .secondary
    }
  }
}

/// Inline banner surfacing the last failed action so it is visible rather than
/// silently swallowed. Success is confirmed by the default/paused badge updating.
struct ErrorBanner: View {
  @Environment(\.barTheme) private var theme
  let message: String
  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(theme.accent)
      Text(message)
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(2)
    }
    .padding(.vertical, 5)
    .padding(.horizontal, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(theme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
  }
}

/// One in-dropdown alert row. Mirrors a delivered notification so the conditions
/// are visible even when system notifications are denied. The icon is keyed off
/// the alert kind so each rule reads at a glance.
struct AlertRow: View {
  @Environment(\.barTheme) private var theme
  let alert: BarNotification

  var body: some View {
    HStack(alignment: .top, spacing: 6) {
      Image(systemName: icon)
        .foregroundStyle(tint)
        .font(.caption)
        .padding(.top, 1)
      VStack(alignment: .leading, spacing: 1) {
        Text(alert.title)
          .font(.caption.weight(.medium))
        Text(alert.body)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 5)
    .padding(.horizontal, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
  }

  private var icon: String {
    switch alert.kind {
    case .quotaRemainingBelow: return "gauge.with.dots.needle.bottom.0percent"
    case .dailySpendAbove, .monthSpendAbove: return "dollarsign.circle"
    case .reauthNeeded: return "key.slash"
    case .accountCooldownOrPaused: return "pause.circle"
    }
  }

  private var tint: Color {
    // Themed: quota warnings take the brand accent, reauth the critical band,
    // so alert chips match the rest of the dropdown on both plates.
    switch alert.kind {
    case .quotaRemainingBelow: return theme.accent
    case .dailySpendAbove, .monthSpendAbove: return theme.accent
    case .reauthNeeded: return theme.bandRed
    case .accountCooldownOrPaused: return .secondary
    }
  }
}

/// Small pill label used in account sublines.
struct Chip: View {
  @Environment(\.colorScheme) private var colorScheme
  let text: String
  let tint: Color
  init(_ text: String, tint: Color) {
    self.text = text
    self.tint = tint
  }
  /// Lift the small 9pt label toward the opposite of the surface so it stays
  /// legible: toward white on the dark plate (the raw indigo subscription tint
  /// was too dim to read), toward black on the light plate (lifting toward white
  /// there would wash the text out). The forced scheme is already in effect on
  /// this subtree, so `colorScheme` reflects exactly the plate being drawn.
  private var textColor: Color {
    if tint == .secondary { return .secondary }
    let target: NSColor = (colorScheme == .light) ? .black : .white
    let lifted = NSColor(tint).blended(withFraction: 0.5, of: target) ?? NSColor(tint)
    return Color(nsColor: lifted)
  }
  var body: some View {
    Text(text)
      .font(.system(size: 9.5, weight: .semibold))
      .padding(.horizontal, 5)
      .padding(.vertical, 1.5)
      .background(tint.opacity(0.22), in: Capsule())
      .foregroundStyle(textColor)
  }
}
