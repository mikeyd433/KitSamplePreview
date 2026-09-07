<#
.SYNOPSIS
  Pulls the latest Kitbench, builds it, and puts a shortcut on the Desktop.

.DESCRIPTION
  Run this when you want the newest version. It is deliberately separate from
  launching: a release build takes minutes, and an icon that rebuilt on every
  double-click would be unusable. The Desktop shortcut points at the built
  executable, so launching afterwards is instant.

  After it finishes, check the version badge in the app's status bar — it shows
  the commit the running binary was built from, which is the only reliable way
  to tell a fresh build from a stale one.

.PARAMETER NoPull
  Build what is already checked out, without fetching.

.EXAMPLE
  .\scripts\update-kitbench.ps1
#>
[CmdletBinding()]
param(
    [switch] $NoPull
)

$ErrorActionPreference = 'Stop'

# Resolve the repo from this script's own location, so the shortcut works no
# matter where it is invoked from.
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
Write-Host "Kitbench in $repo" -ForegroundColor Cyan

function Require-Tool([string] $name, [string] $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "$name is not on PATH. $hint"
    }
}

Require-Tool git   'Install Git for Windows.'
Require-Tool node  'Install Node 20.19 or newer.'
Require-Tool npm   'Install Node 20.19 or newer.'
Require-Tool cargo 'Install Rust from https://rustup.rs (MSVC toolchain).'

if (-not $NoPull) {
    # A dirty tree would make the pull fail halfway and leave a confusing
    # state, so say so first.
    $dirty = git status --porcelain
    if ($dirty) {
        Write-Warning 'Uncommitted changes here; skipping the pull so nothing is clobbered.'
        Write-Warning 'Commit or stash them, then run this again to update.'
    } else {
        Write-Host 'Pulling...' -ForegroundColor Cyan
        git pull --ff-only
    }
}

Write-Host 'Installing frontend dependencies...' -ForegroundColor Cyan
npm install --no-audit --no-fund

# --no-bundle: we point the shortcut at the executable, so building the NSIS
# installer would only add a tooling download and another way to fail.
Write-Host 'Building (several minutes the first time, much less after)...' -ForegroundColor Cyan
npm run tauri -- build --no-bundle

$exe = Join-Path $repo 'src-tauri\target\release\kitbench.exe'
if (-not (Test-Path $exe)) {
    throw "Build finished but $exe is missing. Check the build output above."
}

# Point the shortcut at the built executable rather than the installer: it
# needs no install step and never meets SmartScreen.
$desktop  = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'Kitbench.lnk'

$shell    = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath       = $exe
$shortcut.WorkingDirectory = Split-Path -Parent $exe
$shortcut.IconLocation     = "$exe,0"
$shortcut.Description      = 'Kitbench — drum sample auditioner'
$shortcut.Save()

$commit = (git rev-parse --short=7 HEAD).Trim()
Write-Host ''
Write-Host "Built $commit" -ForegroundColor Green
Write-Host "Shortcut: $linkPath" -ForegroundColor Green
Write-Host 'The status bar shows the same commit, so you can confirm what is running.'
