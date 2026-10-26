# Turns OCR output of the Seal Whisper handbook into rows: effect text, timemark range, rarity (icon colour).
param([string]$Ocr, [string]$Dir, [string]$Out)
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

function Get-Rarity([System.Drawing.Bitmap]$bmp, [int]$cy) {
    # Most saturated pixel in a box around the row icon (x ~353).
    $best = $null; $bestSat = -1
    for ($x = 338; $x -le 368; $x++) { for ($y = $cy - 15; $y -le $cy + 15; $y++) {
        $c = $bmp.GetPixel($x, $y); $s = $c.GetSaturation() * $c.GetBrightness()
        if ($s -gt $bestSat) { $bestSat = $s; $best = $c } } }
    # Calibrated on handbook screenshots: white icons are pale blue-violet (hue ~213-223),
    # blue icons are cyan-blue (~194-208), purple ~254-300, orange ~42-49.
    $h = $best.GetHue()
    if ($h -ge 15 -and $h -lt 70) { 'orange' } elseif ($h -ge 180 -and $h -lt 210) { 'blue' } elseif ($h -ge 210 -and $h -lt 240) { 'white' } elseif ($h -ge 240 -and $h -lt 330) { 'purple' } else { "hue$([int]$h)" }
}

$pages = Get-Content $Ocr -Raw | ConvertFrom-Json
$rows = foreach ($p in $pages) {
    $bmp = [System.Drawing.Bitmap]::new((Join-Path $Dir $p.file))
    $text = @($p.lines | Where-Object { $_.x -ge 385 -and $_.x -le 410 -and $_.y -gt 300 -and $_.y -lt 860 } | Sort-Object y)
    $tm = @($p.lines | Where-Object { $_.x -ge 1400 -and $_.y -gt 300 })
    $i = 0
    while ($i -lt $text.Count) {
        $first = $text[$i]; $parts = @($first.text); $last = $first
        # A second line belongs to the row if it follows within one line height and has no timemark of its own.
        while ($i + 1 -lt $text.Count -and ($text[$i + 1].y - $last.y) -lt 40) { $i++; $last = $text[$i]; $parts += $last.text }
        $cy = [int](($first.y + $last.y + $last.h) / 2)
        $t = $tm | Where-Object { [math]::Abs(($_.y + $_.h / 2) - $cy) -lt 30 } | Select-Object -First 1
        if ($cy -lt 860) {
            [pscustomobject]@{ file = $p.file; y = $cy; rarity = (Get-Rarity $bmp $cy); timemark = $t.text; effect = ($parts -join ' ') }
        }
        $i++
    }
    $bmp.Dispose()
}
$rows | ConvertTo-Json -Depth 3 | Out-File -Encoding utf8 $Out
$rows | Format-Table rarity, timemark, effect -AutoSize -Wrap | Out-String -Width 220
