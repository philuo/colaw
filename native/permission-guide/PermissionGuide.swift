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
// The bar is HIDDEN until the System Settings window exists, then anchored
// 12pt under it: the guide is the answer to the pane, so it must not precede
// it. Only the discovery deadline (Settings never showed) falls back to a
// floating position, so the draggable icon is never simply missing.
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
    /// Give up finding Settings after this long and fall back to the top of
    /// the screen, so a missing/renamed Settings process still leaves the user
    /// with a draggable icon rather than no guidance at all.
    let discoveryDeadline: TimeInterval = 12
    /// How long to keep following Settings once the bar is up.
    let followDeadline: TimeInterval = 180

    init(config: Configuration) {
        self.config = config
    }

    func applicationDidFinishLaunching(_: Notification) {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 372, height: 72),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],
            backing: .buffered,
            defer: false,
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
        let hint = NSTextField(labelWithString: "松手即完成授权，无需其他操作")
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
                height: size.height,
            ),
            display: false,
        )
    }

    /**
     * Show the bar under the System Settings window and keep it there.
     *
     * Settings opens asynchronously after this helper, so poll the on-screen
     * window list: the first frame that carries it is both the moment to put
     * the bar on screen and the anchor to sit 12pt below. After that the poll
     * only re-anchors as Settings moves, and retires the bar with it.
     */
    private func followSystemSettings() {
        positioningTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] timer in
            guard let self, let panel = self.panel else { return timer.invalidate() }
            let elapsed = Date().timeIntervalSince(self.startedAt)
            if let anchor = Self.systemSettingsFrame() {
                self.anchored = true
                let size = panel.frame.size
                let margin: CGFloat = 12
                let origin = NSPoint(x: anchor.midX - size.width / 2, y: anchor.minY - size.height - margin)
                if !self.shown {
                    panel.setFrameOrigin(origin)
                    panel.orderFrontRegardless()
                    self.shown = true
                } else if panel.frame.origin != origin {
                    panel.setFrameOrigin(origin)
                }
                if elapsed > self.followDeadline { timer.invalidate() }
                return
            }
            if self.anchored {
                // Settings closed: retire with it.
                timer.invalidate()
                NSApplication.shared.terminate(nil)
                return
            }
            if !self.shown && elapsed > self.discoveryDeadline {
                // No Settings window to anchor under. Fall back to the top of
                // the screen so the draggable icon still exists, and keep
                // polling in case the pane is simply slow to open.
                self.positionFallback(panel)
                panel.orderFrontRegardless()
                self.shown = true
            }
            if elapsed > self.followDeadline { timer.invalidate() }
        }
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
                height: quartz.height,
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
