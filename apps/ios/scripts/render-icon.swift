import CoreGraphics
import CoreText
// Original lettermark rendered from the local bundled OFL font. Paths are relative to this script.
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
// Original open-arch A mark, shared geometrically with public/icon.svg.
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 4096,
  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 39.0/255, green: 116.0/255, blue: 220.0/255, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
context.translateBy(x: 0, y: 1024); context.scaleBy(x: 16, y: -16)
context.setLineCap(.round); context.setLineJoin(.round)
context.setStrokeColor(CGColor(gray: 1, alpha: 1)); context.setLineWidth(6)
context.move(to: CGPoint(x: 17, y: 46)); context.addLine(to: CGPoint(x: 28, y: 20))
context.addQuadCurve(to: CGPoint(x: 36, y: 20), control: CGPoint(x: 32, y: 11))
context.addLine(to: CGPoint(x: 47, y: 46)); context.strokePath()
context.setStrokeColor(CGColor(red: 185.0/255, green: 231.0/255, blue: 1, alpha: 1)); context.setLineWidth(5)
context.move(to: CGPoint(x: 23, y: 38)); context.addQuadCurve(to: CGPoint(x: 41, y: 32), control: CGPoint(x: 33, y: 43)); context.strokePath()
let target = root.appendingPathComponent("Asset/Assets.xcassets/AppIcon.appiconset")
try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
let destination = CGImageDestinationCreateWithURL(
  target.appendingPathComponent("Icon.png") as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
try
  "{\"images\":[{\"filename\":\"Icon.png\",\"idiom\":\"universal\",\"platform\":\"ios\",\"size\":\"1024x1024\"}],\"info\":{\"author\":\"xcode\",\"version\":1}}"
  .write(to: target.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
