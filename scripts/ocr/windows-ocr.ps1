# Windows built-in OCR (Windows.Media.Ocr) of one or more images, written as JSON to -Out:
# per image { file, width, height, lines: [{ text, x, y, w, h, color }], regions: [...] }.
# -Regions "x,y,w,h;x,y,w,h" (in 1920x1080 coordinates, scaled to each image) also returns, per
# region, a 16x16 greyscale fingerprint, the bright-pixel colour, how much of it is bright
# (> 160, used to recognise flame icons), its brightest pixel and how much is lit (> 90, used to
# see the thin outline of a selected card's button).
# The logic is in ../tli-lib.ps1 (shared with the worker that stays warm while a choice screen is open).
param([Parameter(Mandatory)][string[]]$Paths, [Parameter(Mandatory)][string]$Out, [string]$Regions = '')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\tli-lib.ps1"
Read-Images -Paths $Paths -Regions $Regions | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $Out
