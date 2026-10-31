# Creates "Duet" shortcuts (Desktop + Start menu) that launch the app without a console window.
$app = Split-Path -Parent $PSScriptRoot
$native = Join-Path $app 'release\native\duet-native.exe'
if (-not (Test-Path $native)) { throw "Native build not found. Run 'npm run native:build' in $app first." }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')
)
foreach ($dir in $targets) {
  # Shortcut left over from before the rename.
  Remove-Item (Join-Path $dir 'Claude Desk.lnk') -ErrorAction SilentlyContinue
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Duet.lnk'))
  $lnk.TargetPath = $native
  $lnk.Arguments = ''
  $lnk.WorkingDirectory = $app
  $ico = Join-Path $app 'build\icon.ico'
  $lnk.IconLocation = if (Test-Path $ico) { "$ico,0" } else { "$native,0" }
  $lnk.Description = 'Duet'
  $lnk.Save()
  Write-Host "Created $($lnk.FullName)"
}
