<#
.SYNOPSIS
  Writes the sample filenames in a library folder to a text file.

.DESCRIPTION
  Kitbench guesses a sample's category from its name, and the guesses are only
  as good as the names they were tuned against. This dumps the names -- paths
  only, no audio, nothing else about the files -- so the rules can be improved
  against a real library instead of against assumptions about how packs are
  named.

  Run it once per library root. The output lands on the Desktop; open it, check
  you are happy with what it contains, then send it over.

.PARAMETER Root
  The library folder to list. Prompted for if omitted.

.PARAMETER OutFile
  Where to write. Defaults to a file on the Desktop named after the folder.

.EXAMPLE
  .\scripts\dump-library-names.ps1 -Root 'D:\Samples\Trap Essentials'
#>
[CmdletBinding()]
param(
    [string] $Root,
    [string] $OutFile
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Read-Host 'Library folder to list' }
$Root = $Root.Trim('"').Trim()
if (-not (Test-Path -LiteralPath $Root)) { throw "No such folder: $Root" }
$Root = (Resolve-Path -LiteralPath $Root).Path

if (-not $OutFile) {
    $leaf = Split-Path -Leaf $Root
    $safe = ($leaf -replace '[\\/:*?"<>|]', '_')
    $OutFile = Join-Path ([Environment]::GetFolderPath('Desktop')) "kitbench-names-$safe.txt"
}

# The formats Kitbench scans (SPEC 3). Anything else in the folder is not a
# sample as far as the app is concerned, so listing it would only add noise.
$extensions = @('.wav', '.aif', '.aiff', '.flac', '.mp3', '.ogg', '.m4a')

$files = Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() }

# Relative to the root, so the dump carries the folder structure the rules read
# without carrying the drive letter or your home directory.
$prefix = $Root.TrimEnd('\') + '\'
$lines = $files | ForEach-Object { $_.FullName.Substring($prefix.Length) } | Sort-Object

Set-Content -LiteralPath $OutFile -Value $lines -Encoding UTF8

Write-Host ''
Write-Host "$($lines.Count) samples under $Root" -ForegroundColor Cyan
Write-Host "Written to $OutFile" -ForegroundColor Green
