param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("PNG", "image/png", "Bitmap", "FileDrop")]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$FixturePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Import-Module -Name ([System.IO.Path]::Combine($PSHOME, "Modules", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Utility.psd1")) -ErrorAction Stop
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class BridgeNativeTestClipboard {
  [DllImport("user32.dll")]
  public static extern uint GetClipboardSequenceNumber();
}
"@

$fixture = [System.IO.File]::ReadAllText($FixturePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$payload = $null
try {
  if ($Mode -eq "FileDrop") {
    $files = [System.Collections.Specialized.StringCollection]::new()
    foreach ($file in $fixture.fileDrop) { [void]$files.Add([string]$file) }
    [System.Windows.Forms.Clipboard]::SetFileDropList($files)
  } else {
    $data = [System.Windows.Forms.DataObject]::new()
    if ($Mode -eq "Bitmap") {
      $payload = [System.Drawing.Bitmap]::new([string]$fixture.sourceImage)
    } else {
      $payload = [System.IO.MemoryStream]::new([System.IO.File]::ReadAllBytes([string]$fixture.sourceImage), $false)
    }
    $data.SetData($Mode, $false, $payload)
    [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 5, 100)
  }
} finally {
  if ($null -ne $payload) { $payload.Dispose() }
}

$observed = [System.Windows.Forms.Clipboard]::GetDataObject()
$value = $observed.GetData($Mode, $false)
$declaredType = if ($null -eq $value) { $null } else { $value.GetType().FullName }
$observedFiles = if ($Mode -eq "FileDrop") { @([System.Windows.Forms.Clipboard]::GetFileDropList()) } else { @() }
$result = [ordered]@{
  mode = $Mode
  clipboardSequence = [uint64][BridgeNativeTestClipboard]::GetClipboardSequenceNumber()
  registeredFormats = @($observed.GetFormats($false))
  declaredType = $declaredType
  files = $observedFiles
}
if ($value -is [System.IDisposable]) { $value.Dispose() }
$result | ConvertTo-Json -Depth 6 -Compress
