$ErrorActionPreference = 'Stop'
$mintRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mintCompiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $mintCompiler)) { throw 'Install the .NET Framework C# compiler first.' }
& "$PSScriptRoot/restore-webview2.ps1"
$mintLauncherResponse = @('/nologo','/target:winexe','/optimize+','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',('/win32icon:"'+$mintRoot+'\Mint Desk.ico"'),('/out:"'+$mintRoot+'\Mint Desk.exe"'),('"'+$mintRoot+'\launcher\MintDeskLauncher.cs"'))
$mintLauncherResponse | Set-Content -LiteralPath "$mintRoot/build-cache/launcher.rsp"
& $mintCompiler ("@$mintRoot/build-cache/launcher.rsp")
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
$mintResponse = @('/nologo','/target:winexe','/platform:x64','/main:MintDeskWindow','/optimize+','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',('/reference:"'+$mintRoot+'\Microsoft.Web.WebView2.Core.dll"'),('/reference:"'+$mintRoot+'\Microsoft.Web.WebView2.WinForms.dll"'),('/win32icon:"'+$mintRoot+'\Mint Desk.ico"'),('/out:"'+$mintRoot+'\MintDeskWindow.exe"'),('"'+$mintRoot+'\launcher\MintDeskLauncher.cs"'),('"'+$mintRoot+'\launcher\MintDeskWindow.cs"'))
$mintResponse | Set-Content -LiteralPath "$mintRoot/build-cache/window.rsp"
& $mintCompiler ("@$mintRoot/build-cache/window.rsp")
if ($LASTEXITCODE -ne 0) { throw 'Desktop window compilation failed.' }
