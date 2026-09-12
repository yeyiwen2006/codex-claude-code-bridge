param(
  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not [System.IO.Path]::IsPathRooted($Destination)) {
  throw "Destination must be an absolute path."
}

# Load the built-in commands directly instead of discovering modules across
# user and machine locations in the bridge's restricted child environment.
$utilityModule = [System.IO.Path]::Combine($PSHOME, "Modules", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Utility.psd1")
Import-Module -Name $utilityModule -ErrorAction Stop

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class ClaudeBridgeClipboardNative {
    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();
}
"@

[System.IO.Directory]::CreateDirectory($Destination) | Out-Null
$supportedExtensions = @(".png", ".jpg", ".jpeg", ".gif", ".webp")

function New-DestinationPath([string]$Extension) {
  return [System.IO.Path]::Combine($Destination, ([Guid]::NewGuid().ToString("N") + $Extension.ToLowerInvariant()))
}

function Copy-ClipboardFileDrop([string[]]$Files) {
  $sources = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
  $totalBytes = [long]0
  foreach ($sourcePath in $Files) {
    if (-not [System.IO.File]::Exists($sourcePath)) { continue }
    $source = [System.IO.FileInfo]::new($sourcePath)
    if ($supportedExtensions -notcontains $source.Extension.ToLowerInvariant()) { continue }
    if ($source.Length -le 0 -or $source.Length -gt 25MB) {
      throw "Each clipboard image must be a non-empty file no larger than 25 MiB."
    }
    $sources.Add($source)
    $totalBytes += $source.Length
    if ($sources.Count -gt 20 -or $totalBytes -gt 100MB) {
      throw "A clipboard capture cannot exceed 20 images or 100 MiB."
    }
  }
  $captured = [System.Collections.Generic.List[object]]::new()
  foreach ($source in $sources) {
    $destinationPath = New-DestinationPath $source.Extension
    [System.IO.File]::Copy($source.FullName, $destinationPath, $false)
    $captured.Add([ordered]@{
      path = $destinationPath
      sourceName = $source.Name
      sourceFormat = "FileDrop"
      byteExact = $true
    })
  }
  return ,$captured
}

function Get-ClipboardDataObject {
  $lastError = $null
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    try {
      return [System.Windows.Forms.Clipboard]::GetDataObject()
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 100
    }
  }
  throw $lastError
}

$data = Get-ClipboardDataObject
if ($null -eq $data) {
  throw "The clipboard does not contain a data object."
}

$items = [System.Collections.Generic.List[object]]::new()

if ($data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
  $files = [string[]]$data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
  $items = Copy-ClipboardFileDrop $files
}

if ($items.Count -eq 0) {
  foreach ($format in @("PNG", "image/png")) {
    if (-not $data.GetDataPresent($format)) {
      continue
    }
    $pngData = $data.GetData($format)
    if ($pngData -is [System.IO.Stream]) {
      $destinationPath = New-DestinationPath ".png"
      $output = [System.IO.File]::Open($destinationPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
      try {
        if ($pngData.CanSeek) {
          $pngData.Position = 0
        }
        $buffer = [byte[]]::new(65536)
        $copiedBytes = [long]0
        while (($readBytes = $pngData.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $copiedBytes += $readBytes
          if ($copiedBytes -gt 25MB) {
            throw "Clipboard PNG data exceeds 25 MiB."
          }
          $output.Write($buffer, 0, $readBytes)
        }
      } finally {
        $output.Dispose()
        $pngData.Dispose()
      }
      $items.Add([ordered]@{
        path = $destinationPath
        sourceName = "clipboard.png"
        sourceFormat = $format
        byteExact = $true
      })
      break
    }
  }
}

if ($items.Count -eq 0 -and [System.Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [System.Windows.Forms.Clipboard]::GetImage()
  if ($null -ne $image) {
    $destinationPath = New-DestinationPath ".png"
    try {
      $image.Save($destinationPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $image.Dispose()
    }
    $items.Add([ordered]@{
      path = $destinationPath
      sourceName = "clipboard.png"
      sourceFormat = "Bitmap"
      byteExact = $false
    })
  }
}

if ($items.Count -eq 0) {
  throw "The clipboard does not contain a supported image or image-file list."
}

$result = [ordered]@{
  clipboardSequence = [uint64][ClaudeBridgeClipboardNative]::GetClipboardSequenceNumber()
  items = $items
}
$result | ConvertTo-Json -Depth 5 -Compress
