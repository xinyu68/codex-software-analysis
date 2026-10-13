param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination, [Parameter(Mandatory=$true)][string]$ManagedRoot)
$ErrorActionPreference = 'Stop'
$rootPath = [IO.Path]::GetFullPath($ManagedRoot).TrimEnd('\') + '\'
$destinationPath = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
$archivePath = [IO.Path]::GetFullPath($Archive)
if (!$destinationPath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase) -or !$archivePath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Extraction paths must stay in the managed dependency directory' }
if (Test-Path -LiteralPath $Destination) { throw 'Extraction destination already exists; inspect an incomplete installation before retrying' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($entry in $zip.Entries) {
    $entryPath = [IO.Path]::GetFullPath([IO.Path]::Combine($destinationPath, $entry.FullName))
    if (!$entryPath.StartsWith($destinationPath, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::IsPathRooted($entry.FullName) -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe archive entry' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $Destination)
