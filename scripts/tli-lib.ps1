# Shared by capture-window.ps1 (one grab), windows-ocr.ps1 (one OCR run) and worker.ps1 (both,
# kept warm while a Black Sail choice screen is open). Dot-source it: . "$PSScriptRoot\..\tli-lib.ps1"
# Read-only: copies pixels from the screen and reads image files; never touches the game process.

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TliWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class TliPix {
    // Average RGB of the brightest 20% of pixels in the box (the text, not the dark background).
    public static int[] TextColor(Bitmap bmp, int x, int y, int w, int h) {
        x = Math.Max(0, x); y = Math.Max(0, y);
        w = Math.Min(w, bmp.Width - x); h = Math.Min(h, bmp.Height - y);
        if (w <= 0 || h <= 0) return new int[] { 0, 0, 0 };
        BitmapData d = bmp.LockBits(new Rectangle(x, y, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        byte[] buf = new byte[d.Stride * h];
        Marshal.Copy(d.Scan0, buf, 0, buf.Length);
        bmp.UnlockBits(d);
        int n = w * h; int[] lum = new int[n]; int k = 0;
        for (int r = 0; r < h; r++) for (int c = 0; c < w; c++) {
            int i = r * d.Stride + c * 3; lum[k++] = buf[i] + buf[i + 1] + buf[i + 2];
        }
        int[] sorted = (int[])lum.Clone(); Array.Sort(sorted);
        int cut = sorted[(int)(n * 0.8)];
        long sr = 0, sg = 0, sb = 0, cnt = 0; k = 0;
        for (int r = 0; r < h; r++) for (int c = 0; c < w; c++, k++) {
            if (lum[k] < cut) continue;
            int i = r * d.Stride + c * 3; sb += buf[i]; sg += buf[i + 1]; sr += buf[i + 2]; cnt++;
        }
        if (cnt == 0) return new int[] { 0, 0, 0 };
        return new int[] { (int)(sr / cnt), (int)(sg / cnt), (int)(sb / cnt) };
    }

    // 16x16 box-averaged greyscale of the region, the share of pixels brighter than 160/255,
    // the brightest pixel and the share brighter than 90/255.
    const int G = 16;
    public static int[] Fingerprint(Bitmap bmp, int x, int y, int w, int h, out double bright, out int max, out double lit) {
        bright = 0; max = 0; lit = 0;
        x = Math.Max(0, x); y = Math.Max(0, y);
        w = Math.Min(w, bmp.Width - x); h = Math.Min(h, bmp.Height - y);
        int[] g = new int[G * G];
        if (w < G || h < G) return g;
        BitmapData d = bmp.LockBits(new Rectangle(x, y, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        byte[] buf = new byte[d.Stride * h];
        Marshal.Copy(d.Scan0, buf, 0, buf.Length);
        bmp.UnlockBits(d);
        long[] sum = new long[G * G]; int[] cnt = new int[G * G]; long brightCount = 0; long litCount = 0;
        for (int r = 0; r < h; r++) for (int c = 0; c < w; c++) {
            int i = r * d.Stride + c * 3;
            int v = (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
            if (v > 160) brightCount++;
            if (v > 90) litCount++;
            if (v > max) max = v;
            int cell = (r * G / h) * G + (c * G / w);
            sum[cell] += v; cnt[cell]++;
        }
        for (int k = 0; k < G * G; k++) g[k] = cnt[k] > 0 ? (int)(sum[k] / cnt[k]) : 0;
        bright = (double)brightCount / (w * h);
        lit = (double)litCount / (w * h);
        return g;
    }
}
'@
# Physical pixels, so grabs match the game's real resolution on scaled displays.
[void][TliWin]::SetProcessDPIAware()

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) {
    $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result
}
# en-US is the only OCR language installed on this PC, so the user-profile engine is English.
$script:engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

# Where the game window is: its handle (for a window capture), its whole frame and its client
# area in screen pixels, and whether it is minimized or in front.
function Get-GameWindow([string]$ProcessName = 'torchlight_infinite') {
    $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $proc) { return @{ ok = $false; reason = 'game window not found' } }
    $h = $proc.MainWindowHandle
    $wr = New-Object TliWin+RECT
    [void][TliWin]::GetWindowRect($h, [ref]$wr)
    $cr = New-Object TliWin+RECT
    [void][TliWin]::GetClientRect($h, [ref]$cr)
    $p = New-Object TliWin+POINT
    [void][TliWin]::ClientToScreen($h, [ref]$p)
    return @{
        ok = $true; hwnd = $h.ToInt64(); title = $proc.MainWindowTitle
        minimized = [TliWin]::IsIconic($h); foreground = ([TliWin]::GetForegroundWindow() -eq $h)
        window = @{ x = $wr.L; y = $wr.T; width = $wr.R - $wr.L; height = $wr.B - $wr.T }
        client = @{ x = $p.X; y = $p.Y; width = $cr.R - $cr.L; height = $cr.B - $cr.T }
    }
}

# One frame of the game window's client area to a PNG or JPEG file. Returns a hashtable:
# { ok, file, x, y, width, height } (client area on screen, physical pixels) or { ok = $false, reason }.
# The window must be visible and in front: a screen copy of a covered window would grab whatever
# is on top (PrintWindow is refused by the game).
function Grab-GameWindow([string]$Out, [string]$ProcessName = 'torchlight_infinite') {
    $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $proc) { return @{ ok = $false; reason = 'game window not found' } }
    $h = $proc.MainWindowHandle
    if ([TliWin]::IsIconic($h)) { return @{ ok = $false; reason = 'game window is minimized' } }
    $r = New-Object TliWin+RECT
    [void][TliWin]::GetClientRect($h, [ref]$r)
    $p = New-Object TliWin+POINT
    [void][TliWin]::ClientToScreen($h, [ref]$p)
    $w = $r.R - $r.L; $hgt = $r.B - $r.T
    if ($w -le 0 -or $hgt -le 0) { return @{ ok = $false; reason = 'game window has no size' } }
    if ([TliWin]::GetForegroundWindow() -ne $h) { return @{ ok = $false; reason = 'game window is not in front' } }
    # Made inside the try: a failure making the Graphics must not leave the Bitmap undisposed in the warm worker.
    $bmp = $null; $g = $null
    try {
        $bmp = New-Object System.Drawing.Bitmap $w, $hgt
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($p.X, $p.Y, 0, 0, (New-Object System.Drawing.Size $w, $hgt))
        if ($Out -match '\.jpe?g$') {
            # JPEG quality 92: ~0.3 MB per 1080p frame instead of ~1.5 MB PNG; text still OCRs cleanly.
            $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
            $params = New-Object System.Drawing.Imaging.EncoderParameters 1
            $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]92)
            $bmp.Save($Out, $codec, $params)
        } else {
            $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
        }
    } finally { if ($g) { $g.Dispose() }; if ($bmp) { $bmp.Dispose() } }
    return @{ ok = $true; file = $Out; x = $p.X; y = $p.Y; width = $w; height = $hgt }
}

# Windows OCR of image files: per file { file, width, height, lines[], regions[] }.
# -Regions "x,y,w,h;x,y,w,h" (1920x1080 coordinates, scaled to each image) adds per region a 16x16
# greyscale fingerprint, the bright-pixel colour, bright share (> 160), brightest pixel and lit share (> 90).
function Read-Images([string[]]$Paths, [string]$Regions = '') {
    $results = foreach ($p in $Paths) {
        $full = (Resolve-Path $p).Path
        # try/finally: the warm worker lives on after a failed read, and an undisposed stream or
        # Bitmap would keep the frame file locked (and leak the handle) until it exits.
        $stream = $null; $pix = $null; $bitmap = $null
        try {
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $ocr = Await ($script:engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $stream.Dispose(); $stream = $null
        $pix = [System.Drawing.Bitmap]::new($full)
        $page = [pscustomobject]@{
            file   = (Split-Path $p -Leaf)
            width  = $bitmap.PixelWidth
            height = $bitmap.PixelHeight
            lines = @($ocr.Lines | ForEach-Object {
                $xs = $_.Words | ForEach-Object { $_.BoundingRect }
                $x = ($xs | Measure-Object X -Minimum).Minimum
                $y = ($xs | Measure-Object Y -Minimum).Minimum
                $r = ($xs | ForEach-Object { $_.X + $_.Width } | Measure-Object -Maximum).Maximum
                $b = ($xs | ForEach-Object { $_.Y + $_.Height } | Measure-Object -Maximum).Maximum
                $color = [TliPix]::TextColor($pix, [int]$x, [int]$y, [int]($r - $x), [int]($b - $y))
                [pscustomobject]@{ text = $_.Text; x = [int]$x; y = [int]$y; w = [int]($r - $x); h = [int]($b - $y); color = $color }
            })
            regions = @(if ($Regions) {
                $sx = $pix.Width / 1920; $sy = $pix.Height / 1080
                foreach ($spec in $Regions.Split(';')) {
                    $v = $spec.Split(',') | ForEach-Object { [double]$_ }
                    $rx = [int]($v[0] * $sx); $ry = [int]($v[1] * $sy); $rw = [int]($v[2] * $sx); $rh = [int]($v[3] * $sy)
                    $bright = 0.0; $max = 0; $lit = 0.0
                    $fp = [TliPix]::Fingerprint($pix, $rx, $ry, $rw, $rh, [ref]$bright, [ref]$max, [ref]$lit)
                    [pscustomobject]@{ gray = $fp; color = [TliPix]::TextColor($pix, $rx, $ry, $rw, $rh); bright = [math]::Round($bright, 4); max = $max; lit = [math]::Round($lit, 4) }
                }
            })
        }
        $page
        } finally {
            if ($stream) { $stream.Dispose() }
            if ($pix) { $pix.Dispose() }
            if ($bitmap) { $bitmap.Dispose() } # SoftwareBitmap holds the decoded frame until disposed
        }
    }
    return @($results)
}
