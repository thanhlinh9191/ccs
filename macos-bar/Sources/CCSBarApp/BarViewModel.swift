import Foundation
import SwiftUI
import CCSBarCore

/// Observable state for the menu bar. Holds the last-known rows for instant
/// paint, reconnects to the CCS web-server via the discovery file or by
/// self-starting the server, and fires a debounced force-refresh when the
/// menu opens.
@MainActor
final class BarViewModel: ObservableObject {
  @Published var rows: [BarSummaryRow] = []
  @Published var analytics: BarAnalytics?
  @Published var offline = false
  @Published var lastError: String?
  @Published var isRefreshing = false
  /// True while the launcher is waiting for the server to become reachable.
  @Published var isStarting = false
  @Published var iconStyle: BarIconStyle {
    didSet { MenuBarIcon.saveStyle(iconStyle) }
  }
  /// User-selected dropdown theme (System / Light / Dark). Global chrome, not an
  /// alert pref, so it persists on its own key and bypasses the draft/writeThrough
  /// path. Being @Published makes the MenuBarExtra re-render `ThemedRoot` the
  /// instant it changes, giving a live theme switch.
  @Published var appearance: BarAppearance {
    didSet { BarAppearanceStore.save(appearance) }
  }
  /// Which figure leads the always-on title. Persisted; a change re-derives
  /// `statusTitle` live because it is @Published.
  @Published var glanceMode: BarGlanceMode
  /// Render style for the spend sparkline (bars or line). Persisted via
  /// SpendChartStyleStore; didSet mirrors the BarAppearance/iconStyle pattern.
  @Published var spendChartStyle: SpendChartStyle {
    didSet { SpendChartStyleStore.save(spendChartStyle) }
  }
  /// The alerts the most recent evaluation wanted delivered, surfaced in the
  /// dropdown so users who deny notifications still see the conditions.
  @Published var activeAlerts: [BarNotification] = []

  private let home: String
  private var client: CCSBarClient?
  private var debouncer = RefreshDebouncer(interval: 15)
  /// Periodic background refresh so the glance self-heals from a transient
  /// server gap without the user having to reopen the menu. Each tick re-probes
  /// (not just re-reads bar.json) so a server that restarted on a new port is
  /// found automatically.
  private var pollTask: Task<Void, Never>?
  /// Guard against overlapping start-and-connect sequences.
  private var connectTask: Task<Void, Never>?
  private let prefs: BarPreferences
  private let notifier: NotificationDelivering
  private let probe: BarServerProbe
  private let launcher: BarServerLauncher

  // MARK: - Init

  init(
    home: String = NSHomeDirectory(),
    prefs: BarPreferences = BarPreferences(),
    notifier: NotificationDelivering? = nil,
    probe: BarServerProbe = BarServerProbe(),
    launcher: BarServerLauncher? = nil
  ) {
    self.home = home
    self.prefs = prefs
    prefs.registerDefaults()
    self.notifier = notifier ?? BarNotifier()
    self.probe = probe
    self.launcher = launcher ?? BarServerLauncher(home: home)
    self.iconStyle = MenuBarIcon.loadStyle()
    self.appearance = BarAppearanceStore.load()
    self.glanceMode = prefs.load().glanceMode
    self.spendChartStyle = SpendChartStyleStore.load()
    reconnect()
    startBackgroundPolling()
  }

  // MARK: - Background polling

  /// Periodically re-probe for the app's lifetime so a transient empty/missing-row
  /// state recovers on its own within one interval. Each tick re-probes the
  /// network (not just re-reads bar.json) so a server that moved ports is found.
  private func startBackgroundPolling() {
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(60))
        guard let self else { return }
        // Re-probe first; if live, reconnect; then load cached data.
        await self.reconnectIfNeeded()
        await self.load(force: false)
      }
    }
  }

  // MARK: - Prefs

  /// Re-read prefs after the preferences sheet writes through.
  func reloadPrefs() {
    glanceMode = prefs.load().glanceMode
  }

  /// Toggle the menu-bar icon between the color mark and the mono template.
  func toggleIconStyle() {
    iconStyle = (iconStyle == .color) ? .mono : .color
  }

  // MARK: - Status title

  /// Compact status-bar title, resolved through the user's chosen glance mode.
  var statusTitle: String {
    if isStarting { return "CCS starting…" }
    return offline
      ? "CCS offline"
      : BarFormatting.statusTitle(rows: rows, analytics: analytics, mode: glanceMode)
  }

  // MARK: - Connection / discovery

  /// Fast synchronous reconnect: reads bar.json and builds a client if the URL
  /// is valid. Does NOT probe the network. Used as a cheap first-pass before
  /// the async probe path.
  func reconnect() {
    switch BarDiscovery.load(home: home) {
    case .success(let discovery):
      if let url = discovery.resolvedURL {
        client = CCSBarClient(baseURL: url)
        // Don't clear `offline` yet — the network probe in connectAndLoad()
        // will confirm liveness. Leave existing offline state until we know.
      } else {
        client = nil
      }
    case .failure:
      client = nil
    }
  }

  /// Full async reconnect: probe the network for a live server, build a client
  /// when found, launch the server if not found. Updates `isStarting`/`offline`.
  ///
  /// This is the entry point called by `onOpen()` and the background poll.
  func reconnectAndLoad(force: Bool = false) {
    // Cancel any in-flight connect so we don't stack up.
    connectTask?.cancel()
    connectTask = Task { [weak self] in
      guard let self else { return }
      await self.connectSequence(force: force)
    }
  }

  /// Core sequence: probe → if live build client + load; else launch + poll → load.
  private func connectSequence(force: Bool) async {
    let discovery = try? BarDiscovery.load(home: home).get()

    // 1. Probe for an already-running server.
    if let liveURL = await probe.findLiveServer(discovery: discovery) {
      client = CCSBarClient(baseURL: liveURL, transport: URLSessionTransport())
      offline = false
      isStarting = false
      await load(force: force)
      return
    }

    // 2. No live server found — try to start one.
    isStarting = true
    offline = false  // show spinner, not the error state

    let launched = await Task.detached(priority: .utility) { [launcher = self.launcher] in
      launcher.start()
    }.value

    if !launched {
      // Could not even attempt a launch (no descriptor, no ccs on PATH).
      isStarting = false
      offline = true
      return
    }

    // 3. Poll until reachable (timeout ~12s, 500ms interval).
    let deadline = Date().addingTimeInterval(12)
    while Date() < deadline {
      guard !Task.isCancelled else { break }
      try? await Task.sleep(for: .milliseconds(500))
      if let liveURL = await probe.findLiveServer(discovery: BarDiscovery.load(home: home).ok) {
        client = CCSBarClient(baseURL: liveURL, transport: URLSessionTransport())
        isStarting = false
        offline = false
        await load(force: true)
        return
      }
    }

    // 4. Timed out.
    isStarting = false
    offline = true
  }

  /// Re-probe silently during the background poll. If a live server is found and
  /// we currently have no client (or are offline), build the client and clear
  /// offline. If no server found and we had one, mark offline.
  private func reconnectIfNeeded() async {
    let discovery = try? BarDiscovery.load(home: home).get()
    if let liveURL = await probe.findLiveServer(discovery: discovery) {
      client = CCSBarClient(baseURL: liveURL, transport: URLSessionTransport())
      if offline { offline = false }
    } else if client != nil {
      // We had a client but server is gone.
      client = nil
      if rows.isEmpty { offline = true }
    }
  }

  // MARK: - Menu open

  /// Menu opened: cached rows are already on screen; fire a debounced reconnect
  /// + force-refresh so the glance reflects live provider data.
  func onOpen() {
    let force = debouncer.shouldRefresh(now: Date())
    reconnectAndLoad(force: force)
  }

  // MARK: - Start CCS (called from offline UI button)

  /// Trigger a full connect sequence (probe → launch → poll). Used by the
  /// "Start CCS" button in the offline state.
  func startCCS() {
    reconnectAndLoad(force: true)
  }

  // MARK: - Data loading

  func load(force: Bool) async {
    // If we still have no client after the connect sequence, bail.
    guard let client else {
      if !isStarting { offline = true }
      return
    }
    if force { isRefreshing = true }
    defer { isRefreshing = false }
    do {
      rows = try await client.summary(refresh: force)
      offline = false
      lastError = nil
    } catch {
      lastError = describe(error)
      // Keep the last rows visible (instant cached paint); only flip to the
      // offline state when there is nothing to show.
      if rows.isEmpty { offline = true }
    }

    // Analytics is a best-effort side-load: a failure here must never blank the
    // glance or flip us offline. Keep the last-known analytics on error.
    if let fresh = try? await client.analytics() {
      analytics = fresh
    }

    evaluateAlerts()
  }

  // MARK: - Alert engine

  /// Run the pure rule engine once per poll against the freshly-loaded state.
  private func evaluateAlerts() {
    let current = prefs.load()
    let eval = BarAlertEngine.evaluate(
      rows: rows,
      analytics: analytics,
      prefs: current,
      priorFiredKeys: prefs.firedKeys,
      now: Date())
    for notification in eval.toDeliver {
      notifier.deliver(notification)
    }
    prefs.firedKeys = eval.firedKeys
    activeAlerts = eval.toDeliver
  }

  // MARK: - Account actions

  func pause(_ row: BarSummaryRow) {
    perform { try await $0.pause(provider: row.provider, accountId: row.accountId) }
  }
  func resume(_ row: BarSummaryRow) {
    perform { try await $0.resume(provider: row.provider, accountId: row.accountId) }
  }
  func solo(_ row: BarSummaryRow) {
    perform { try await $0.solo(provider: row.provider, accountId: row.accountId) }
  }
  func setDefault(_ row: BarSummaryRow) {
    perform { try await $0.setDefault(name: row.id) }
  }
  func tierLock(_ row: BarSummaryRow, tier: String?) {
    perform { try await $0.tierLock(provider: row.provider, tier: tier) }
  }

  private func perform(_ op: @escaping (CCSBarClient) async throws -> Void) {
    guard let client else { return }
    Task {
      do {
        try await op(client)
        await load(force: true)
      } catch {
        lastError = describe(error)
      }
    }
  }

  private func describe(_ error: Error) -> String {
    String(describing: error)
  }
}

// MARK: - Result convenience

private extension Result {
  /// Extract the success value without throwing, for use in async contexts where
  /// we want an optional rather than a thrown error.
  var ok: Success? {
    guard case .success(let v) = self else { return nil }
    return v
  }
}
