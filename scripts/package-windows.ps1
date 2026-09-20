param([Parameter(Mandatory=$true)][string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$mintRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mintRuntime = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$mintRuntimeLicense = Join-Path $mintRuntime 'NODE-LICENSE.txt'
if (!(Test-Path -LiteralPath $mintRuntimeLicense)) { $mintRuntimeLicense = Join-Path $mintRuntime 'LICENSE' }
if (!(Test-Path -LiteralPath (Join-Path $mintRuntime 'node.exe')) -or !(Test-Path -LiteralPath $mintRuntimeLicense)) { throw 'Runtime needs node.exe and its official license.' }
if (!(Test-Path -LiteralPath "$mintRoot/node_modules/ethers/package.json")) { throw 'Run npm ci first.' }
& "$PSScriptRoot/build-launcher.ps1"
$mintDist = Join-Path $mintRoot 'dist'
New-Item -ItemType Directory -Path $mintDist -Force | Out-Null
$mintZip = Join-Path $mintDist ('Mint-Desk-Windows-V1.0-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
if (Test-Path -LiteralPath $mintZip) { throw 'Output already exists.' }
$mintEntries = [Collections.Generic.List[object]]::new()
foreach ($mintName in @('MintDeskWindow.exe','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WEBVIEW2-LICENSE.txt','WEBVIEW2-NOTICE.txt')) {
 $mintEntries.Add(@{File=(Get-Item -LiteralPath (Join-Path $mintRoot $mintName)).FullName;Relative=$mintName})
}
foreach ($mintName in @('wallet-tracker.mjs','CHANGELOG.md','chain-cost.mjs','cost-basis.mjs','server.mjs','engine.mjs','coordinator.mjs','lib.mjs','nft-market.mjs','nft-image.mjs','monitor-service.mjs','opensea-page.mjs','project-market.mjs','run-lock.mjs','package.json','package-lock.json','README.md','LICENSE','THIRD-PARTY-NOTICES.md','START.cmd','Mint Desk.exe','Mint Desk.ico')) {
 $mintEntries.Add(@{File=(Get-Item -LiteralPath (Join-Path $mintRoot $mintName)).FullName;Relative=$mintName})
}
foreach ($mintFolder in @('app','test','docs','launcher','scripts','node_modules')) {
 foreach ($mintFile in Get-ChildItem -LiteralPath (Join-Path $mintRoot $mintFolder) -File -Recurse) {
  if ($mintFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point not allowed.' }
  $mintEntries.Add(@{File=$mintFile.FullName;Relative=[IO.Path]::GetRelativePath($mintRoot,$mintFile.FullName).Replace('\','/')})
 }
}
foreach ($mintFile in Get-ChildItem -LiteralPath (Join-Path $mintRoot 'monitor') -File -Filter '*.mjs') { $mintEntries.Add(@{File=$mintFile.FullName;Relative='monitor/'+$mintFile.Name}) }
$mintEntries.Add(@{File=(Join-Path $mintRuntime 'node.exe');Relative='runtime/node.exe'})
$mintEntries.Add(@{File=$mintRuntimeLicense;Relative='runtime/NODE-LICENSE.txt'})
$mintArchive = [IO.Compression.ZipFile]::Open($mintZip,[IO.Compression.ZipArchiveMode]::Create)
try { foreach ($mintEntry in $mintEntries) {
 if ($mintEntry.Relative -match '(^|/)(data|\.git|\.env)(/|$)|\.local\.json$|\.log$|\.lock$|^\.\.') { throw 'Disallowed local data in package.' }
 [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($mintArchive,$mintEntry.File,('mint-desk/'+$mintEntry.Relative),[IO.Compression.CompressionLevel]::Optimal) | Out-Null
} } finally { $mintArchive.Dispose() }
Get-FileHash -LiteralPath $mintZip -Algorithm SHA256
