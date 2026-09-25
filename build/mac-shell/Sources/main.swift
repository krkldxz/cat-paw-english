// 英语背诵工具 · macOS 原生壳 (Swift + WKWebView)
// 独立 NSWindow + 系统自带 WebKit 渲染 (Retina 原生清晰度), Dock 显示专属猫爪图标
// 职责: 拉起 llama-server + node 服务 → 等就绪 → WKWebView 加载 127.0.0.1:8804; 关窗回收子进程
import Cocoa
import WebKit

let APP_PORT = 8804
let ENGINE_PORT = 8080

func pkgPath(_ sub: String) -> String {
    let exeDir = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
    let contents = (exeDir as NSString).deletingLastPathComponent
    let appBundle = (contents as NSString).deletingLastPathComponent
    let base = (appBundle as NSString).deletingLastPathComponent
    let direct = ((base as NSString).appendingPathComponent(sub) as NSString).standardizingPath
    if FileManager.default.fileExists(atPath: direct) { return direct }
    let inApp = ((appBundle as NSString).appendingPathComponent("Contents/Resources/" + sub) as NSString).standardizingPath
    if FileManager.default.fileExists(atPath: inApp) { return inApp }
    return direct
}

func portAlive(_ port: Int, path: String) -> Bool {
    guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return false }
    var req = URLRequest(url: url, timeoutInterval: 1.5)
    req.httpMethod = "GET"
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { data, resp, _ in
        if let h = resp as? HTTPURLResponse, h.statusCode == 200 { ok = true }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 2.5)
    return ok
}

func runProc(_ path: String, _ args: [String], cwd: String? = nil) -> Process? {
    guard FileManager.default.isExecutableFile(atPath: path) else { return nil }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    if let c = cwd { p.currentDirectoryURL = URL(fileURLWithPath: c) }
    p.standardOutput = FileHandle(forWritingAtPath: "/dev/null")
    p.standardError = FileHandle(forWritingAtPath: "/dev/null")
    do { try p.run(); return p } catch { return nil }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var statusLabel: NSTextField!
    var engineProc: Process?
    var webProc: Process?
    var spawned = false

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)
        let rect = NSRect(x: 0, y: 0, width: 1320, height: 900)
        window = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "AI 英语学习舱"
        window.minSize = NSSize(width: 900, height: 600)
        window.center()

        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        window.backgroundColor = NSColor(calibratedRed: 1, green: 0.973, blue: 0.933, alpha: 1) // 防白闪, 匹配页面暖色底

        statusLabel = NSTextField(labelWithString: "正在启动本地 AI 引擎，请稍候…\n(首次加载模型约 10-60 秒)")
        statusLabel.frame = window.contentView!.bounds
        statusLabel.autoresizingMask = [.width, .height]
        statusLabel.alignment = .center
        statusLabel.font = NSFont.systemFont(ofSize: 15)
        statusLabel.textColor = NSColor(calibratedRed: 0.63, green: 0.35, blue: 0.08, alpha: 1)
        statusLabel.maximumNumberOfLines = 4

        window.contentView!.addSubview(web)
        window.contentView!.addSubview(statusLabel)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.global(qos: .userInitiated).async { self.bootstrap() }
    }

    func bootstrap() {
        if !portAlive(APP_PORT, path: "/api/books") {
            let arch = Self.isArm64 ? "mac" : "mac-x64"
            let llama = pkgPath("engine/\(arch)/llama-server")
            let node = pkgPath("runtime/mac/node")
            let server = pkgPath("app/server.js")
            let model = pkgPath("models/gemma-4-E2B-it-Q4_K_M.gguf")
            let mmproj = pkgPath("models/gemma-4-E2B-mmproj-F16.gguf")
            setStatus("启动推理引擎…")
            FileHandle.standardError.write("[shell] llama=".appending(llama).appending(" node=").appending(node).appending(" server=").appending(server).data(using: .utf8)!)
            engineProc = runProc(llama, ["-m", model, "--mmproj", mmproj, "--host", "127.0.0.1", "--port", "\(ENGINE_PORT)", "-ngl", "99", "-c", "8192", "--jinja"])
            webProc = runProc(node, [server], cwd: pkgPath("app"))
            spawned = true
            for i in 0..<300 {
                Thread.sleep(forTimeInterval: 2.0)
                if portAlive(ENGINE_PORT, path: "/health") && portAlive(APP_PORT, path: "/api/books") { break }
                if i % 5 == 4 { setStatus("等待引擎就绪… (\(i * 2)s)") }
            }
        }
        if portAlive(APP_PORT, path: "/api/books") {
            DispatchQueue.main.async {
                self.statusLabel.isHidden = true
                self.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(APP_PORT)")!))
            }
        } else {
            setStatus("启动超时: 引擎未就绪。\n日志见 /tmp/es_engine.log")
        }
    }

    static var isArm64: Bool {
        var sysinfo = utsname()
        uname(&sysinfo)
        let machine = withUnsafePointer(to: &sysinfo.machine) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) }
        }
        return machine.contains("arm64")
    }

    func setStatus(_ s: String) {
        DispatchQueue.main.async { if !self.statusLabel.isHidden { self.statusLabel.stringValue = s } }
    }

    func webView(_ wv: WKWebView, didFinish nav: WKNavigation!) {
        web.evaluateJavaScript("document.title") { t, _ in
            if let s = t as? String, !s.isEmpty { DispatchQueue.main.async { self.window.title = s } }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ n: Notification) {
        guard spawned else { return }
        for p in [webProc, engineProc] { if let pr = p, pr.isRunning { pr.terminate() } }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
