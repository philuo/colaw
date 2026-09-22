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
        positionFallback(panel)
        panel.orderFrontRegardless()
        followSystemSettings()
    }

    /** Center the bar near the top of the main display until Settings appears. */
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
     * Keep the bar directly under the System Settings window. Settings opens
     * asynchronously after this helper, so poll the on-screen window list for
     * a few seconds; once found (and whenever it moves), re-anchor below it.
     */
    private func followSystemSettings() {
        var found = false
        positioningTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self, let panel = self.panel else { return timer.invalidate() }
            if let anchor = Self.systemSettingsFrame() {
                found = true
                let size = panel.frame.size
                let margin: CGFloat = 12
                let x = anchor.midX - size.width / 2
                let y = anchor.minY - size.height - margin
                if panel.frame.origin != NSPoint(x: x, y: y) {
                    panel.setFrameOrigin(NSPoint(x: x, y: y))
                }
            } else if found {
                // Settings closed: retire with it.
                timer.invalidate()
                NSApplication.shared.terminate(nil)
            } else if timer.fireDate.timeIntervalSinceNow < -6 {
                timer.invalidate()
            }
        }
    }

    /** The frontmost System Settings window, in AppKit coordinates, if on screen. */
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
            guard let screen = NSScreen.main else { continue }
            // Quartz is top-left origin; AppKit is bottom-left.
            return NSRect(
                x: quartz.minX,
                y: screen.frame.maxY - quartz.maxY,
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
