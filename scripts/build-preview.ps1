# LeiZai shadow preview build script (ASCII-only, encoding-safe)
# Build LeiZai-preview.exe from app_preview tree, independent of official build.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-preview.ps1 [-Open]
param([switch]$Open)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$utf8bom = New-Object System.Text.UTF8Encoding($true)

$srcDir = Join-Path $root 'app_preview'
$out = Join-Path $root 'LeiZai-preview.exe'

# 1) copy official app/*.cs into preview tree
if (Test-Path $srcDir) { Remove-Item $srcDir -Recurse -Force }
New-Item -ItemType Directory -Path $srcDir -Force | Out-Null
Get-ChildItem (Join-Path $root 'app\*.cs') | ForEach-Object { Copy-Item $_.FullName (Join-Path $srcDir $_.Name) -Force }

# 2) customize preview mutex name so preview can run in parallel with official
$prog = Join-Path $srcDir 'Program.cs'
$progTxt = [System.IO.File]::ReadAllText($prog, $utf8bom)
$progTxt = $progTxt.Replace('LeiZai_Desktop_SingleInstance_NewBody3458', 'LeiZai_Desktop_SingleInstance_NewBody3458_PREVIEW')
[System.IO.File]::WriteAllText($prog, $progTxt, $utf8bom)

# 2b) add "(preview)" badge to window title so preview is clearly distinguishable from official
$main = Join-Path $srcDir 'MainForm.cs'
$mainTxt = [System.IO.File]::ReadAllText($main, $utf8bom)
# original title:  Text = "\u96F7\u4ED4 \u00B7 NEW BODY"
# append preview badge:  "\u00B7 \u9884\u89C8"  =>  "NEW BODY \u00B7 \u9884\u89C8"
$mainTxt = $mainTxt.Replace('Text = "\u96F7\u4ED4 \u00B7 NEW BODY";', 'Text = "\u96F7\u4ED4 \u00B7 NEW BODY \u00B7 \u9884\u89C8";')
# in-UI title is the self-drawn logo label:  logo.Text = "\u26A1  \u96F7\u4ED4"
# append preview badge to the in-UI title:  "\u96F7\u4ED4" => "\u96F7\u4ED4 \u00B7 \u9884\u89C8"
$mainTxt = $mainTxt.Replace('logo.Text = "\u26A1  \u96F7\u4ED4";', 'logo.Text = "\u26A1  \u96F7\u4ED4 \u00B7 \u9884\u89C8";')
# NOTE: window-size isolation is now built into official source (WindowStateStore picks
#       window-preview.json for -preview process, window.json otherwise). No need to replace here.
[System.IO.File]::WriteAllText($main, $mainTxt, $utf8bom)

# 3) ensure UTF-8 BOM on all preview sources (csc reads BOM to pick encoding)
Get-ChildItem $srcDir\*.cs | ForEach-Object {
    $t = [System.IO.File]::ReadAllText($_.FullName)
    [System.IO.File]::WriteAllText($_.FullName, $t, $utf8bom)
}

# 4) compile preview exe
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$wpf = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF'
$refs = @('/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', ('/r:' + (Join-Path $wpf 'WindowsFormsIntegration.dll')), ('/r:' + (Join-Path $wpf 'PresentationCore.dll')), ('/r:' + (Join-Path $wpf 'PresentationFramework.dll')), ('/r:' + (Join-Path $wpf 'WindowsBase.dll')), ('/r:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Xaml.dll'))
$sources = Get-ChildItem $srcDir\*.cs | ForEach-Object { $_.FullName }
$args = @('/nologo', '/target:winexe', '/optimize', ('/out:' + $out)) + $refs + $sources
$errs = & $csc $args 2>&1 | Where-Object { $_ -match 'error' }
if ($errs) {
    Write-Output "BUILD FAIL"
    $errs
    exit 1
}
Write-Output ("BUILD OK " + (Get-Item $out).LastWriteTime.ToString('HH:mm:ss'))
Write-Output ("preview exe: " + $out)

# 5) optionally auto-launch the preview window so user can see it immediately
if ($Open) {
    # kill any stale preview instance first (so it re-opens with fresh build)
    Get-Process -Name 'LeiZai-preview' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 300
    Start-Process -FilePath $out
    Write-Output "preview window launched"
}
