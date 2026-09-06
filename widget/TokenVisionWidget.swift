// Token Vision — a macOS menu-bar widget showing plan-limit usage.
//
// A status-bar button (Claude starburst) toggles a black tray that unfurls
// downward from the menu bar, centered under the button, with one ring gauge
// per agent: Claude and Codex. The ring shows the most-used limit window;
// hovering a ring opens a callout listing every window (session / weekly) with
// a bar, percent used, and the reset time. When the usage endpoint is briefly
// rate-limited the ring keeps the last-known value, dimmed, rather than blanking
// to a dash. The Codex callout also lists the live Codex sessions (from the
// local rollout tailer) with context fill, tokens and a running state, and the
// Codex ring wears a green dot while any thread is mid-turn. The Claude callout
// adds a per-model token breakdown (Claude Code vs OMP) and the live OMP
// (oh-my-pi) sessions; its ring lights the same dot while an OMP turn runs.
// Right-click the
// button to quit. Data comes from `node src/live-usage.js --stream` (NDJSON).
// Build with widget/build.sh.

import AppKit
import Combine
import QuartzCore
import SwiftUI

// MARK: - Layout constants

enum Layout {
    static let shoulder: CGFloat = 14 // concave flare where the tray meets the menu bar
    static let cornerRadius: CGFloat = 26
    static let ringSize: CGFloat = 50
    static let ringStroke: CGFloat = 5
    static let labelHeight: CGFloat = 18
    static let ringLabelGap: CGFloat = 6
    static let columnGap: CGFloat = 18
    static let padSide: CGFloat = 22
    static let padTop: CGFloat = 16
    static let padBottom: CGFloat = 18
    static let calloutWidth: CGFloat = 300
    static let calloutPointer: CGFloat = 12
    static let shadowPad: CGFloat = 22 // margin around the tray so its drop shadow isn't clipped
    static let maxSessionRows = 8 // callout lists at most this many live threads

    static var columnHeight: CGFloat { ringSize + ringLabelGap + labelHeight }
    static var trayHeight: CGFloat { padTop + columnHeight + padBottom }
    static func trayWidth(columns: Int) -> CGFloat {
        2 * shoulder + 2 * padSide + CGFloat(columns) * ringSize + CGFloat(max(columns - 1, 0)) * columnGap
    }
    /// Distance from the tray's left edge to the center of ring `i`.
    static func ringCenterX(_ i: Int) -> CGFloat {
        shoulder + padSide + CGFloat(i) * (ringSize + columnGap) + ringSize / 2
    }
}

// MARK: - Formatting helpers

func num(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    return nil
}

func resetDate(_ value: Any?) -> Date? {
    if let epoch = num(value) {
        // Accept both seconds (codex/anthropic resetsAt) and milliseconds
        // (limitsAsOf, stamped with Date.now()); anything past ~year 2286 in
        // seconds must actually be milliseconds.
        return Date(timeIntervalSince1970: epoch > 10_000_000_000 ? epoch / 1000 : epoch)
    }
    if let iso = value as? String { return ISO8601DateFormatter().date(from: iso) }
    return nil
}

/// "Resets in 51 min", "Resets in 3h 12m", or "Resets Thu 12:00 AM".
func resetLabel(_ date: Date?, now: Date = Date()) -> String? {
    guard let date else { return nil }
    let secs = date.timeIntervalSince(now)
    if secs <= 0 { return "Resets now" }
    let mins = Int((secs / 60).rounded(.up))
    if mins < 60 { return "Resets in \(mins) min" }
    if secs < 24 * 3600 { return "Resets in \(mins / 60)h \(mins % 60)m" }
    let f = DateFormatter()
    f.dateFormat = "EEE h:mm a"
    return "Resets \(f.string(from: date))"
}

/// "just now", "3m ago", "1h 5m ago" — how long since a timestamp.
func agoLabel(_ date: Date?, now: Date = Date()) -> String? {
    guard let date else { return nil }
    let secs = max(0, now.timeIntervalSince(date))
    if secs < 60 { return "just now" }
    let mins = Int(secs / 60)
    if mins < 60 { return "\(mins)m ago" }
    let hours = mins / 60
    if hours < 24 { return "\(hours)h \(mins % 60)m ago" }
    return "\(hours / 24)d ago"
}

/// Turn a raw fetch error into something worth reading on a tiny callout — used
/// when there is no last-known value at all (nothing to show but the reason).
func friendlyLimitNote(_ err: String?) -> String {
    guard let err else { return "Limits unavailable" }
    let lower = err.lowercased()
    if err.contains("429") || lower.contains("rate") { return "Rate limited — retrying" }
    if err.contains("401") || lower.contains("auth") { return "Open Claude to refresh sign-in" }
    if lower.contains("no limit windows") { return "No data from Claude" }
    return err
}

/// Short reason shown next to a stale (last-known, dimmed) value.
func staleReason(_ err: String?) -> String {
    guard let err else { return "Rate limited" } // stale with no detail → assume throttle
    let lower = err.lowercased()
    if err.contains("401") || lower.contains("auth") { return "Sign in to Claude to refresh" }
    if err.contains("429") || lower.contains("rate") { return "Rate limited" }
    if lower.contains("no limit windows") { return "No data from Claude" }
    return "Update paused"
}

/// "Rate limited · updated 3m ago" — the note under a stale ring.
func staleNote(_ err: String?, asOf: Date?) -> String {
    let reason = staleReason(err)
    return agoLabel(asOf).map { "\(reason) · updated \($0)" } ?? reason
}

/// "1.2M", "708K", "950", or "—".
func compactTokens(_ v: Double?) -> String {
    guard let v else { return "—" }
    let a = abs(v)
    if a >= 1e9 { return String(format: "%.1fB", v / 1e9) }
    if a >= 1e6 { return String(format: "%.1fM", v / 1e6) }
    if a >= 1e3 { return String(format: "%.0fK", v / 1e3) }
    return String(format: "%.0f", v)
}

func windowLabel(claudeName: String) -> String {
    switch claudeName {
    case "session": return "Current session"
    case "weekly": return "All models"
    case "weekly opus": return "Opus"
    case "weekly sonnet": return "Sonnet"
    default: return claudeName.prefix(1).uppercased() + claudeName.dropFirst()
    }
}

func windowLabel(codexMins: Double?) -> String {
    guard let codexMins else { return "Current session" }
    return codexMins >= 1440 ? "Weekly" : "Current session"
}

// MARK: - Palette

func rgb(_ v: UInt32) -> Color {
    Color(
        red: Double((v >> 16) & 0xFF) / 255,
        green: Double((v >> 8) & 0xFF) / 255,
        blue: Double(v & 0xFF) / 255
    )
}

enum Palette {
    static let low = rgb(0x34C759)
    static let mid = rgb(0xDDF247)
    static let high = rgb(0xFF3B30)
    static let track = Color.white.opacity(0.16)

    static func severity(_ percent: Int) -> Color {
        percent >= 70 ? high : percent >= 40 ? mid : low
    }
}

// MARK: - Snapshot model

struct LimitWindow: Identifiable {
    let id: String
    let label: String
    let usedPercent: Int
    let resetsAt: Date?
}

/// One live thread — a Codex rollout (`codex.sessions`) or an OMP session
/// (`claude.omp.sessions`) — as emitted by the streamer.
struct LiveSession: Identifiable {
    let id: String
    let label: String      // subagent nickname, "Guardian review", project folder, or the Claude Code session name
    let kind: String       // user | subagent | guardian (Claude Code: interactive | bg)
    let model: String?
    let state: String      // running | idle | stale
    let ctxPercent: Int?   // Codex /status context-used percent (Codex only)
    let total: Double?     // cumulative tokens since the thread was loaded
    let messages: Int?     // message count (OMP only)
    let tokensPerMin: Double
    let ageSec: Double?
    /// Which tool runs it: "claude" (Claude Code), "omp" (oh-my-pi) or "codex".
    var source: String = "codex"
    var title: String? = nil        // human title (Codex thread name) when known
    var cwd: String? = nil
    var tty: String? = nil          // pty the process sits on ("ttys005")
    var termTty: String? = nil      // pty of the terminal the session is visible in
    var attached: Bool = false      // background job followed by an interactive session
    var app: String? = nil          // hosting .app bundle path (terminal / IDE)
    var url: String? = nil          // web view of the session (Claude Code background jobs)
    var sessionKind: String? = nil  // Claude Code: "interactive" | "bg"
    var originator: String? = nil   // Codex: "Codex Desktop", CLI, …
    /// The terminal to focus for this session (falls back to the process pty).
    var focusTty: String? { termTty ?? tty }
    /// Claude Code's pty host has no windows of its own.
    var hasWindowedApp: Bool { app.map { !$0.hasSuffix("ClaudeCode.app") } ?? false }
    var running: Bool { state == "running" }
    /// Stable identity across snapshots (ids are only unique per tool).
    var key: String { "\(source):\(id)" }
    var displayName: String { title ?? label }
    var sourceLabel: String {
        switch source {
        case "claude": return "Claude Code"
        case "omp": return "OMP"
        default: return "Codex"
        }
    }
    var folder: String? { cwd.map { ($0 as NSString).lastPathComponent } }
}

/// The place a session is "open in": a terminal or IDE app, the Claude or
/// Codex desktop app, or — for headless Claude Code background jobs — the
/// claude.ai web view. Rendered as a chip with the app's own icon; clicking it
/// brings that app (or web page) forward.
struct HostApp {
    enum Kind { case app, web }
    let kind: Kind
    let name: String
    var path: String? = nil   // .app bundle (kind .app)
    var url: URL? = nil       // kind .web

    var icon: NSImage? {
        guard let path else { return nil }
        if let cached = HostApp.iconCache[path] { return cached }
        let img = NSWorkspace.shared.icon(forFile: path)
        HostApp.iconCache[path] = img
        return img
    }
    private static var iconCache: [String: NSImage] = [:]
    private static var bundleCache: [String: String?] = [:]

    /// Installed path for a bundle id (cached; nil when not installed).
    static func path(bundleId: String) -> String? {
        if let hit = bundleCache[bundleId] { return hit }
        let p = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)?.path
        bundleCache[bundleId] = p
        return p
    }

    /// "Warp", "Terminal", "Claude", "Codex" (the ChatGPT.app is the Codex app), …
    static func displayName(forPath path: String) -> String {
        let base = (path as NSString).lastPathComponent.replacingOccurrences(of: ".app", with: "")
        switch base {
        case "ChatGPT": return "Codex"
        case "ClaudeCode": return "Claude Code"
        case "Visual Studio Code": return "VS Code"
        case "iTerm", "iTerm2": return "iTerm"
        default: return base
        }
    }

    static func app(_ path: String) -> HostApp {
        HostApp(kind: .app, name: displayName(forPath: path), path: path)
    }
}

/// Where a session's window is. For Claude Code that is the terminal (or the
/// Claude desktop app) the session is on screen in — for a background job,
/// the terminal that follows it or launched it. Only a job with no such
/// terminal is offered as its claude.ai web view. The headless pty host
/// (`ClaudeCode.app`, no windows) is never offered.
func hostApp(for s: LiveSession) -> HostApp? {
    switch s.source {
    case "claude":
        if let app = s.app, s.hasWindowedApp { return .app(app) }
        if s.sessionKind == "bg", let u = s.url.flatMap(URL.init(string:)) {
            return HostApp(kind: .web, name: "claude.ai", url: u)
        }
        return nil
    case "omp":
        return s.app.map { .app($0) }
    default:
        let origin = (s.originator ?? "").lowercased()
        if origin.contains("desktop"), let p = HostApp.path(bundleId: "com.openai.codex") { return .app(p) }
        if origin.contains("vscode") || origin.contains("vs code"),
           let p = HostApp.path(bundleId: "com.microsoft.VSCode") { return .app(p) }
        if let app = s.app { return .app(app) }
        return nil
    }
}

func parseSessions(_ raw: Any?, source: String) -> [LiveSession] {
    ((raw as? [[String: Any]]) ?? []).compactMap { s in
        guard let id = s["id"] as? String else { return nil }
        return LiveSession(
            id: id,
            label: s["label"] as? String ?? String(id.prefix(8)),
            kind: s["kind"] as? String ?? "user",
            model: s["model"] as? String,
            state: s["state"] as? String ?? "idle",
            ctxPercent: num(s["ctxPercent"]).map { Int($0) },
            total: num(s["total"]),
            messages: num(s["messages"]).map { Int($0) },
            tokensPerMin: num(s["tokensPerMin"]) ?? 0,
            ageSec: num(s["ageSec"]),
            source: source,
            title: s["title"] as? String,
            cwd: s["cwd"] as? String,
            tty: s["tty"] as? String,
            termTty: s["termTty"] as? String,
            attached: s["attached"] as? Bool ?? false,
            app: s["app"] as? String,
            url: s["url"] as? String,
            sessionKind: source == "claude" ? s["kind"] as? String : nil,
            originator: s["originator"] as? String
        )
    }
}

/// Lifetime Claude usage of one model, split by source (`claude.models`).
struct ModelShare: Identifiable {
    let model: String
    let tokens: Double
    let messages: Int
    let claudeCode: Double // tokens seen via Claude Code transcripts
    let omp: Double        // tokens seen via OMP (oh-my-pi)
    var id: String { model }
    /// "fable-5-1" for "claude-fable-5-1" — the vendor prefix is implied.
    var shortName: String { model.hasPrefix("claude-") ? String(model.dropFirst(7)) : model }
}

func parseModels(_ raw: Any?) -> [ModelShare] {
    ((raw as? [[String: Any]]) ?? []).compactMap { m in
        guard let model = m["model"] as? String else { return nil }
        return ModelShare(
            model: model,
            tokens: num(m["tokens"]) ?? 0,
            messages: Int(num(m["messages"]) ?? 0),
            claudeCode: num(m["claudeCode"]) ?? 0,
            omp: num(m["omp"]) ?? 0
        )
    }
}

/// OMP (oh-my-pi) usage block (`claude.omp`); absent when OMP tracking is off.
struct OmpUsage {
    let today: Double
    let lifetime: Double
    let messages: Int
    let costUsd: Double
    let perMinute: Double
    let sessions: [LiveSession]
    var running: Int { sessions.filter(\.running).count }
}

func parseOmp(_ raw: Any?) -> OmpUsage? {
    guard let o = raw as? [String: Any] else { return nil }
    return OmpUsage(
        today: num(o["today"]) ?? 0,
        lifetime: num(o["lifetime"]) ?? 0,
        messages: Int(num(o["messages"]) ?? 0),
        costUsd: num(o["costUsd"]) ?? 0,
        perMinute: num(o["perMinute"]) ?? 0,
        sessions: parseSessions(o["sessions"], source: "omp")
    )
}

enum Agent: String {
    case claude, codex
    var title: String { self == .claude ? "Claude Usage" : "Codex Usage" }
}

struct Ring: Identifiable {
    let agent: Agent
    var windows: [LimitWindow]
    var note: String?
    /// True when the numbers are the last-known ones and a fresh fetch failed
    /// (usually a transient rate limit). Rendered dimmed instead of blanked.
    var stale: Bool = false
    var asOf: Date?
    /// Raw error text from the streamer, so notes can name the real reason
    /// (rate limit vs expired sign-in) rather than always saying "rate limited".
    var errorText: String?
    /// Live threads (Codex only); independent of the plan-limit windows.
    var sessions: [LiveSession] = []
    /// Per-model lifetime breakdown (Claude only; empty for Codex).
    var models: [ModelShare] = []
    /// OMP usage and live sessions (Claude only; nil when OMP is off).
    var omp: OmpUsage?
    /// Live Claude Code processes (Claude only), from Claude Code's own registry.
    var claudeSessions: [LiveSession] = []
    var id: String { agent.rawValue }
    var percent: Int? { windows.map(\.usedPercent).max() }
    var running: Bool {
        sessions.contains { $0.running } || (omp?.running ?? 0) > 0 || claudeSessions.contains { $0.running }
    }
    /// Everything this ring lists as a live session — Claude Code + OMP for the
    /// Claude ring, the rollout threads for Codex — running first, then newest.
    var liveSessions: [LiveSession] {
        let all = agent == .claude ? claudeSessions + (omp?.sessions ?? []) : sessions
        return all.sorted { a, b in
            if a.running != b.running { return a.running }
            return (a.ageSec ?? .infinity) < (b.ageSec ?? .infinity)
        }
    }
}

struct Snapshot {
    var rings: [Ring] = []

    init(dict: [String: Any]) {
        if let c = dict["claude"] as? [String: Any] {
            let windows = ((c["limits"] as? [[String: Any]]) ?? []).enumerated().map { i, w in
                LimitWindow(
                    id: "claude-\(i)",
                    label: windowLabel(claudeName: w["name"] as? String ?? "limit"),
                    usedPercent: Int(num(w["usedPercent"]) ?? 0),
                    resetsAt: resetDate(w["resetsAt"])
                )
            }
            let stale = (c["limitsStale"] as? Bool ?? false) && !windows.isEmpty
            let asOf = resetDate(c["limitsAsOf"])
            let err = c["limitsError"] as? String
            let note: String?
            if windows.isEmpty {
                note = friendlyLimitNote(err)
            } else if stale {
                note = staleNote(err, asOf: asOf)
            } else {
                note = nil
            }
            rings.append(Ring(agent: .claude, windows: windows, note: note,
                              stale: stale, asOf: asOf, errorText: err,
                              models: parseModels(c["models"]), omp: parseOmp(c["omp"]),
                              claudeSessions: parseSessions(c["sessions"], source: "claude")))
        }
        if let x = dict["codex"] as? [String: Any] {
            var windows: [LimitWindow] = []
            var note: String?
            if x["pending"] != nil {
                note = "waiting for first poll"
            } else if let error = x["error"] as? String {
                note = error
            } else {
                if let used = num(x["usedPercent"]) {
                    windows.append(LimitWindow(
                        id: "codex-primary",
                        label: windowLabel(codexMins: num(x["windowMins"])),
                        usedPercent: Int(used),
                        resetsAt: resetDate(x["resetsAt"])
                    ))
                }
                if let s = x["secondary"] as? [String: Any], let used = num(s["usedPercent"]) {
                    windows.append(LimitWindow(
                        id: "codex-secondary",
                        label: windowLabel(codexMins: num(s["windowMins"])),
                        usedPercent: Int(used),
                        resetsAt: resetDate(s["resetsAt"])
                    ))
                }
                if windows.isEmpty { note = "limits unavailable" }
            }
            rings.append(Ring(agent: .codex, windows: windows, note: note,
                              errorText: x["error"] as? String,
                              sessions: parseSessions(x["sessions"], source: "codex")))
        }
    }
}

final class Model: ObservableObject {
    @Published var snapshot: Snapshot?
    @Published var hovered: Int?
    /// Drives the tray reveal (SwiftUI animates on this changing).
    @Published var open = false
    /// Sessions that finished a job and haven't been looked at yet (by `key`).
    /// Drives the red badge on the menu-bar button.
    @Published var unread: Set<String> = []
    /// When each session last went running -> idle; cleared once it runs again.
    /// Drives the "finished" mark in the callout.
    @Published var finishedAt: [String: Date] = [:]
    /// Fired on the main thread when a session transitions running -> idle.
    var onFinished: ((LiveSession) -> Void)?

    /// Last non-empty windows per agent, so a snapshot that arrives without
    /// limits (endpoint down / rate limited before the on-disk cache seeded)
    /// still shows the most recent real numbers, dimmed, instead of a dash.
    private var lastGood: [Agent: (windows: [LimitWindow], asOf: Date?)] = [:]
    private var prevRunning: [String: Bool] = [:]
    private var primed = false

    var unreadCount: Int { unread.count }

    func markRead(_ key: String) { unread.remove(key) }
    func markAllRead() { if !unread.isEmpty { unread.removeAll() } }

    /// Diff session states against the previous snapshot: a session that was
    /// running and is now idle "finished a job". The first snapshot only primes
    /// the table, so sessions already idle when the widget starts don't fire.
    private func trackFinished(_ snap: Snapshot) {
        var nowRunning: [String: Bool] = [:]
        for s in snap.rings.flatMap(\.liveSessions) {
            nowRunning[s.key] = s.running
            if s.running {
                // Back to work: the earlier "finished" no longer applies.
                finishedAt.removeValue(forKey: s.key)
                unread.remove(s.key)
            } else if primed, prevRunning[s.key] == true {
                finishedAt[s.key] = Date()
                unread.insert(s.key)
                onFinished?(s)
            }
        }
        // Sessions whose process exited drop out of the badge and the marks.
        for key in Array(unread) where nowRunning[key] == nil { unread.remove(key) }
        for key in Array(finishedAt.keys) where nowRunning[key] == nil { finishedAt.removeValue(forKey: key) }
        prevRunning = nowRunning
        primed = true
    }

    func apply(dict: [String: Any]) {
        var snap = Snapshot(dict: dict)
        snap.rings = snap.rings.map { ring in
            if !ring.windows.isEmpty {
                lastGood[ring.agent] = (ring.windows, ring.asOf)
                return ring
            }
            guard let lg = lastGood[ring.agent] else { return ring }
            var r = ring
            r.windows = lg.windows
            r.asOf = lg.asOf
            r.stale = true
            // Name the real reason: Claude is what the usage endpoint throttles;
            // Codex going empty is an app-server hiccup, not a rate limit.
            let reason = ring.agent == .claude ? staleReason(ring.errorText) : "Reconnecting"
            r.note = agoLabel(lg.asOf).map { "\(reason) · updated \($0)" } ?? reason
            return r
        }
        snapshot = snap
        trackFinished(snap)
    }
}

// MARK: - Logos

/// Claude's starburst mark: 12 rounded rays of alternating length.
struct ClaudeMark: View {
    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            let c = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
            Path { p in
                for i in 0..<12 {
                    let a = CGFloat(i) * .pi / 6
                    let len = (i % 2 == 0 ? 0.5 : 0.44) * s
                    let inner = 0.1 * s
                    p.move(to: CGPoint(x: c.x + cos(a) * inner, y: c.y + sin(a) * inner))
                    p.addLine(to: CGPoint(x: c.x + cos(a) * len, y: c.y + sin(a) * len))
                }
            }
            .stroke(Color.white, style: StrokeStyle(lineWidth: s * 0.11, lineCap: .round))
        }
    }
}

/// The official OpenAI logomark, filled white, rendered from an embedded SVG via
/// AppKit's native (vector) SVG support — crisp at any size, no asset file.
let openAILogo: NSImage = {
    let svg = """
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#FFFFFF" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>
    """
    let img = NSImage(data: Data(svg.utf8)) ?? NSImage()
    img.isTemplate = false
    return img
}()

/// Codex (OpenAI) logomark.
struct CodexMark: View {
    var body: some View {
        Image(nsImage: openAILogo)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
    }
}

struct AgentMark: View {
    let agent: Agent
    var body: some View {
        switch agent {
        case .claude: ClaudeMark()
        case .codex: CodexMark()
        }
    }
}

// MARK: - Views

struct RingView: View {
    let ring: Ring

    var body: some View {
        let pct = ring.percent
        let dim = ring.stale ? 0.5 : 1.0
        VStack(spacing: Layout.ringLabelGap) {
            ZStack {
                Circle()
                    .stroke(Palette.track, lineWidth: Layout.ringStroke)
                if let pct {
                    Circle()
                        .trim(from: 0, to: CGFloat(min(max(pct, 0), 100)) / 100)
                        .stroke(Palette.severity(pct),
                                style: StrokeStyle(lineWidth: Layout.ringStroke, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .opacity(dim)
                }
                AgentMark(agent: ring.agent)
                    .frame(width: Layout.ringSize * 0.42, height: Layout.ringSize * 0.42)
                    .opacity(ring.stale ? 0.85 : 1)
                if ring.running {
                    // A thread is mid-turn: green dot on the ring's 45° shoulder.
                    let r = Layout.ringSize / 2 * 0.7071
                    Circle().fill(Palette.low)
                        .frame(width: 7, height: 7)
                        .shadow(color: Palette.low.opacity(0.9), radius: 3)
                        .offset(x: r, y: -r)
                }
            }
            .frame(width: Layout.ringSize, height: Layout.ringSize)
            // Spring the arc to new values as fresh snapshots arrive.
            .animation(.spring(response: 0.55, dampingFraction: 0.85), value: pct)
            Text(pct.map { "\($0)%" } ?? "—")
                .font(.system(size: 15, weight: .medium, design: .rounded).monospacedDigit())
                .foregroundStyle(.white)
                .opacity(dim)
                .frame(height: Layout.labelHeight)
        }
        .frame(width: Layout.ringSize, height: Layout.columnHeight)
    }
}

/// Tray body: straight top edge with concave shoulders, rounded bottom corners.
struct TrayShape: Shape {
    func path(in r: CGRect) -> Path {
        let s = Layout.shoulder
        let cr = Layout.cornerRadius
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.minX + s, y: r.minY + s), control: CGPoint(x: r.minX + s, y: r.minY))
        p.addLine(to: CGPoint(x: r.minX + s, y: r.maxY - cr))
        p.addArc(center: CGPoint(x: r.minX + s + cr, y: r.maxY - cr), radius: cr,
                 startAngle: .degrees(180), endAngle: .degrees(90), clockwise: true)
        p.addLine(to: CGPoint(x: r.maxX - s - cr, y: r.maxY))
        p.addArc(center: CGPoint(x: r.maxX - s - cr, y: r.maxY - cr), radius: cr,
                 startAngle: .degrees(90), endAngle: .degrees(0), clockwise: true)
        p.addLine(to: CGPoint(x: r.maxX - s, y: r.minY + s))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.minY), control: CGPoint(x: r.maxX - s, y: r.minY))
        p.closeSubpath()
        return p
    }
}

struct TrayView: View {
    @ObservedObject var model: Model

    var body: some View {
        let rings = model.snapshot?.rings ?? []
        let open = model.open
        HStack(spacing: Layout.columnGap) {
            if rings.isEmpty {
                ProgressView().controlSize(.small).tint(.white)
                    .frame(width: Layout.ringSize, height: Layout.columnHeight)
            }
            ForEach(rings) { RingView(ring: $0) }
        }
        .padding(.top, Layout.padTop)
        .padding(.bottom, Layout.padBottom)
        .padding(.horizontal, Layout.shoulder + Layout.padSide)
        .background(TrayShape().fill(Color.black))
        .shadow(color: .black.opacity(0.34), radius: 16, x: 0, y: 7)
        // Cross-fade rings as the agent set changes (Claude-only -> +Codex).
        .animation(.easeInOut(duration: 0.25), value: rings.count)
        // Unfurl downward from the menu bar: grow vertically from the top edge
        // and fade in. Deterministic GPU transform — no window-frame animation.
        .scaleEffect(x: 1, y: open ? 1 : 0.02, anchor: .top)
        .opacity(open ? 1 : 0)
        .animation(.spring(response: 0.32, dampingFraction: 0.84), value: open)
    }
}

/// The tray content centered at the top of its (shadow-padded) panel.
struct TrayPanelView: View {
    @ObservedObject var model: Model
    var body: some View {
        TrayView(model: model)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

/// Hosts the tray and tracks which ring column the pointer is over. SwiftUI's
/// `onHover` only fires in the active app, and this accessory app never is,
/// so an always-active tracking area does the work instead.
final class TrayHostView<Content: View>: NSHostingView<Content> {
    var onHover: ((Int?) -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        // The tray content occupies only the top `trayHeight` of the panel; the
        // rest is the transparent shadow margin. Ignore hovers that land there
        // so a callout never opens over apparently-empty desktop.
        let inContentBand = isFlipped
            ? p.y >= 0 && p.y <= Layout.trayHeight
            : p.y >= bounds.height - Layout.trayHeight && p.y <= bounds.height
        let stride = Layout.ringSize + Layout.columnGap
        // The tray content sits inside a shadow-padding margin within the panel.
        let offset = p.x - Layout.shadowPad - Layout.shoulder - Layout.padSide
        guard inContentBand, offset >= 0, offset.truncatingRemainder(dividingBy: stride) < Layout.ringSize else {
            onHover?(nil)
            return
        }
        onHover?(Int(offset / stride))
    }

    override func mouseEntered(with event: NSEvent) { mouseMoved(with: event) }

    override func mouseExited(with event: NSEvent) { onHover?(nil) }
}

struct CalloutRow: View {
    let window: LimitWindow

    var body: some View {
        let color = Palette.severity(window.usedPercent)
        VStack(alignment: .leading, spacing: 6) {
            Text(window.label)
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.85))
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.18))
                    Capsule().fill(color)
                        .frame(width: max(4, geo.size.width * CGFloat(min(window.usedPercent, 100)) / 100))
                }
            }
            .frame(height: 4)
            HStack {
                Text("\(window.usedPercent)% Used")
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(.white)
                Spacer()
                if let reset = resetLabel(window.resetsAt) {
                    Text(reset)
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
        }
    }
}

/// One live session in the callout: name, source/model, state (running /
/// finished / idle), a context bar when known, and a detail line. The whole
/// row is a link: clicking opens the session's window.
struct SessionRow: View {
    let session: LiveSession
    var finished = false
    var unread = false
    var showSource = false
    var onOpen: () -> Void = {}
    var onOpenApp: (HostApp) -> Void = { _ in }

    var body: some View {
        let pct = session.ctxPercent
        let color = pct.map { Palette.severity($0) } ?? Color.white.opacity(0.35)
        let host = hostApp(for: session)
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                if unread {
                    Circle().fill(Palette.high).frame(width: 7, height: 7)
                }
                Text(session.displayName)
                    .font(.system(size: 12, weight: unread ? .semibold : .medium))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                if showSource {
                    Text(session.sourceLabel)
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(.white.opacity(0.75))
                        .padding(.horizontal, 5).padding(.vertical, 1.5)
                        .background(Capsule().fill(Color.white.opacity(0.14)))
                } else if let model = session.model {
                    Text(model)
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.5))
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if session.running {
                    HStack(spacing: 4) {
                        Circle().fill(Palette.low).frame(width: 6, height: 6)
                        Text("running").font(.system(size: 11)).foregroundStyle(Palette.low)
                    }
                } else if finished {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Palette.low)
                        Text("finished").font(.system(size: 11)).foregroundStyle(Palette.low)
                    }
                } else {
                    Text(session.state)
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.45))
                }
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white.opacity(0.4))
            }
            if pct != nil {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.18))
                        Capsule().fill(color)
                            .frame(width: max(4, geo.size.width * CGFloat(min(max(pct ?? 0, 0), 100)) / 100))
                    }
                }
                .frame(height: 4)
            }
            HStack(spacing: 8) {
                if let host {
                    // Link to the app the session is open in (its own icon).
                    HStack(spacing: 4) {
                        if let icon = host.icon {
                            Image(nsImage: icon).resizable().interpolation(.high)
                                .frame(width: 13, height: 13)
                        } else {
                            Image(systemName: "globe").font(.system(size: 10, weight: .semibold))
                        }
                        Text(host.name).font(.system(size: 10.5, weight: .medium))
                    }
                    .foregroundStyle(.white.opacity(0.9))
                    .padding(.leading, 4).padding(.trailing, 7).padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.14)))
                    .contentShape(Capsule())
                    .onTapGesture { onOpenApp(host) }
                    .help("Open in \(host.name)")
                }
                Text(detail)
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
                Spacer()
                Text(trailing)
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.6))
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .help("Open this session")
    }

    private var detail: String {
        if let pct = session.ctxPercent { return "\(pct)% context" }
        if let m = session.messages { return "\(m) msgs" }
        return session.folder ?? "—"
    }

    private var trailing: String {
        let ago = session.ageSec.map { agoLabel(Date().addingTimeInterval(-$0)) ?? "" } ?? ""
        if session.source == "claude" {
            let where_ = session.sessionKind == "bg" ? "background" : "terminal"
            return ago.isEmpty ? where_ : "\(where_) · \(ago)"
        }
        return "\(compactTokens(session.total)) tokens · \(compactTokens(session.tokensPerMin))/min"
    }
}

struct CalloutDivider: View {
    var body: some View { Rectangle().fill(Color.white.opacity(0.12)).frame(height: 1) }
}

/// "Live session(s)" header with running / finished counts, then at most
/// `Layout.maxSessionRows` clickable rows and a "+N more" tail.
struct SessionList: View {
    let sessions: [LiveSession]
    var weight: Font.Weight = .regular
    var showSource = false
    var finishedKeys: Set<String> = []
    var unreadKeys: Set<String> = []
    var onOpen: (LiveSession) -> Void = { _ in }
    var onOpenApp: (LiveSession, HostApp) -> Void = { _, _ in }

    var body: some View {
        Group {
            HStack(spacing: 8) {
                Text(sessions.count == 1 ? "Live session" : "Live sessions")
                    .font(.system(size: 12, weight: weight))
                    .foregroundStyle(.white.opacity(0.85))
                Spacer()
                let running = sessions.filter(\.running).count
                let unread = sessions.filter { unreadKeys.contains($0.key) }.count
                if unread > 0 {
                    Text("\(unread) finished")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Palette.high)
                }
                if running > 0 {
                    Text("\(running) running")
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.low)
                }
            }
            ForEach(sessions.prefix(Layout.maxSessionRows)) { s in
                SessionRow(session: s,
                           finished: finishedKeys.contains(s.key),
                           unread: unreadKeys.contains(s.key),
                           showSource: showSource,
                           onOpen: { onOpen(s) },
                           onOpenApp: { onOpenApp(s, $0) })
            }
            if sessions.count > Layout.maxSessionRows {
                Text("+\(sessions.count - Layout.maxSessionRows) more")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
    }
}

/// One model's share of Claude tokens: name, bar relative to the top model,
/// total, and (when both sources contributed) the Claude Code / OMP split.
struct ModelShareRow: View {
    let share: ModelShare
    let maxTokens: Double

    var body: some View {
        let frac = maxTokens > 0 ? min(max(share.tokens / maxTokens, 0), 1) : 0
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(share.shortName)
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(compactTokens(share.tokens))
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(.white)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.18))
                    Capsule().fill(Color.white.opacity(0.7))
                        .frame(width: max(3, geo.size.width * CGFloat(frac)))
                }
            }
            .frame(height: 3)
            if share.claudeCode > 0 && share.omp > 0 {
                Text("Claude Code \(compactTokens(share.claudeCode)) · OMP \(compactTokens(share.omp))")
                    .font(.system(size: 10.5).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
    }
}

struct ModelShareSection: View {
    static let maxRows = 5
    let models: [ModelShare]

    var body: some View {
        let top = models.map(\.tokens).max() ?? 0
        Group {
            Text("By model")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
            ForEach(models.prefix(Self.maxRows)) { ModelShareRow(share: $0, maxTokens: top) }
            if models.count > Self.maxRows {
                Text("+\(models.count - Self.maxRows) more")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
    }
}

/// OMP totals (today / lifetime / cost). Its live sessions are listed in the
/// Claude callout's unified session list, tagged "OMP".
struct OmpSection: View {
    let omp: OmpUsage

    var body: some View {
        HStack(alignment: .top) {
            Text("OMP · oh-my-pi")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text("today \(compactTokens(omp.today)) · total \(compactTokens(omp.lifetime))")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.6))
                if omp.costUsd > 0 {
                    Text(String(format: "$%.2f", omp.costUsd))
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
        }
    }
}

/// Upward-pointing triangle.
struct CalloutPointer: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.midX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
        p.closeSubpath()
        return p
    }
}

struct CalloutView: View {
    let ring: Ring
    /// Horizontal shift of the pointer from the bubble's center (points at the
    /// ring even when the bubble had to be clamped onto the screen).
    var pointerOffset: CGFloat = 0
    @ObservedObject var model: Model
    var onOpen: (LiveSession) -> Void = { _ in }
    var onOpenApp: (LiveSession, HostApp) -> Void = { _, _ in }
    @State private var shown = false

    var body: some View {
        let live = ring.liveSessions
        VStack(spacing: 0) {
            CalloutPointer()
                .fill(Color.black)
                .frame(width: 24, height: Layout.calloutPointer)
                .offset(x: pointerOffset)
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 8) {
                    AgentMark(agent: ring.agent).frame(width: 18, height: 18)
                    Text(ring.agent.title)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(.white)
                }
                if let note = ring.note {
                    Text(note)
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(3)
                }
                ForEach(ring.windows) { CalloutRow(window: $0) }
                CalloutDivider()
                if live.isEmpty {
                    Text("No live session")
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.5))
                } else {
                    // Claude lists Claude Code + OMP sessions together (tagged);
                    // Codex lists its rollout threads. Rows open the session.
                    SessionList(sessions: live, weight: .medium,
                                showSource: ring.agent == .claude,
                                finishedKeys: Set(model.finishedAt.keys),
                                unreadKeys: model.unread,
                                onOpen: onOpen,
                                onOpenApp: onOpenApp)
                }
                if !ring.models.isEmpty {
                    CalloutDivider()
                    ModelShareSection(models: ring.models)
                }
                if let omp = ring.omp {
                    CalloutDivider()
                    OmpSection(omp: omp)
                }
            }
            .padding(16)
            .frame(width: Layout.calloutWidth, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.black))
        }
        .fixedSize()
        // Subtle grow-in; the window's alpha handles the fade.
        .scaleEffect(shown ? 1 : 0.97, anchor: .top)
        .offset(y: shown ? 0 : -4)
        .onAppear { withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) { shown = true } }
    }
}

// MARK: - Windows

/// Non-activating panel that floats over every space, including the menu bar strip.
final class OverlayPanel: NSPanel {
    init() {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isMovableByWindowBackground = false
        hidesOnDeactivate = false
        acceptsMouseMovedEvents = true
    }
    override var canBecomeKey: Bool { false }
}

/// Hosts the callout. Tracks whether the pointer is inside it (so the bubble
/// stays open while the user moves in to click a session) and accepts the
/// first click without activating this accessory app.
final class CalloutHostView<Content: View>: NSHostingView<Content> {
    var onHoverChange: ((Bool) -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { onHoverChange?(true) }
    override func mouseExited(with event: NSEvent) { onHoverChange?(false) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - Opening a session's window

/// Brings a live session's window forward. Each tool has a different "window":
/// - Claude Code background jobs live on a headless pty, so their window is the
///   claude.ai/code web view (`url`); interactive ones get their terminal focused.
/// - OMP sessions get their terminal focused if an `omp` process is still on the
///   recorded pty, else a new Terminal window resumes the session (`omp -r`).
/// - Codex threads driven by the desktop app / IDE activate that app (there is
///   no per-thread deep link); CLI ones focus the terminal or `codex resume`.
/// Terminal.app tabs can be selected by pty over AppleScript; other terminals
/// (Warp, Ghostty, …) expose no tab API, so their app is activated instead.
enum SessionOpener {
    static func open(_ s: LiveSession) {
        switch s.source {
        case "claude":
            // The terminal (or desktop app) the session is on screen in wins —
            // for a background job that is the terminal following/launching it.
            if s.hasWindowedApp, focusTerminal(tty: s.focusTty ?? "", app: s.app) { return }
            if let u = s.url.flatMap(URL.init(string:)) {
                openInBrowser(u)
                return
            }
            openInTerminal("claude --resume \(shellQuote(s.id))", cwd: s.cwd)
        case "omp":
            if let tty = s.tty, processOnTTY(tty, named: "omp"),
               focusTerminal(tty: tty, app: s.app ?? appOwning(tty: tty)) {
                return
            }
            openInTerminal("omp -r \(shellQuote(s.id))", cwd: s.cwd)
        default:
            let origin = (s.originator ?? "").lowercased()
            if origin.contains("desktop") || origin.contains("vscode") || origin.contains("code") {
                if activate(bundleId: "com.openai.codex") { return }
            }
            if let tty = s.tty, focusTerminal(tty: tty, app: s.app) { return }
            openInTerminal("codex resume \(shellQuote(s.id))", cwd: s.cwd)
        }
    }

    /// Bring the app (or web page) a session is open in to the front. For a
    /// terminal, select the session's tab where the terminal supports it.
    static func open(_ host: HostApp, for s: LiveSession) {
        switch host.kind {
        case .web:
            if let u = host.url { openInBrowser(u) }
        case .app:
            guard let path = host.path else { return }
            if focusTerminal(tty: s.focusTty ?? "", app: path) { return }
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path),
                                               configuration: NSWorkspace.OpenConfiguration(),
                                               completionHandler: nil)
        }
    }

    /// Open a web link in the default browser. A plain `open(url)` lets
    /// LaunchServices hand claude.ai links to the Claude desktop app (universal
    /// links); naming the browser keeps a hyperlink a hyperlink.
    static func openInBrowser(_ url: URL) {
        if let probe = URL(string: "https://example.com/"),
           let browser = NSWorkspace.shared.urlForApplication(toOpen: probe) {
            NSWorkspace.shared.open([url], withApplicationAt: browser,
                                    configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    /// macOS user notification for a finished job. `osascript` works from an
    /// unbundled binary, where UNUserNotificationCenter would need a bundle id.
    static func notify(finished s: LiveSession) {
        let script = "display notification \(appleScriptString(s.displayName)) " +
            "with title \"Token Vision\" subtitle \(appleScriptString("\(s.sourceLabel) finished"))"
        runAppleScript(script)
    }

    // MARK: helpers

    static func focusTerminal(tty: String, app: String?) -> Bool {
        let dev = "/dev/\(tty)"
        if let app, app.hasSuffix("Terminal.app") {
            runAppleScript("""
            tell application "Terminal"
                repeat with w in windows
                    repeat with t in tabs of w
                        if tty of t is "\(dev)" then
                            set selected tab of w to t
                            set index of w to 1
                            activate
                            return
                        end if
                    end repeat
                end repeat
                activate
            end tell
            """)
            return true
        }
        if let app, app.contains("iTerm") {
            runAppleScript("""
            tell application "iTerm2"
                repeat with w in windows
                    repeat with t in tabs of w
                        repeat with s in sessions of t
                            if tty of s is "\(dev)" then
                                select t
                                activate
                                return
                            end if
                        end repeat
                    end repeat
                end repeat
                activate
            end tell
            """)
            return true
        }
        if let app {
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: app),
                                               configuration: NSWorkspace.OpenConfiguration(),
                                               completionHandler: nil)
            return true
        }
        return false
    }

    static func activate(bundleId: String) -> Bool {
        if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
            running.activate(options: [.activateIgnoringOtherApps])
            return true
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return false }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration(),
                                           completionHandler: nil)
        return true
    }

    /// Open a fresh Terminal window in `cwd` running `command`.
    static func openInTerminal(_ command: String, cwd: String?) {
        let cd = cwd.map { "cd \(shellQuote($0)) && " } ?? ""
        runAppleScript("""
        tell application "Terminal"
            activate
            do script \(appleScriptString(cd + command))
        end tell
        """)
    }

    static func runAppleScript(_ script: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    /// Output of `ps` with the given arguments, or "" (bounded, synchronous —
    /// only used at click time).
    static func ps(_ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    static func processOnTTY(_ tty: String, named name: String) -> Bool {
        ps(["-t", tty, "-o", "comm="]).split(separator: "\n").contains {
            ($0.split(separator: "/").last ?? "") == Substring(name) || $0.trimmingCharacters(in: .whitespaces) == name
        }
    }

    /// The .app hosting whatever runs on `tty` (walks parent processes).
    static func appOwning(tty: String) -> String? {
        for pidStr in ps(["-t", tty, "-o", "pid="]).split(separator: "\n") {
            var pid = Int(pidStr.trimmingCharacters(in: .whitespaces)) ?? 0
            for _ in 0..<24 where pid > 1 {
                let line = ps(["-o", "ppid=,comm=", "-p", String(pid)]).trimmingCharacters(in: .whitespacesAndNewlines)
                guard let space = line.firstIndex(of: " ") else { break }
                let comm = line[line.index(after: space)...].trimmingCharacters(in: .whitespaces)
                if let r = comm.range(of: ".app/Contents/MacOS/") {
                    return String(comm[..<r.lowerBound]) + ".app"
                }
                pid = Int(line[..<space]) ?? 0
            }
        }
        return nil
    }

    static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func appleScriptString(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}

// MARK: - Status-bar icon

/// Claude starburst for the status item. With `badge` > 0 a red counter sits
/// on the top-right corner (unread finished jobs). A badged icon can't be a
/// template image (the badge must stay red), so the mark is drawn in the label
/// color — this block re-runs per appearance, so it still follows the menu bar.
func statusIcon(badge: Int = 0) -> NSImage {
    let size: CGFloat = 18
    let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
        let c = CGPoint(x: size / 2, y: size / 2)
        let path = NSBezierPath()
        path.lineWidth = 1.8
        path.lineCapStyle = .round
        for i in 0..<12 {
            let a = CGFloat(i) * .pi / 6
            let len = (i % 2 == 0 ? 0.48 : 0.4) * size
            path.move(to: CGPoint(x: c.x + cos(a) * 1.5, y: c.y + sin(a) * 1.5))
            path.line(to: CGPoint(x: c.x + cos(a) * len, y: c.y + sin(a) * len))
        }
        (badge > 0 ? NSColor.labelColor : NSColor.black).setStroke()
        path.stroke()
        if badge > 0 {
            let text = badge > 99 ? "99+" : String(badge)
            let font = NSFont.systemFont(ofSize: text.count > 2 ? 7 : 9, weight: .bold)
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
            let ts = (text as NSString).size(withAttributes: attrs)
            let h: CGFloat = 11
            let w = max(h, ts.width + 5)
            let rect = NSRect(x: size - w, y: size - h, width: w, height: h)
            NSColor.systemRed.setFill()
            NSBezierPath(roundedRect: rect, xRadius: h / 2, yRadius: h / 2).fill()
            (text as NSString).draw(at: NSPoint(x: rect.midX - ts.width / 2, y: rect.midY - ts.height / 2),
                                    withAttributes: attrs)
        }
        return true
    }
    image.isTemplate = badge == 0
    return image
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = Model()
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let tray = OverlayPanel()
    let trayContainer = NSView()
    var trayHost: NSView?
    let callout = OverlayPanel()
    var expanded = false
    var outsideClickMonitor: Any?
    var proc: Process?
    var buffer = Data()
    var quitting = false
    var subs: [AnyCancellable] = []
    /// Bumped on every open/close so a stale deferred close can't hide a tray
    /// that has since been reopened.
    var openGen = 0
    /// Bumped on every callout fade-out so a superseded fade can't order it out.
    var calloutHideGen = 0
    /// Which ring the callout currently shows, and whether the pointer is in it.
    var calloutRing: Int?
    var calloutHovered = false
    var calloutHide: DispatchWorkItem?

    static let openDuration: TimeInterval = 0.32
    static let closeDuration: TimeInterval = 0.22

    let scriptPath: String = {
        if CommandLine.arguments.count > 1 { return CommandLine.arguments[1] }
        let bin = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        return bin.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("src/live-usage.js").path
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let button = item.button {
            button.image = statusIcon()
            button.action = #selector(statusClicked)
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        let host = TrayHostView(rootView: TrayPanelView(model: model))
        host.onHover = { [weak self] column in
            guard let self, self.model.hovered != column else { return }
            self.model.hovered = column
        }
        // The panel stays a fixed size (tray + shadow margin); the tray unfurls
        // downward from the menu bar as a SwiftUI transform, so nothing depends
        // on autoresizing timing. The drop shadow is drawn in SwiftUI (the panel
        // window shadow is off) so it animates with the reveal.
        host.autoresizingMask = [.width, .height]
        trayContainer.autoresizesSubviews = true
        trayContainer.addSubview(host)
        trayHost = host
        tray.contentView = trayContainer

        model.$snapshot
            .map { $0?.rings.count ?? 0 }
            .removeDuplicates()
            .sink { [weak self] _ in self?.positionTray() }
            .store(in: &subs)
        model.$hovered
            .removeDuplicates()
            .sink { [weak self] hovered in self?.trayHoverChanged(hovered) }
            .store(in: &subs)
        // Fresh data while the callout is up: refresh it in place (no flicker,
        // and a click in progress survives the 2 s snapshot cadence).
        model.$snapshot
            .sink { [weak self] _ in self?.refreshCalloutIfShown() }
            .store(in: &subs)
        // Unread finished jobs -> red counter on the menu-bar icon.
        model.$unread
            .map(\.count)
            .removeDuplicates()
            .sink { [weak self] n in self?.item.button?.image = statusIcon(badge: n) }
            .store(in: &subs)
        model.onFinished = { SessionOpener.notify(finished: $0) }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.positionTray() }
        launchStreamer()
    }

    var columns: Int { max(model.snapshot?.rings.count ?? 0, 1) }

    /// Full tray frame: hanging from the menu bar, centered under the status
    /// button and nudged onto the screen if the button sits near a corner.
    func trayFrame(columns: Int) -> NSRect {
        let size = NSSize(width: Layout.trayWidth(columns: columns), height: Layout.trayHeight)
        guard let button = item.button, let window = button.window else { return NSRect(origin: .zero, size: size) }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        var x = anchor.midX - size.width / 2
        if let vf = (button.window?.screen ?? NSScreen.main)?.visibleFrame {
            x = min(max(x, vf.minX + 6), vf.maxX - size.width - 6)
        }
        return NSRect(x: x, y: anchor.minY - size.height, width: size.width, height: size.height)
    }

    /// The panel window frame: the tray content rect grown by the shadow margin
    /// on the sides and bottom (the top stays flush under the menu bar).
    func panelFrame(columns: Int) -> NSRect {
        let c = trayFrame(columns: columns)
        return NSRect(x: c.minX - Layout.shadowPad,
                      y: c.maxY - (Layout.trayHeight + Layout.shadowPad),
                      width: c.width + 2 * Layout.shadowPad,
                      height: Layout.trayHeight + Layout.shadowPad)
    }

    /// Snap the panel to its current position/size (used on data/screen changes).
    /// The reveal itself is a SwiftUI transform, so this never animates geometry.
    func positionTray() {
        let pf = panelFrame(columns: columns)
        tray.setFrame(pf, display: true)
        trayHost?.frame = NSRect(origin: .zero, size: pf.size)
        refreshCalloutIfShown()
    }

    @objc func statusClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(NSMenuItem(title: "Quit Token Vision", action: #selector(quit), keyEquivalent: "q"))
            item.menu = menu
            item.button?.performClick(nil)
            item.menu = nil
        } else {
            setExpanded(!expanded)
        }
    }

    func setExpanded(_ value: Bool) {
        guard value != expanded else { return }
        expanded = value
        openGen += 1
        let gen = openGen
        item.button?.highlight(value)
        if value {
            positionTray()
            model.open = false // paint the collapsed state first, then animate in
            tray.orderFrontRegardless()
            DispatchQueue.main.async { [weak self] in
                guard let self, self.openGen == gen else { return }
                self.model.open = true
            }
            outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
                [weak self] _ in self?.setExpanded(false)
            }
        } else {
            model.hovered = nil
            model.open = false // SwiftUI animates the retract
            hideCallout()
            // Closing the tray counts as having seen the finished jobs; the
            // "finished" marks stay until those sessions run again.
            model.markAllRead()
            if let outsideClickMonitor { NSEvent.removeMonitor(outsideClickMonitor) }
            outsideClickMonitor = nil
            // Hide the window only after the retract finishes, and only if it
            // wasn't reopened in the meantime.
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.closeDuration + 0.05) { [weak self] in
                guard let self, self.openGen == gen, !self.expanded else { return }
                self.tray.orderOut(nil)
            }
        }
    }

    // MARK: Callout — hover-bridged so its rows can be clicked

    /// The tray reports which ring the pointer is over (nil when it leaves).
    /// Leaving doesn't hide immediately: the pointer is usually on its way
    /// into the bubble, which reports its own hover.
    func trayHoverChanged(_ ring: Int?) {
        if let ring {
            cancelHide()
            showCallout(ring: ring)
        } else if !calloutHovered {
            scheduleHide(after: 0.35)
        }
    }

    func calloutHoverChanged(_ inside: Bool) {
        calloutHovered = inside
        if inside {
            cancelHide()
        } else if model.hovered == nil {
            scheduleHide(after: 0.25)
        }
    }

    func scheduleHide(after delay: TimeInterval) {
        cancelHide()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.calloutHovered, self.model.hovered == nil else { return }
            self.hideCallout()
        }
        calloutHide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    func cancelHide() {
        calloutHide?.cancel()
        calloutHide = nil
    }

    func calloutView(for ring: Ring) -> CalloutView {
        CalloutView(ring: ring, model: model,
                    onOpen: { [weak self] s in self?.openSession(s) },
                    onOpenApp: { [weak self] s, host in self?.openApp(host, for: s) })
    }

    /// The app chip on a row was clicked: bring that app forward (and mark the
    /// session as seen, same as opening it).
    func openApp(_ host: HostApp, for s: LiveSession) {
        model.markRead(s.key)
        SessionOpener.open(host, for: s)
    }

    func clampedCalloutX(ringX: CGFloat, width: CGFloat) -> CGFloat {
        var x = ringX - width / 2
        if let screen = item.button?.window?.screen ?? NSScreen.screens.first {
            x = min(x, screen.visibleFrame.maxX - width)
            x = max(x, screen.visibleFrame.minX)
        }
        return x
    }

    func showCallout(ring index: Int) {
        guard expanded, let ring = model.snapshot?.rings[safe: index] else {
            hideCallout()
            return
        }
        let full = trayFrame(columns: columns)
        let ringX = full.minX + Layout.ringCenterX(index)
        // Same ring already up: swap the content in place so the bubble (and a
        // click in progress) survives the snapshot cadence; resize if needed.
        if callout.isVisible, calloutRing == index,
           let host = callout.contentView as? CalloutHostView<CalloutView> {
            var view = calloutView(for: ring)
            view.pointerOffset = host.rootView.pointerOffset
            host.rootView = view
            let size = host.fittingSize
            if abs(size.height - callout.frame.height) > 0.5 || abs(size.width - callout.frame.width) > 0.5 {
                let x = clampedCalloutX(ringX: ringX, width: size.width)
                host.rootView.pointerOffset = ringX - (x + size.width / 2)
                callout.setFrame(NSRect(x: x, y: full.minY - size.height + 4,
                                        width: size.width, height: size.height), display: true)
            }
            return
        }
        let host = CalloutHostView(rootView: calloutView(for: ring))
        host.onHoverChange = { [weak self] inside in self?.calloutHoverChanged(inside) }
        let size = host.fittingSize
        let x = clampedCalloutX(ringX: ringX, width: size.width)
        host.rootView.pointerOffset = ringX - (x + size.width / 2)
        let frame = NSRect(x: x, y: full.minY - size.height + 4, width: size.width, height: size.height)
        callout.contentView = host
        calloutRing = index
        calloutHideGen += 1 // cancel any in-flight fade-out
        if callout.isVisible {
            // Re-hover during a fade / move to the other ring: reclaim full
            // opacity and slide over (the swapped-in content plays its grow-in).
            callout.alphaValue = 1
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                ctx.allowsImplicitAnimation = true
                callout.animator().setFrame(frame, display: true)
            }
        } else {
            callout.setFrame(frame, display: true)
            callout.alphaValue = 0
            callout.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.16
                callout.animator().alphaValue = 1
            }
        }
    }

    func refreshCalloutIfShown() {
        guard callout.isVisible, let ring = calloutRing else { return }
        showCallout(ring: ring)
    }

    func hideCallout() {
        cancelHide()
        guard callout.isVisible else { return }
        calloutHideGen += 1
        let gen = calloutHideGen
        calloutHovered = false
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.12
            callout.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            // Bail if a re-hover superseded this fade (it already restored alpha).
            guard let self, self.calloutHideGen == gen else { return }
            self.callout.orderOut(nil)
            self.callout.alphaValue = 1
            self.calloutRing = nil
        })
    }

    /// A session row was clicked: it has been seen, and its window comes forward.
    func openSession(_ s: LiveSession) {
        model.markRead(s.key)
        SessionOpener.open(s)
    }

    @objc func quit() {
        quitting = true
        proc?.terminate()
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        proc?.terminate()
    }

    func launchStreamer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // Login shell so the user's PATH (homebrew node) applies.
        p.arguments = ["-lc", "exec node '\(scriptPath)' --stream --interval 2 --codex-interval 30"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consume(handle.availableData)
        }
        p.terminationHandler = { [weak self] _ in
            guard let self, !self.quitting else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.launchStreamer() }
        }
        do {
            try p.run()
            proc = p
        } catch {
            NSLog("Token Vision: could not launch node: \(error)")
        }
    }

    func consume(_ data: Data) {
        guard !data.isEmpty else { return }
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard
                let obj = try? JSONSerialization.jsonObject(with: line),
                let dict = obj as? [String: Any]
            else { continue }
            DispatchQueue.main.async { self.model.apply(dict: dict) }
        }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

// MARK: - Headless preview render (`TokenVision --render [outDir]`)
//
// Renders the real views offscreen to a PNG so the look can be checked without
// Screen Recording permission or a live click. Not used in normal operation.

func renderRep<V: View>(_ view: V) -> NSImage {
    let host = NSHostingView(rootView: view)
    host.wantsLayer = true
    host.layoutSubtreeIfNeeded()
    let size = host.fittingSize
    host.frame = NSRect(origin: .zero, size: size)
    host.layoutSubtreeIfNeeded()
    // Force the layer tree to render, then composite it with alpha preserved so
    // the tray's transparent shoulders/corners don't come out white.
    if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
        host.cacheDisplay(in: host.bounds, to: rep)
    }
    let img = NSImage(size: size)
    img.lockFocus()
    if let ctx = NSGraphicsContext.current?.cgContext {
        // Layers render top-left origin; the focus context is bottom-left. Flip.
        ctx.saveGState()
        ctx.translateBy(x: 0, y: size.height)
        ctx.scaleBy(x: 1, y: -1)
        host.layer?.render(in: ctx)
        ctx.restoreGState()
    }
    img.unlockFocus()
    return img
}

func model(_ rings: [Ring]) -> Model {
    let m = Model()
    var s = Snapshot(dict: [:])
    s.rings = rings
    m.snapshot = s
    m.open = true // render the revealed tray, not the collapsed transform
    return m
}

/// A template image recolored for the preview (AppKit does this in the menu bar).
func tint(_ image: NSImage, _ color: NSColor) -> NSImage {
    let out = NSImage(size: image.size, flipped: false) { rect in
        image.draw(in: rect)
        color.set()
        rect.fill(using: .sourceAtop)
        return true
    }
    return out
}

func renderArtboards(to dir: String) {
    let now = Date()
    let soon = now.addingTimeInterval(51 * 60)
    let thu = now.addingTimeInterval(3 * 24 * 3600)
    func w(_ id: String, _ label: String, _ p: Int, _ r: Date?) -> LimitWindow {
        LimitWindow(id: id, label: label, usedPercent: p, resetsAt: r)
    }
    let models = [
        ModelShare(model: "claude-fable-5-1", tokens: 1_520_000, messages: 340, claudeCode: 1_220_000, omp: 300_000),
        ModelShare(model: "claude-opus-4-1", tokens: 640_000, messages: 88, claudeCode: 640_000, omp: 0),
        ModelShare(model: "claude-haiku-4-5", tokens: 95_000, messages: 410, claudeCode: 20_000, omp: 75_000),
    ]
    let omp = OmpUsage(today: 12_300, lifetime: 9_870_000, messages: 210, costUsd: 12.34, perMinute: 4_000,
                       sessions: [
        LiveSession(id: "o1", label: "worktree", kind: "user", model: "claude-fable-5-1", state: "running",
                    ctxPercent: nil, total: 456_789, messages: 12, tokensPerMin: 3_000, ageSec: 5,
                    source: "omp", cwd: "/Users/osika/worktree", tty: "ttys006",
                    app: "/System/Applications/Utilities/Terminal.app"),
        LiveSession(id: "o2", label: "widget", kind: "user", model: "claude-fable-5-1", state: "idle",
                    ctxPercent: nil, total: 88_100, messages: 4, tokensPerMin: 0, ageSec: 400,
                    source: "omp", cwd: "/Users/osika/widget", tty: "ttys004"),
    ])
    let claudeSessions = [
        LiveSession(id: "c1", label: "Widget activity count with Anthropic and OpenAI models", kind: "bg",
                    model: nil, state: "running", ctxPercent: nil, total: nil, messages: nil, tokensPerMin: 0,
                    ageSec: 12, source: "claude", cwd: "/Users/osika/widget", tty: "ttys006",
                    termTty: "ttys005", attached: true, app: "/Applications/Warp.app",
                    url: "https://claude.ai/code/session_1", sessionKind: "bg"),
        LiveSession(id: "c2", label: "landing page plan groundwork", kind: "bg", model: nil, state: "idle",
                    ctxPercent: nil, total: nil, messages: nil, tokensPerMin: 0, ageSec: 240,
                    source: "claude", cwd: "/Users/osika/html", tty: "ttys003",
                    url: "https://claude.ai/code/session_2", sessionKind: "bg"),
        LiveSession(id: "c3", label: "html-b8", kind: "interactive", model: nil, state: "idle",
                    ctxPercent: nil, total: nil, messages: nil, tokensPerMin: 0, ageSec: 900,
                    source: "claude", cwd: "/Users/osika/html", tty: "ttys005", app: "/Applications/Warp.app",
                    sessionKind: "interactive"),
        LiveSession(id: "c4", label: "desktop chat", kind: "interactive", model: nil, state: "idle",
                    ctxPercent: nil, total: nil, messages: nil, tokensPerMin: 0, ageSec: 1500,
                    source: "claude", cwd: "/Users/osika/notes", app: "/Applications/Claude.app",
                    sessionKind: "interactive"),
    ]
    let claudeFresh = Ring(agent: .claude,
                           windows: [w("c0", "Current session", 73, soon), w("c1", "All models", 7, thu)],
                           note: nil, stale: false, asOf: now, models: models, omp: omp,
                           claudeSessions: claudeSessions)
    let sessions = [
        LiveSession(id: "s1", label: "Archimedes", kind: "subagent", model: "gpt-5.6-sol", state: "running",
                    ctxPercent: 71, total: 29_400_000, messages: nil, tokensPerMin: 675_000, ageSec: 2,
                    originator: "Codex Desktop"),
        LiveSession(id: "s2", label: "proj", kind: "user", model: "gpt-5.6-sol", state: "idle",
                    ctxPercent: 31, total: 118_400_000, messages: nil, tokensPerMin: 0, ageSec: 90,
                    title: "Reverse engineer Grok bots", cwd: "/Users/osika/Documents/proj",
                    originator: "Codex Desktop"),
        LiveSession(id: "s3", label: "Guardian review", kind: "guardian", model: "codex-auto-review", state: "idle",
                    ctxPercent: 8, total: 155_000, messages: nil, tokensPerMin: 0, ageSec: 40),
    ]
    let codexFresh = Ring(agent: .codex, windows: [w("x0", "Current session", 21, soon)], note: nil,
                          sessions: sessions)
    let claudeStale = Ring(agent: .claude,
                           windows: [w("c0", "Current session", 73, soon), w("c1", "All models", 7, thu)],
                           note: "Rate limited · updated 3m ago", stale: true, asOf: now.addingTimeInterval(-180))
    let codexFresh2 = Ring(agent: .codex, windows: [w("x0", "Current session", 52, soon)], note: nil)

    // Two jobs finished since the tray was last opened: "landing page…" (Claude
    // Code) and the Codex "proj" thread — red dot + ✓ in the lists, 2 on the icon.
    let cm = model([claudeFresh, codexFresh])
    cm.finishedAt["claude:c2"] = now.addingTimeInterval(-240)
    cm.finishedAt["codex:s2"] = now.addingTimeInterval(-90)
    cm.unread = ["claude:c2", "codex:s2"]

    let trayFresh = renderRep(TrayView(model: cm))
    let trayStale = renderRep(TrayView(model: model([claudeStale, codexFresh2])))
    let callout = renderRep(CalloutView(ring: claudeFresh, model: cm))
    let calloutCodex = renderRep(CalloutView(ring: codexFresh, model: cm))
    let badgeIcon = statusIcon(badge: 2)
    let plainIcon = statusIcon(badge: 0)

    let H: CGFloat = 1500
    let canvas = NSImage(size: NSSize(width: 940, height: H))
    canvas.lockFocus()
    // desktop-ish backdrop
    let bg = NSGradient(starting: NSColor(calibratedRed: 0.10, green: 0.11, blue: 0.14, alpha: 1),
                        ending: NSColor(calibratedRed: 0.04, green: 0.04, blue: 0.06, alpha: 1))
    bg?.draw(in: NSRect(x: 0, y: 0, width: 940, height: H), angle: -90)
    func label(_ s: String, _ x: CGFloat, _ y: CGFloat) {
        let attrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.white.withAlphaComponent(0.65),
            .font: NSFont.systemFont(ofSize: 13, weight: .medium),
        ]
        NSString(string: s).draw(at: NSPoint(x: x, y: y), withAttributes: attrs)
    }
    func place(_ img: NSImage, _ x: CGFloat, _ topY: CGFloat) {
        // topY measured from the top edge; convert to bottom-left origin.
        let s = img.size
        img.draw(in: NSRect(x: x, y: H - topY - s.height, width: s.width, height: s.height))
    }
    label("Claude callout — Claude Code + OMP sessions (click to open)", 40, H - 40)
    label("✓ finished · red dot = unread", 40, H - 58)
    place(callout, 40, 80)
    label("Expanded tray (dot = a thread is mid-turn)", 470, H - 40)
    place(trayFresh, 470, 80)
    label("Menu-bar icon: 2 unread finished jobs / none", 470, H - 330)
    // Icons at 3x so the badge is legible in the preview; light and dark grounds.
    for (i, (icon, ground)) in [(badgeIcon, NSColor.white), (badgeIcon, NSColor.black),
                                (plainIcon, NSColor.white)].enumerated() {
        let cell = NSRect(x: 470 + CGFloat(i) * 80, y: H - 420, width: 64, height: 64)
        ground.setFill()
        NSBezierPath(roundedRect: cell, xRadius: 10, yRadius: 10).fill()
        let tinted = icon.isTemplate ? tint(icon, ground == .white ? .black : .white) : icon
        tinted.draw(in: cell.insetBy(dx: 5, dy: 5))
    }
    label("Codex callout — threads titled from Codex's state DB", 470, H - 470)
    place(calloutCodex, 470, 500)
    label("Rate limited — last value kept, dimmed", 470, H - 1000)
    place(trayStale, 470, 1030)
    canvas.unlockFocus()

    guard let tiff = canvas.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        FileHandle.standardError.write("render failed\n".data(using: .utf8)!)
        exit(1)
    }
    let path = (dir as NSString).appendingPathComponent("tokenvision-preview.png")
    try? png.write(to: URL(fileURLWithPath: path))
    print(path)
}

if let idx = CommandLine.arguments.firstIndex(of: "--render") {
    let dir = CommandLine.arguments[safe: idx + 1] ?? NSTemporaryDirectory()
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    renderArtboards(to: dir)
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
