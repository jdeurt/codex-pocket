import AppKit
import WebKit

/// Exercises the real native menu bar window with a disposable local editor.
@MainActor
@main
struct MenuBarWindowFlow {
  /// Run the real application delegate and report native window flow failures through the process exit code.
  static func main() {
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

        let focused = try await webView.evaluateJavaScript(
          """
          (() => {const input=document.querySelector('textarea');return document.hasFocus() && document.activeElement===input &&
          input.value==='x' && getComputedStyle(input).outlineWidth==='3px' && input.selectionStart===1;})()
          """)

        guard focused as? Bool == true else {
          throw failure("The editor has no active focus ring or caret selection.")
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

        delegate.perform(NSSelectorFromString("toggle"))
        guard !window.isVisible else {
          throw failure("The second icon action did not hide the window.")
        }
        guard UserDefaults.standard.string(forKey: "NSWindow Frame PocketMenuBar") != nil else {
          throw failure("The chosen window size was not saved for the next launch.")
        }
        delegate.perform(NSSelectorFromString("toggle"))
        try await Task.sleep(nanoseconds: 100_000_000)

        let draft =
          try await webView.evaluateJavaScript("document.querySelector('textarea').value")
          as? String

        guard window.isKeyWindow, window.frame.size == resized, draft == "x" else {
          throw failure("Reopening lost keyboard focus, the chosen size, or the draft.")
        }

        window.performClose(nil)
        guard !window.isVisible else { throw failure("Closing did not hide the retained window.") }
        if let identifier = Bundle.main.bundleIdentifier {
          UserDefaults.standard.removePersistentDomain(forName: identifier)
        }

        print(
          "Native editor focus, focus ring, caret selection, resize, saved size, toggle, draft retention and hidden banner passed."
        )
        app.terminate(nil)
      } catch {
        fputs("\(error.localizedDescription)\n", stderr)
        exit(1)
      }
    }
    withExtendedLifetime(delegate) { app.run() }
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
