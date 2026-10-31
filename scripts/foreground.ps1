# Foreground watcher: prints which app's window is in front and whether it covers the game's
# window, once at start and again on each change, so the overlay can stay out of the way while the
# player works in another app over the game, and stay up when that app is on another monitor.
# Event-driven (WinEvent hooks): a window coming to the front, moved or resized, minimised or
# restored. It does nothing between those.
# Read-only: it only asks Windows about windows; never touches the game or its input.
#
# Output: one JSON line per change, { "pid": 1234, "name": "Discord", "covers": false }. "covers":
# the front window overlaps the game's window (true when the game's window isn't found). Runs until
# the overlay ends it.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class TliForeground {
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_MOVESIZEEND = 0x000B;
    const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016, EVENT_SYSTEM_MINIMIZEEND = 0x0017;
    const uint WINEVENT_OUTOFCONTEXT = 0;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    /** Overlaps thinner than this are shadows or borders, not one window over the other. */
    const int MIN_OVERLAP = 16;
    static WinEventProc keep; // held, so the callback isn't collected while hooked
    static string last = "";

    /** The visible bounds (without the invisible resize border Windows 10/11 adds around windows). */
    static RECT Bounds(IntPtr h) {
        RECT r;
        if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
        return r;
    }

    static IntPtr GameWindow() {
        foreach (Process p in Process.GetProcessesByName("torchlight_infinite")) if (p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle;
        return IntPtr.Zero;
    }

    static bool Covers(IntPtr front) {
        IntPtr game = GameWindow();
        if (game == IntPtr.Zero) return true; // can't tell: as if covered
        if (front == game) return false;
        if (IsIconic(game)) return true; // minimised: out of view (its bounds at -32000 overlap nothing)
        if (IsIconic(front)) return false;
        StringBuilder cls = new StringBuilder(64);
        GetClassName(front, cls, cls.Capacity);
        string c = cls.ToString();
        if (c == "Progman" || c == "WorkerW") return false; // the desktop
        RECT a = Bounds(front), b = Bounds(game);
        int w = Math.Min(a.R, b.R) - Math.Max(a.L, b.L), h = Math.Min(a.B, b.B) - Math.Max(a.T, b.T);
        return w > MIN_OVERLAP && h > MIN_OVERLAP;
    }

    static void Report() {
        IntPtr hwnd = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) return;
        string name = "";
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
        string line = "{\"pid\":" + pid + ",\"name\":\"" + name.Replace("\\", "").Replace("\"", "") + "\",\"covers\":" + (Covers(hwnd) ? "true" : "false") + "}";
        if (line == last) return;
        last = line;
        Console.Out.WriteLine(line);
        Console.Out.Flush();
    }

    public static void Run() {
        // Both windows' bounds in physical pixels, whichever monitor each is on and its scaling
        // (per-monitor aware, -4; older Windows: system aware).
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        keep = (hook, ev, hwnd, idObject, idChild, thread, time) => { if (idObject == 0) Report(); };
        SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, keep, 0, 0, WINEVENT_OUTOFCONTEXT);
        SetWinEventHook(EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND, IntPtr.Zero, keep, 0, 0, WINEVENT_OUTOFCONTEXT);
        SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, keep, 0, 0, WINEVENT_OUTOFCONTEXT);
        Report();
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); }
    }
}
'@
[TliForeground]::Run()
