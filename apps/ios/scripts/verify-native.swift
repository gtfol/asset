import Foundation
import JavaScriptCore

let args = CommandLine.arguments
if args.count != 4 {
  fatalError("Usage: swift scripts/verify-native.swift engine.js parity.js expected.json")
}
let context = JSContext()!
var exception: String?
context.exceptionHandler = { _, value in exception = value?.toString() }
context.evaluateScript(try String(contentsOfFile: args[1], encoding: .utf8))
let actual =
  context.evaluateScript(try String(contentsOfFile: args[2], encoding: .utf8))?.toString() ?? ""
if let exception { fatalError("JavaScriptCore: \(exception)") }
let actualObject = try JSONSerialization.jsonObject(with: Data(actual.utf8)) as! NSDictionary
let expectedObject =
  try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[3])))
  as! NSDictionary
if !actualObject.isEqual(to: expectedObject as! [AnyHashable: Any]) {
  fatalError("Native engine disagrees with the TypeScript engine")
}
print(
  "PASS: JavaScriptCore and Node agree on dashboard, cash flow, net worth, holdings, edit propagation, CSV preview, and full backup restoration."
)
