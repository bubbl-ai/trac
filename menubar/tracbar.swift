// tracbar — minimal menu-bar gauge for Trac.
// Shows live session quota % + task counts, refreshing every 60s.
// All logic lives in trac.js; this binary just renders `trac json`.
// Build:  swiftc -O tracbar.swift -o tracbar
import AppKit
import Foundation

final class TracBar: NSObject, NSApplicationDelegate {
  var item: NSStatusItem!
  var timer: Timer?
  // When the session is capped (100%), skip polling until the window resets.
  var pauseUntil: Date?

  func applicationDidFinishLaunching(_ note: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.title = "◌ …"
    item.menu = NSMenu()
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      self?.refresh()
    }
  }

  func refresh() {
    if let until = pauseUntil {
      if Date() < until { return } // capped — nothing to learn until reset
      pauseUntil = nil
    }
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }
      let proc = Process()
      proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
      // login shell so node is on PATH regardless of how it was installed
      proc.arguments = ["-lc", "node ~/trac/trac.js json"]
      let pipe = Pipe()
      proc.standardOutput = pipe
      proc.standardError = Pipe()
      do { try proc.run() } catch {
        DispatchQueue.main.async { self.item.button?.title = "◌ err" }
        return
      }
      proc.waitUntilExit()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      guard
        let obj = try? JSONSerialization.jsonObject(with: data),
        let j = obj as? [String: Any],
        let session = j["session"] as? [String: Any],
        let week = j["week"] as? [String: Any],
        let sPct = session["pct"] as? Int,
        let wPct = week["pct"] as? Int
      else {
        DispatchQueue.main.async { self.item.button?.title = "◌ err" }
        return
      }
      let plan = j["plan"] as? String ?? "Claude"
      let source = j["source"] as? String ?? "live"
      let burn = j["burnPerHr"] as? Double ?? 0
      let tasks = j["tasks"] as? [String: Int] ?? [:]
      let sReset = Self.fmtReset(session["resetsAt"] as? String)
      let wReset = Self.fmtReset(week["resetsAt"] as? String)
      // Paid extra-usage credits — null/absent when not enabled on this account.
      let extra = j["extra"] as? [String: Any]
      let extraEnabled = (extra?["enabled"] as? Bool) ?? false
      let extraUsed = (extra?["used"] as? Double) ?? 0
      let extraLimit = (extra?["limit"] as? Double) ?? 0

      DispatchQueue.main.async {
        var title: String
        if sPct >= 100, let reset = Self.parseISO(session["resetsAt"] as? String) {
          // sleep until 30s past the reset, then resume polling
          self.pauseUntil = reset.addingTimeInterval(30)
          title = "🔴 100%\(sReset.map { " → \($0)" } ?? "")"
        } else {
          self.pauseUntil = nil
          title = "\(Self.dot(sPct)) \(sPct)%"
        }
        // Surface paid overspend at a glance; no title change when nothing spent.
        if extraEnabled && extraUsed > 0 {
          title += String(format: " +$%.2f", extraUsed)
        }
        var badges: [String] = []
        if let q = tasks["queued"], q > 0 { badges.append("\(q)⏳") }
        if let r = tasks["running"], r > 0 { badges.append("\(r)⚙") }
        if let d = tasks["done"], d > 0 { badges.append("\(d)✓") }
        if !badges.isEmpty { title += " · " + badges.joined(separator: " ") }
        self.item.button?.title = title

        let menu = NSMenu()
        menu.addItem(Self.label("\(plan)\(source == "estimate" ? " · estimated" : "")"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(Self.label("Session  \(Self.dot(sPct)) \(sPct)%\(sReset.map { " · resets \($0)" } ?? "")"))
        menu.addItem(Self.label("Week     \(Self.dot(wPct)) \(wPct)%\(wReset.map { " · resets \($0)" } ?? "")"))
        if extraEnabled {
          menu.addItem(Self.label(String(format: "Extra    $%.2f of $%.2f used", extraUsed, extraLimit)))
        }
        if burn > 0 { menu.addItem(Self.label(String(format: "Burn     $%.1f/hr API-equiv", burn))) }
        let q = tasks["queued"] ?? 0, r = tasks["running"] ?? 0, d = tasks["done"] ?? 0
        if q + r + d > 0 {
          menu.addItem(NSMenuItem.separator())
          menu.addItem(Self.label("Tasks    \(q) queued · \(r) running · \(d) to review"))
        }
        menu.addItem(NSMenuItem.separator())
        let o = NSMenuItem(title: "Open Trac…", action: #selector(self.openTrac), keyEquivalent: "o")
        o.target = self
        menu.addItem(o)
        let re = NSMenuItem(title: "Refresh", action: #selector(self.doRefresh), keyEquivalent: "r")
        re.target = self
        menu.addItem(re)
        menu.addItem(NSMenuItem(title: "Quit Trac", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        self.item.menu = menu
      }
    }
  }

  @objc func openTrac() {
    DispatchQueue.global(qos: .userInitiated).async {
      let proc = Process()
      proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
      // start the dashboard server if it isn't already running, then open it
      proc.arguments = ["-lc",
        "pgrep -f 'trac.js ui' >/dev/null || (nohup node ~/trac/trac.js ui --no-open >/dev/null 2>&1 &); sleep 0.5; open http://localhost:7433"]
      try? proc.run()
    }
  }

  @objc func doRefresh() {
    pauseUntil = nil // manual refresh always overrides the capped pause
    refresh()
  }

  static func dot(_ pct: Int) -> String { pct >= 80 ? "🔴" : pct >= 50 ? "🟠" : "🟢" }

  static func label(_ s: String) -> NSMenuItem {
    let m = NSMenuItem(title: s, action: nil, keyEquivalent: "")
    m.isEnabled = false
    return m
  }

  static func parseISO(_ iso: String?) -> Date? {
    guard let iso else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: iso) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: iso)
  }

  static func fmtReset(_ iso: String?) -> String? {
    guard let date = parseISO(iso) else { return nil }
    let out = DateFormatter()
    out.dateFormat = Calendar.current.isDateInToday(date) ? "h:mm a" : "EEE h:mm a"
    return out.string(from: date)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = TracBar()
app.delegate = delegate
app.run()
