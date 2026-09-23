// The Colaw permission guide: a small always-on-top floating bar carrying the
// app icon as a native drag source. The user drags the icon straight into the
// System Settings privacy list — the macOS-native grant gesture — without a
// Finder round trip.
//
// The helper owns no permissions itself: the pasteboard carries only the app
// bundle's file URL, and the host keeps responsibility for probing TCC and
// dismissing the guide (it terminates this process when the grant lands or
// the user dismisses).
//
// The panel is a STRONG property of the application delegate: a window held
// only by a local variable outlives its owner on screen and crashes the
// process on first interaction — exactly the click-kills-the-drag failure.
//
// The bar is HIDDEN until the System Settings window exists, then placed 12pt
// under it ONCE: the guide is the answer to the pane, so it must not precede
// it — and it is a landmark beside that pane, not a follower. Re-anchoring on
// every frame made the bar drift under a window the user was dragging and
// turned a static hint into moving furniture; the position is therefore taken
// from the first frame that carries Settings and then left alone. Only two
// things end the bar: the user closes it, or Settings goes away (the host also
// ends it the moment the grant lands). When Settings never shows up, the
// discovery deadline falls back to a fixed spot so the draggable icon is never
// simply missing.
//
// Usage: permission-guide <path-to-Colaw.app> <accessibility|screenRecording>

import AppKit
import Cocoa

struct Configuration {
    let appBundleURL: URL
    let pane: String

    static func parse() -> Configuration? {
        let args = CommandLine.arguments
        guard args.count >= 3 else { return nil }
        let bundle = URL(fileURLWithPath: args[1])
        let pane = args[2]
        guard pane == "accessibility" || pane == "screenRecording" else { return nil }
        return Configuration(appBundleURL: bundle, pane: pane)
    }

    var paneTitle: String {
        pane == "accessibility" ? "辅助功能" : "屏幕录制"
    }
}

/// The icon view that starts a file drag when the user pulls it.
final class DraggableIconView: NSImageView, NSDraggingSource {
    private let appURL: URL

    init(appURL: URL) {
        self.appURL = appURL
        super.init(frame: .zero)
        image = NSWorkspace.shared.icon(forFile: appURL.path)
        imageScaling = .scaleProportionallyUpOrDown
        isEditable = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func mouseDown(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: appURL as NSURL)
        item.draggingFrame = bounds
        beginDraggingSession(with: [item], event: event, source: self)
    }

    // MARK: - NSDraggingSource

    func draggingSession(_: NSDraggingSession, sourceOperationMaskFor _: NSDraggingContext) -> NSDragOperation {
        .copy
    }
}

final class GuideController: NSObject, NSApplicationDelegate {
    let config: Configuration
    /// Strong owner of the on-screen panel (see the file header).
    var panel: NSPanel?
    var positioningTimer: Timer?
    /// Whether the bar has been put on screen yet. The bar stays hidden until
    /// the System Settings window exists: showing it first (at a fallback
    /// position) put the guide ahead of the pane it points into.
    var shown = false
    /// Whether Settings was seen at least once. Only then does the bar retire
    /// with it — a bar that fell back for lack of a Settings window must not
    /// conclude on the next tick that Settings has closed.
    var anchored = false
    /// When polling began, for the give-up deadline.
    let startedAt = Date()
    /// Give up finding Settings after this long and fall back to a fixed spot
    /// near the top of the screen, so a missing/renamed Settings process still
    /// leaves the user with a draggable icon rather than no guidance at all.
    let discoveryDeadline: TimeInterval = 12
    /// How long the bar may live, in total, however it got on screen. Long
    /// enough for a slow grant, short enough that a forgotten bar retires on
    /// its own rather than sitting over the desktop forever.
    let lifetimeDeadline: TimeInterval = 180
    /// Cadence of the presence check that decides when the bar retires. It
    /// never moves the panel — see `followSystemSettings`.
    let presenceInterval: TimeInterval = 0.5

    init(config: Configuration) {
        self.config = config
    }

    func applicationDidFinishLaunching(_: Notification) {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 372, height: 72),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = ""
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.backgroundColor = NSColor(white: 0.10, alpha: 0.92)
        panel.isOpaque = false
        panel.hasShadow = true

        let icon = DraggableIconView(appURL: config.appBundleURL)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.wantsLayer = true
        icon.layer?.cornerRadius = 8

        let arrow = NSTextField(labelWithAttributedString: NSAttributedString(string: "↑", attributes: [
            .font: NSFont.systemFont(ofSize: 22, weight: .semibold),
            .foregroundColor: NSColor.controlAccentColor,
        ]))

        let title = NSTextField(labelWithString: "把 Colaw 拖进「\(config.paneTitle)」列表")
        title.font = .systemFont(ofSize: 13, weight: .medium)
        title.textColor = .white
        // The bar grants the macOS permission and nothing more: the capability
        // switch in Colaw is the user's to flip, so the hint must not promise
        // that dragging finishes the job.
        let hint = NSTextField(labelWithString: "松手即完成授权，之后在 Colaw 中打开开关")
        hint.font = .systemFont(ofSize: 11)
        hint.textColor = NSColor.white.withAlphaComponent(0.6)

        let text = NSStackView(views: [title, hint])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2

        let close = NSButton(title: "✕", target: self, action: #selector(closeGuide))
        close.isBordered = false
        close.font = .systemFont(ofSize: 12)
        close.contentTintColor = NSColor.white.withAlphaComponent(0.5)

        let row = NSStackView(views: [icon, arrow, text, close])
        row.orientation = .horizontal
        row.spacing = 14
        row.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 12)

        let content = NSView()
        content.addSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = content
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 44),
            icon.heightAnchor.constraint(equalToConstant: 44),
            row.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            row.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor),
            row.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])

        self.panel = panel
        // Deliberately NOT ordered front here. The bar appears the moment the
        // System Settings window is on screen, anchored under it; showing it
        // first (at a fallback position) put the guide ahead of the pane it
        // points into, which reads as the wrong order.
        followSystemSettings()
    }

    /** Center the bar near the top of the main display. */
    private func positionFallback(_ panel: NSPanel) {
        guard let screen = NSScreen.main else { return }
        let frame = screen.frame
        let size = panel.frame.size
        panel.setFrame(
            NSRect(
                x: frame.midX - size.width / 2,
                y: frame.maxY - size.height - 72,
                width: size.width,
                height: size.height
            ),
            display: false
        )
    }

    /**
     * Put the bar on screen once, under the System Settings window, and hold
     * it there.
     *
     * Settings opens asynchronously after this helper, so the on-screen window
     * list is polled until the frame that carries it: that first frame is both
     * the moment to show the bar and the place to put it. After that the bar
     * is NOT moved again — it reads as a landmark beside the pane, and a bar
     * that chased a window the user was dragging read as moving furniture. The
     * poll only survives to answer one question: is the pane still on screen.
     * When Settings goes away the guide retires with it, because the thing it
     * was pointing into no longer exists.
     */
    private func followSystemSettings() {
        positioningTimer = Timer.scheduledTimer(withTimeInterval: presenceInterval, repeats: true) { [weak self] timer in
            guard let self, let panel = self.panel else { return timer.invalidate() }
            let elapsed = Date().timeIntervalSince(self.startedAt)
            let anchor = Self.systemSettingsFrame()
            if anchor != nil { self.anchored = true }
            if !self.shown {
                if let anchor {
                    self.place(panel, under: anchor)
                    panel.orderFrontRegardless()
                    self.shown = true
                } else if elapsed > self.discoveryDeadline {
                    // No Settings window to sit under. Fall back to a fixed
                    // spot so the draggable icon still exists; the presence
                    // check stays armed in case the pane is merely slow.
                    self.positionFallback(panel)
                    panel.orderFrontRegardless()
                    self.shown = true
                }
                if elapsed > self.lifetimeDeadline { timer.invalidate() }
                return
            }
            if self.anchored && anchor == nil {
                timer.invalidate()
                NSApplication.shared.terminate(nil)
                return
            }
            if elapsed > self.lifetimeDeadline { timer.invalidate() }
        }
    }

    /**
     * Place the bar 12pt below a System Settings window, kept on screen.
     *
     * Below is the natural side: the privacy list the user must drag into runs
     * down from the pane's title, so a bar above the window would cover the
     * very heading it refers to. A window sitting at the bottom of the display
     * has no room below it, and there the bar goes above instead of off screen;
     * everything is finally clamped into the visible frame, so a window that
     * covers the whole display still leaves a reachable icon.
     */
    private func place(_ panel: NSPanel, under anchor: NSRect) {
        let size = panel.frame.size
        let margin: CGFloat = 12
        var origin = NSPoint(x: anchor.midX - size.width / 2, y: anchor.minY - size.height - margin)
        // `screens.first` is the primary display, which is the origin every
        // AppKit frame here is already measured against.
        let primary = NSScreen.screens.first
        if let primary, origin.y < primary.frame.minY + margin { origin.y = anchor.maxY + margin }
        if let visible = (NSScreen.main ?? primary)?.visibleFrame {
            // max(_, lower) keeps the range sane on a display narrower or
            // shorter than the bar itself.
            origin.x = min(max(origin.x, visible.minX + margin), max(visible.minX + margin, visible.maxX - size.width - margin))
            origin.y = min(max(origin.y, visible.minY + margin), max(visible.minY + margin, visible.maxY - size.height - margin))
        }
        panel.setFrame(NSRect(origin: origin, size: size), display: false)
    }

    /**
     * The frontmost System Settings window, in AppKit coordinates, if on screen.
     *
     * `kCGWindowBounds` is Quartz (top-left origin, measured from the primary
     * display); AppKit puts the origin at the bottom left, so the flip uses the
     * primary screen's height rather than whatever `NSScreen.main` happens to
     * report for an accessory app.
     */
    private static func systemSettingsFrame() -> NSRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]]
        else { return nil }
        for window in list {
            let owner = window[kCGWindowOwnerName as String] as? String ?? ""
            guard owner.contains("System Settings") || owner.contains("系统设置") || owner.contains("System Preferences") else { continue }
            let layer = window[kCGWindowLayer as String] as? Int ?? 0
            guard layer == 0 else { continue }
            guard let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
                let quartz = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else { continue }
            // Skip transient chrome (the launch stub, tooltips): only the real
            // Settings window is wide enough to be worth anchoring under.
            guard quartz.width >= 400, quartz.height >= 300 else { continue }
            let primaryHeight = NSScreen.screens.first?.frame.height ?? NSScreen.main?.frame.height ?? quartz.maxY
            return NSRect(
                x: quartz.minX,
                y: primaryHeight - quartz.maxY,
                width: quartz.width,
                height: quartz.height
            )
        }
        return nil
    }

    @objc private func closeGuide() {
        NSApplication.shared.terminate(nil)
    }
}

let config = Configuration.parse() ?? {
    FileHandle.standardError.write("usage: permission-guide <Colaw.app> <accessibility|screenRecording>\n".data(using: .utf8)!)
    exit(64)
}()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = GuideController(config: config)
app.delegate = delegate
app.run()
