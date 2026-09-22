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
        registerForDraggedTypes([])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func mouseDown(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: appURL as NSURL)
        // The drag image is the icon itself, sized as displayed.
        let frame = bounds
        image?.size = frame.size
        beginDraggingSession(with: [item], event: event, source: self)
    }

    // MARK: - NSDraggingSource

    func draggingSession(_: NSDraggingSession, sourceOperationMaskFor _: NSDraggingContext) -> NSDragOperation {
        .copy
    }
}

final class GuideController: NSObject, NSApplicationDelegate {
    let config: Configuration

    init(config: Configuration) {
        self.config = config
    }

    func applicationDidFinishLaunching(_: Notification) {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 76),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],
            backing: .buffered,
            defer: false,
        )
        panel.title = ""
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
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

        let row = NSStackView(views: [icon, arrow, text])
        row.orientation = .horizontal
        row.spacing = 14
        row.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)

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

        panel.center()
        panel.orderFrontRegardless()
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
