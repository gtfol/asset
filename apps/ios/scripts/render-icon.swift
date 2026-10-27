import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
// Refined Layers mark, shared geometrically with public/icon.svg and AssetMark.
// Keep the canvas opaque and square; iOS applies its own corner mask.
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
func rgb(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> CGColor {
  CGColor(colorSpace: colorSpace, components: [red / 255, green / 255, blue / 255, 1])!
}
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 4096,
  space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.translateBy(x: 0, y: 1024); context.scaleBy(x: 4, y: -4)
let colors = [
  rgb(57, 137, 244), rgb(34, 101, 213)
]
let gradient = CGGradient(colorsSpace: colorSpace,
                          colors: colors as CFArray, locations: [0, 1])!
context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 256, y: 256), options: [])
context.translateBy(x: 128, y: 128)
context.scaleBy(x: 1.08, y: 1.08)
context.translateBy(x: -128, y: -126)
context.setFillColor(rgb(255, 255, 255))
context.move(to: CGPoint(x: 124.6575, y: 81.3370))
context.addArc(tangent1End: CGPoint(x: 128, y: 80), tangent2End: CGPoint(x: 208, y: 112), radius: 9)
context.addArc(tangent1End: CGPoint(x: 208, y: 112), tangent2End: CGPoint(x: 128, y: 144), radius: 9)
context.addArc(tangent1End: CGPoint(x: 128, y: 144), tangent2End: CGPoint(x: 48, y: 112), radius: 9)
context.addArc(tangent1End: CGPoint(x: 48, y: 112), tangent2End: CGPoint(x: 128, y: 80), radius: 9)
context.closePath(); context.fillPath()
context.setLineCap(.round); context.setLineJoin(.round)
context.setStrokeColor(rgb(199, 239, 255)); context.setLineWidth(11)
context.move(to: CGPoint(x: 68, y: 144)); context.addLine(to: CGPoint(x: 122, y: 165.6))
context.addQuadCurve(to: CGPoint(x: 134, y: 165.6), control: CGPoint(x: 128, y: 168))
context.addLine(to: CGPoint(x: 188, y: 144)); context.strokePath()
let target = root.appendingPathComponent("Asset/Assets.xcassets/AppIcon.appiconset")
try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
let destination = CGImageDestinationCreateWithURL(
  target.appendingPathComponent("Icon.png") as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
try
  "{\"images\":[{\"filename\":\"Icon.png\",\"idiom\":\"universal\",\"platform\":\"ios\",\"size\":\"1024x1024\"}],\"info\":{\"author\":\"xcode\",\"version\":1}}"
  .write(to: target.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
