// Glint panel for macOS: the frosted-glass Glint window. It shows the same Claude Design page as the
// Windows panel (../panel/glint-panel.html) in a WKWebView, over macOS's own frosted glass.
//
//   ⌘Enter    In the Claude desktop app: check your draft. The result appears here while the cursor
//             stays in Claude's message box. Enter and Shift+Enter work as before.
//   Apply     Click a fix's Apply button: just that phrase changes in Claude. ⌘Z undoes it.
//   ⌥F        Put the whole fixed version into Claude's message box. Then press Enter.
//   ⌃⌥E       Anywhere: show or hide the panel, e.g. to ask about an English word or phrase.
//   Esc       Hide the panel.
//
// Build it with build.sh (needs the Xcode command line tools and Node.js). It needs Accessibility
// permission: it watches for ⌘Enter while Claude is in front, and presses ⌘A, ⌘C and ⌘V in Claude to
// read and change your message.
//
// Options: --hidden (start in the background), --theme light|dark.
// For development: --state file.json renders that state at start; --target <bundle ID> uses another
// app as Claude; --selftest sends each kind of page message through WebKit and logs what the panel
// did to panel.log (use it with a --target that isn't running, so nothing touches Claude).

import ApplicationServices
import Carbon
import Cocoa
import ServiceManagement
import WebKit

// ---------- settings ----------
let SHOW_KEY = (letter: Character("e"), modifiers: controlKey | optionKey)  // ⌃⌥E: show or hide the panel
let HIDE_AFTER_SEND = true          // hide a check result when you press Enter in Claude
let KEEP_WARM = true                // keep a Claude process ready so a check takes ~2 s (uses ~180 MB)
let EXTRA_TRANSPARENCY = 0.10       // make the glass more see-through than the design: 0.10 = 10% more, 0 = as designed
let CLAUDE_APP = argValue("--target") ?? "com.anthropic.claudefordesktop"  // the Claude desktop app
// ⌘Enter (check) and ⌥F (use fixed version) are in hotkey(for:) further down.

// The clone this app was built from: build.sh records it in Info.plist.
let ROOT: URL = {
  if let root = ProcessInfo.processInfo.environment["GLINT_ROOT"] { return URL(fileURLWithPath: root) }
  if let root = Bundle.main.object(forInfoDictionaryKey: "GlintRoot") as? String { return URL(fileURLWithPath: root) }
  var url = Bundle.main.bundleURL  // tools/glint/mac/build/Glint.app
  for _ in 0..<5 { url.deleteLastPathComponent() }
  return url
}()
let GLINT = ROOT.appendingPathComponent("plugins/glint/scripts/glint.mjs").path
let PANEL_DIR = ROOT.appendingPathComponent("tools/glint/panel")
let DATA_DIR: String = {
  if let home = ProcessInfo.processInfo.environment["GLINT_HOME"], !home.isEmpty { return home }
  return NSHomeDirectory() + "/.claude/glint"
}()
let FEEDBACK_FILE = DATA_DIR + "/window/feedback.txt"  // gate mode, a held-back prompt: pop up
let TIPS_FILE = DATA_DIR + "/window/tips.txt"          // gate mode, tips for a sent prompt: show only if open
let NATURAL_FILE = DATA_DIR + "/window/natural.txt"

// Bridges the page's WebView2 messages (window.chrome.webview.postMessage) to WebKit's.
let BRIDGE_JS = #"""
window.chrome = window.chrome || {};
window.chrome.webview = {
  postMessage: function (message) { window.webkit.messageHandlers.glint.postMessage(JSON.stringify(message)); }
};
"""#

// Added to the page by the host (the design's HTML stays as designed): the Mac font, square edges
// (the window rounds its own corners), Mac key names for the page's Windows ones, with keycaps as the
// page draws them, and no browser context menu.
let MAC_JS = #"""
(function () {
  var NAMES = [[/Ctrl\+Alt\+E/g, '⌃⌥E'], [/Alt\+Enter/g, '⌘Enter'], [/Alt\+F/g, '⌥F'], [/Ctrl\+Z/g, '⌘Z'], [/Ctrl\+V/g, '⌘V']];
  var CAPS = /(⌃⌥E|⌘Enter|⌥F)/;
  var SCOPE = '.hints, #useFix, #status, #result .p';
  function fixText(node) {
    var parent = node.parentNode;
    if (!parent || !parent.closest || !parent.closest(SCOPE)) return;
    var text = node.nodeValue, mac = text;
    NAMES.forEach(function (n) { mac = mac.replace(n[0], n[1]); });
    if (mac !== text) node.nodeValue = mac;
    if (parent.nodeName !== 'P' || !CAPS.test(mac)) return;
    var parts = document.createDocumentFragment();
    mac.split(CAPS).forEach(function (part, i) {
      if (!part) return;
      if (i % 2) {
        var cap = document.createElement('kbd');
        cap.className = 'k';
        cap.textContent = part;
        parts.appendChild(cap);
      } else parts.appendChild(document.createTextNode(part));
    });
    parent.replaceChild(parts, node);
  }
  function sweep(node) {
    if (node.nodeType === 3) return fixText(node);
    if (node.nodeType !== 1) return;
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(fixText);
  }
  function start() {
    var style = document.createElement('style');
    style.textContent = ':root { --font: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }\n'
      + '#panel { border: 0; border-radius: 0; }';
    document.head.appendChild(style);
    var close = document.getElementById('close');
    if (close) close.title = 'Hide (keeps running in the menu bar)';
    sweep(document.body);
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        if (r.type === 'characterData') sweep(r.target);
        else r.addedNodes.forEach(sweep);
      });
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
  }
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
"""#

// EXTRA_TRANSPARENCY: lowers the opacity of the page's glass tint (82% in the design's light mode,
// 84% in dark mode). Only in glass mode: the solid fallback stays solid.
func glassJs(_ amount: Double) -> String {
  if amount <= 0 { return "" }
  let css = "@supports (color: rgb(from red r g b)) { :root[data-glass=\"on\"] #panel {"
    + " background: rgb(from var(--tint-base) r g b / calc(alpha - \(String(format: "%.2f", amount)))); } }"
  return "\n(function () { var s = document.createElement('style'); s.textContent = \(jsonString(css));"
    + " document.head.appendChild(s); })();"
}

// ---------- small helpers ----------

func hasArg(_ name: String) -> Bool { CommandLine.arguments.dropFirst().contains(name) }

func argValue(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: name), i > 0, i + 1 < args.count else { return nil }
  return args[i + 1]
}

func fourCC(_ code: String) -> UInt32 { code.utf8.reduce(0) { $0 << 8 | UInt32($1) } }

func jsonString(_ text: String) -> String {
  guard let data = try? JSONSerialization.data(withJSONObject: [text]) else { return "\"\"" }
  return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
}

func messageState(_ title: String, _ body: String = "") -> String {
  "{\"view\":\"message\",\"title\":\(jsonString(title)),\"body\":\(jsonString(body))}"
}

func readText(_ path: String) -> String { (try? String(contentsOfFile: path, encoding: .utf8)) ?? "" }
func readData(_ path: String) -> Data? { FileManager.default.contents(atPath: path) }
func writeFile(_ path: String, _ data: Data) { try? data.write(to: URL(fileURLWithPath: path)) }
func removeFiles(_ paths: [String]) { for path in paths { try? FileManager.default.removeItem(atPath: path) } }

// Startup problems (and --selftest results) go to panel.log in the data folder.
func writeLog(_ text: String) {
  let path = DATA_DIR + "/panel.log"
  let files = FileManager.default
  try? files.createDirectory(atPath: DATA_DIR, withIntermediateDirectories: true)
  if let size = (try? files.attributesOfItem(atPath: path))?[.size] as? Int, size > 100_000 { try? files.removeItem(atPath: path) }
  let time = DateFormatter()
  time.dateFormat = "HH:mm:ss"
  let line = Data("\(time.string(from: Date())) \(text)\n".utf8)
  if let file = FileHandle(forWritingAtPath: path) {
    file.seekToEndOfFile()
    file.write(line)
    file.closeFile()
  } else {
    writeFile(path, line)
  }
}

// ---------- running glint.mjs ----------

// Apps opened from Finder get a short PATH, without Homebrew's or nvm's node or the claude CLI, so
// node runs with your login shell's PATH.
enum ChildEnv {
  static let value: [String: String] = {
    var env = ProcessInfo.processInfo.environment
    var dirs: [String] = []
    let fallback = "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/.local/bin:/usr/bin:/bin"
    for path in [loginShellPath(), env["PATH"], fallback] {
      for dir in (path ?? "").split(separator: ":").map(String.init) where !dir.isEmpty && !dirs.contains(dir) {
        dirs.append(dir)
      }
    }
    env["PATH"] = dirs.joined(separator: ":")
    env["GLINT_KEYS"] = "mac"
    return env
  }()
}

func loginShellPath() -> String? {
  let file = FileManager.default.temporaryDirectory.appendingPathComponent("glint-path-\(getpid()).txt").path
  defer { removeFiles([file]) }
  let shell = Process()
  shell.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
  shell.arguments = ["-ilc", "printf '%s' \"$PATH\" > \"$GLINT_PATH_FILE\""]
  shell.environment = ProcessInfo.processInfo.environment.merging(["GLINT_PATH_FILE": file]) { $1 }
  shell.standardInput = FileHandle.nullDevice
  shell.standardOutput = FileHandle.nullDevice
  shell.standardError = FileHandle.nullDevice
  let done = DispatchSemaphore(value: 0)
  shell.terminationHandler = { _ in done.signal() }
  do { try shell.run() } catch { return nil }
  if done.wait(timeout: .now() + 5) == .timedOut { shell.terminate() }
  let path = readText(file).trimmingCharacters(in: .whitespacesAndNewlines)
  return path.isEmpty ? nil : path
}

func nodeProcess(_ args: [String]) -> Process {
  let node = Process()
  node.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  node.arguments = ["node", GLINT] + args
  node.environment = ChildEnv.value
  node.currentDirectoryURL = FileManager.default.temporaryDirectory
  node.standardInput = FileHandle.nullDevice
  node.standardOutput = FileHandle.nullDevice
  node.standardError = FileHandle.nullDevice
  return node
}

// Run glint.mjs and wait for it to finish, without blocking the panel.
func runNode(_ args: [String]) async {
  let node = nodeProcess(args)
  await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
    node.terminationHandler = { _ in done.resume() }
    do {
      try node.run()
    } catch {
      node.terminationHandler = nil
      writeLog("couldn't run node: \(error.localizedDescription)")
      done.resume()
    }
  }
}

// ---------- keys ----------

// What the key watcher needs to know, kept up to date from the main thread.
struct KeyState {
  var claudeInFront = false
  var panelIsKey = false
  var hasFix = false
  var keyF = kVK_ANSI_F
  var tap: CFMachPort?
}

final class Locked<Value>: @unchecked Sendable {
  private var value: Value
  private let lock = NSLock()
  init(_ value: Value) { self.value = value }
  var get: Value {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  func update(_ change: (inout Value) -> Void) {
    lock.lock()
    change(&value)
    lock.unlock()
  }
}

let keyState = Locked(KeyState())
let SYNTHETIC: Int64 = 0x474C_4E54  // 'GLNT': marks the keys Glint presses itself

enum Hotkey { case check, sent, useFix }

// ⌘Enter and Enter count only while Claude is in front, and ⌥F only while there's a fixed version
// to use and Claude or the panel has the keyboard. Everything else goes through untouched.
func hotkey(for event: CGEvent, _ state: KeyState) -> Hotkey? {
  if event.getIntegerValueField(.eventSourceUserData) == SYNTHETIC { return nil }
  let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
  let mods = event.flags.intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift])
  if state.claudeInFront && (code == kVK_Return || code == kVK_ANSI_KeypadEnter) {
    if mods == .maskCommand { return .check }
    if mods.isEmpty { return .sent }
  }
  if mods == .maskAlternate && code == state.keyF && state.hasFix && (state.claudeInFront || state.panelIsKey) {
    return .useFix
  }
  return nil
}

// The key watcher (a Quartz event tap), on its own thread: it never waits for the panel, so the
// keys Glint presses in Claude reach Claude while the panel waits for them.
func onKeyEvent(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
  let state = keyState.get
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let tap = state.tap { CGEvent.tapEnable(tap: tap, enable: true) }
  } else if type == .keyDown, let key = hotkey(for: event, state) {
    if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
      Task { @MainActor in glint.handle(key) }
    }
    if key != .sent { return nil }  // Claude doesn't see ⌘Enter or ⌥F
  }
  return Unmanaged.passUnretained(event)
}

// ⌃⌥E, the system hotkey that shows or hides the panel.
func onShowKey(_ call: EventHandlerCallRef?, _ event: EventRef?, _ data: UnsafeMutableRawPointer?) -> OSStatus {
  Task { @MainActor in glint.toggle() }
  return noErr
}

// The key code that types `char` in the current keyboard layout (with ⌘ held, for shortcuts:
// "Dvorak - QWERTY ⌘" switches layouts then). So Glint's ⌘A is ⌘A on an AZERTY keyboard too, not ⌘Q.
@MainActor
func keyCode(for char: Character, command: Bool = false, fallback: Int) -> Int {
  let modifierState = command ? UInt32((cmdKey >> 8) & 0xFF) : 0
  let sources: [() -> Unmanaged<TISInputSource>?] = [
    { TISCopyCurrentKeyboardLayoutInputSource() }, { TISCopyCurrentASCIICapableKeyboardLayoutInputSource() },
  ]
  for copySource in sources {
    guard let source = copySource()?.takeRetainedValue(),
          let layoutData = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { continue }
    let layout = Unmanaged<CFData>.fromOpaque(layoutData).takeUnretainedValue() as Data
    let found: Int? = layout.withUnsafeBytes { bytes in
      guard let keyboard = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
      for code in 0..<128 {
        var deadKeys: UInt32 = 0
        var length = 0
        var chars = [UniChar](repeating: 0, count: 4)
        let status = UCKeyTranslate(keyboard, UInt16(code), UInt16(kUCKeyActionDown), modifierState, UInt32(LMGetKbdType()),
                                    OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKeys, chars.count, &length, &chars)
        if status == noErr && length == 1 && String(utf16CodeUnits: chars, count: 1).lowercased() == String(char) {
          return code
        }
      }
      return nil
    }
    if let found { return found }
  }
  return fallback
}

func postKey(_ code: Int, flags: CGEventFlags) {
  let source = CGEventSource(stateID: .hidSystemState)
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down) else { continue }
    event.flags = flags
    event.setIntegerValueField(.eventSourceUserData, value: SYNTHETIC)
    event.post(tap: .cghidEventTap)
  }
  usleep(10_000)
}

// ⌘ plus a letter, in Claude.
@MainActor
func pressCommand(_ char: Character, fallback: Int) {
  postKey(keyCode(for: char, command: true, fallback: fallback), flags: .maskCommand)
}

// Wait until ⌘, ⌥, ⌃ and ⇧ are up (at most a second), so they don't mix with the keys Glint presses.
func waitForModifiersUp() {
  let deadline = Date().addingTimeInterval(1)
  while Date() < deadline
    && !CGEventSource.flagsState(.hidSystemState).intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift]).isEmpty {
    usleep(10_000)
  }
}

// ---------- the clipboard ----------
//
// Claude's message box puts its content on the clipboard twice: as plain text, which leaves out the
// numbers of a numbered list and turns a /command chip into plain words, and as HTML, which keeps
// both. Glint reads the HTML too (glint.mjs turns it into text with the list numbers written out) and
// pastes HTML back, so lists, /commands and @mentions survive a fix. Whatever Glint puts on the
// clipboard, including your own content put back afterwards, is marked so clipboard managers skip it
// (the nspasteboard.org markers).

let PRIVATE_TYPES = ["org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType", "org.nspasteboard.AutoGeneratedType"]
  .map { NSPasteboard.PasteboardType($0) }

typealias SavedPasteboard = [[(NSPasteboard.PasteboardType, Data)]]

@MainActor
func savePasteboard() -> SavedPasteboard {
  (NSPasteboard.general.pasteboardItems ?? []).map { item in
    item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
  }
}

@MainActor
func restorePasteboard(_ saved: SavedPasteboard) {
  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  let items = saved.map { entries -> NSPasteboardItem in
    let item = NSPasteboardItem()
    for (type, data) in entries { item.setData(data, forType: type) }
    return item
  }
  guard let first = items.first else { return }
  markPrivate(first)
  pasteboard.writeObjects(items)
}

func markPrivate(_ item: NSPasteboardItem) {
  for type in PRIVATE_TYPES { item.setData(Data(), forType: type) }
}

// Copy Claude's message box without losing what was on the clipboard. Returns its plain text, and its
// HTML if there was some.
@MainActor
func copyDraft() -> (text: String, html: Data?) {
  let pasteboard = NSPasteboard.general
  let saved = savePasteboard()
  let before = pasteboard.changeCount
  pressCommand("a", fallback: kVK_ANSI_A)
  pressCommand("c", fallback: kVK_ANSI_C)
  var text = ""
  var html: Data?
  let deadline = Date().addingTimeInterval(1)
  while Date() < deadline {
    if pasteboard.changeCount != before, !(pasteboard.string(forType: .string) ?? "").isEmpty {
      usleep(30_000)  // the HTML may land just after the text
      text = pasteboard.string(forType: .string) ?? ""
      html = pasteboard.data(forType: .html)
      break
    }
    usleep(10_000)
  }
  postKey(kVK_DownArrow, flags: [.maskCommand, .maskNumericPad, .maskSecondaryFn])  // drop the selection, cursor at the end
  if pasteboard.changeCount != before { restorePasteboard(saved) }
  return (text, html)
}

// Replace everything in Claude's message box with `text`, keeping the clipboard as it was. With
// `html`, the message box rebuilds its lists and chips.
@MainActor
func pasteIntoClaude(_ text: String, html: String?) {
  let pasteboard = NSPasteboard.general
  let saved = savePasteboard()
  pasteboard.clearContents()
  let item = NSPasteboardItem()
  item.setString(text, forType: .string)
  if let html { item.setString("<meta charset='utf-8'>" + html, forType: .html) }
  markPrivate(item)
  if pasteboard.writeObjects([item]) {
    pressCommand("a", fallback: kVK_ANSI_A)
    pressCommand("v", fallback: kVK_ANSI_V)
    usleep(300_000)  // let the paste finish before the clipboard is restored
  }
  restorePasteboard(saved)
}

// The HTML inside the Windows clipboard format that glint.mjs writes (.cfhtml files).
func htmlFragment(_ cfHtml: Data?) -> String? {
  guard let cfHtml, let text = String(data: cfHtml, encoding: .utf8),
        let start = text.range(of: "<!--StartFragment-->"),
        let end = text.range(of: "<!--EndFragment-->", options: .backwards),
        start.upperBound <= end.lowerBound else { return nil }
  return String(text[start.upperBound..<end.lowerBound])
}

// ---------- the window ----------

final class PanelWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }  // one click on Apply is enough
}

// The page's title bar, left of its pin and close buttons: drags the window.
final class DragStrip: NSView {
  override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class Job {
  let kind: String
  let input: String
  let output: String
  var process: Process?
  var shown = ""
  let started = Date()
  var exited: Date?

  init(kind: String, input: String, output: String) {
    self.kind = kind
    self.input = input
    self.output = output
  }
}

@MainActor
final class Glint: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
  var panel: NSPanel!
  var webView: WKWebView!
  var statusItem: NSStatusItem?
  var showKeyRef: EventHotKeyRef?
  var keyTimer: Timer?
  var pollTimer: Timer?
  var job: Job?                         // the check or lookup running now, if any
  var fixText = "" {                    // what ⌥F / "Use fixed version" puts into Claude
    didSet { let hasFix = !fixText.isEmpty; keyState.update { $0.hasFix = hasFix } }
  }
  var fixHtml: Data?                    // the same as HTML, which keeps lists and /command chips
  var claudeApp: NSRunningApplication?  // the Claude the draft came from
  var previousApp: NSRunningApplication?  // the last app in front other than Glint
  var showingCheck = false              // the panel shows a check result (hidden again when you send)
  var lastState = "{\"view\":\"welcome\"}"  // the page's current state, as JSON
  var pageReady = false
  var pinned = false                    // always on top (the pin in the title bar): off at first
  var atLogin = false
  var tempCount = 0
  let selftest = hasArg("--selftest")
  let theme = argValue("--theme")
  var lastFeedback = readText(FEEDBACK_FILE)  // don't show feedback from before the panel started
  var lastTips = readText(TIPS_FILE)
  let permissionState = messageState("Glint needs Accessibility access",
    "It watches for ⌘Enter while Claude is in front, and presses ⌘A, ⌘C and ⌘V in Claude to read and change your message. "
    + "Open System Settings → Privacy & Security → Accessibility and turn on Glint. If it's on already (after you rebuilt Glint), "
    + "turn it off and on again.")

  func applicationWillFinishLaunching(_ notification: Notification) {
    // Started as a login item: stay in the background, like --hidden.
    if let event = NSAppleEventManager.shared().currentAppleEvent {
      atLogin = event.eventID == fourCC("oapp")
        && event.paramDescriptor(forKeyword: fourCC("prdt"))?.enumCodeValue == fourCC("lgit")
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    closeOtherCopies()
    guard FileManager.default.fileExists(atPath: GLINT),
          FileManager.default.fileExists(atPath: PANEL_DIR.appendingPathComponent("glint-panel.html").path) else {
      let alert = NSAlert()
      alert.messageText = "Glint can't find its files"
      alert.informativeText = "It looked in \(ROOT.path). Run tools/glint/mac/build.sh again in your clone of Glint."
      NSApp.activate(ignoringOtherApps: true)
      alert.runModal()
      NSApp.terminate(nil)
      return
    }
    Task.detached(priority: .userInitiated) { _ = ChildEnv.value }  // look up node's PATH now
    setUpMenus()
    setUpPanel()
    setUpShowKey()
    watchApps()
    startKeyWatch()
    Timer.scheduledTimer(timeInterval: 0.7, target: self, selector: #selector(watchFeedback), userInfo: nil, repeats: true)
    if let state = argValue("--state") { render(readText(state)) }  // for previews
    if !hasArg("--hidden") && !atLogin { showPanel() }
    if KEEP_WARM {
      warm()
      Timer.scheduledTimer(timeInterval: 10 * 60, target: self, selector: #selector(warm), userInfo: nil, repeats: true)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    stopJob()
  }

  // Only one Glint listens for ⌘Enter: starting it again replaces the running one.
  func closeOtherCopies() {
    guard let id = Bundle.main.bundleIdentifier else { return }
    for other in NSRunningApplication.runningApplications(withBundleIdentifier: id)
    where other.processIdentifier != ProcessInfo.processInfo.processIdentifier {
      other.forceTerminate()
    }
  }

  // ---------- menus ----------

  func setUpMenus() {
    // Glint has no menu bar, but an Edit menu makes ⌘C, ⌘V, ⌘A and ⌘Z work in the ask box.
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    let editItem = NSMenuItem()
    editItem.submenu = edit
    let mainMenu = NSMenu()
    mainMenu.addItem(editItem)
    NSApp.mainMenu = mainMenu

    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = item.button {
      if let image = NSImage(systemSymbolName: "text.badge.checkmark", accessibilityDescription: "Glint") {
        image.isTemplate = true
        button.image = image
      } else {
        button.title = "G"
      }
      button.toolTip = "Glint (⌘Enter in Claude, ⌃⌥E)"
    }
    let menu = NSMenu()
    let show = NSMenuItem(title: "Show or Hide Glint", action: #selector(toggleFromMenu), keyEquivalent: "e")
    show.keyEquivalentModifierMask = [.control, .option]
    show.target = self
    menu.addItem(show)
    if #available(macOS 13, *) {
      let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin(_:)), keyEquivalent: "")
      login.target = self
      login.state = SMAppService.mainApp.status == .enabled ? .on : .off
      menu.addItem(login)
    }
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Glint", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.menu = menu
    statusItem = item
  }

  @objc func toggleFromMenu() {
    toggle()
  }

  @objc func toggleLogin(_ sender: NSMenuItem) {
    guard #available(macOS 13, *) else { return }
    do {
      if SMAppService.mainApp.status == .enabled {
        try SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
      }
    } catch {
      writeLog("login item: \(error.localizedDescription)")
    }
    sender.state = SMAppService.mainApp.status == .enabled ? .on : .off
  }

  // ---------- the panel ----------

  func setUpPanel() {
    let size = NSSize(width: 480, height: 490)
    let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                        styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    panel.title = "Glint"
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.titlebarSeparatorStyle = .none
    for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      panel.standardWindowButton(button)?.isHidden = true
    }
    panel.minSize = NSSize(width: 420, height: 330)
    panel.level = pinned ? .floating : .normal
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    // On every desktop (Space) and over Claude in full screen: shown without being activated, the panel
    // would otherwise stay on the desktop it was first shown on.
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    if let theme { panel.appearance = NSAppearance(named: theme == "dark" ? .darkAqua : .aqua) }
    if let screen = NSScreen.main?.visibleFrame {
      panel.setFrameOrigin(NSPoint(x: screen.maxX - size.width - 24, y: screen.minY + 24))  // bottom right
    }

    // The frosted glass. Always active: the panel is rarely the active window (it leaves the focus in Claude).
    let glass = NSVisualEffectView()
    glass.material = .popover
    glass.blendingMode = .behindWindow
    glass.state = .active
    panel.contentView = glass

    let scripts = WKUserContentController()
    scripts.add(self, name: "glint")
    scripts.addUserScript(WKUserScript(source: BRIDGE_JS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    scripts.addUserScript(WKUserScript(source: MAC_JS + glassJs(EXTRA_TRANSPARENCY), injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    let config = WKWebViewConfiguration()
    config.userContentController = scripts
    let web = PanelWebView(frame: glass.bounds, configuration: config)
    web.autoresizingMask = [.width, .height]
    web.setValue(false, forKey: "drawsBackground")  // see-through: the page draws its own tint over the glass
    web.navigationDelegate = self
    glass.addSubview(web)

    let strip = DragStrip(frame: NSRect(x: 0, y: glass.bounds.height - 36, width: glass.bounds.width - 80, height: 36))
    strip.autoresizingMask = [.width, .minYMargin]
    glass.addSubview(strip)

    self.panel = panel
    webView = web
    web.loadFileURL(PANEL_DIR.appendingPathComponent("glint-panel.html"), allowingReadAccessTo: PANEL_DIR)
  }

  var isShown: Bool { panel.isVisible }

  // Show the panel in front of Claude without taking the focus, or with it (for the ask box).
  func showPanel(activate: Bool = false) {
    if NSApp.isHidden { NSApp.unhideWithoutActivation() }
    panel.level = pinned ? .floating : .normal
    if activate {
      if #available(macOS 14, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
      panel.makeKeyAndOrderFront(nil)
    } else {
      panel.orderFrontRegardless()
    }
  }

  // Hide the panel, and give the keyboard back to the app before it. (Not by hiding Glint: a hidden
  // app's panel can't come back until the app is unhidden, which can make the next ⌘Enter show nothing.)
  func hidePanel() {
    panel.orderOut(nil)
    guard NSApp.isActive else { return }
    if let app = previousApp, !app.isTerminated {
      if #available(macOS 14, *) { NSApp.yieldActivation(to: app) }
      app.activate(options: [])
    } else {
      NSApp.hide(nil)
    }
  }

  func toggle() {
    if isShown && panel.isKeyWindow && NSApp.isActive {
      hidePanel()
      return
    }
    showPanel(activate: true)
    panel.makeFirstResponder(webView)
    js("document.getElementById('askInput').focus()")
  }

  @objc func warm() {
    Task.detached(priority: .utility) { await runNode(["warm"]) }
  }

  // ---------- talking to the page ----------

  func js(_ code: String) {
    if pageReady { webView.evaluateJavaScript(code, completionHandler: nil) }
  }

  // Show a state (JSON text in the shape window.glint.render takes), optionally with a status line.
  func render(_ state: String, status: String? = nil) {
    lastState = state
    if let status {
      js("window.glint.render(Object.assign(\(state), {status: \(jsonString(status))}))")
    } else {
      js("window.glint.render(\(state))")
    }
  }

  func setStatus(_ text: String) {
    if selftest { writeLog("status: \(text)") }
    render(lastState, status: text)
  }

  @objc func updateGlass() {
    js("window.glint.setGlass(\(NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency ? "false" : "true"))")
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    writeLog("page loaded")
    pageReady = true
    if let theme { js("window.glint.setTheme(\(jsonString(theme)))") }
    updateGlass()
    js("window.glint.render(Object.assign(\(lastState), {pinned: \(pinned)}))")  // the page's pin starts on
    if selftest { Task { await runSelfTest() } }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    writeLog("page failed: \(error.localizedDescription)")
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    writeLog("page failed to load: \(error.localizedDescription)")
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    writeLog("page crashed, reloading")
    pageReady = false
    webView.reload()
  }

  // Messages from the page: { type: 'apply', index } / 'useFix' / { type: 'ask', text } /
  // { type: 'pin', on } / 'close'. They run after this event returns.
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? String,
          let fields = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any],
          let type = fields["type"] as? String else { return }
    if selftest { writeLog("message: \(body)") }
    let index = fields["index"] as? Int
    let text = fields["text"] as? String
    let on = fields["on"] as? Bool ?? true
    Task {
      switch type {
      case "apply":
        if let index { await self.applyFix(index) }
      case "useFix":
        await self.useFix()
      case "ask":
        if let text {
          if self.selftest { writeLog("ask text: \(text)") }
          self.startJob("ask", text)
        }
      case "pin":
        self.pinned = on
        self.panel.level = on ? .floating : .normal
      case "close":
        self.hidePanel()
      default:
        break
      }
    }
  }

  // --selftest: each kind of message, sent by the page itself through the real WebKit path.
  func runSelfTest() async {
    func post(_ message: String) { js("window.chrome.webview.postMessage(\(message))") }
    func pause(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
    let onTop = { self.panel.level == .floating ? 1 : 0 }
    writeLog("selftest: start, on top = \(onTop())")
    post("{type: 'pin', on: true}")
    await pause(0.6)
    writeLog("selftest: after pin on, on top = \(onTop())")
    post("{type: 'pin', on: false}")
    await pause(0.6)
    writeLog("selftest: after pin off, on top = \(onTop())")
    // quotes, a new line and a Chinese character, to exercise the JSON decoding
    post("{type: 'ask', text: ['is ', 'revert back', ' correct?'].join(String.fromCharCode(34)) + String.fromCharCode(10, 0x5e2e)}")
    await pause(4)
    writeLog("selftest: after ask, state = \(lastState.prefix(140))")
    post("{type: 'apply', index: 2}")
    await pause(1.5)
    post("{type: 'close'}")
    await pause(0.8)
    writeLog("selftest: after close, visible = \(isShown)")
    // a check brings the closed panel back, on this desktop (the fake claude answers it)
    startJob("check", "the build got error, what to do next?")
    await pause(3)
    writeLog("selftest: after check, visible = \(isShown), on this desktop = \(panel.isOnActiveSpace), state = \(lastState.prefix(40))")
    writeLog("selftest: done")
  }

  // ---------- keys ----------

  // ⌃⌥E anywhere: a system hotkey, which needs no permission.
  func setUpShowKey() {
    var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), onShowKey, 1, &pressed, nil, nil)
    registerShowKey()
  }

  func registerShowKey() {
    if let ref = showKeyRef { UnregisterEventHotKey(ref) }
    showKeyRef = nil
    let code = keyCode(for: SHOW_KEY.letter, fallback: kVK_ANSI_E)
    let status = RegisterEventHotKey(UInt32(code), UInt32(SHOW_KEY.modifiers), EventHotKeyID(signature: fourCC("GLNT"), id: 1),
                                     GetApplicationEventTarget(), 0, &showKeyRef)
    if status != noErr { writeLog("couldn't register the show key: \(status)") }
  }

  // ⌘Enter, Enter and ⌥F in Claude. Seeing them needs Accessibility permission, like pressing keys in
  // Claude does: ask for it, and start as soon as it's given.
  func startKeyWatch() {
    if startKeyTap() { return }
    if selftest { return }
    let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    if AXIsProcessTrustedWithOptions(options) { _ = CGRequestListenEventAccess() }  // trusted, but the tap failed
    render(permissionState)
    showPanel()
    keyTimer = Timer.scheduledTimer(timeInterval: 2, target: self, selector: #selector(retryKeyWatch), userInfo: nil, repeats: true)
  }

  @objc func retryKeyWatch() {
    guard startKeyTap() else { return }
    keyTimer?.invalidate()
    keyTimer = nil
    if lastState == permissionState { render("{\"view\":\"welcome\"}") }
  }

  func startKeyTap() -> Bool {
    guard AXIsProcessTrusted() else { return false }
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                      eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
                                      callback: onKeyEvent, userInfo: nil) else {
      writeLog("couldn't watch the keyboard")
      return false
    }
    keyState.update { $0.tap = tap }
    let thread = Thread {
      guard let tap = keyState.get.tap else { return }
      CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
      CGEvent.tapEnable(tap: tap, enable: true)
      CFRunLoopRun()
    }
    thread.name = "Glint keys"
    thread.qualityOfService = .userInteractive
    thread.start()
    writeLog("watching ⌘Enter in \(CLAUDE_APP)")
    return true
  }

  func watchApps() {
    let workspace = NSWorkspace.shared.notificationCenter
    workspace.addObserver(self, selector: #selector(appActivated(_:)), name: NSWorkspace.didActivateApplicationNotification, object: nil)
    workspace.addObserver(self, selector: #selector(updateGlass), name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(panelKeyChanged), name: NSWindow.didBecomeKeyNotification, object: panel)
    NotificationCenter.default.addObserver(self, selector: #selector(panelKeyChanged), name: NSWindow.didResignKeyNotification, object: panel)
    DistributedNotificationCenter.default().addObserver(self, selector: #selector(layoutChanged),
      name: NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String), object: nil)
    setFrontApp(NSWorkspace.shared.frontmostApplication)
    layoutChanged()
  }

  @objc func appActivated(_ notification: Notification) {
    setFrontApp(notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
  }

  func setFrontApp(_ app: NSRunningApplication?) {
    let isClaude = app?.bundleIdentifier == CLAUDE_APP
    keyState.update { $0.claudeInFront = isClaude }
    if let app, app.processIdentifier != ProcessInfo.processInfo.processIdentifier { previousApp = app }
  }

  @objc func panelKeyChanged() {
    let isKey = panel.isKeyWindow
    keyState.update { $0.panelIsKey = isKey }
  }

  @objc func layoutChanged() {
    let keyF = keyCode(for: "f", fallback: kVK_ANSI_F)
    keyState.update { $0.keyF = keyF }
    registerShowKey()
  }

  func handle(_ key: Hotkey) {
    switch key {
    case .check: checkDraft()
    case .sent: afterSend()
    case .useFix: Task { await useFix() }
    }
  }

  // ---------- ⌘Enter, Enter, Apply, ⌥F in Claude ----------

  func checkDraft() {
    claudeApp = NSWorkspace.shared.frontmostApplication
    waitForModifiersUp()
    let draft = copyDraft()
    writeLog("⌘Enter: checking \(draft.text.count) characters")
    startJob("check", draft.text, html: draft.html)
  }

  func afterSend() {
    guard HIDE_AFTER_SEND && showingCheck else { return }
    showingCheck = false
    if job?.kind == "check" { stopJob() }
    if isShown { hidePanel() }
  }

  func useFix() async {
    if fixText.isEmpty {
      setStatus("Nothing to use yet. Press ⌘Enter in Claude first.")
      return
    }
    guard await focusClaude() else { return }
    let text = fixText
    let html = await fixedHtml(text, checked: fixHtml)
    pasteIntoClaude(text, html: htmlFragment(html))
    setStatus("Fixed version is in Claude. Press Enter to send.")
  }

  // Fix N only (its Apply button): re-read the draft (keeping any edits made since the check), change
  // that one phrase, and put the message back. The plugin's `apply` command does the matching.
  func applyFix(_ n: Int) async {
    guard await focusClaude() else { return }
    let base = tempPath()
    let inFile = base + ".draft.txt"
    let outFile = base + ".fixed.txt"
    let draft = copyDraft()
    writeFile(inFile, Data(draft.text.utf8))
    var args = ["apply", "--index", String(n), "--in", inFile]
    if let html = draft.html {
      writeFile(inFile + ".html", html)
      args += ["--html", inFile + ".html"]
    }
    await runNode(args + ["--out", outFile])
    let result = readText(outFile + ".status").components(separatedBy: "\n")
    if result.first == "ok" { pasteIntoClaude(readText(outFile), html: htmlFragment(readData(outFile + ".cfhtml"))) }
    let state = readText(outFile + ".json")
    if !state.isEmpty {
      render(state)
    } else {
      setStatus(result.count >= 2 ? result[1] : "Something went wrong applying that fix.")
    }
    removeFiles([inFile, inFile + ".html", outFile, outFile + ".cfhtml", outFile + ".rtf", outFile + ".json", outFile + ".status"])
  }

  // "Use fixed version": HTML to paste for the fixed text, so lists and chips come back. The check made
  // it already (`checked`, with any /command chip), but @mention chips can only come from the message
  // box's own HTML: for a text with an @, copy that now and let glint.mjs rebuild the fixed text.
  func fixedHtml(_ fixed: String, checked: Data?) async -> Data? {
    guard fixed.contains("@"), let html = copyDraft().html else { return checked }
    let base = tempPath()
    let inFile = base + ".natural.txt"
    let outFile = base + ".natural.out"
    writeFile(inFile, Data(fixed.utf8))
    writeFile(inFile + ".html", html)
    await runNode(["natural", "--in", inFile, "--html", inFile + ".html", "--out", outFile])
    let rebuilt = readData(outFile + ".cfhtml")
    removeFiles([inFile, inFile + ".html", outFile + ".cfhtml"])
    return rebuilt ?? checked
  }

  // Bring Claude (the one the draft came from) to the front. Returns false if it can't.
  func focusClaude() async -> Bool {
    let running = claudeApp.flatMap { $0.isTerminated ? nil : $0 }
    guard let app = running ?? NSRunningApplication.runningApplications(withBundleIdentifier: CLAUDE_APP).first else {
      setStatus("Open Claude first.")
      return false
    }
    claudeApp = app
    let inFront = { NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier }
    if !inFront() {
      if #available(macOS 14, *) { NSApp.yieldActivation(to: app) }
      app.activate(options: [])
      var waited = 0
      while !inFront() {
        if waited >= 20 {
          setStatus("Couldn't switch to Claude.")
          return false
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
        waited += 1
      }
      try? await Task.sleep(nanoseconds: 100_000_000)  // let Claude put the focus back in its message box
    }
    waitForModifiersUp()
    return true
  }

  // ---------- gate mode: held-back prompts and tips ----------

  @objc func watchFeedback() {
    let tips = readText(TIPS_FILE)
    if !tips.isEmpty && tips != lastTips {
      lastTips = tips
      if isShown && job == nil {  // never interrupt a check or lookup for a tip
        render(messageState("English tip", tips), status: "Your prompt was sent.")
      }
    }
    let text = readText(FEEDBACK_FILE)
    if text.isEmpty || text == lastFeedback { return }
    lastFeedback = text
    stopJob()
    fixText = readText(NATURAL_FILE).trimmingCharacters(in: .whitespacesAndNewlines)
    fixHtml = nil  // gate mode only has the prompt's text
    render(messageState("Prompt held back", text), status: "Fix it, or press ⌥F. Then send again.")
    showingCheck = true
    showPanel()  // in front, even if it was behind Claude; the focus stays in Claude's message box
  }

  // ---------- running checks and lookups ----------

  func tempPath() -> String {
    tempCount += 1
    let name = "glint-\(ProcessInfo.processInfo.processIdentifier)-\(tempCount)"
    return FileManager.default.temporaryDirectory.appendingPathComponent(name).path
  }

  func startJob(_ kind: String, _ text: String, html: Data? = nil) {
    stopJob()
    fixText = ""
    fixHtml = nil
    showingCheck = kind == "check"
    let base = tempPath()
    let job = Job(kind: kind, input: base + ".in.txt", output: base + ".out.txt")
    writeFile(job.input, Data(text.utf8))
    var args = [kind, "--in", job.input]
    if let html {
      writeFile(job.input + ".html", html)
      args += ["--html", job.input + ".html"]
    }
    render(kind == "check" ? "{\"view\":\"checking\"}"
      : "{\"view\":\"lookup\",\"question\":\(jsonString(text)),\"answer\":\"\",\"streaming\":true,\"canUseFix\":false}")
    if kind == "check" { showPanel() }  // in front, even if it was behind Claude; the focus stays in Claude
    let node = nodeProcess(args + ["--out", job.output])
    do {
      try node.run()
      job.process = node
    } catch {
      writeLog("couldn't run node: \(error.localizedDescription)")
    }
    self.job = job
    pollTimer = Timer.scheduledTimer(timeInterval: 0.15, target: self, selector: #selector(poll), userInfo: nil, repeats: true)
  }

  @objc func poll() {
    guard let job else {
      stopJob()
      return
    }
    let noAnswer = messageState("No answer came back", "Check that Node.js and the Claude CLI work in a terminal.")
    let done = FileManager.default.fileExists(atPath: job.output + ".done")
    let state = readText(job.output + ".json")
    if !state.isEmpty && state != job.shown {
      job.shown = state
      if !done { render(state) }  // a lookup streaming in
    }
    if done {
      if job.shown.isEmpty {
        render(noAnswer)
      } else if job.kind == "check" {
        fixText = readText(job.output + ".natural").trimmingCharacters(in: .whitespacesAndNewlines)
        fixHtml = fixText.isEmpty ? nil : readData(job.output + ".naturalhtml")
        render(job.shown)
      } else {
        render(job.shown, status: String(format: "Answered in %.1f s", Date().timeIntervalSince(job.started)))
      }
      stopJob()
    } else if job.process?.isRunning != true {
      // The .done marker may land just after the process exits.
      guard let exited = job.exited else {
        job.exited = Date()
        return
      }
      if Date().timeIntervalSince(exited) > 0.3 {
        if job.shown.isEmpty { render(noAnswer) }
        stopJob()
      }
    }
  }

  func stopJob() {
    pollTimer?.invalidate()
    pollTimer = nil
    guard let job else { return }
    if let node = job.process, node.isRunning { node.terminate() }
    removeFiles([job.input, job.input + ".html", job.output, job.output + ".rtf", job.output + ".json",
                 job.output + ".natural", job.output + ".naturalhtml", job.output + ".done"])
    self.job = nil
  }
}

@MainActor let glint = Glint()

@main
enum GlintMain {
  @MainActor static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.delegate = glint
    app.run()
  }
}
