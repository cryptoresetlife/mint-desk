$ErrorActionPreference = 'Stop'
$mintRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mintCompiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $mintCompiler)) { throw 'Install the .NET Framework C# compiler first.' }
& $mintCompiler /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/win32icon:$mintRoot/Mint Desk.ico" "/out:$mintRoot/Mint Desk.exe" "$mintRoot/launcher/MintDeskLauncher.cs"
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
