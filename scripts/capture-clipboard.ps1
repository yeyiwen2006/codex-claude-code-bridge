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
  foreach ($sourcePath in $files) {
    if (-not [System.IO.File]::Exists($sourcePath)) {
      continue
    }
    $extension = [System.IO.Path]::GetExtension($sourcePath).ToLowerInvariant()
    if ($supportedExtensions -notcontains $extension) {
      continue
    }
    $destinationPath = New-DestinationPath $extension
    [System.IO.File]::Copy($sourcePath, $destinationPath, $false)
    $items.Add([ordered]@{
      path = $destinationPath
      sourceName = [System.IO.Path]::GetFileName($sourcePath)
      sourceFormat = "FileDrop"
      byteExact = $true
    })
  }
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
        $pngData.CopyTo($output)
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
