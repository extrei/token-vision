// Token Vision — a small macOS menu-bar widget showing live token usage.
//
// It runs `node src/live-usage.js --stream` (the NDJSON snapshot mode) and
// mirrors each snapshot into the status bar: live Claude tokens/min in the
// title, details in the dropdown. Build with widget/build.sh; quit from the
// menu. No dock icon, no window — just the status item.

import AppKit

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

final class AppDelegate: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let claudeRate = NSMenuItem(title: "starting…", action: nil, keyEquivalent: "")
    let claudeTotals = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let codexTotals = NSMenuItem(title: "waiting for first poll…", action: nil, keyEquivalent: "")
    let codexLimit = NSMenuItem(title: "", action: nil, keyEquivalent: "")
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
        let menu = NSMenu()
        let claudeHeader = NSMenuItem(title: "Claude Code", action: nil, keyEquivalent: "")
        let codexHeader = NSMenuItem(title: "Codex", action: nil, keyEquivalent: "")
        for header in [claudeHeader, codexHeader] { header.isEnabled = false }
        for detail in [claudeRate, claudeTotals, codexTotals, codexLimit] { detail.isEnabled = false }
        menu.addItem(claudeHeader)
        menu.addItem(claudeRate)
        menu.addItem(claudeTotals)
        menu.addItem(.separator())
        menu.addItem(codexHeader)
        menu.addItem(codexTotals)
        menu.addItem(codexLimit)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Token Vision", action: #selector(quit), keyEquivalent: "q"))
        menu.autoenablesItems = false
        item.menu = menu
        launchStreamer()
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
                let snapshot = obj as? [String: Any]
            else { continue }
            DispatchQueue.main.async { self.apply(snapshot) }
        }
    }

    func apply(_ snapshot: [String: Any]) {
        var title = "⌁ —"
        if let claude = snapshot["claude"] as? [String: Any] {
            let rate = num(claude["perMinute"]) ?? 0
            title = rate > 0 ? "⌁ \(compact(rate))/m" : "⌁ idle"
            claudeRate.title = rate > 0
                ? "rate  \(compact(rate)) tok/min · \(compact(num(claude["perFiveMinutes"]) ?? 0)) in 5m"
                : "rate  idle"
            claudeTotals.title =
                "today \(compact(num(claude["today"]) ?? 0)) · lifetime \(compact(num(claude["lifetime"]) ?? 0))"
        }
        if let codex = snapshot["codex"] as? [String: Any] {
            if codex["pending"] != nil {
                codexTotals.title = "waiting for first poll…"
                codexLimit.title = ""
            } else if let error = codex["error"] as? String {
                codexTotals.title = "unavailable: \(error)"
                codexLimit.title = ""
            } else {
                codexTotals.title =
                    "today \(compact(num(codex["today"]) ?? 0)) · lifetime \(compact(num(codex["lifetime"]) ?? 0))"
                if let used = num(codex["usedPercent"]) {
                    let plan = codex["planType"] as? String ?? "plan"
                    var line = "\(plan) limit \(Int(used))%"
                    if let resetsAt = num(codex["resetsAt"]) { line += " · resets \(resetLabel(resetsAt))" }
                    codexLimit.title = line
                    if used >= 60 { title += " · \(Int(used))%" }
                }
            }
        }
        setTitle(title)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
