# A1 · 免构建前端发布（webui 源 → webui/dist 静态根，供 src/server.js serveStatic 托管）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-webui.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'webui'
$dst  = Join-Path $src  'dist'

if (-not (Test-Path $src)) { throw "webui 源目录不存在: $src" }

# ---- 构建前 JS 语法门禁（refs=build-gate，2026-10-10）----
# 目的：源 JS 语法错永不进 dist（历史上 dock.js 残缺经 build 带进 dist → 整站白屏）。
# 做法：构建前对 webui/js/**/*.js 逐个强语法校验；任一失败 → 打印坏文件名+错误 → 中止构建（**不触碰 dist**）。
# 实现：webui 的 js 是 ESM（含 import），`node --check *.js` 会按 CJS 误报 → 复制为临时 .mjs 再 check。
$jsRoot = Join-Path $src 'js'
if (Test-Path $jsRoot) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw "构建中止：未找到 node，无法执行 JS 语法门禁" }
  $sgTmp = Join-Path ([System.IO.Path]::GetTempPath()) ('webui_syntax_' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $sgTmp -Force | Out-Null
  $sgFiles = Get-ChildItem -Recurse -File -Path $jsRoot -Filter *.js | Where-Object { $_.Name -notlike '*.bak*' }
  $sgBad = @()
  foreach ($sgf in $sgFiles) {
    $sgt = Join-Path $sgTmp ($sgf.BaseName + '_' + [Math]::Abs($sgf.FullName.GetHashCode()) + '.mjs')
    Copy-Item $sgf.FullName $sgt -Force
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $sgo = (& node --check $sgt 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($code -ne 0) { $sgBad += [pscustomobject]@{ Rel = $sgf.FullName.Replace($root + '\', ''); Err = $sgo.Trim() } }
  }
  Remove-Item -Recurse -Force $sgTmp -ErrorAction SilentlyContinue
  if ($sgBad.Count -gt 0) {
    Write-Host "❌ JS 语法门禁未通过 → 构建中止（dist 未改动）："
    foreach ($b in $sgBad) { Write-Host ("  - " + $b.Rel); Write-Host ("      " + $b.Err) }
    throw ("构建中止：" + $sgBad.Count + " 个源文件存在 JS 语法错误")
  }
  Write-Output ("JS 语法门禁通过（" + $sgFiles.Count + " 个文件）")
}

# ---- 角色色键集一致性断言（refs=custom-role-avatar-fx，2026-10-10）----
# 目的：角色色定义散落多处（ROLE_META(roles.js) / base.css --role-* / themes.css .role-* / dock.js _roleColor），
#       新增预置角色若漏改其一 → 中枢 orbit/avatar 无色。构建期强制键集一致，不一致 → 中止（不触碰 dist）。
# 单一权威 = roles.js ROLE_META 的 cls→token 映射；base.css / themes.css 必须与之键集相等。
# dock.js 的硬编码色表已删除（改由 ROLE_META 派生），故不再参与比对。
$rolesJs   = Join-Path $src 'js\roles.js'
$baseCss2  = Join-Path $src 'styles\base.css'
$themesCss2= Join-Path $src 'styles\themes.css'
$roleAssertErrors = @()
foreach ($p in @($rolesJs, $baseCss2, $themesCss2)) { if (-not (Test-Path $p)) { $roleAssertErrors += "缺文件: $p" } }
if ($roleAssertErrors.Count -eq 0) {
  $rolesTxt  = Get-Content -Raw -Encoding UTF8 $rolesJs
  $rmMatch = [regex]::Match($rolesTxt, 'ROLE_META\s*=\s*\{(?<body>[\s\S]*?)\n\};')
  $expectSet = @()
  if ($rmMatch.Success) {
    foreach ($m in [regex]::Matches($rmMatch.Groups['body'].Value, "cls:\s*'role-(?<t>[A-Za-z0-9_-]+)'")) { $expectSet += $m.Groups['t'].Value }
    $expectSet = @($expectSet | Sort-Object -Unique)
  } else { $roleAssertErrors += 'roles.js 未解析到 ROLE_META 定义块' }
  if ($expectSet.Count -eq 0) { $roleAssertErrors += 'ROLE_META 未解析出任何 cls token' }
  $baseTxt   = Get-Content -Raw -Encoding UTF8 $baseCss2
  $themeTxt  = Get-Content -Raw -Encoding UTF8 $themesCss2
  $baseSet  = @([regex]::Matches($baseTxt,  '--role-(?<t>[A-Za-z0-9_-]+)\s*:')  | ForEach-Object { $_.Groups['t'].Value } | Sort-Object -Unique)
  $themeSet = @([regex]::Matches($themeTxt, '(?m)^\s*\.role-(?<t>[A-Za-z0-9_-]+)\s*\{') | ForEach-Object { $_.Groups['t'].Value } | Sort-Object -Unique)
  $dBase  = Compare-Object $expectSet $baseSet  -ErrorAction SilentlyContinue
  $dTheme = Compare-Object $expectSet $themeSet -ErrorAction SilentlyContinue
  if ($dBase)  { $roleAssertErrors += ('ROLE_META ↔ base.css --role-* 不一致：'   + (($dBase  | ForEach-Object { $_.SideIndicator + $_.InputObject }) -join ' ')) }
  if ($dTheme) { $roleAssertErrors += ('ROLE_META ↔ themes.css .role-* 不一致：' + (($dTheme | ForEach-Object { $_.SideIndicator + $_.InputObject }) -join ' ')) }
}
if ($roleAssertErrors.Count -gt 0) {
  Write-Host "❌ 角色色键集断言未通过 → 构建中止（dist 未改动）："
  foreach ($e in $roleAssertErrors) { Write-Host ("  - " + $e) }
  throw ("构建中止：角色色定义多处不一致（" + $roleAssertErrors.Count + " 项）")
}
Write-Output ("角色色键集断言通过（ROLE_META=" + $expectSet.Count + "，base.css=" + $baseSet.Count + "，themes.css=" + $themeSet.Count + "）")

# 清理旧 dist（若被占用则跳过清理，改为覆盖复制，避免整体失败）
if (Test-Path $dst) {
  try { Remove-Item -Recurse -Force $dst -ErrorAction Stop } catch { Write-Warning "dist 占用中，改为覆盖复制：$($_.Exception.Message)" }
}
New-Item -ItemType Directory -Path $dst -Force | Out-Null

# 仅发布运行时需要的部分（排除 dist 自身与草稿备份）
$items = @('index.html', 'styles', 'assets', 'js', 'vendor')
foreach ($it in $items) {
  $s = Join-Path $src $it
  if (Test-Path $s) { Copy-Item -Recurse -Force $s (Join-Path $dst $it) }
}

# 清理误入 dist 的备份/临时文件（*.bak* / *~），避免污染部署目录
Get-ChildItem -Recurse -File $dst -Include *.bak*,*~ -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

# scrub sensitive files (signature/keys/tokens) that may have slipped into dist
Get-ChildItem -Recurse -File $dst -Include *.key,*.pem,*.pfx,*token*,*_pat*,id_rsa* -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Recurse -File $dst -Filter '.devsign' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
foreach ($d in @('secrets','_secrets')) { $sp = Join-Path $dst $d; if (Test-Path $sp) { Remove-Item -Recurse -Force $sp } }
# assert: release dir must contain NO sensitive items (throw = abort publish)
$assert = Join-Path $PSScriptRoot 'assert-pack-clean.ps1'
if (Test-Path $assert) { & $assert -Path $dst -SkipRequireAssets }   # 局部目录：跳过必需资产正向断言

# 校验关键文件
$need = @('index.html', 'js\app.js', 'vendor\vue.esm-browser.js', 'styles\themes.css')
foreach ($n in $need) {
  if (-not (Test-Path (Join-Path $dst $n))) { throw "发布缺失关键文件: $n" }
}
Write-Output ("WEBUI BUILD OK -> " + $dst)
Get-ChildItem -Recurse $dst -File | Measure-Object -Property Length -Sum | ForEach-Object { Write-Output ("files=" + $_.Count + " bytes=" + $_.Sum) }
