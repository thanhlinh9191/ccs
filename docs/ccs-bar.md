# CCS Bar — Native macOS Menu Bar App

CCS Bar is a native macOS menu-bar app that shows live subscription quota and usage at a glance for your Claude Code, Codex, and CLIProxy accounts, without opening the dashboard.

## What It Is

CCS Bar is a thin client of the CCS local web-server. It never talks to a provider directly: every call goes to `localhost`, and CCS performs any provider fetch server-side. Opening the menu fires a debounced force-refresh so the glance reflects live data without blocking the UI.

It is macOS only.

## What It Shows

- Per-account quota percent and reset countdown
- Account tier
- Today, 7-day, and 30-day cost
- A 30-day usage sparkline
- Account state (active, paused, default)
- Native subscription rows for Claude Code and Codex

## Requirements

- macOS
- CCS CLI installed and configured (`ccs config` works)
- The CCS web-server reachable on loopback. `ccs bar` (or `ccs bar launch`) starts it for you.

## Install

```bash
ccs bar install
```

This downloads `CCS-Bar.app.zip` from the floating `ccs-bar-latest` GitHub release and installs `CCS Bar.app` into `~/Applications`. Downloads are restricted to `github.com` and `objects.githubusercontent.com`, and extraction is guarded against zip-slip.

If `CCS Bar.app` is already installed, the command shows the current version and proceeds as a reinstall.

After installation, CCS reads the app version directly from the bundle's `Info.plist` and pins it to `~/.ccs/bar/.version`. It then performs a reachability check against the bar API (`GET /api/bar/summary`). A 404 response means the running CCS server predates CCS Bar support — update CCS to a version that includes CCS Bar, then restart `ccs bar`.

After a successful install, CCS asks whether to launch CCS Bar immediately (default: yes). Pass `--launch` to skip the prompt and launch right away, or `--no-launch` to suppress the prompt entirely:

```bash
ccs bar install --launch     # install and launch immediately
ccs bar install --no-launch  # install, skip launch prompt
```

### Gatekeeper note

The install command automatically clears the macOS Gatekeeper quarantine attribute (`xattr -dr com.apple.quarantine`) on the downloaded app. If clearing fails for any reason, the command falls back to printing the manual command:

```bash
xattr -dr com.apple.quarantine "$HOME/Applications/CCS Bar.app"
```

Or right-click the app and choose Open.

## Launch

```bash
ccs bar          # alias: ccs bar launch
```

This checks whether a CCS web-server is already running (probing port 3000, 3001, 3002, 8000, and 8080, with the port from the previous `bar.json` checked first). If a live server is found it is reused; otherwise a new one is started. Either way the discovery file `~/.ccs/bar.json` is written and the app is opened. The discovery file looks like this:

```json
{ "baseUrl": "http://127.0.0.1:3000", "port": 3000, "authMode": "loopback" }
```

The Swift app reads `~/.ccs/bar.json` to find the server.

## Loopback / Localhost Requirement

CCS Bar talks only to `http://127.0.0.1:<port>`. v1 supports `authMode: "loopback"` only, meaning dashboard auth disabled on localhost.

If you bind the dashboard beyond localhost (for example `--host` set to a non-loopback address) with dashboard auth disabled, the bar's read endpoints (`GET /api/bar/summary`, `GET /api/bar/analytics`) are refused for non-loopback callers, and the app cannot reach the server. Keep the dashboard on loopback for CCS Bar to work.

## Uninstall

```bash
ccs bar uninstall
```

This removes `~/Applications/CCS Bar.app` and the installed version pin. It is a no-op if the app is not present.

## Troubleshooting

- Install fails with "server predates CCS Bar" or bar API returns 404: the CCS server running does not yet include CCS Bar. Update CCS (`npm i -g ccs@latest` or equivalent), then restart `ccs bar`.
- Server failed to start: `ccs bar` first checks whether a CCS server is already running on the candidate ports (3000, 3001, 3002, 8000, 8080) and reuses it if found. A true failure here means a non-CCS process is occupying all candidate ports. Free one of those ports and re-run `ccs bar`.
- App won't open (Gatekeeper): right-click and Open, or clear quarantine with the `xattr` command above.
- Blank app: the web-server is not running. Re-run `ccs bar` and confirm `~/.ccs/bar.json` exists.
- Quota not updating: re-open the menu to force a refresh, or confirm the server is still reachable on loopback.

## Development

The source lives in `macos-bar/`. Contributors can build and run the logic checks with a Swift 5.9+ toolchain (CommandLineTools is enough, full Xcode not required):

```bash
swift build                 # build all targets, including the app
swift run ccs-bar-check     # run the logic tests
```
