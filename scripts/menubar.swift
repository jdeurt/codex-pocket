import AppKit
import WebKit

/// Owns the menu bar icon and retains the embedded Pocket page while its popover is hidden.
@MainActor
@main
final class PocketMenuBar: NSObject, NSApplicationDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let popover = NSPopover()
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

  /// Configure the icon, popover, and standard text editing commands after the application starts.
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

    let controller = NSViewController()

    controller.view = webView
    pocketURL = url
    popover.contentViewController = controller
    popover.contentSize = NSSize(width: 420, height: 640)
    popover.behavior = .transient
    popover.animates = false
    item.button?.image = NSImage(
      systemSymbolName: "bubble.left.and.bubble.right", accessibilityDescription: "Pocket")
    item.button?.toolTip = "Pocket"
    item.button?.target = self
    item.button?.action = #selector(toggle)
    configureMenu()
    escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      if event.keyCode == 53, self?.popover.isShown == true {
        self?.popover.performClose(nil)
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

    if popover.isShown {
      popover.performClose(nil)
    } else {
      // Loading waits for the first click so login startup does not depend on server readiness.
      if webView.url == nil, let url = pocketURL {
        webView.load(URLRequest(url: url))
      }

      NSApp.activate(ignoringOtherApps: true)
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
      popover.contentViewController?.view.window?.makeKey()
      popover.contentViewController?.view.window?.makeFirstResponder(webView)
    }
  }
}
