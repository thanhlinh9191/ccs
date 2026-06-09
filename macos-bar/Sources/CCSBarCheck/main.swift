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

// cleanup
try? FileManager.default.removeItem(atPath: tmp)

if failures > 0 {
  print("\nFAILED: \(failures) check(s)")
  exit(1)
} else {
  print("\nALL CHECKS PASSED")
  exit(0)
}
