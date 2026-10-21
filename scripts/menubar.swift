import AppKit
import WebKit

/// Owns the menu bar icon and retains the embedded Pocket page while its window is hidden.
@MainActor
#if !MENUBAR_WINDOW_TEST
  @main
#endif
final class PocketMenuBar: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 420, height: 640),
    styleMask: [.titled, .closable, .resizable],
    backing: .buffered,
    defer: false)
  private let webView = WKWebView()
  private var escapeMonitor: Any?
  private var pocketURL: URL?

  /// Start the accessory app and retain its delegate for the complete native event loop.
  static func main() {
    let application = NSApplication.shared
    let delegate = PocketMenuBar()

    application.setActivationPolicy(.accessory)
    application.delegate = delegate
    withExtendedLifetime(delegate) {
      application.run()
    }
  }

  /// Configure the icon, retained window, and standard text editing commands after the application starts.
  /// - Parameter notification: The application launch notification.
  func applicationDidFinishLaunching(_ notification: Notification) {
    guard let address = Bundle.main.object(forInfoDictionaryKey: "PocketURL") as? String,
      let url = URL(string: address),
      url.scheme == "http",
      url.host == "127.0.0.1"
    else {
      fputs("Pocket Menu Bar requires its local Pocket URL. Run pocket menubar setup.\n", stderr)
      NSApp.terminate(nil)
      return
    }

    let nativeStyle = WKUserScript(
      source: """
        (() => {
          const nativeStyle = document.createElement('style');
          nativeStyle.textContent = '.notification-prompt { display: none !important; }';
          document.head.appendChild(nativeStyle);
        })();
        """,
      injectionTime: .atDocumentEnd,
      forMainFrameOnly: true)

    pocketURL = url
    webView.configuration.userContentController.addUserScript(nativeStyle)
    window.title = "Pocket"
    window.contentView = webView
    window.delegate = self
    window.level = .floating
    window.minSize = NSSize(width: 320, height: 360)
    window.isReleasedWhenClosed = false
    window.setFrameUsingName("PocketMenuBar")
    window.setFrameAutosaveName("PocketMenuBar")
    item.button?.image = NSImage(
      systemSymbolName: "bubble.left.and.bubble.right", accessibilityDescription: "Pocket")
    item.button?.toolTip = "Pocket"
    item.button?.target = self
    item.button?.action = #selector(toggle)
    configureMenu()
    escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      if event.keyCode == 53, self?.window.isVisible == true {
        self?.hide()
        return nil
      }

      return event
    }
  }

  /// Provide normal keyboard shortcuts to the embedded chat editor and a command to quit this companion.
  private func configureMenu() {
    let menu = NSMenu()
    let applicationItem = NSMenuItem()
    let applicationMenu = NSMenu()
    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")

    applicationMenu.addItem(
      withTitle: "Quit Pocket Menu Bar", action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q")
    applicationItem.submenu = applicationMenu
    menu.addItem(applicationItem)
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(
      withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    menu.addItem(editItem)
    NSApp.mainMenu = menu
  }

  /// Show or hide the retained Pocket page beneath the status icon.
  @objc private func toggle() {
    guard let button = item.button else { return }

    if window.isVisible {
      hide()
    } else {
      // Loading waits for the first click so login startup does not depend on server readiness.
      if webView.url == nil, let url = pocketURL {
        webView.load(URLRequest(url: url))
      }

      NSApp.activate(ignoringOtherApps: true)
      position(beneath: button)
      window.makeKeyAndOrderFront(nil)
      window.makeFirstResponder(webView)
    }
  }

  /// Anchor the current window size below the clicked icon and constrain it to that screen.
  /// - Parameter button: The status item button on the screen where Pocket should open.
  private func position(beneath button: NSStatusBarButton) {
    guard let statusWindow = button.window, let screen = statusWindow.screen else { return }

    let anchor = statusWindow.convertToScreen(button.convert(button.bounds, to: nil))
    let bounds = screen.visibleFrame.insetBy(dx: 8, dy: 8)
    let width = min(window.frame.width, bounds.width)
    let height = min(window.frame.height, bounds.height)
    let x = min(max(anchor.maxX - width, bounds.minX), bounds.maxX - width)
    let y = min(max(anchor.minY - height - 6, bounds.minY), bounds.maxY - height)

    window.maxSize = bounds.size
    window.setFrame(NSRect(x: x, y: y, width: width, height: height), display: false)
  }

  /// Save the chosen window size and hide the retained editor.
  private func hide() {
    guard window.isVisible else { return }

    window.saveFrame(usingName: "PocketMenuBar")
    window.orderOut(nil)
  }

  /// Restore native keyboard focus after macOS finishes activating this accessory application.
  /// - Parameter notification: The native application activation event.
  func applicationDidBecomeActive(_ notification: Notification) {
    if window.isVisible {
      window.makeKeyAndOrderFront(nil)
    }
  }

  /// Reveal the retained editor when the app bundle is explicitly opened again.
  /// - Parameters:
  ///   - sender: The application receiving the reopen request.
  ///   - flag: Whether macOS reports any visible application windows.
  /// - Returns: False because the menu bar delegate handles reopening its own window.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    if !window.isVisible {
      toggle()
    }

    return false
  }

  /// Retain the editor and its draft when the native close button is clicked.
  /// - Parameter sender: The window receiving the native close request.
  /// - Returns: False because closing hides the retained editor.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    hide()

    return false
  }
}
