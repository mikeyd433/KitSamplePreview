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

.PARAMETER Relaunch
  Start Kitbench when the build succeeds, and keep this window open if it
  fails. Used by the app's own "update" button, which has to quit before the
  build can replace its executable.

.EXAMPLE
  .\scripts\update-kitbench.ps1
#>
[CmdletBinding()]
param(
    [switch] $NoPull,
    [switch] $Relaunch
)

$ErrorActionPreference = 'Stop'

# Launched from the app's update button, this window is the only place an error
# can be read — so it must not vanish on failure.
trap {
    Write-Host ''
    Write-Host "Update failed: $_" -ForegroundColor Red
    Write-Host 'Kitbench has not been changed; the Desktop icon still runs the previous build.'
    if ($Relaunch) { Read-Host 'Press Enter to close' }
    exit 1
}

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
        # Loud, because the build still succeeds — it just builds the old code,
        # and a successful-looking update that changed nothing is worse than a
        # failure.
        Write-Host ''
        Write-Warning 'NOT UPDATING: there are uncommitted changes here, so the pull was skipped.'
        Write-Warning 'What follows builds the code already checked out, not the latest.'
        Write-Host $dirty -ForegroundColor Yellow
        Write-Host 'Commit or stash these, then run again to actually update.' -ForegroundColor Yellow
        Write-Host ''
    } else {
        Write-Host 'Pulling...' -ForegroundColor Cyan
        git pull --ff-only
    }
}

if ($Relaunch) {
    # The app spawned this and is on its way out. Windows will not let a
    # running executable be overwritten, so wait for it to actually go.
    $waited = 0
    while ((Get-Process -Name 'kitbench' -ErrorAction SilentlyContinue) -and $waited -lt 30) {
        Start-Sleep -Milliseconds 250
        $waited++
    }
}

# `npm ci` rather than `npm install`: install can rewrite package-lock.json,
# which leaves the tree dirty, which makes the next run skip its pull and
# rebuild stale code without saying anything much. ci installs exactly the lock
# file and never modifies it.
Write-Host 'Installing frontend dependencies...' -ForegroundColor Cyan
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'npm ci failed (lock file out of step with package.json?); falling back to npm install.'
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed.' }
}

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
$dirtyNow = if (git status --porcelain) { '+' } else { '' }
Write-Host ''
Write-Host "Built $commit$dirtyNow" -ForegroundColor Green
Write-Host 'The version badge in the status bar should show the same thing.' -ForegroundColor Green
Write-Host "Shortcut: $linkPath" -ForegroundColor Green

if ($Relaunch) {
    Write-Host 'Starting Kitbench...' -ForegroundColor Cyan
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
}
