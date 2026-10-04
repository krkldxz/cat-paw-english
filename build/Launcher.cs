// 英语背诵工具 一体化启动器 (Windows)
// 职责: 拉起本地推理引擎(llama-server) + 网页服务(node) → 打开浏览器; 关窗即全部退出
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

class Launcher
{
    static string BASE = AppDomain.CurrentDomain.BaseDirectory;
    static Process engine, web;

    static int Main()
    {
        Console.WriteLine("==============================================");
        Console.WriteLine("  英语背诵工具 (本地离线 · 一体化版)");
        Console.WriteLine("==============================================");
        string llama = Path.Combine(BASE, "app", "llama", "llama-server.exe");
        string model = Path.Combine(BASE, "models", "gemma-4-E2B-it-Q4_K_M.gguf");
        string mmproj = Path.Combine(BASE, "models", "gemma-4-E2B-mmproj-F16.gguf");
        string node = Path.Combine(BASE, "runtime", "win", "node.exe");
        string server = Path.Combine(BASE, "app", "server.js");
        foreach (var p in new[] { llama, model, node, server })
            if (!File.Exists(p)) { Console.WriteLine("[错误] 缺少文件: " + p); Console.WriteLine("请保持文件夹完整, 按任意键退出"); Console.ReadKey(); return 1; }

        // 已有实例在跑? 必须两个端口都在才算健康
        // (旧版只看 8804: 网页活着+引擎死了时会直接开页面返回, 引擎永远没人重启 → "引擎离线")
        bool webUp = PortOpen(8804);
        if (webUp && PortOpen(8080))
        {
            Console.WriteLine("[提示] 检测到工具已在运行, 直接打开页面");
            OpenStandalone("http://127.0.0.1:8804");
            Console.WriteLine("关闭此窗口不会结束已在运行的实例。按任意键退出本窗口。");
            Console.ReadKey(); return 0;
        }
        if (webUp) Console.WriteLine("[提示] 网页服务已在运行, 但推理引擎没起来 → 只补启动引擎");

        Console.WriteLine("[1/3] 启动 AI 推理引擎 (首次加载模型约 10-60 秒, 取决于内存/显卡)...");
        engine = RunHidden(llama, "-m \"" + model + "\" --mmproj \"" + mmproj + "\" --host 127.0.0.1 --port 8080 -ngl 99 -c 8192 --jinja", Path.GetDirectoryName(llama));
        bool triedCpu = false;
        if (!webUp)
        {
            Console.WriteLine("[2/3] 启动网页服务...");
            web = RunHidden(node, "\"" + server + "\"", Path.Combine(BASE, "app"));
        }
        else
        {
            Console.WriteLine("[2/3] 网页服务已在运行, 跳过启动");
        }

        Console.WriteLine("      等待引擎就绪 ", false);
        bool ok = false;
        for (int i = 0; i < 150; i++)
        {
            Thread.Sleep(2000);
            Console.Write(".", false);
            if (PortOpen(8080) && PortOpen(8804)) { ok = true; break; }
            if (engine != null && engine.HasExited && !triedCpu)
            {
                triedCpu = true;
                Console.WriteLine();
                Console.WriteLine("[提示] 显卡模式启动失败, 自动改用纯 CPU 模式重试 (速度慢约 3-10 倍, 但能用)...");
                engine = RunHidden(llama, "-m \"" + model + "\" --mmproj \"" + mmproj + "\" --host 127.0.0.1 --port 8080 -ngl 0 -c 8192 --jinja", Path.GetDirectoryName(llama));
            }
            if (engine != null && web != null && engine.HasExited && web.HasExited && triedCpu) break;
        }
        Console.WriteLine();
        if (!ok)
        {
            Console.WriteLine("[警告] 启动超时。可能显存不足或文件被杀毒软件拦截。");
            Console.WriteLine("       可尝试: 1) 关闭占用显卡的程序后重试 2) 将本文件夹加入杀毒白名单");
            Console.WriteLine("按任意键退出并关闭已启动的进程...");
            Console.ReadKey();
            Shutdown();
            return 2;
        }
        Console.WriteLine("[3/3] 就绪! 打开浏览器 → http://127.0.0.1:8804");
        OpenStandalone("http://127.0.0.1:8804");
        Console.WriteLine();
        Console.WriteLine("工具运行中。使用期间请不要关闭本窗口; 关闭本窗口 = 退出工具。");
        try
        {
            while (true)
            {
                // 只盯我们自己拉起的进程; 网页是别人的实例时不参与判定
                bool eDone = engine != null && engine.HasExited;
                bool wDone = web != null && web.HasExited;
                if (eDone || wDone) break;
                Thread.Sleep(1000);
            }
        }
        catch { }
        Console.WriteLine("检测到子进程退出, 正在收尾...");
        Shutdown();
        return 0;
    }

    static Process RunHidden(string file, string args, string workdir)
    {
        var psi = new ProcessStartInfo(file, args) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = workdir };
        try { return Process.Start(psi); }
        catch (Exception e) { Console.WriteLine("[错误] 无法启动 " + file + " : " + e.Message); return null; }
    }

    static bool PortOpen(int port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + (port == 8080 ? "/health" : "/api/books"));
            req.Timeout = 1500;
            using (var r = req.GetResponse()) return true;
        }
        catch { return false; }
    }

    static void OpenStandalone(string url)
    {
        string[] exes = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft\\Edge\\Application\\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft\\Edge\\Application\\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google\\Chrome\\Application\\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google\\Chrome\\Application\\chrome.exe")
        };
        foreach (var e in exes)
        {
            if (!File.Exists(e)) continue;
            try
            {
                string prof = Path.Combine(BASE, "tmp", "app-profile");
                var psi = new ProcessStartInfo(e, "--app=" + url + " --user-data-dir=\"" + prof + "\" --window-size=1300,900 --no-first-run --no-default-browser-check") { UseShellExecute = false, CreateNoWindow = true };
                Process.Start(psi);
                return;
            }
            catch { }
        }
        Open(url); // 兜底: 没有 Edge/Chrome 才开默认浏览器
    }

    static void Open(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    static void Shutdown()
    {
        foreach (var p in new[] { web, engine })
        {
            try
            {
                if (p == null || p.HasExited) continue;
                var psi = new ProcessStartInfo("taskkill.exe", "/T /F /PID " + p.Id) { UseShellExecute = false, CreateNoWindow = true };
                Process.Start(psi);
            }
            catch { }
        }
    }
}
