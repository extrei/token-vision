// Token Vision — a macOS menu-bar widget showing plan-limit usage.
//
// A status-bar button (Claude starburst) toggles a black tray that slides out
// horizontally beneath the menu bar with one ring gauge per agent: Claude and
// Codex. The ring shows the most-used limit window; hovering a ring opens a
// callout listing every window (session / weekly) with a bar, percent used,
// and the reset time. Right-click the button to quit. Data comes from
// `node src/live-usage.js --stream` (NDJSON). Build with widget/build.sh.

import AppKit
import Combine
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
    if let epoch = num(value) { return Date(timeIntervalSince1970: epoch) }
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

enum Agent: String {
    case claude, codex
    var title: String { self == .claude ? "Claude Usage" : "Codex Usage" }
}

struct Ring: Identifiable {
    let agent: Agent
    let windows: [LimitWindow]
    let note: String?
    var id: String { agent.rawValue }
    var percent: Int? { windows.map(\.usedPercent).max() }
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
            rings.append(Ring(agent: .claude, windows: windows,
                              note: windows.isEmpty ? "limits unavailable" : nil))
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
            rings.append(Ring(agent: .codex, windows: windows, note: note))
        }
    }
}

final class Model: ObservableObject {
    @Published var snapshot: Snapshot?
    @Published var hovered: Int?
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

/// Codex (OpenAI) pinwheel: six rounded bars rotated in 60° steps.
struct CodexMark: View {
    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            ZStack {
                ForEach(0..<6, id: \.self) { i in
                    Capsule()
                        .stroke(Color.white, lineWidth: s * 0.1)
                        .frame(width: s * 0.26, height: s * 0.62)
                        .offset(y: -s * 0.14)
                        .rotationEffect(.degrees(Double(i) * 60))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
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
                }
                AgentMark(agent: ring.agent)
                    .frame(width: Layout.ringSize * 0.42, height: Layout.ringSize * 0.42)
            }
            .frame(width: Layout.ringSize, height: Layout.ringSize)
            Text(pct.map { "\($0)%" } ?? "—")
                .font(.system(size: 15, weight: .medium, design: .rounded).monospacedDigit())
                .foregroundStyle(.white)
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
        let stride = Layout.ringSize + Layout.columnGap
        let offset = p.x - Layout.shoulder - Layout.padSide
        guard offset >= 0, offset.truncatingRemainder(dividingBy: stride) < Layout.ringSize else {
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

    var body: some View {
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
            }
            .padding(16)
            .frame(width: Layout.calloutWidth, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.black))
        }
        .fixedSize()
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

// MARK: - Status-bar icon

/// Claude starburst as a template image for the status item.
func statusIcon() -> NSImage {
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
        NSColor.black.setStroke()
        path.stroke()
        return true
    }
    image.isTemplate = true
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
    var slideTimer: Timer?
    var expanded = false
    var outsideClickMonitor: Any?
    var proc: Process?
    var buffer = Data()
    var quitting = false
    var subs: [AnyCancellable] = []

    static let slideDuration: TimeInterval = 0.22

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

        let host = TrayHostView(rootView: TrayView(model: model))
        host.onHover = { [weak self] column in
            guard let self, self.model.hovered != column else { return }
            self.model.hovered = column
        }
        // The tray slides out by animating the window's width; the content keeps
        // its full size pinned to the right edge so it is revealed, not squashed.
        trayContainer.addSubview(host)
        trayHost = host
        tray.contentView = trayContainer
        tray.hasShadow = true
        callout.hasShadow = true

        model.$snapshot
            .map { $0?.rings.count ?? 0 }
            .removeDuplicates()
            .sink { [weak self] columns in self?.layoutTray(columns: max(columns, 1), animated: false) }
            .store(in: &subs)
        model.$hovered
            .combineLatest(model.$snapshot)
            .sink { [weak self] hovered, snapshot in self?.updateCallout(hovered, snapshot) }
            .store(in: &subs)
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.layoutTray(columns: max(self.model.snapshot?.rings.count ?? 0, 1), animated: false)
        }
        launchStreamer()
    }

    var columns: Int { max(model.snapshot?.rings.count ?? 0, 1) }

    /// Full tray frame: hanging from the menu bar, right edge under the status button.
    func trayFrame(columns: Int) -> NSRect {
        let size = NSSize(width: Layout.trayWidth(columns: columns), height: Layout.trayHeight)
        guard let button = item.button, let window = button.window else { return NSRect(origin: .zero, size: size) }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        return NSRect(x: anchor.maxX - size.width, y: anchor.minY - size.height,
                      width: size.width, height: size.height)
    }

    /// Resize the window to a partial width and keep the content flush right.
    func applyTrayWidth(_ width: CGFloat, full: NSRect) {
        let w = max(width, 0)
        tray.setFrame(NSRect(x: full.maxX - w, y: full.minY, width: w, height: full.height), display: true)
        trayHost?.frame = NSRect(x: w - full.width, y: 0, width: full.width, height: full.height)
    }

    /// Size the content for `columns` and resize the window to the expanded or
    /// collapsed (zero-width, right-anchored) frame.
    func layoutTray(columns: Int, animated: Bool) {
        slideTimer?.invalidate()
        let full = trayFrame(columns: columns)
        let target: CGFloat = expanded ? full.width : 0
        guard animated else {
            applyTrayWidth(target, full: full)
            updateCallout(model.hovered, model.snapshot)
            return
        }
        let start = tray.frame.width
        let t0 = Date()
        slideTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            let t = min(Date().timeIntervalSince(t0) / Self.slideDuration, 1)
            let eased = 1 - pow(1 - t, 3)
            self.applyTrayWidth(start + (target - start) * eased, full: full)
            if t >= 1 {
                timer.invalidate()
                self.slideTimer = nil
                if !self.expanded { self.tray.orderOut(nil) }
                self.updateCallout(self.model.hovered, self.model.snapshot)
            }
        }
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
        item.button?.highlight(value)
        if value {
            if !tray.isVisible { applyTrayWidth(0, full: trayFrame(columns: columns)) }
            tray.orderFrontRegardless()
            outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
                [weak self] _ in self?.setExpanded(false)
            }
        } else {
            model.hovered = nil
            if let outsideClickMonitor { NSEvent.removeMonitor(outsideClickMonitor) }
            outsideClickMonitor = nil
        }
        layoutTray(columns: columns, animated: true)
    }

    func updateCallout(_ hovered: Int?, _ snapshot: Snapshot?) {
        guard expanded, let hovered, let ring = snapshot?.rings[safe: hovered] else {
            callout.orderOut(nil)
            return
        }
        let host = NSHostingView(rootView: CalloutView(ring: ring))
        let size = host.fittingSize
        let full = trayFrame(columns: columns)
        let ringX = full.minX + Layout.ringCenterX(hovered)
        var x = ringX - size.width / 2
        if let screen = item.button?.window?.screen ?? NSScreen.screens.first {
            x = min(x, screen.visibleFrame.maxX - size.width)
            x = max(x, screen.visibleFrame.minX)
        }
        host.rootView.pointerOffset = ringX - (x + size.width / 2)
        callout.contentView = host
        callout.setFrame(NSRect(x: x, y: full.minY - size.height + 4, width: size.width, height: size.height),
                         display: true)
        callout.orderFrontRegardless()
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
            DispatchQueue.main.async { self.model.snapshot = Snapshot(dict: dict) }
        }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
