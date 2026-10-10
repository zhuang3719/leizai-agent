# LeiZai desktop client build script (ASCII-only, encoding-safe)
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-client.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$utf8bom = New-Object System.Text.UTF8Encoding($true)

# ensure UTF-8 BOM on all sources (csc reads BOM to pick correct encoding)
Get-ChildItem (Join-Path $root 'app\*.cs') | ForEach-Object {
    $txt = [System.IO.File]::ReadAllText($_.FullName)
    [System.IO.File]::WriteAllText($_.FullName, $txt, $utf8bom)
}

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$out = Join-Path $root 'LeiZai_legacy.exe'   # v6.50：旧 app/ 客户端已退役，改名防与 A1 外壳 LeiZai.exe 撞名
$wpf = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF'
$refs = @('/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll',
    ('/r:' + (Join-Path $wpf 'WindowsFormsIntegration.dll')),
    ('/r:' + (Join-Path $wpf 'PresentationCore.dll')),
    ('/r:' + (Join-Path $wpf 'PresentationFramework.dll')),
    ('/r:' + (Join-Path $wpf 'WindowsBase.dll')),
    ('/r:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Xaml.dll'))
$sources = Get-ChildItem (Join-Path $root 'app\*.cs') | ForEach-Object { $_.FullName }
$args = @('/nologo', '/target:winexe', '/optimize', ('/out:' + $out)) + $refs + $sources
$out2 = & $csc $args 2>&1
$errs = $out2 | Where-Object { $_ -match 'error' }
if ($errs) {
    Write-Output "BUILD FAIL"
    $errs
    exit 1
}
Write-Output ("BUILD OK " + (Get-Item $out).LastWriteTime.ToString('HH:mm:ss'))
