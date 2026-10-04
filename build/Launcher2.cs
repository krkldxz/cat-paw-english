// 英语背诵工具 · 原生窗口启动器 v2
// WinForms + WebView2: 独立软件窗口(自己的图标/标题/任务栏分组), 不再是浏览器app窗口
// 无 WebView2 运行时的老系统自动回退 Edge --app
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;

class App : Form
{
    static string BASE = AppDomain.CurrentDomain.BaseDirectory;
    static Process engine, web;
    static bool spawned = false;
    WebView2 wv;
    Label statusLbl;
    bool ready = false;

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main()
    {
        // 高 DPI 声明: 避免系统位图拉伸导致发糊 (1.25x/1.5x 缩放屏)
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try { Application.Run(new App()); }
        catch (Exception e)
        {
            MessageBox.Show("启动失败: " + e.Message, "英语背诵工具");
        }
        ShutdownChildren();
    }

    public App()
    {
        Text = "英语背诵工具";
        try { Icon = new Icon(Path.Combine(BASE, "app.ico")); } catch { }
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1320, 920);
        MinimumSize = new Size(900, 600);
        BackColor = Color.FromArgb(255, 248, 238);

        statusLbl = new Label
        {
            Text = "正在启动本地 AI 引擎，请稍候…\n(首次加载模型约 10-60 秒)",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Microsoft YaHei UI", 13F),
            ForeColor = Color.FromArgb(160, 90, 20)
        };
        wv = new WebView2 { Dock = DockStyle.Fill, Visible = false };
        Controls.Add(wv);
        Controls.Add(statusLbl);

        Load += delegate
        {
            var t = new Thread(Boot);
            t.IsBackground = true;
            t.Start();
        };
        FormClosing += delegate { ShutdownChildren(); };
    }

    void Boot()
    {
        try
        {
            // 健康判定必须看两个端口: 旧版只看 8804, 网页活着+引擎死了时会整段跳过,
            // 引擎永远没人重启 → 界面报"引擎离线"(2026-09-27 实测复现)
            bool webUp = PortAlive(8804);
            bool engineUp = PortAlive(8080);
            if (!webUp || !engineUp)
            {
                string llama = Path.Combine(BASE, "app", "llama", "llama-server.exe");
                string model = Path.Combine(BASE, "models", "gemma-4-E2B-it-Q4_K_M.gguf");
                string mmproj = Path.Combine(BASE, "models", "gemma-4-E2B-mmproj-F16.gguf");
                string node = Path.Combine(BASE, "runtime", "win", "node.exe");
                string server = Path.Combine(BASE, "app", "server.js");
                foreach (var p in new[] { llama, model, node, server })
                    if (!File.Exists(p)) { Fail("缺少文件: " + p + "\n请保持文件夹完整"); return; }

                if (!engineUp)
                {
                    SetStatus("启动推理引擎…");
                    engine = Run(llama, "-m \"" + model + "\" --mmproj \"" + mmproj + "\" --host 127.0.0.1 --port 8080 -ngl 99 -c 8192 --jinja", Path.GetDirectoryName(llama));
                }
                else SetStatus("推理引擎已在运行, 跳过启动");

                if (!webUp)
                {
                    web = Run(node, "\"" + server + "\"", Path.Combine(BASE, "app"));
                }
                else SetStatus("网页服务已在运行, 只补启动引擎…");

                spawned = (engine != null || web != null);
                if (engine == null && !engineUp) { Fail("无法启动推理引擎 (可能被杀毒软件拦截)。"); return; }

                bool cpuTried = false;
                for (int i = 0; i < 300; i++)
                {
                    Thread.Sleep(2000);
                    if (engine != null && engine.HasExited && !cpuTried)
                    {
                        cpuTried = true;
                        SetStatus("显卡模式失败, 切换纯 CPU 模式重试 (较慢)…");
                        engine = Run(llama, "-m \"" + model + "\" --mmproj \"" + mmproj + "\" --host 127.0.0.1 --port 8080 -ngl 0 -c 8192 --jinja", Path.GetDirectoryName(llama));
                    }
                    if (PortAlive(8080) && PortAlive(8804)) break;
                    if (i % 5 == 4) SetStatus("等待引擎就绪… (" + (i * 2) + "s)");
                }
                if (!PortAlive(8804) || !PortAlive(8080)) { Fail("启动超时: 引擎或网页服务未就绪。\n可尝试关闭占显卡的程序后重试。"); return; }
            }
            ShowWeb();
        }
        catch (Exception e) { Fail("启动异常: " + e.Message); }
    }

    void ShowWeb()
    {
        ready = true;
        if (IsDisposed) return;
        try
        {
            BeginInvoke((Action)(async delegate
            {
                try
                {
                    string udf = Path.Combine(BASE, "tmp", "webview2");
                    Directory.CreateDirectory(udf);
                    var env = await CoreWebView2Environment.CreateAsync(null, udf, null);
                    await wv.EnsureCoreWebView2Async(env);
                    wv.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                    wv.CoreWebView2.Settings.IsZoomControlEnabled = false;
                    wv.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
                    wv.CoreWebView2.Settings.IsStatusBarEnabled = false;
                    wv.CoreWebView2.DocumentTitleChanged += delegate
                    {
                        try { BeginInvoke((Action)(() => { Text = wv.CoreWebView2.DocumentTitle.Length > 0 ? wv.CoreWebView2.DocumentTitle : "英语背诵工具"; })); } catch { }
                    };
                    wv.CoreWebView2.Navigate("http://127.0.0.1:8804");
                    statusLbl.Visible = false;
                    wv.Visible = true;
                }
                catch
                {
                    // WebView2 不可用 → 回退 Edge --app
                    FallbackApp();
                }
            }));
        }
        catch { FallbackApp(); }
    }

    void FallbackApp()
    {
        try
        {
            BeginInvoke((Action)(() =>
            {
                statusLbl.Text = "正在打开应用窗口…";
                OpenStandalone("http://127.0.0.1:8804");
                Close();
            }));
        }
        catch { OpenStandalone("http://127.0.0.1:8804"); Environment.Exit(0); }
    }

    void OpenStandalone(string url)
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
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    void SetStatus(string s)
    {
        try { BeginInvoke((Action)(() => { if (!ready) statusLbl.Text = s; })); } catch { }
    }

    void Fail(string s)
    {
        try { BeginInvoke((Action)(() => { statusLbl.Text = s; })); } catch { }
    }

    static Process Run(string file, string args, string workdir)
    {
        var psi = new ProcessStartInfo(file, args) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = workdir };
        try { return Process.Start(psi); } catch { return null; }
    }

    static bool PortAlive(int port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + (port == 8080 ? "/health" : "/api/books"));
            req.Timeout = 1500;
            using (var r = req.GetResponse()) return true;
        }
        catch { return false; }
    }

    static void ShutdownChildren()
    {
        if (!spawned) return;
        spawned = false;
        foreach (var p in new[] { web, engine })
        {
            try
            {
                if (p == null || p.HasExited) continue;
                Process.Start(new ProcessStartInfo("taskkill.exe", "/T /F /PID " + p.Id) { UseShellExecute = false, CreateNoWindow = true });
            }
            catch { }
        }
    }
}
