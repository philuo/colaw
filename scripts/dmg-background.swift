import AppKit
let out = CommandLine.arguments[1]
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2560, pixelsHigh: 1600, bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: 1280, height: 800)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor(calibratedWhite: 0.958, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: 1280, height: 800)).fill()
let ink = NSColor(calibratedWhite: 0.1, alpha: 0.05)
func bubble(_ r: NSRect) { NSBezierPath(roundedRect: r, xRadius: 22, yRadius: 22).stroke(); let p = NSBezierPath(); p.move(to: NSPoint(x: r.minX+26, y: r.minY)); p.line(to: NSPoint(x: r.minX+18, y: r.minY-20)); p.line(to: NSPoint(x: r.minX+44, y: r.minY)); p.close(); p.fill() }
func plusCircle(_ r: NSRect) { NSBezierPath(ovalIn: r).stroke(); let l = NSBezierPath(); l.move(to: NSPoint(x: r.midX-16, y: r.midY)); l.line(to: NSPoint(x: r.midX+16, y: r.midY)); l.move(to: NSPoint(x: r.midX, y: r.midY-16)); l.line(to: NSPoint(x: r.midX, y: r.midY+16)); l.stroke() }
func magnifier(_ r: NSRect) { NSBezierPath(ovalIn: NSRect(x: r.minX, y: r.minY+18, width: 52, height: 52)).stroke(); let l = NSBezierPath(); l.move(to: NSPoint(x: r.minX+46, y: r.minY+14)); l.line(to: NSPoint(x: r.minX+66, y: r.minY-6)); l.lineWidth = 8; l.stroke() }
func terminal(_ r: NSRect) { NSBezierPath(roundedRect: r, xRadius: 14, yRadius: 14).stroke(); let l = NSBezierPath(); l.move(to: NSPoint(x: r.minX+18, y: r.maxY-34)); l.line(to: NSPoint(x: r.minX+34, y: r.maxY-48)); l.line(to: NSPoint(x: r.minX+18, y: r.maxY-62)); l.move(to: NSPoint(x: r.minX+42, y: r.maxY-62)); l.line(to: NSPoint(x: r.minX+66, y: r.maxY-62)); l.stroke() }
func check(_ r: NSRect) { NSBezierPath(ovalIn: r).stroke(); let l = NSBezierPath(); l.move(to: NSPoint(x: r.minX+20, y: r.midY)); l.line(to: NSPoint(x: r.midX, y: r.minY+20)); l.line(to: NSPoint(x: r.maxX-16, y: r.maxY-24)); l.lineWidth = 9; l.stroke() }
func doc(_ r: NSRect) { let p = NSBezierPath(); p.move(to: NSPoint(x: r.minX, y: r.minY)); p.line(to: NSPoint(x: r.minX, y: r.maxY)); p.line(to: NSPoint(x: r.maxX-24, y: r.maxY)); p.line(to: NSPoint(x: r.maxX, y: r.maxY-24)); p.line(to: NSPoint(x: r.maxX, y: r.minY)); p.close(); p.stroke(); for i in 0..<3 { let l = NSBezierPath(); l.move(to: NSPoint(x: r.minX+16, y: r.minY+26+CGFloat(i)*20)); l.line(to: NSPoint(x: r.maxX-16, y: r.minY+26+CGFloat(i)*20)); l.stroke() } }
func robot(_ r: NSRect) { NSBezierPath(roundedRect: NSRect(x: r.minX, y: r.minY, width: r.width, height: r.height-16), xRadius: 16, yRadius: 16).stroke(); let a = NSBezierPath(); a.move(to: NSPoint(x: r.midX, y: r.maxY-16)); a.line(to: NSPoint(x: r.midX, y: r.maxY)); a.stroke(); let e = NSBezierPath(); e.move(to: NSPoint(x: r.minX+20, y: r.maxY-46)); e.line(to: NSPoint(x: r.minX+34, y: r.maxY-46)); e.move(to: NSPoint(x: r.maxX-34, y: r.maxY-46)); e.line(to: NSPoint(x: r.maxX-20, y: r.maxY-46)); e.lineWidth = 7; e.stroke() }
let shapes: [(Double, Double, Double, (NSRect) -> Void)] = [
  (60, 560, -0.25, bubble), (230, 640, 0.15, plusCircle), (90, 120, 0.2, doc), (300, 40, -0.1, magnifier),
  (520, 690, 0.1, terminal), (1050, 60, 0.18, check), (1130, 620, -0.15, robot), (890, 700, 0.1, magnifier),
  (1180, 320, 0.22, bubble), (40, 360, 0.12, plusCircle), (420, 720, -0.18, doc), (620, 40, 0.15, robot),
]
for (x, y, rot, draw) in shapes {
  NSGraphicsContext.current?.cgContext.saveGState()
  NSGraphicsContext.current?.cgContext.translateBy(x: CGFloat(x)+45, y: CGFloat(y)+45)
  NSGraphicsContext.current?.cgContext.rotate(by: CGFloat(rot))
  NSGraphicsContext.current?.cgContext.translateBy(x: -45, y: -45)
  ink.setStroke(); ink.setFill()
  draw(NSRect(x: CGFloat(x), y: CGFloat(y), width: 90, height: 90))
  NSGraphicsContext.current?.cgContext.restoreGState()
}
let title = NSAttributedString(string: "COLAW", attributes: [
  .font: NSFont.systemFont(ofSize: 132, weight: .bold),
  .foregroundColor: NSColor(calibratedWhite: 0.17, alpha: 1),
  .kern: 10,
])
let ts = title.size()
title.draw(at: NSPoint(x: (1280-ts.width)/2, y: 470))
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 445, y: 275))
arrow.curve(to: NSPoint(x: 838, y: 275), controlPoint1: NSPoint(x: 560, y: 225), controlPoint2: NSPoint(x: 730, y: 225))
arrow.lineWidth = 14; arrow.lineCapStyle = .round; NSColor(calibratedWhite: 0.42, alpha: 1).setStroke(); arrow.stroke()
let head = NSBezierPath()
head.move(to: NSPoint(x: 838, y: 315)); head.line(to: NSPoint(x: 872, y: 276)); head.line(to: NSPoint(x: 822, y: 254)); head.close()
NSColor(calibratedWhite: 0.42, alpha: 1).setFill(); head.fill()
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("bg written")
