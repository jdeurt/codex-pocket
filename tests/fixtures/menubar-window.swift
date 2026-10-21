import AppKit
import WebKit

/// Exercises the real native menu bar window with a disposable local editor.
@MainActor
@main
struct MenuBarWindowFlow {
  /// Run the real application delegate and report native window flow failures through the process exit code.
  static func main() {
    if CommandLine.arguments.contains("--other-app") {
      runOtherApp()
      return
    }

    let app = NSApplication.shared
    let delegate = PocketMenuBar()

    app.setActivationPolicy(.accessory)
    app.delegate = delegate
    Task { @MainActor in
      do {
        try await Task.sleep(nanoseconds: 200_000_000)
        delegate.perform(NSSelectorFromString("toggle"))
        try await Task.sleep(nanoseconds: 200_000_000)

        guard let webView = app.windows.compactMap({ editor(in: $0.contentView) }).first,
          let window = webView.window
        else { throw failure("The icon action did not open the editor window.") }

        webView.stopLoading()
        webView.loadHTMLString(
          """
          <!doctype html><html lang="en"><head><title>Pocket native editor check</title>
          <style>body{font:16px system-ui;padding:24px}textarea{width:90%;height:120px;caret-color:black}
          textarea:focus-visible{outline:3px solid rgb(0, 102, 255)}</style></head>
          <body><h1>Pocket native editor check</h1>
          <aside class="notification-prompt">Add Pocket to your Home Screen to enable notifications.</aside>
          <label>Draft<textarea aria-label="Draft"></textarea></label></body></html>
          """, baseURL: nil)

        for _ in 0..<500 {
          let ready = try? await webView.evaluateJavaScript(
            "Boolean(document.querySelector('textarea'))")

          if ready as? Bool == true { break }
          try await Task.sleep(nanoseconds: 20_000_000)
        }

        for _ in 0..<100 {
          if window.isKeyWindow, app.isActive { break }
          try await Task.sleep(nanoseconds: 20_000_000)
        }

        guard window.isKeyWindow, app.isActive else {
          throw failure("The editor window did not receive native keyboard focus.")
        }

        let inputPoint =
          try await webView.evaluateJavaScript(
            """
            (() => {const r=document.querySelector('textarea').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];})()
            """) as? [Double]

        guard let inputPoint else { throw failure("The editor has no clickable native position.") }

        let point = webView.convert(
          NSPoint(
            x: inputPoint[0],
            y: webView.isFlipped ? inputPoint[1] : webView.bounds.height - inputPoint[1]), to: nil)

        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
          guard
            let event = NSEvent.mouseEvent(
              with: type, location: point, modifierFlags: [],
              timestamp: ProcessInfo.processInfo.systemUptime,
              windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
              pressure: 1)
          else { throw failure("The native mouse event could not be created.") }

          window.sendEvent(event)
        }

        try await Task.sleep(nanoseconds: 100_000_000)

        guard
          let key = NSEvent.keyEvent(
            with: .keyDown, location: point, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, characters: "x",
            charactersIgnoringModifiers: "x", isARepeat: false,
            keyCode: 7)
        else { throw failure("The native keyboard event could not be created.") }

        window.sendEvent(key)
        try await Task.sleep(nanoseconds: 100_000_000)

        var focused = false

        for _ in 0..<100 {
          focused =
            try await webView.evaluateJavaScript(
              """
              (() => {const input=document.querySelector('textarea');return document.hasFocus() && document.activeElement===input &&
              input.value==='x' && getComputedStyle(input).outlineWidth==='3px' && input.selectionStart===1;})()
              """) as? Bool == true

          if focused { break }
          try await Task.sleep(nanoseconds: 20_000_000)
        }

        guard focused else {
          let state = try await webView.evaluateJavaScript(
            """
            (() => {const input=document.querySelector('textarea');return JSON.stringify({
            focused:document.hasFocus(),active:document.activeElement?.tagName,value:input.value,
            outline:getComputedStyle(input).outlineWidth,selection:input.selectionStart});})()
            """)

          throw failure(
            "The editor has no active focus ring or caret selection: \(String(describing: state)).")
        }
        guard window.styleMask.contains(.resizable) else {
          throw failure("The editor window cannot resize.")
        }

        let bannerHidden = try await webView.evaluateJavaScript(
          "getComputedStyle(document.querySelector('.notification-prompt')).display==='none'")

        guard bannerHidden as? Bool == true else {
          throw failure("The native window still shows a notification banner.")
        }

        window.setContentSize(NSSize(width: 600, height: 700))
        try await Task.sleep(nanoseconds: 100_000_000)

        let resized = window.frame.size
        let viewportWidth = try await webView.evaluateJavaScript("window.innerWidth") as? Double

        guard viewportWidth == 600 else {
          throw failure("The web page did not resize with the window.")
        }

        let otherApp = Process()

        otherApp.executableURL = Bundle.main.executableURL
        otherApp.arguments = ["--other-app"]
        try otherApp.run()
        defer { otherApp.terminate() }

        for _ in 0..<100 {
          if !app.isActive { break }
          try await Task.sleep(nanoseconds: 20_000_000)
        }

        guard !app.isActive, window.isVisible, window.level > .normal else {
          throw failure(
            "The editor did not remain visible above normal windows after losing focus: "
              + "active=\(app.isActive), visible=\(window.isVisible), level=\(window.level.rawValue)."
          )
        }

        delegate.perform(NSSelectorFromString("toggle"))
        try await Task.sleep(nanoseconds: 200_000_000)

        guard !window.isVisible else {
          throw failure("The second icon action did not leave the window hidden.")
        }
        guard UserDefaults.standard.string(forKey: "NSWindow Frame PocketMenuBar") != nil else {
          throw failure("The chosen window size was not saved for the next launch.")
        }
        delegate.perform(NSSelectorFromString("toggle"))

        for _ in 0..<100 {
          if window.isKeyWindow, app.isActive { break }
          try await Task.sleep(nanoseconds: 20_000_000)
        }

        let draft =
          try await webView.evaluateJavaScript("document.querySelector('textarea').value")
          as? String

        guard window.isKeyWindow, window.frame.size == resized, draft == "x" else {
          throw failure(
            "Reopening lost keyboard focus, the chosen size, or the draft: "
              + "key=\(window.isKeyWindow), active=\(app.isActive), "
              + "size=\(window.frame.size), draft=\(String(describing: draft)).")
        }

        window.performClose(nil)
        guard !window.isVisible else { throw failure("Closing did not hide the retained window.") }
        if let identifier = Bundle.main.bundleIdentifier {
          UserDefaults.standard.removePersistentDomain(forName: identifier)
        }

        otherApp.terminate()
        otherApp.waitUntilExit()
        print(
          "Native editor focus, focus ring, caret selection, resize, saved size, "
            + "floating while inactive, toggle, draft retention and hidden banner passed."
        )
        app.terminate(nil)
      } catch {
        fputs("\(error.localizedDescription)\n", stderr)
        exit(1)
      }
    }
    withExtendedLifetime(delegate) { app.run() }
  }

  /// Present another application's normal window to exercise a real native focus transfer.
  private static func runOtherApp() {
    let app = NSApplication.shared
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 320, height: 240),
      styleMask: [.titled], backing: .buffered, defer: false)

    app.setActivationPolicy(.regular)
    app.finishLaunching()
    window.title = "Pocket flow companion"
    window.center()
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    withExtendedLifetime(window) { app.run() }
  }

  /// Find the embedded editor through the native window's view hierarchy.
  /// - Parameter view: A native window content view or one of its descendants.
  /// - Returns: The embedded WebKit view, or nil before the window mounts it.
  private static func editor(in view: NSView?) -> WKWebView? {
    if let webView = view as? WKWebView { return webView }

    return view?.subviews.compactMap { editor(in: $0) }.first
  }

  /// Describe a failed native interaction without crashing the surrounding desktop test session.
  /// - Parameter message: The interaction contract that failed.
  /// - Returns: An error consumed by the native flow's process boundary.
  private static func failure(_ message: String) -> NSError {
    NSError(domain: "PocketMenuBarFlow", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
