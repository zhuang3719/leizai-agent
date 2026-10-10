# LeiZai A1 shell build script (T-B4)
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-webview2-shell.ps1
# 下载(缓存) Microsoft.Web.WebView2 → 解出 Core.dll / WinForms.dll / WebView2Loader.dll
# 用 csc 编译 shell/*.cs → LeiZai.exe；WebView2Loader.dll 随 exe 拷贝同目录。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ver = '1.0.4191.47'          # 钉死版本
$cache = Join-Path $root 'scripts\data\webview2'
$libdir = Join-Path $root 'shell\lib'
$utf8bom = New-Object System.Text.UTF8Encoding($true)

New-Item -ItemType Directory -Path $cache -Force | Out-Null
New-Item -ItemType Directory -Path $libdir -Force | Out-Null

# 1) 确保 shell/*.cs 为 UTF-8 BOM（csc 靠 BOM 判定编码，含中文）
Get-ChildItem (Join-Path $root 'shell\*.cs') | ForEach-Object {
    $txt = [System.IO.File]::ReadAllText($_.FullName)
    [System.IO.File]::WriteAllText($_.FullName, $txt, $utf8bom)
}

# 2) 下载并缓存 nupkg
$nupkg = Join-Path $cache ("Microsoft.Web.WebView2.$ver.nupkg")
if (-not (Test-Path $nupkg)) {
    $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$ver/microsoft.web.webview2.$ver.nupkg"
    Write-Output ("DOWNLOAD " + $url)
    Invoke-WebRequest -Uri $url -OutFile $nupkg -UseBasicParsing -TimeoutSec 180
}
Write-Output ("NUPKG " + (Get-Item $nupkg).Length + " bytes")

# 3) 解出所需 DLL
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($nupkg)
try {
    $want = @{
        'lib/net462/Microsoft.Web.WebView2.Core.dll'      = 'Microsoft.Web.WebView2.Core.dll'
        'lib/net462/Microsoft.Web.WebView2.WinForms.dll'  = 'Microsoft.Web.WebView2.WinForms.dll'
        'runtimes/win-x64/native/WebView2Loader.dll'      = 'WebView2Loader.dll'
    }
    foreach ($e in $zip.Entries) {
        if ($want.ContainsKey($e.FullName)) {
            $dest = Join-Path $libdir $want[$e.FullName]
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
            Write-Output ("EXTRACT " + $e.FullName + " -> " + $want[$e.FullName])
        }
    }
} finally { $zip.Dispose() }

# 4) 编译
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$out = Join-Path $root 'LeiZai.exe'
$refs = @(
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    '/r:System.Web.Extensions.dll',
    ('/r:' + (Join-Path $libdir 'Microsoft.Web.WebView2.Core.dll')),
    ('/r:' + (Join-Path $libdir 'Microsoft.Web.WebView2.WinForms.dll')),
    ('/r:' + (Join-Path $root '_tools\velopack\lib\Velopack.dll')),
    ('/r:' + (Join-Path $root '_tools\velopack\lib\Newtonsoft.Json.dll'))
)
$sources = Get-ChildItem (Join-Path $root 'shell\*.cs') | ForEach-Object { $_.FullName }
# v6.53：内嵌原生遮罩品牌海报（loop 首帧）——确保 exe 任意目录运行都有品牌帧（资源名=boot_loop_first_frame.png）
$resArgs = @()
foreach ($png in @('boot_loop_first_frame.png', 'boot_intro_first_frame.png')) {
    $pp = Join-Path $root ('shell\boot_masks\' + $png)
    if (Test-Path $pp) { $resArgs += ('/resource:' + $pp) }
}

# 安全加固 A（2026-10-08）：发布构建（LEIZAI_RELEASE=1）加 /define:RELEASE_BUILD，
#   使 Shell.cs 在 #if RELEASE_BUILD 段注入 env LEIZAI_RELEASE=1（env 权威，删 .release 不降级）；dev 构建不加。
$defArgs = @()
if ($env:LEIZAI_RELEASE -eq '1') {
    $defArgs += '/define:RELEASE_BUILD'
    Write-Output 'DEFINE RELEASE_BUILD（发布构建：Shell 注入 LEIZAI_RELEASE=1）'
}
$cscArgs = @('/nologo', '/target:winexe', '/optimize', '/platform:x64',
    ('/win32icon:' + (Join-Path $root 'shell\LeiZai2.ico')),
    ('/out:' + $out)) + $defArgs + $refs + $resArgs + $sources
$out2 = & $csc $cscArgs 2>&1
$errs = $out2 | Where-Object { $_ -match ': error' }
if ($errs) {
    Write-Output "BUILD FAIL"
    $errs
    exit 1
}

# 安全加固A 断言（2026-10-08）：注入生效的可核验构建断言（编译后、混淆前）。
#   release 构建（/define:RELEASE_BUILD）产物**必须**含 UTF-16 串 LEIZAI_RELEASE；
#   dev 构建产物**必须不含**（红线：dev 绝不注入）。把"注入生效"从"解包 grep（混淆后不可行）"变为硬断言。
$hasInject = [System.Text.Encoding]::Unicode.GetString([System.IO.File]::ReadAllBytes($out)).Contains('LEIZAI_RELEASE')
if ($env:LEIZAI_RELEASE -eq '1') {
    if (-not $hasInject) { throw "ASSERT FAIL：release 产物缺 LEIZAI_RELEASE 注入串（A 加固未生效）" }
    Write-Output 'ASSERT OK：release 产物含 LEIZAI_RELEASE 注入串'
} else {
    if ($hasInject) { throw "ASSERT FAIL：dev 产物意外含 LEIZAI_RELEASE 注入串（红线：dev 不得注入）" }
    Write-Output 'ASSERT OK：dev 产物不含 LEIZAI_RELEASE 注入串（符合红线）'
}

# 5) 托管 DLL + Loader DLL 随 exe 拷贝同目录（csc /r 只引用，运行时需同目录可加载）
foreach ($dll in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')) {
    Copy-Item (Join-Path $libdir $dll) (Join-Path $root $dll) -Force
}
# P1：Velopack 运行时 DLL 随 exe 拷贝（未安装态需可加载，不崩）
foreach ($dll in @('Velopack.dll', 'Newtonsoft.Json.dll')) {
    Copy-Item (Join-Path $root ('_tools\velopack\lib\' + $dll)) (Join-Path $root $dll) -Force
}

# v6.55：本地 splash 页随 exe 拷贝（file:// 零引擎依赖，开机即动画）
$splashSrc = Join-Path $root 'shell\boot_splash'
if (Test-Path $splashSrc) {
    $splashDst = Join-Path $root 'boot_splash'
    if (Test-Path $splashDst) { Remove-Item -Recurse -Force $splashDst -ErrorAction SilentlyContinue }
    Copy-Item -Recurse -Force $splashSrc $splashDst
    Write-Output ("SPLASH assets -> " + $splashDst)
}
Write-Output ("BUILD OK " + (Get-Item $out).LastWriteTime.ToString('HH:mm:ss'))
Write-Output ("EXE " + $out + " · WebView2 DLLs 已随 exe 拷贝同目录")

# P3（多雷影防破解）：发布构建标记 .release —— 使发布构建恒 enforce（gate.js:_RELEASE），
#   config 的 pro.devAllowAll 与 env LEIZAI_PRO_DEV 均失效。
#   仅当**构建期**显式注入 env LEIZAI_RELEASE=1 时写入；开发构建不写（避免误封 dev 实例）。
if ($env:LEIZAI_RELEASE -eq '1') {
    $flag = Join-Path $root '.release'
    [System.IO.File]::WriteAllText($flag, "release`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Output ("RELEASE FLAG -> " + $flag + "（发布构建恒 enforce）")
} else {
    Write-Output "SKIP .release（非发布构建；发布请设 $env:LEIZAI_RELEASE=1 或改用出包流程）"
}
