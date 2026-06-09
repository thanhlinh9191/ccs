import Foundation
import CCSBarCore

// Lightweight assert harness used in place of XCTest (unavailable without a
// full Xcode install). Run with `swift run ccs-bar-check`; exits non-zero on
// any failure so it works as a CI/test gate on a CommandLineTools toolchain.

var failures = 0
func check(_ condition: Bool, _ message: String) {
  if condition {
    print("[OK] \(message)")
  } else {
    print("[X] \(message)")
    failures += 1
  }
}

// Recording transport so CCSBarClient can be exercised without a live server.
final class RequestRecorder: @unchecked Sendable {
  var lastRequest: URLRequest?
  var responseData = Data("[]".utf8)
  var status = 200
}
struct RecordingTransport: HTTPTransport {
  let recorder: RequestRecorder
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    recorder.lastRequest = request
    let http = HTTPURLResponse(
      url: request.url!, statusCode: recorder.status, httpVersion: nil, headerFields: nil)!
    return (recorder.responseData, http)
  }
}

// MARK: BarSummaryRow decoding (mixed snake_case / camelCase keys)

let summaryJSON = """
[
  {
    "account_id": "alice@example.com",
    "provider": "agy",
    "displayName": "Alice (Ultra)",
    "tier": "ultra",
    "paused": false,
    "quota_percentage": 82.4,
    "quotaStatus": "ok",
    "next_reset": "2026-06-08T00:00:00Z",
    "is_default": true,
    "last_activity_at": "2026-04-29T10:00:00Z",
    "today_cost": 3.2,
    "health": "ok",
    "cached": true,
    "fetchedAt": "2026-06-07T19:00:00Z",
    "needsReauth": false
  },
  {
    "account_id": "bob@example.com",
    "provider": "codex",
    "displayName": null,
    "tier": null,
    "paused": true,
    "quota_percentage": null,
    "quotaStatus": "error",
    "next_reset": null,
    "is_default": false,
    "last_activity_at": null,
    "today_cost": null,
    "health": "error",
    "cached": false,
    "fetchedAt": null,
    "needsReauth": true
  }
]
"""

do {
  let rows = try JSONDecoder().decode([BarSummaryRow].self, from: Data(summaryJSON.utf8))
  check(rows.count == 2, "decodes two rows")
  check(rows[0].accountId == "alice@example.com", "maps account_id")
  check(rows[0].quotaPercentage == 82.4, "maps quota_percentage")
  check(rows[0].quotaStatus == "ok", "maps quotaStatus (ok)")
  check(rows[0].isDefault == true, "maps is_default")
  check(rows[0].lastActivityAt == "2026-04-29T10:00:00Z", "maps last_activity_at")
  check(rows[0].todayCost == 3.2, "maps today_cost")
  check(rows[0].id == "agy:alice@example.com", "stable id is provider:account")
  check(rows[1].quotaPercentage == nil, "null quota decodes to nil")
  check(rows[1].quotaStatus == "error", "maps quotaStatus (error)")
  check(rows[1].isDefault == false, "is_default false decodes")
  check(rows[1].lastActivityAt == nil, "null last_activity_at decodes to nil")
  check(rows[1].paused == true, "maps paused")
  check(rows[1].needsReauth == true, "maps needsReauth")
  check(rows[1].healthDot == "X", "error -> X dot")
  check(rows[0].healthDot == "OK", "ok -> OK dot")
}

// An "unsupported" provider (ghcp/kiro) decodes with quotaStatus "unsupported"
// and health "ok" — the backend's key correctness fix (no permanent orange dot).
do {
  let unsupportedJSON = """
  [{
    "account_id": "copilot-kaitranntt", "provider": "ghcp", "displayName": "copilot-kaitranntt",
    "tier": null, "paused": false, "quota_percentage": null, "quotaStatus": "unsupported",
    "next_reset": null, "is_default": true, "last_activity_at": null, "today_cost": null,
    "health": "ok", "cached": false, "fetchedAt": "2026-06-08T16:40:00.000Z", "needsReauth": false
  }]
  """
  let rows = try JSONDecoder().decode([BarSummaryRow].self, from: Data(unsupportedJSON.utf8))
  check(rows[0].quotaStatus == "unsupported", "ghcp decodes quotaStatus unsupported")
  check(rows[0].health == "ok", "unsupported provider is health ok (no orange dot)")
}

// MARK: BarDiscovery loading

let tmp = NSTemporaryDirectory() + "ccs-bar-check-\(ProcessInfo.processInfo.globallyUniqueString)"
let ccsDir = tmp + "/.ccs"
try? FileManager.default.createDirectory(atPath: ccsDir, withIntermediateDirectories: true)
let barJSON = """
{ "baseUrl": "http://127.0.0.1:3210", "port": 3210, "authMode": "loopback" }
"""
try? barJSON.write(toFile: ccsDir + "/bar.json", atomically: true, encoding: .utf8)

switch BarDiscovery.load(home: tmp) {
case .success(let d):
  check(d.port == 3210, "discovery reads port")
  check(d.authMode == "loopback", "discovery reads authMode")
  check(d.resolvedURL?.absoluteString == "http://127.0.0.1:3210", "resolvedURL from baseUrl")
case .failure(let e):
  check(false, "discovery load failed: \(e)")
}

let missingHome = NSTemporaryDirectory() + "ccs-bar-check-missing-\(ProcessInfo.processInfo.globallyUniqueString)"
switch BarDiscovery.load(home: missingHome) {
case .failure(.missing):
  check(true, "absent bar.json -> .missing (offline state)")
case .success:
  check(false, "expected .missing for absent file")
case .failure(let e):
  check(false, "expected .missing, got \(e)")
}

// MARK: BarFormatting

// Tri-state quota label: never a bare "--".
check(BarFormatting.quotaLabel(percentage: 82.4, status: "ok") == "82%", "ok+pct -> NN%")
check(
  BarFormatting.quotaLabel(percentage: nil, status: "unsupported") == "no quota",
  "unsupported -> 'no quota'")
check(
  BarFormatting.quotaLabel(percentage: nil, status: "error") == "quota ?", "error -> 'quota ?'")
check(BarFormatting.costLabel(3.2) == "$3.20", "cost label formats")
check(BarFormatting.costLabel(0) == "", "zero cost hidden")
check(BarFormatting.costLabel(nil) == "", "nil cost hidden")

// MARK: statusTitle fallback chain (NEVER a bare "--", NEVER a lifetime figure when today==0)

// Shared analytics fixtures for the chain.
func mkAnalytics(allTimeCost: Double, todayCost: Double = 0) -> BarAnalytics {
  BarAnalytics(
    today: .init(cost: todayCost, requests: todayCost > 0 ? 10 : 0),
    last7d: .init(cost: 0, requests: 0),
    last30d: .init(cost: 0, requests: 0),
    allTime: .init(cost: allTimeCost, requests: 5314),
    byDay: [],
    topModels: [],
    topModelsWindow: "all",
    lastActivityAt: "2026-04-29T10:00:00Z",
    daysSinceLastActivity: 40,
    hasRecentData: false,
    generatedAt: "2026-06-08T13:00:00Z")
}

// (1) QUOTA wins: a quota row yields "<provider> NN%".
do {
  let rows = try JSONDecoder().decode([BarSummaryRow].self, from: Data(summaryJSON.utf8))
  let title = BarFormatting.statusTitle(rows: rows, analytics: mkAnalytics(allTimeCost: 2609.1))
  check(title == "agy 82%", "title (1) quota wins -> 'agy 82%'")
}

// (1) lowest-remaining among quota rows is chosen; unsupported/error skipped.
let quotaMix = [
  BarSummaryRow(accountId: "a", provider: "agy", quotaPercentage: 90, quotaStatus: "ok"),
  BarSummaryRow(accountId: "b", provider: "agy", quotaPercentage: 12, quotaStatus: "ok"),
  BarSummaryRow(accountId: "c", provider: "ghcp", quotaStatus: "unsupported"),
]
let mixTitle = BarFormatting.statusTitle(rows: quotaMix, analytics: nil)
check(mixTitle == "agy 12%", "title features lowest-remaining quota, skips unsupported")
check(!mixTitle.contains("--"), "quota-mix title never contains '--'")

// (2) TODAY COST wins when no quota but analytics.today.cost > 0.
// The title reads the fresh analytics aggregate, not per-row today_cost.
let todayRows = [
  BarSummaryRow(accountId: "a", provider: "ghcp", quotaStatus: "unsupported"),
]
let todayAnalytics = mkAnalytics(allTimeCost: 40844, todayCost: 3.2)
check(
  BarFormatting.statusTitle(rows: todayRows, analytics: todayAnalytics) == "$3.20",
  "title (2) today cost from analytics -> '$3.20'")

// (2) today cost zero with non-zero all-time must NOT produce a "~$..." lifetime
// figure — the all-time step was removed to prevent confusion with live spend.
let staleRows = [
  BarSummaryRow(accountId: "a", provider: "ghcp", quotaStatus: "unsupported", todayCost: 0),
  BarSummaryRow(accountId: "b", provider: "kiro", quotaStatus: "unsupported", todayCost: nil),
]
let staleAnalytics = mkAnalytics(allTimeCost: 2609.1, todayCost: 0)
let staleTitle = BarFormatting.statusTitle(rows: staleRows, analytics: staleAnalytics)
check(!staleTitle.contains("~$"), "today==0 title never shows a '~$' lifetime figure")
check(!staleTitle.contains("2.6k"), "today==0 title never shows the all-time dollar amount")
check(!staleTitle.contains("--"), "stale title never contains '--'")
// With no quota and today==0 and 2 active rows, chain falls to COUNT.
check(staleTitle == "CCS 2", "title (3) no quota + today==0 falls to active count 'CCS 2'")

// (3) COUNT / ATTENTION when no quota and no today spend.
let reauthRows = [
  BarSummaryRow(accountId: "a", provider: "ghcp", quotaStatus: "error", needsReauth: true),
  BarSummaryRow(accountId: "b", provider: "kiro", quotaStatus: "unsupported"),
]
check(
  BarFormatting.statusTitle(rows: reauthRows, analytics: mkAnalytics(allTimeCost: 0)) == "CCS 1!",
  "title (3) reauth attention -> 'CCS 1!'")
let activeRows = [
  BarSummaryRow(accountId: "a", provider: "ghcp", quotaStatus: "unsupported"),
  BarSummaryRow(accountId: "b", provider: "kiro", paused: true, quotaStatus: "unsupported"),
]
check(
  BarFormatting.statusTitle(rows: activeRows, analytics: nil) == "CCS 1",
  "title (3) active count -> 'CCS 1'")

// (4) empty rows -> "CCS".
check(BarFormatting.statusTitle(rows: [], analytics: nil) == "CCS", "title (4) empty -> 'CCS'")

// All-empty-quota fixture: title never a bare "--".
check(
  !BarFormatting.statusTitle(rows: activeRows, analytics: nil).contains("--"),
  "no-quota title never contains a bare '--'")

// leadRow is deterministic with no quota: the is_default row, not rows.first.
let leadRows = [
  BarSummaryRow(accountId: "z", provider: "ghcp", quotaStatus: "unsupported", isDefault: false),
  BarSummaryRow(accountId: "a", provider: "kiro", quotaStatus: "unsupported", isDefault: true),
]
check(BarFormatting.leadRow(leadRows)?.accountId == "a", "leadRow prefers is_default row")

// MARK: RefreshDebouncer (arms at decision time)

var deb = RefreshDebouncer(interval: 15)
let t0 = Date(timeIntervalSince1970: 1000)
check(deb.shouldRefresh(now: t0), "first force-refresh proceeds")
check(!deb.shouldRefresh(now: t0.addingTimeInterval(5)), "within 15s blocked")
check(!deb.shouldRefresh(now: t0.addingTimeInterval(14.9)), "just before window end blocked")
check(deb.shouldRefresh(now: t0.addingTimeInterval(15)), "at/after 15s proceeds")

// MARK: CCSBarClient (recording transport)

let recorder = RequestRecorder()
recorder.responseData = Data(summaryJSON.utf8)
let client = CCSBarClient(
  baseURL: URL(string: "http://127.0.0.1:3210")!,
  transport: RecordingTransport(recorder: recorder)
)

do {
  let rows = try await client.summary(refresh: true)
  check(rows.count == 2, "client.summary decodes rows")
  check(
    recorder.lastRequest?.url?.query?.contains("refresh=true") == true,
    "summary(refresh: true) adds ?refresh=true")
} catch {
  check(false, "client.summary threw: \(error)")
}

recorder.responseData = Data("{}".utf8)
recorder.lastRequest = nil
do {
  try await client.pause(provider: "agy", accountId: "alice@example.com")
  check(recorder.lastRequest?.httpMethod == "POST", "pause is POST")
  check(
    recorder.lastRequest?.url?.path.hasSuffix("bulk-pause") == true,
    "pause hits bulk-pause endpoint")
} catch {
  check(false, "pause threw: \(error)")
}

recorder.lastRequest = nil
do {
  try await client.tierLock(provider: "agy", tier: nil)
  let body = recorder.lastRequest?.httpBody ?? Data()
  let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
  check(obj?["tier"] is NSNull, "tierLock(nil) serializes tier: null")
  check((obj?["provider"] as? String) == "agy", "tierLock sends provider")
} catch {
  check(false, "tierLock threw: \(error)")
}

recorder.status = 409
do {
  _ = try await client.summary(refresh: false)
  check(false, "non-200 summary should throw")
} catch CCSBarClientError.httpStatus(let code) {
  check(code == 409, "non-200 -> httpStatus(409)")
} catch {
  check(false, "wrong error type: \(error)")
}
recorder.status = 200

// Analytics formatting + decode.
check(BarFormatting.money(0) == "$0.00", "money shows zero")
check(BarFormatting.money(2609.1) == "$2.6k", "money compacts thousands")
check(BarFormatting.count(5314) == "5.3k", "count compacts thousands")

// Mirrors the stale-snapshot reality: recent windows zero, all-time populated,
// hasRecentData false, last-active in late April, 30-entry zero-filled byDay.
func buildByDayJSON(count: Int) -> String {
  (0..<count).map { i in "{\"date\":\"2026-05-\(String(format: "%02d", i + 1))\",\"cost\":0,\"requests\":0}" }
    .joined(separator: ",")
}
let analyticsJSON = """
{"today":{"cost":0,"requests":0},"last7d":{"cost":0,"requests":0},
"last30d":{"cost":0,"requests":0},"allTime":{"cost":2609.1,"requests":5314},
"byDay":[\(buildByDayJSON(count: 30))],
"topModels":[{"model":"gpt-5.4","cost":1253.65,"requests":1306}],
"topModelsWindow":"all","lastActivityAt":"2026-04-29T10:00:00.000Z",
"daysSinceLastActivity":40,"hasRecentData":false,
"generatedAt":"2026-06-08T13:00:00.000Z"}
""".data(using: .utf8)!
do {
  let a = try JSONDecoder().decode(BarAnalytics.self, from: analyticsJSON)
  check(a.allTime.requests == 5314, "analytics decodes all-time requests")
  check(a.topModels.first?.model == "gpt-5.4", "analytics decodes top model")
  check(a.topModelsWindow == "all", "analytics decodes window")
  check(a.byDay.count == 30, "analytics decodes 30-day byDay series")
  check(a.lastActivityAt == "2026-04-29T10:00:00.000Z", "analytics decodes lastActivityAt")
  check(a.daysSinceLastActivity == 40, "analytics decodes daysSinceLastActivity")
  check(a.hasRecentData == false, "analytics decodes hasRecentData (false on idle)")
  // bySurface absent from JSON → defaults to empty array (resilient decoding).
  check(a.bySurface.isEmpty, "analytics bySurface defaults to [] when absent from payload")
}

// MARK: BarAnalyticsSurface decoding

// Verify bySurface round-trips correctly with the exact field names the backend
// sends: `source`, `surface`, `cost`, `requests` (all camelCase / exact match).
let surfaceAnalyticsJSON = """
{"today":{"cost":1963.70,"requests":13103},"last7d":{"cost":1963.70,"requests":13103},
"last30d":{"cost":35620.0,"requests":70973},"allTime":{"cost":40844.0,"requests":91207},
"byDay":[\(buildByDayJSON(count: 30))],
"topModels":[],"topModelsWindow":"30d",
"hasRecentData":true,"generatedAt":"2026-06-09T00:00:00.000Z",
"bySurface":[
  {"source":"custom-parser","surface":"Claude Code","cost":33656.21,"requests":57870},
  {"source":"codex-native","surface":"Codex","cost":1963.70,"requests":13103}
]}
""".data(using: .utf8)!
do {
  let a = try JSONDecoder().decode(BarAnalytics.self, from: surfaceAnalyticsJSON)
  check(a.bySurface.count == 2, "bySurface decodes 2 surfaces")
  check(a.bySurface[0].surface == "Claude Code", "bySurface[0].surface decodes")
  check(a.bySurface[0].source == "custom-parser", "bySurface[0].source decodes")
  check(a.bySurface[0].cost == 33656.21, "bySurface[0].cost decodes")
  check(a.bySurface[0].requests == 57870, "bySurface[0].requests decodes")
  check(a.bySurface[1].surface == "Codex", "bySurface[1].surface decodes")
  check(a.bySurface[1].cost == 1963.70, "bySurface[1].cost decodes")
  // Stable identity for SwiftUI ForEach: surface name is the id.
  check(a.bySurface[0].id == "Claude Code", "bySurface[0].id == surface name")
  // Today cost from the surface-bearing payload.
  check(a.today.cost == 1963.70, "surface analytics decodes today.cost")
  check(a.hasRecentData == true, "surface analytics decodes hasRecentData true")
} catch {
  check(false, "surface analytics decode threw: \(error)")
}

// MARK: monthToDate decode (calendar MTD field, resilient default)

do {
  // Older payload WITHOUT monthToDate → decodes to a zero window (back-compat).
  let a = try JSONDecoder().decode(BarAnalytics.self, from: analyticsJSON)
  check(a.monthToDate.cost == 0, "monthToDate defaults to 0 cost when absent from payload")
  check(a.monthToDate.requests == 0, "monthToDate defaults to 0 requests when absent")
}
do {
  // Newer payload WITH monthToDate → decodes the real value, distinct from last30d.
  let mtdJSON = """
  {"today":{"cost":0,"requests":0},"last7d":{"cost":0,"requests":0},
  "last30d":{"cost":35620.0,"requests":70973},"monthToDate":{"cost":1200.5,"requests":4096},
  "allTime":{"cost":40844.0,"requests":91207},
  "byDay":[\(buildByDayJSON(count: 30))],
  "topModels":[],"topModelsWindow":"30d","hasRecentData":true,
  "generatedAt":"2026-06-09T00:00:00.000Z"}
  """.data(using: .utf8)!
  let a = try JSONDecoder().decode(BarAnalytics.self, from: mtdJSON)
  check(a.monthToDate.cost == 1200.5, "monthToDate decodes its own cost")
  check(a.monthToDate.requests == 4096, "monthToDate decodes its own requests")
  check(a.monthToDate.cost != a.last30d.cost, "monthToDate is distinct from rolling last30d")
}

// MARK: BarQuotaGauge band + fillFraction + countdown

check(BarQuotaGauge.band(percentage: 82, status: "ok") == .green, "band >50 -> green")
check(BarQuotaGauge.band(percentage: 51, status: "ok") == .green, "band 51 -> green (boundary)")
check(BarQuotaGauge.band(percentage: 50, status: "ok") == .yellow, "band 50 -> yellow (boundary)")
check(BarQuotaGauge.band(percentage: 21, status: "ok") == .yellow, "band 21 -> yellow")
check(BarQuotaGauge.band(percentage: 20, status: "ok") == .orange, "band 20 -> orange (boundary)")
check(BarQuotaGauge.band(percentage: 11, status: "ok") == .orange, "band 11 -> orange")
check(BarQuotaGauge.band(percentage: 10, status: "ok") == .red, "band 10 -> red (boundary)")
check(BarQuotaGauge.band(percentage: 0, status: "ok") == .red, "band 0 -> red")
check(BarQuotaGauge.band(percentage: nil, status: "ok") == .none, "band nil pct -> none")
check(BarQuotaGauge.band(percentage: 50, status: "unsupported") == .none, "band unsupported -> none")
check(BarQuotaGauge.band(percentage: 50, status: "error") == .none, "band error -> none")

check(BarQuotaGauge.fillFraction(percentage: 82, status: "ok") == 0.82, "fillFraction 82 -> 0.82")
check(BarQuotaGauge.fillFraction(percentage: 0, status: "ok") == 0.0, "fillFraction 0 -> 0")
check(BarQuotaGauge.fillFraction(percentage: 150, status: "ok") == 1.0, "fillFraction clamps >100 to 1")
check(BarQuotaGauge.fillFraction(percentage: nil, status: "ok") == nil, "fillFraction nil pct -> nil")
check(
  BarQuotaGauge.fillFraction(percentage: 50, status: "unsupported") == nil,
  "fillFraction unsupported -> nil")

do {
  let now = Date(timeIntervalSince1970: 1_000_000)
  let in3h12m = now.addingTimeInterval(3 * 3600 + 12 * 60)
  let iso = ISO8601DateFormatter().string(from: in3h12m)
  check(
    BarQuotaGauge.resetCountdown(nextReset: iso, now: now) == "resets in 3h 12m",
    "resetCountdown formats hours+minutes")
  let in12m = now.addingTimeInterval(12 * 60)
  let iso12 = ISO8601DateFormatter().string(from: in12m)
  check(
    BarQuotaGauge.resetCountdown(nextReset: iso12, now: now) == "resets in 12m",
    "resetCountdown formats minutes-only")
  let past = now.addingTimeInterval(-60)
  let isoPast = ISO8601DateFormatter().string(from: past)
  check(
    BarQuotaGauge.resetCountdown(nextReset: isoPast, now: now) == "resets soon",
    "resetCountdown past -> 'resets soon'")
  check(BarQuotaGauge.resetCountdown(nextReset: nil, now: now) == nil, "resetCountdown nil -> nil")
  check(
    BarQuotaGauge.resetCountdown(nextReset: "not-a-date", now: now) == nil,
    "resetCountdown unparseable -> nil")
}

// MARK: Glance-mode title resolution (lifetime dollar NEVER appears)

do {
  let allTimeBig = mkAnalytics(allTimeCost: 40844, todayCost: 0)  // allTime is the largest window
  let lifetime = BarFormatting.money(allTimeBig.allTime.cost)
  let rows = [
    BarSummaryRow(accountId: "a", provider: "ghcp", quotaStatus: "unsupported"),
    BarSummaryRow(accountId: "b", provider: "kiro", quotaStatus: "unsupported"),
  ]
  // For EVERY mode, the title must never be the lifetime figure.
  for mode in BarGlanceMode.allCases {
    let t = BarFormatting.statusTitle(rows: rows, analytics: allTimeBig, mode: mode)
    check(t != lifetime, "glance mode \(mode.rawValue): title never == lifetime dollar")
  }

  // .todaySpend leads with today when > 0, else falls back to .auto chain.
  let todayA = mkAnalytics(allTimeCost: 40844, todayCost: 3.2)
  check(
    BarFormatting.statusTitle(rows: rows, analytics: todayA, mode: .todaySpend) == "$3.20",
    "glance .todaySpend leads with today's spend")
  check(
    BarFormatting.statusTitle(rows: rows, analytics: allTimeBig, mode: .todaySpend) == "CCS 2",
    "glance .todaySpend falls back to .auto when today==0")

  // .monthSpend leads with monthToDate when > 0, else falls back.
  func mkMonth(_ mtd: Double, today: Double = 0) -> BarAnalytics {
    BarAnalytics(
      today: .init(cost: today, requests: 0),
      last7d: .init(cost: 0, requests: 0),
      last30d: .init(cost: 35000, requests: 0),
      monthToDate: .init(cost: mtd, requests: 0),
      allTime: .init(cost: 40844, requests: 0),
      byDay: [], topModels: [], topModelsWindow: "30d",
      generatedAt: "2026-06-09T00:00:00Z")
  }
  check(
    BarFormatting.statusTitle(rows: rows, analytics: mkMonth(1200.5), mode: .monthSpend)
      == BarFormatting.money(1200.5),
    "glance .monthSpend leads with calendar MTD")
  check(
    BarFormatting.statusTitle(rows: rows, analytics: mkMonth(0), mode: .monthSpend) == "CCS 2",
    "glance .monthSpend falls back to .auto when MTD==0")
  // MTD mode must NOT leak last30d (35000) even though it is far larger.
  let mtdTitle = BarFormatting.statusTitle(rows: rows, analytics: mkMonth(1200.5), mode: .monthSpend)
  check(!mtdTitle.contains("35"), "glance .monthSpend never shows last30d figure")

  // .lowestQuota leads with the lowest ok-quota row, else falls back.
  let quotaRows = [
    BarSummaryRow(accountId: "a", provider: "agy", quotaPercentage: 90, quotaStatus: "ok"),
    BarSummaryRow(accountId: "b", provider: "agy", quotaPercentage: 12, quotaStatus: "ok"),
  ]
  check(
    BarFormatting.statusTitle(rows: quotaRows, analytics: nil, mode: .lowestQuota) == "agy 12%",
    "glance .lowestQuota leads with lowest remaining quota")
  check(
    BarFormatting.statusTitle(rows: rows, analytics: allTimeBig, mode: .lowestQuota) == "CCS 2",
    "glance .lowestQuota falls back to .auto with no ok-quota rows")

  // .accountCount = non-paused count, never appends "!".
  let pausedMix = [
    BarSummaryRow(accountId: "a", provider: "ghcp", quotaStatus: "unsupported"),
    BarSummaryRow(accountId: "b", provider: "kiro", paused: true, quotaStatus: "unsupported"),
  ]
  check(
    BarFormatting.statusTitle(rows: pausedMix, analytics: nil, mode: .accountCount) == "CCS 1",
    "glance .accountCount = non-paused count")
  let allPaused = [
    BarSummaryRow(accountId: "a", provider: "ghcp", paused: true, quotaStatus: "unsupported"),
    BarSummaryRow(accountId: "b", provider: "kiro", paused: true, quotaStatus: "unsupported"),
  ]
  check(
    BarFormatting.statusTitle(rows: allPaused, analytics: nil, mode: .accountCount) == "CCS 2",
    "glance .accountCount falls back to total when all paused")
  let reauthCount = [
    BarSummaryRow(accountId: "a", provider: "ghcp", quotaStatus: "error", needsReauth: true)
  ]
  check(
    !BarFormatting.statusTitle(rows: reauthCount, analytics: nil, mode: .accountCount).contains("!"),
    "glance .accountCount never appends attention '!'")
}

// MARK: BarAlertPrefsStore dictionary codec + level parsing

do {
  // Empty dict -> all defaults.
  let p = BarAlertPrefsStore.decode(from: [:])
  check(p.quotaEnabled == true, "prefs default quotaEnabled true")
  check(p.quotaLevels == [20, 10, 0], "prefs default quota levels 20,10,0")
  check(p.dailyCapUSD == 500, "prefs default daily cap 500")
  check(p.monthCapUSD == 10000, "prefs default month cap 10000")
  check(p.glanceMode == .auto, "prefs default glance mode auto")

  // Round-trip encode -> decode is identity.
  let custom = BarAlertPrefs(
    quotaEnabled: false, quotaLevels: [5, 25, 50], dailyCapUSD: 12.5, monthCapUSD: 2000,
    glanceMode: .monthSpend)
  let back = BarAlertPrefsStore.decode(from: BarAlertPrefsStore.encode(custom))
  check(back.quotaEnabled == false, "prefs round-trip quotaEnabled")
  check(back.quotaLevels == [50, 25, 5], "prefs round-trip levels sorted desc")
  check(back.dailyCapUSD == 12.5, "prefs round-trip daily cap")
  check(back.glanceMode == .monthSpend, "prefs round-trip glance mode")

  // Level parsing: clamp, dedupe, sort desc; garbage tokens dropped.
  check(
    BarAlertPrefsStore.parseQuotaLevels("0, 10, 200, 10, -5, foo") == [100, 10, 0],
    "parseQuotaLevels clamps/dedupes/sorts and drops garbage")
}

// MARK: BarAlertEngine — pure rule engine

let engineNow = Date(timeIntervalSince1970: 1_700_000_000)  // fixed clock
let utc = { () -> Calendar in
  var c = Calendar(identifier: .gregorian)
  c.timeZone = TimeZone(identifier: "UTC")!
  return c
}()

func mkSpendAnalytics(today: Double, month: Double) -> BarAnalytics {
  BarAnalytics(
    today: .init(cost: today, requests: 0),
    last7d: .init(cost: 0, requests: 0),
    last30d: .init(cost: 99999, requests: 0),  // intentionally huge to prove it's unused
    monthToDate: .init(cost: month, requests: 0),
    allTime: .init(cost: 999999, requests: 0),  // intentionally huge to prove it's unused
    byDay: [], topModels: [], topModelsWindow: "30d",
    generatedAt: "2026-06-09T00:00:00Z")
}

// (A) Threshold cross: quota dropping below levels fires exactly ONE notif at the
//     most-severe crossed level (L10 for remaining 5 with levels [20,10,0]).
do {
  let rows = [
    BarSummaryRow(
      accountId: "a", provider: "agy", quotaPercentage: 5, quotaStatus: "ok",
      nextReset: "2026-07-01T00:00:00Z")
  ]
  let prefs = BarAlertPrefs(quotaLevels: [20, 10, 0])
  let ev = BarAlertEngine.evaluate(
    rows: rows, analytics: nil, prefs: prefs, priorFiredKeys: [], now: engineNow, calendar: utc)
  let quotaNotifs = ev.toDeliver.filter { $0.kind == .quotaRemainingBelow }
  check(quotaNotifs.count == 1, "quota cross fires exactly ONE notif (most-severe level)")
  check(quotaNotifs.first?.id.hasSuffix("|L10") == true, "quota fires at most-severe crossed L10")
  check(quotaNotifs.first?.body.contains("5%") == true, "quota body reports remaining %")
}

// (B) dailySpendAbove strict > ; silent at ==cap ; driven by today (not last30d/allTime).
do {
  let prefs = BarAlertPrefs(dailyCapUSD: 50)
  let over = BarAlertEngine.evaluate(
    rows: [], analytics: mkSpendAnalytics(today: 50.01, month: 0), prefs: prefs,
    priorFiredKeys: [], now: engineNow, calendar: utc)
  check(
    over.toDeliver.contains { $0.kind == .dailySpendAbove }, "daily spend fires when today > cap")
  let atCap = BarAlertEngine.evaluate(
    rows: [], analytics: mkSpendAnalytics(today: 50, month: 0), prefs: prefs,
    priorFiredKeys: [], now: engineNow, calendar: utc)
  check(
    !atCap.toDeliver.contains { $0.kind == .dailySpendAbove },
    "daily spend silent at == cap (strict >)")
}

// (C) monthSpendAbove driven by monthToDate ONLY — huge last30d/allTime must not trigger.
do {
  let prefs = BarAlertPrefs(monthCapUSD: 1000)
  // monthToDate UNDER cap but last30d (99999) and allTime (999999) huge → must NOT fire.
  let under = BarAlertEngine.evaluate(
    rows: [], analytics: mkSpendAnalytics(today: 0, month: 500), prefs: prefs,
    priorFiredKeys: [], now: engineNow, calendar: utc)
  check(
    !under.toDeliver.contains { $0.kind == .monthSpendAbove },
    "month alert ignores last30d/allTime — silent when MTD under cap")
  let over = BarAlertEngine.evaluate(
    rows: [], analytics: mkSpendAnalytics(today: 0, month: 1500), prefs: prefs,
    priorFiredKeys: [], now: engineNow, calendar: utc)
  check(
    over.toDeliver.contains { $0.kind == .monthSpendAbove }, "month alert fires on MTD > cap")
}

// (D) Dedupe: a second identical evaluate with same now + same firedKeys → empty toDeliver.
do {
  let rows = [
    BarSummaryRow(accountId: "a", provider: "agy", quotaPercentage: 5, quotaStatus: "ok",
      nextReset: "2026-07-01T00:00:00Z")
  ]
  let prefs = BarAlertPrefs(dailyCapUSD: 10)
  let a1 = BarAlertEngine.evaluate(
    rows: rows, analytics: mkSpendAnalytics(today: 100, month: 5000), prefs: prefs,
    priorFiredKeys: [], now: engineNow, calendar: utc)
  check(!a1.toDeliver.isEmpty, "first poll delivers notifs")
  let a2 = BarAlertEngine.evaluate(
    rows: rows, analytics: mkSpendAnalytics(today: 100, month: 5000), prefs: prefs,
    priorFiredKeys: a1.firedKeys, now: engineNow, calendar: utc)
  check(a2.toDeliver.isEmpty, "second identical poll delivers nothing (dedupe)")
  check(a2.firedKeys == a1.firedKeys, "fired keys stable across identical polls")
}

// (E) Re-arm period: +1 day re-fires daily; +1 month re-fires month; new nextReset re-fires quota.
do {
  let prefs = BarAlertPrefs(dailyCapUSD: 10, monthCapUSD: 100)
  let day0 = mkSpendAnalytics(today: 100, month: 500)
  let p0 = BarAlertEngine.evaluate(
    rows: [], analytics: day0, prefs: prefs, priorFiredKeys: [], now: engineNow, calendar: utc)
  let nextDay = engineNow.addingTimeInterval(24 * 3600)
  let p1 = BarAlertEngine.evaluate(
    rows: [], analytics: day0, prefs: prefs, priorFiredKeys: p0.firedKeys, now: nextDay,
    calendar: utc)
  check(p1.toDeliver.contains { $0.kind == .dailySpendAbove }, "daily re-fires next calendar day")
  let nextMonth = engineNow.addingTimeInterval(40 * 24 * 3600)
  let p2 = BarAlertEngine.evaluate(
    rows: [], analytics: day0, prefs: prefs, priorFiredKeys: p0.firedKeys, now: nextMonth,
    calendar: utc)
  check(p2.toDeliver.contains { $0.kind == .monthSpendAbove }, "month re-fires next calendar month")

  // New nextReset string => new quota bucket => quota re-fires.
  let q0rows = [
    BarSummaryRow(accountId: "a", provider: "agy", quotaPercentage: 5, quotaStatus: "ok",
      nextReset: "2026-07-01T00:00:00Z")
  ]
  let q0 = BarAlertEngine.evaluate(
    rows: q0rows, analytics: nil, prefs: BarAlertPrefs(quotaLevels: [10]), priorFiredKeys: [],
    now: engineNow, calendar: utc)
  let q1rows = [
    BarSummaryRow(accountId: "a", provider: "agy", quotaPercentage: 5, quotaStatus: "ok",
      nextReset: "2026-08-01T00:00:00Z")
  ]
  let q1 = BarAlertEngine.evaluate(
    rows: q1rows, analytics: nil, prefs: BarAlertPrefs(quotaLevels: [10]),
    priorFiredKeys: q0.firedKeys, now: engineNow, calendar: utc)
  check(
    q1.toDeliver.contains { $0.kind == .quotaRemainingBelow },
    "quota re-fires on a new next_reset bucket")
}

// (F) Re-arm clears-then-recurs: reauth true->fires->key set; false->key dropped; true->re-fires.
do {
  let onRows = [BarSummaryRow(accountId: "a", provider: "agy", needsReauth: true)]
  let offRows = [BarSummaryRow(accountId: "a", provider: "agy", needsReauth: false)]
  let s1 = BarAlertEngine.evaluate(
    rows: onRows, analytics: nil, prefs: BarAlertPrefs(), priorFiredKeys: [], now: engineNow,
    calendar: utc)
  check(s1.toDeliver.contains { $0.kind == .reauthNeeded }, "reauth fires when needsReauth true")
  check(
    s1.firedKeys.contains { $0.hasPrefix("reauthNeeded|") }, "reauth key present after firing")
  let s2 = BarAlertEngine.evaluate(
    rows: offRows, analytics: nil, prefs: BarAlertPrefs(), priorFiredKeys: s1.firedKeys,
    now: engineNow, calendar: utc)
  check(
    !s2.firedKeys.contains { $0.hasPrefix("reauthNeeded|") },
    "reauth key dropped when condition clears")
  let s3 = BarAlertEngine.evaluate(
    rows: onRows, analytics: nil, prefs: BarAlertPrefs(), priorFiredKeys: s2.firedKeys,
    now: engineNow, calendar: utc)
  check(
    s3.toDeliver.contains { $0.kind == .reauthNeeded }, "reauth re-fires after clear")

  // Same clears-then-recurs behavior for accountCooldownOrPaused on `paused`.
  let pOn = [BarSummaryRow(accountId: "a", provider: "agy", paused: true)]
  let pOff = [BarSummaryRow(accountId: "a", provider: "agy", paused: false)]
  let c1 = BarAlertEngine.evaluate(
    rows: pOn, analytics: nil, prefs: BarAlertPrefs(), priorFiredKeys: [], now: engineNow,
    calendar: utc)
  check(
    c1.toDeliver.contains { $0.kind == .accountCooldownOrPaused }, "cooldown/paused fires on paused")
  let c2 = BarAlertEngine.evaluate(
    rows: pOff, analytics: nil, prefs: BarAlertPrefs(), priorFiredKeys: c1.firedKeys, now: engineNow,
    calendar: utc)
  check(
    !c2.firedKeys.contains { $0.hasPrefix("accountCooldownOrPaused|") },
    "cooldown/paused key dropped when unpaused")
}

// (G) Prune / bounded: after day+month+reset rollover and account churn, fired set
//     holds only current-bucket keys and no keys for absent accounts.
do {
  let prefs = BarAlertPrefs(quotaLevels: [10], dailyCapUSD: 10, monthCapUSD: 100)
  let rowsT0 = [
    BarSummaryRow(accountId: "a", provider: "agy", quotaPercentage: 5, quotaStatus: "ok",
      nextReset: "2026-07-01T00:00:00Z", needsReauth: true)
  ]
  let t0 = BarAlertEngine.evaluate(
    rows: rowsT0, analytics: mkSpendAnalytics(today: 100, month: 500), prefs: prefs,
    priorFiredKeys: [], now: engineNow, calendar: utc)
  check(t0.firedKeys.count >= 3, "t0 accumulates quota+daily+month+reauth keys")

  // Roll a full month forward AND drop account "a", introduce account "b".
  let later = engineNow.addingTimeInterval(40 * 24 * 3600)
  let rowsT1 = [BarSummaryRow(accountId: "b", provider: "kiro", quotaStatus: "unsupported")]
  let t1 = BarAlertEngine.evaluate(
    rows: rowsT1, analytics: mkSpendAnalytics(today: 0, month: 0), prefs: prefs,
    priorFiredKeys: t0.firedKeys, now: later, calendar: utc)
  check(
    !t1.firedKeys.contains { $0.contains("|agy:a|") || $0.hasSuffix("|agy:a|on") },
    "prune drops keys for departed account a")
  // Stale daily/month/quota buckets from t0 are gone (bucket rolled), so the set
  // collapses to only what's currently true (account b has no alerts) → empty.
  check(t1.firedKeys.isEmpty, "prune collapses stale-bucket + absent-account keys (bounded)")
}

// (H) Deterministic order: shuffled rows produce notifs in stable id order.
do {
  let rows = [
    BarSummaryRow(accountId: "z", provider: "agy", needsReauth: true),
    BarSummaryRow(accountId: "a", provider: "agy", needsReauth: true),
  ]
  let ev = BarAlertEngine.evaluate(
    rows: rows, analytics: nil, prefs: BarAlertPrefs(), priorFiredKeys: [], now: engineNow,
    calendar: utc)
  let reauthIds = ev.toDeliver.filter { $0.kind == .reauthNeeded }.map { $0.id }
  check(
    reauthIds == reauthIds.sorted(), "engine emits notifs in stable account-id order")
}

// (I) Delivery wrapper (structural): RecordingNotifier (Core protocol) gets exactly
//     the toDeliver ids; a repeat poll delivers nothing.
final class RecordingNotifier: NotificationDelivering, @unchecked Sendable {
  var delivered: [String] = []
  func deliver(_ n: BarNotification) { delivered.append(n.id) }
}
do {
  let notifier = RecordingNotifier()
  let rows = [BarSummaryRow(accountId: "a", provider: "agy", needsReauth: true)]
  let ev = BarAlertEngine.evaluate(
    rows: rows, analytics: nil, prefs: BarAlertPrefs(), priorFiredKeys: [], now: engineNow,
    calendar: utc)
  for n in ev.toDeliver { notifier.deliver(n) }
  check(notifier.delivered == ev.toDeliver.map { $0.id }, "notifier delivered ids == toDeliver ids")
  let ev2 = BarAlertEngine.evaluate(
    rows: rows, analytics: nil, prefs: BarAlertPrefs(), priorFiredKeys: ev.firedKeys, now: engineNow,
    calendar: utc)
  let before = notifier.delivered.count
  for n in ev2.toDeliver { notifier.deliver(n) }
  check(notifier.delivered.count == before, "repeat poll delivers nothing through notifier")
}

// (J) Disabled rule: quota disabled => no quota notif even on a deep cross.
do {
  let rows = [
    BarSummaryRow(accountId: "a", provider: "agy", quotaPercentage: 1, quotaStatus: "ok",
      nextReset: "2026-07-01T00:00:00Z")
  ]
  let ev = BarAlertEngine.evaluate(
    rows: rows, analytics: nil, prefs: BarAlertPrefs(quotaEnabled: false), priorFiredKeys: [],
    now: engineNow, calendar: utc)
  check(
    !ev.toDeliver.contains { $0.kind == .quotaRemainingBelow },
    "disabled quota rule never fires")
}

// cleanup
try? FileManager.default.removeItem(atPath: tmp)

if failures > 0 {
  print("\nFAILED: \(failures) check(s)")
  exit(1)
} else {
  print("\nALL CHECKS PASSED")
  exit(0)
}
