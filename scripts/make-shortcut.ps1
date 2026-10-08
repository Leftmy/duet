# Creates "Duet" shortcuts (Desktop + Start menu) that launch the app without a console window.
$app = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $app 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "Electron not found. Run 'npm install' in $app first." }
if (-not (Test-Path (Join-Path $app 'dist\index.html'))) { throw "UI not built. Run 'npm run build' in $app first." }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')
)
foreach ($dir in $targets) {
  # Shortcut left over from before the rename.
  Remove-Item (Join-Path $dir 'Claude Desk.lnk') -ErrorAction SilentlyContinue
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Duet.lnk'))
  $lnk.TargetPath = $electron
  $lnk.Arguments = "`"$app`""
  $lnk.WorkingDirectory = $app
  $ico = Join-Path $app 'build\icon.ico'
  $lnk.IconLocation = if (Test-Path $ico) { "$ico,0" } else { "$electron,0" }
  $lnk.Description = 'Duet'
  $lnk.Save()
  Write-Host "Created $($lnk.FullName)"
}
