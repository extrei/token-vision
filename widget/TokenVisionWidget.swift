// Token Vision — a macOS menu-bar widget showing live token usage.
//
// The status item shows live Claude tokens/min; clicking it opens a 498x198
// SwiftUI panel with both agents side by side: hero numbers, 14-day
// sparklines, and plan-limit gauges with reset times. Right-click the status
// item to quit. Data comes from `node src/live-usage.js --stream` (NDJSON).
// Build with widget/build.sh.

import AppKit
import SwiftUI

// MARK: - Formatting helpers

func compact(_ n: Double) -> String {
    let abs = Swift.abs(n)
    if abs >= 1e9 { return String(format: "%.2fB", n / 1e9) }
    if abs >= 1e6 { return String(format: "%.1fM", n / 1e6) }
    if abs >= 1e3 { return String(format: "%.0fK", n / 1e3) }
    return String(format: "%.0f", n)
}

func num(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    return nil
}

func resetLabel(_ epoch: Double) -> String {
    let d = Date(timeIntervalSince1970: epoch)
    let f = DateFormatter()
    f.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "MMM d"
    return f.string(from: d)
}

func resetLabelAny(_ value: Any?) -> String? {
    if let epoch = num(value) { return resetLabel(epoch) }
    if let iso = value as? String, let d = ISO8601DateFormatter().date(from: iso) {
        return resetLabel(d.timeIntervalSince1970)
    }
    return nil
}

// MARK: - Palette (dataviz reference palette, light/dark selected per mode)

func dynamicColor(light: UInt32, dark: UInt32) -> Color {
    func nsColor(_ v: UInt32) -> NSColor {
        NSColor(
            srgbRed: CGFloat((v >> 16) & 0xFF) / 255,
            green: CGFloat((v >> 8) & 0xFF) / 255,
            blue: CGFloat(v & 0xFF) / 255,
            alpha: 1
        )
    }
    return Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? nsColor(dark) : nsColor(light)
    })
}

enum Palette {
    static let claude = dynamicColor(light: 0x2A78D6, dark: 0x3987E5) // categorical slot 1
    static let codex = dynamicColor(light: 0xEB6834, dark: 0xD95926) // categorical slot 2
    static let warning = dynamicColor(light: 0xFAB219, dark: 0xFAB219)
    static let critical = dynamicColor(light: 0xD03B3B, dark: 0xD03B3B)
}

// MARK: - Snapshot model

struct LimitWindow: Identifiable {
    let id: String
    let name: String
    let usedPercent: Int
    let reset: String?
}

struct AgentData {
    var hero: String
    var heroUnit: String
    var subline: String
    var daily: [Double]
    var limits: [LimitWindow]
    var note: String?
}

struct Snapshot {
    var claude: AgentData?
    var codex: AgentData?

    init(dict: [String: Any]) {
        if let c = dict["claude"] as? [String: Any] {
            let rate = num(c["perMinute"]) ?? 0
            var limits: [LimitWindow] = []
            for (i, w) in ((c["limits"] as? [[String: Any]]) ?? []).enumerated() {
                limits.append(LimitWindow(
                    id: "\(i)-\(w["name"] as? String ?? "")",
                    name: w["name"] as? String ?? "limit",
                    usedPercent: Int(num(w["usedPercent"]) ?? 0),
                    reset: resetLabelAny(w["resetsAt"])
                ))
            }
            claude = AgentData(
                hero: rate > 0 ? compact(rate) : "idle",
                heroUnit: rate > 0 ? "tok/min" : "",
                subline: "today \(compact(num(c["today"]) ?? 0)) · lifetime \(compact(num(c["lifetime"]) ?? 0))",
                daily: (c["daily"] as? [Any])?.compactMap(num) ?? [],
                limits: limits,
                note: nil
            )
        }
        if let x = dict["codex"] as? [String: Any] {
            if x["pending"] != nil {
                codex = AgentData(hero: "…", heroUnit: "", subline: "waiting for first poll",
                                  daily: [], limits: [], note: nil)
            } else if let error = x["error"] as? String {
                codex = AgentData(hero: "—", heroUnit: "", subline: "",
                                  daily: [], limits: [], note: error)
            } else {
                let estimate = (x["todayEstimated"] as? Bool) == true ? "~" : ""
                var limits: [LimitWindow] = []
                if let used = num(x["usedPercent"]) {
                    limits.append(LimitWindow(
                        id: "codex-limit",
                        name: "\(x["planType"] as? String ?? "plan") limit",
                        usedPercent: Int(used),
                        reset: resetLabelAny(x["resetsAt"])
                    ))
                }
                codex = AgentData(
                    hero: estimate + compact(num(x["today"]) ?? 0),
                    heroUnit: "today",
                    subline: "lifetime \(compact(num(x["lifetime"]) ?? 0))",
                    daily: (x["daily"] as? [Any])?.compactMap(num) ?? [],
                    limits: limits,
                    note: nil
                )
            }
        }
    }

    var claudeRateSuffix: String {
        guard let maxUsed = claude?.limits.map(\.usedPercent).max(), maxUsed >= 60 else { return "" }
        return " · C \(maxUsed)%"
    }
    var codexSuffix: String {
        guard let used = codex?.limits.first?.usedPercent, used >= 60 else { return "" }
        return " · X \(used)%"
    }
}

final class Model: ObservableObject {
    @Published var snapshot: Snapshot?
}

// MARK: - Views

struct SparklineView: View {
    let values: [Double]
    let color: Color

    var body: some View {
        GeometryReader { geo in
            let maxV = max(values.max() ?? 0, 1)
            let w = geo.size.width
            let h = geo.size.height - 3
            let step = values.count > 1 ? w / CGFloat(values.count - 1) : w
            let pts = values.enumerated().map { i, v in
                CGPoint(x: CGFloat(i) * step, y: 1.5 + h * (1 - CGFloat(v / maxV)))
            }
            if pts.count > 1 {
                Path { p in
                    p.move(to: CGPoint(x: pts[0].x, y: geo.size.height))
                    for pt in pts { p.addLine(to: pt) }
                    p.addLine(to: CGPoint(x: pts[pts.count - 1].x, y: geo.size.height))
                    p.closeSubpath()
                }
                .fill(color.opacity(0.1))
                Path { p in
                    p.move(to: pts[0])
                    for pt in pts.dropFirst() { p.addLine(to: pt) }
                }
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
        }
    }
}

struct GaugeRow: View {
    let limit: LimitWindow
    let accent: Color

    var fill: Color {
        limit.usedPercent >= 85 ? Palette.critical : limit.usedPercent >= 60 ? Palette.warning : accent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(limit.name)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let reset = limit.reset {
                    Text("resets \(reset)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Text("\(limit.usedPercent)%")
                    .font(.caption2.weight(.medium).monospacedDigit())
                    .foregroundStyle(.primary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(fill.opacity(0.18))
                    Capsule()
                        .fill(fill)
                        .frame(width: max(5, geo.size.width * CGFloat(limit.usedPercent) / 100))
                }
            }
            .frame(height: 5)
        }
    }
}

struct AgentColumn: View {
    let title: String
    let data: AgentData?
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Circle().fill(accent).frame(width: 7, height: 7)
                Text(title)
                    .font(.caption2.weight(.semibold))
                    .kerning(0.8)
                    .foregroundStyle(.secondary)
            }
            if let data {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(data.hero)
                        .font(.system(size: 24, weight: .semibold, design: .rounded))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    if !data.heroUnit.isEmpty {
                        Text(data.heroUnit)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if let note = data.note {
                    Text(note)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                    Spacer()
                } else {
                    SparklineView(values: data.daily, color: accent)
                        .frame(height: 26)
                    Text(data.subline)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    ForEach(data.limits.prefix(2)) { limit in
                        GaugeRow(limit: limit, accent: accent)
                    }
                }
            } else {
                Text("waiting for data…")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct WidgetView: View {
    @ObservedObject var model: Model

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentColumn(title: "CLAUDE", data: model.snapshot?.claude, accent: Palette.claude)
            Divider()
            AgentColumn(title: "CODEX", data: model.snapshot?.codex, accent: Palette.codex)
        }
        .padding(12)
        .frame(width: 498, height: 198)
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let model = Model()
    let popover = NSPopover()
    var proc: Process?
    var buffer = Data()
    var quitting = false

    let scriptPath: String = {
        if CommandLine.arguments.count > 1 { return CommandLine.arguments[1] }
        let bin = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        return bin.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("src/live-usage.js").path
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        setTitle("⌁ …")
        popover.contentSize = NSSize(width: 498, height: 198)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: WidgetView(model: model))
        if let button = item.button {
            button.action = #selector(statusClicked)
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        launchStreamer()
    }

    @objc func statusClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(NSMenuItem(title: "Quit Token Vision", action: #selector(quit), keyEquivalent: "q"))
            item.menu = menu
            item.button?.performClick(nil)
            item.menu = nil
        } else if popover.isShown {
            popover.performClose(nil)
        } else if let button = item.button {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
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

    func setTitle(_ text: String) {
        guard let button = item.button else { return }
        button.attributedTitle = NSAttributedString(
            string: text,
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)]
        )
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
            DispatchQueue.main.async { self.setTitle("⌁ ✖") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.launchStreamer() }
        }
        do {
            try p.run()
            proc = p
        } catch {
            setTitle("⌁ no node")
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
            DispatchQueue.main.async { self.apply(Snapshot(dict: dict)) }
        }
    }

    func apply(_ snapshot: Snapshot) {
        model.snapshot = snapshot
        var title = "⌁ —"
        if let claude = snapshot.claude {
            title = claude.heroUnit.isEmpty ? "⌁ \(claude.hero)" : "⌁ \(claude.hero)/m"
        }
        title += snapshot.claudeRateSuffix + snapshot.codexSuffix
        setTitle(title)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
