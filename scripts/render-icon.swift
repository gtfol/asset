// Original lettermark rendered from the bundled OFL font; run from the repository root.
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
CTFontManagerRegisterFontsForURL(root.appendingPathComponent("public/fonts/Lato-Medium.ttf") as CFURL, .process, nil)
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 4096, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 62.0/255, green: 111.0/255, blue: 198.0/255, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
let font = CTFontCreateWithName("Lato-Medium" as CFString, 820, nil)
let string = NSAttributedString(string: "a", attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1)])
let line = CTLineCreateWithAttributedString(string)
let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
context.textPosition = CGPoint(x: (1024-bounds.width)/2-bounds.minX, y: (1024-bounds.height)/2-bounds.minY)
CTLineDraw(line, context)
let target = root.appendingPathComponent("ios/Asset/Assets.xcassets/AppIcon.appiconset")
try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
let destination = CGImageDestinationCreateWithURL(target.appendingPathComponent("Icon.png") as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
try "{\"images\":[{\"filename\":\"Icon.png\",\"idiom\":\"universal\",\"platform\":\"ios\",\"size\":\"1024x1024\"}],\"info\":{\"author\":\"xcode\",\"version\":1}}".write(to: target.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
