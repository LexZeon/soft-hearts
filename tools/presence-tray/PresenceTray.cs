// I-030 "我在用电脑" tray toggle (docs/claude/2026-11-04-presence-tray-plan.md). The user's own check box: checked (the default,
// and every time the program starts) means the user is using the computer, so Claude's heavy work is capped
// (scripts/dev/presence.mjs); unchecked means no cap. It only writes %LOCALAPPDATA%\claude-presence\presence.json: no screen,
// no keyboard, no list of programs. Built with the C# compiler that ships with Windows (tools/presence-tray/build.ps1); C# 5 only.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program {
  [STAThread]
  static void Main() {
    bool created;
    using (Mutex mutex = new Mutex(true, @"Local\ClaudePresenceTray", out created)) {
      if (!created) return; // One tray icon only.
      Application.EnableVisualStyles();
      Application.Run(new PresenceTray());
    }
  }
}

sealed class PresenceTray : ApplicationContext {
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool SetProcessWorkingSetSize(IntPtr process, IntPtr min, IntPtr max);
  /** Give back the memory start-up used (it stays idle in the tray). */
  static void Trim() { try { GC.Collect(); SetProcessWorkingSetSize(Process.GetCurrentProcess().Handle, (IntPtr)(-1), (IntPtr)(-1)); } catch (Exception) { } }

  readonly string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "claude-presence");
  readonly NotifyIcon tray = new NotifyIcon();
  readonly ToolStripMenuItem toggle = new ToolStripMenuItem("我在用电脑（勾着时 Claude 收着用）");
  readonly ToolStripMenuItem running = new ToolStripMenuItem();
  readonly System.Windows.Forms.Timer heartbeat = new System.Windows.Forms.Timer();
  bool present = true;
  DateTime changedAt = DateTime.UtcNow;
  Icon shown;

  public PresenceTray() {
    Directory.CreateDirectory(dir);
    running.Enabled = false;
    toggle.Click += delegate { Set(!present); };
    ToolStripMenuItem quit = new ToolStripMenuItem("退出（退出后 Claude 按“在”处理）");
    quit.Click += delegate { Write(true); tray.Visible = false; heartbeat.Stop(); ExitThread(); };
    ContextMenuStrip menu = new ContextMenuStrip();
    menu.Items.Add(toggle);
    menu.Items.Add(running);
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add(quit);
    menu.Opening += delegate { Refresh(); };
    menu.Closed += delegate { Trim(); };
    tray.ContextMenuStrip = menu;
    tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Set(!present); };
    // The readers treat a file not refreshed for two minutes as "在" (the tray is gone): refresh it well inside that.
    heartbeat.Interval = 20000;
    heartbeat.Tick += delegate { Write(present); Refresh(); };
    Set(true); // Every start is "在": after a reboot the user is at the computer.
    tray.Visible = true;
    heartbeat.Start();
    Trim();
  }

  void Set(bool value) {
    if (value != present) changedAt = DateTime.UtcNow;
    present = value;
    Write(value);
    Refresh();
  }

  void Write(bool value) {
    try {
      string json = "{\"version\":1,\"present\":" + (value ? "true" : "false")
        + ",\"changedAt\":\"" + changedAt.ToString("o") + "\",\"heartbeatAt\":\"" + DateTime.UtcNow.ToString("o") + "\"}\n";
      string file = Path.Combine(dir, "presence.json"), temp = file + ".tmp";
      File.WriteAllText(temp, json, new UTF8Encoding(false));
      if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
    } catch (Exception) { /* Readers fall back to "在" when the file is missing or old. */ }
  }

  int RunningHeavy() {
    int count = 0;
    try {
      string slots = Path.Combine(dir, "slots");
      if (!Directory.Exists(slots)) return 0;
      foreach (string file in Directory.GetFiles(slots, "*.json")) {
        int pid;
        if (!int.TryParse(Path.GetFileNameWithoutExtension(file), out pid)) continue;
        try { using (Process process = Process.GetProcessById(pid)) { if (!process.HasExited) count++; } } catch (Exception) { }
      }
    } catch (Exception) { }
    return count;
  }

  void Refresh() {
    int count = RunningHeavy();
    toggle.Checked = present;
    running.Text = "Claude 正在跑的重活：" + count + " 件";
    string tip = present ? "在用电脑：Claude 最多同时 1 件重活（正在跑 " + count + "）" : "不在：Claude 不设上限（正在跑 " + count + "）";
    tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
    Icon next = Draw(present);
    tray.Icon = next;
    if (shown != null) shown.Dispose();
    shown = next;
  }

  static Icon Draw(bool present) {
    using (Bitmap bitmap = new Bitmap(32, 32)) {
      using (Graphics g = Graphics.FromImage(bitmap)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);
        Color fill = present ? Color.FromArgb(59, 165, 93) : Color.FromArgb(138, 143, 152);
        using (SolidBrush brush = new SolidBrush(fill)) g.FillEllipse(brush, 3, 3, 26, 26);
        using (Pen pen = new Pen(Color.White, 3)) {
          if (present) g.DrawLines(pen, new Point[] { new Point(10, 16), new Point(14, 21), new Point(22, 11) });
          else g.DrawLine(pen, 10, 16, 22, 16);
        }
      }
      IntPtr handle = bitmap.GetHicon();
      try { using (Icon raw = Icon.FromHandle(handle)) return (Icon)raw.Clone(); }
      finally { DestroyIcon(handle); }
    }
  }
}
