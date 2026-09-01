// Token Vision — a macOS notch widget showing plan-limit usage.
//
// A black pill hangs from the notch (or the top-right corner on notch-less
// displays) with one ring gauge per agent: Claude and Codex. The ring shows
// the most-used limit window; hovering a ring opens a callout listing every
// window (session / weekly) with a bar, percent used, and the reset time.
// Right-click the pill to quit. Data comes from
// `node src/live-usage.js --stream` (NDJSON). Build with widget/build.sh.

import AppKit
import Combine
import SwiftUI

// MARK: - Layout constants

enum Layout {
    static let pillWidth: CGFloat = 84
    static let shoulder: CGFloat = 14 // concave flare where the pill meets the notch
    static let cornerRadius: CGFloat = 26
    static let ringSize: CGFloat = 50
    static let ringStroke: CGFloat = 5
    static let labelHeight: CGFloat = 18
    static let ringLabelGap: CGFloat = 6
    static let rowGap: CGFloat = 20
    static let padTop: CGFloat = 20
    static let padBottom: CGFloat = 22
    static let calloutWidth: CGFloat = 300
    static let calloutPointer: CGFloat = 12

    static var rowHeight: CGFloat { ringSize + ringLabelGap + labelHeight }
    static func pillHeight(rows: Int) -> CGFloat {
        padTop + CGFloat(rows) * rowHeight + CGFloat(max(rows - 1, 0)) * rowGap + padBottom
    }
    /// Distance from the pill's top edge to the center of ring `i`.
    static func ringCenterY(_ i: Int) -> CGFloat {
        padTop + CGFloat(i) * (rowHeight + rowGap) + ringSize / 2
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
        .frame(height: Layout.rowHeight)
    }
}

/// Pill body: straight top edge with concave shoulders, rounded bottom corners.
struct PillShape: Shape {
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

struct PillView: View {
    @ObservedObject var model: Model
    let quit: () -> Void

    var body: some View {
        let rings = model.snapshot?.rings ?? []
        VStack(spacing: Layout.rowGap) {
            if rings.isEmpty {
                ProgressView().controlSize(.small).tint(.white)
                    .frame(height: Layout.rowHeight)
            }
            ForEach(rings) { RingView(ring: $0) }
        }
        .padding(.top, Layout.padTop)
        .padding(.bottom, Layout.padBottom)
        .frame(width: Layout.pillWidth)
        .background(PillShape().fill(Color.black))
        .contextMenu {
            Button("Quit Token Vision", action: quit)
        }
    }
}

/// Hosts the pill and tracks which ring row the pointer is over. SwiftUI's
/// `onHover` only fires in the active app, and this accessory app never is,
/// so an always-active tracking area does the work instead.
final class PillHostView<Content: View>: NSHostingView<Content> {
    var onHover: ((Int?) -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let fromTop = isFlipped ? p.y : bounds.height - p.y
        let stride = Layout.rowHeight + Layout.rowGap
        let offset = fromTop - Layout.padTop
        guard offset >= 0, offset.truncatingRemainder(dividingBy: stride) < Layout.rowHeight else {
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

struct CalloutPointer: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.midY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        p.closeSubpath()
        return p
    }
}

struct CalloutView: View {
    let ring: Ring
    /// Vertical shift of the pointer from the bubble's center (points at the ring
    /// even when the bubble had to be clamped onto the screen).
    var pointerOffset: CGFloat = 0

    var body: some View {
        HStack(spacing: 0) {
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
            CalloutPointer()
                .fill(Color.black)
                .frame(width: Layout.calloutPointer, height: 24)
                .offset(y: pointerOffset)
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

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = Model()
    let pill = OverlayPanel()
    let callout = OverlayPanel()
    var proc: Process?
    var buffer = Data()
    var quitting = false
    var subs: [AnyCancellable] = []

    let scriptPath: String = {
        if CommandLine.arguments.count > 1 { return CommandLine.arguments[1] }
        let bin = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        return bin.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("src/live-usage.js").path
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let host = PillHostView(rootView: PillView(model: model, quit: { [weak self] in self?.quit() }))
        host.onHover = { [weak self] row in
            guard let self, self.model.hovered != row else { return }
            self.model.hovered = row
        }
        pill.contentView = host
        pill.hasShadow = true
        callout.hasShadow = true
        placePill(rows: 1)
        pill.orderFrontRegardless()

        model.$snapshot
            .map { $0?.rings.count ?? 0 }
            .removeDuplicates()
            .sink { [weak self] rows in self?.placePill(rows: max(rows, 1)) }
            .store(in: &subs)
        model.$hovered
            .combineLatest(model.$snapshot)
            .sink { [weak self] hovered, snapshot in self?.updateCallout(hovered, snapshot) }
            .store(in: &subs)
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.placePill(rows: max(self.model.snapshot?.rings.count ?? 0, 1))
        }
        launchStreamer()
    }

    /// Pin the pill just below the menu bar, flush with the notch's right edge
    /// (or the top-right corner on displays without a notch).
    func placePill(rows: Int) {
        // screens[0] is the display that carries the menu bar (and the notch).
        guard let screen = NSScreen.screens.first else { return }
        let size = NSSize(width: Layout.pillWidth, height: Layout.pillHeight(rows: rows))
        let top = screen.visibleFrame.maxY
        let x: CGFloat
        if let notch = screen.auxiliaryTopRightArea, notch.minX > screen.frame.minX {
            x = notch.minX - Layout.shoulder
        } else {
            x = screen.frame.maxX - size.width - 12
        }
        pill.setFrame(NSRect(x: x, y: top - size.height, width: size.width, height: size.height), display: true)
        updateCallout(model.hovered, model.snapshot)
    }

    func updateCallout(_ hovered: Int?, _ snapshot: Snapshot?) {
        guard let hovered, let ring = snapshot?.rings[safe: hovered] else {
            callout.orderOut(nil)
            return
        }
        let host = NSHostingView(rootView: CalloutView(ring: ring))
        let size = host.fittingSize
        let ringY = pill.frame.maxY - Layout.ringCenterY(hovered)
        var y = ringY - size.height / 2
        if let screen = NSScreen.screens.first {
            y = min(y, screen.visibleFrame.maxY - size.height)
            y = max(y, screen.frame.minY)
        }
        // Window y grows upward, the view's offset grows downward.
        host.rootView.pointerOffset = (y + size.height / 2) - ringY
        callout.contentView = host
        callout.setFrame(NSRect(x: pill.frame.minX - size.width + 6, y: y,
                                width: size.width, height: size.height), display: true)
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
