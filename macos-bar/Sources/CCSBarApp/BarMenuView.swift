import SwiftUI
import AppKit
import CCSBarCore

/// Dropdown content for the menu bar: a CCS-branded header, usage analytics,
/// per-account rows + actions, an offline state when CCS isn't running, and
/// footer controls.
struct BarMenuView: View {
  @ObservedObject var viewModel: BarViewModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      Divider()

      if viewModel.offline {
        offlineState.padding(14)
      } else {
        // Scrollbar is hidden: the panel chrome already constrains height and a
        // visible scrollbar track adds visual clutter in an always-on-screen widget.
        // Overflow is still fully scrollable — the indicator is just not shown.
        ScrollView {
          VStack(alignment: .leading, spacing: 10) {
            if let analytics = viewModel.analytics {
              BarAnalyticsView(analytics: analytics)
            }

            VStack(alignment: .leading, spacing: 6) {
              SectionLabel("Accounts")
              if let error = viewModel.lastError {
                ErrorBanner(message: error)
              }
              if viewModel.rows.isEmpty {
                Text("No accounts configured")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              } else {
                ForEach(viewModel.rows) { row in
                  BarRowView(row: row, viewModel: viewModel)
                }
              }
            }
          }
          .padding(12)
        }
        .scrollIndicators(.hidden)
        // 580 gives room for the full layout (2×2 grid + sparkline + surface section
        // + top models + accounts) without wasted whitespace on a typical 1-4 account
        // setup. The scroll still triggers gracefully when content overflows.
        .frame(maxHeight: 580)
      }

      Divider()
      footer
    }
    .frame(width: 340)
    .onAppear { viewModel.onOpen() }
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
          viewModel.iconStyle == .color ? "Color" : "Mono",
          systemImage: viewModel.iconStyle == .color ? "paintpalette" : "circle.lefthalf.filled"
        )
      }
      .help("Toggle the menu-bar icon between color and monochrome")
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
    if case .success(let discovery) = BarDiscovery.load(), let url = discovery.resolvedURL {
      NSWorkspace.shared.open(url)
    }
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
  let row: BarSummaryRow
  @ObservedObject var viewModel: BarViewModel

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
            Chip("default", tint: BarTheme.accent)
          }
          if row.paused {
            Chip("paused", tint: .secondary)
          }
          if row.needsReauth {
            Chip("reauth", tint: .red)
          }
        }
        HStack(spacing: 6) {
          Chip(row.provider, tint: BarTheme.accent)
          if let tier = row.tier { Chip(tier, tint: .secondary) }
          Text(BarFormatting.quotaLabel(percentage: row.quotaPercentage, status: row.quotaStatus))
            .font(.caption2)
            .foregroundStyle(quotaColor)
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
    switch row.health {
    case "error": return .red
    case "warning": return .orange
    default: return .green
    }
  }

  /// Quota label color: muted for "no quota", warning-tinted for "quota ?".
  private var quotaColor: Color {
    switch row.quotaStatus {
    case "unsupported": return .secondary
    case "error": return .orange
    default: return .secondary
    }
  }
}

/// Inline banner surfacing the last failed action so it is visible rather than
/// silently swallowed. Success is confirmed by the default/paused badge updating.
struct ErrorBanner: View {
  let message: String
  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
      Text(message)
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(2)
    }
    .padding(.vertical, 5)
    .padding(.horizontal, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
  }
}

/// Small pill label used in account sublines.
struct Chip: View {
  let text: String
  let tint: Color
  init(_ text: String, tint: Color) {
    self.text = text
    self.tint = tint
  }
  var body: some View {
    Text(text)
      .font(.system(size: 9, weight: .semibold))
      .padding(.horizontal, 5)
      .padding(.vertical, 1)
      .background(tint.opacity(0.16), in: Capsule())
      .foregroundStyle(tint == .secondary ? Color.secondary : tint)
  }
}
