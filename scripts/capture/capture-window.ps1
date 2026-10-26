# Grabs ONE frame of the Torchlight: Infinite window (client area) to a PNG/JPEG and prints one
# JSON line: { ok, file, x, y, width, height } or { ok: false, reason }. The logic is in
# ../tli-lib.ps1 (shared with the worker that stays warm while a choice screen is open).
param([Parameter(Mandatory)][string]$Out, [string]$ProcessName = 'torchlight_infinite')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\tli-lib.ps1"
Grab-GameWindow -Out $Out -ProcessName $ProcessName | ConvertTo-Json -Compress
