$ErrorActionPreference = 'Stop'
$mintRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mintSdk = Join-Path $mintRoot 'build-cache/webview2'
$mintPackage = Join-Path $mintRoot 'build-cache/webview2.zip'
$mintVersion = '1.0.3800.47'
$mintHash = '56c9f26bdd07916a2d1949fb58a5c7e434dfa1173577dca879206050c4e718db'
New-Item -ItemType Directory -Path (Split-Path $mintPackage) -Force | Out-Null
if (!(Test-Path -LiteralPath $mintPackage)) {
 Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$mintVersion/microsoft.web.webview2.$mintVersion.nupkg" -OutFile $mintPackage
}
if ((Get-FileHash -LiteralPath $mintPackage -Algorithm SHA256).Hash.ToLowerInvariant() -ne $mintHash) { throw 'WebView2 SDK integrity mismatch.' }
Expand-Archive -LiteralPath $mintPackage -DestinationPath $mintSdk -Force
foreach ($mintDll in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll')) {
 Copy-Item -LiteralPath (Join-Path "$mintSdk/lib/net462" $mintDll) -Destination $mintRoot -Force
}
Copy-Item -LiteralPath "$mintSdk/runtimes/win-x64/native/WebView2Loader.dll" -Destination $mintRoot -Force
Copy-Item -LiteralPath "$mintSdk/LICENSE.txt" -Destination "$mintRoot/WEBVIEW2-LICENSE.txt" -Force
Copy-Item -LiteralPath "$mintSdk/NOTICE.txt" -Destination "$mintRoot/WEBVIEW2-NOTICE.txt" -Force
