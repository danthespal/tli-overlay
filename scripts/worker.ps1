# Capture + OCR worker: one PowerShell process kept warm while a Black Sail choice screen is open,
# so a grab starts in milliseconds instead of the 0.3-0.5 s a fresh process needs. It does
# nothing on its own: every grab and every read is a request from the overlay (which only sends
# them on the game's own log triggers), and the overlay stops it a few seconds after the last one.
#
# Protocol: one JSON object per line on stdin, one JSON line per reply on stdout.
#   { id, op: "grab", out }                 -> { id, ok, file, x, y, width, height } | { id, ok: false, reason }
#   { id, op: "window" }                    -> { id, ok, hwnd, title, minimized, foreground, window: {x,y,width,height}, client: {...} }
#   { id, op: "ocr", paths: [...], regions } -> { id, pages: [...] }      (regions as in windows-ocr.ps1)
#   { op: "quit" }                          -> exits
# Any failure replies { id, error }. The first line written is { "ready": true }.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\tli-lib.ps1"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$in = [Console]::In
$out = [Console]::Out
$out.WriteLine('{"ready":true}')
$out.Flush()
while ($null -ne ($line = $in.ReadLine())) {
    if (-not $line.Trim()) { continue }
    $id = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        switch ($req.op) {
            'grab' {
                $r = Grab-GameWindow -Out ([string]$req.out)
                $r.id = $id
                $out.WriteLine(($r | ConvertTo-Json -Compress))
            }
            'window' {
                $r = Get-GameWindow
                $r.id = $id
                $out.WriteLine(($r | ConvertTo-Json -Depth 4 -Compress))
            }
            'ocr' {
                $pages = Read-Images -Paths @($req.paths) -Regions ([string]$req.regions)
                $out.WriteLine((@{ id = $id; pages = @($pages) } | ConvertTo-Json -Depth 6 -Compress))
            }
            'quit' { exit 0 }
            default { $out.WriteLine((@{ id = $id; error = "unknown op '$($req.op)'" } | ConvertTo-Json -Compress)) }
        }
    } catch {
        $out.WriteLine((@{ id = $id; error = "$_" } | ConvertTo-Json -Compress))
    }
    $out.Flush()
}
