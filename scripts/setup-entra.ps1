<#
.SYNOPSIS
  Registers Switchback's Microsoft Entra application and writes the credentials into .env.

.DESCRIPTION
  One registration carrying two platforms, which is what .env.example describes as the usual
  setup:

    Web             the confidential half. Holds the client secret and the Auth.js callback
                    URI. Only server code ever sees the secret.

    Mobile/desktop  the public half. A shipped iOS binary cannot keep a secret — anyone
                    holding the app can read it — so the native flow uses PKCE with no
                    secret, against the same client id.

  Registered for "any organizational directory and personal Microsoft accounts", so an
  @outlook.com address signs in alongside a work account.

  Safe to re-run. An existing registration is reused by display name rather than duplicated.
  Re-running does mint a fresh client secret — the old one is revoked, which will sign out
  every existing web session until the new value is deployed.

.PARAMETER ProductionUrl
  Your deployed origin, e.g. https://switchback.vercel.app. Adds the matching callback so
  production sign-in works without a second trip through this script. Optional.

.EXAMPLE
  pwsh ./scripts/setup-entra.ps1
  pwsh ./scripts/setup-entra.ps1 -ProductionUrl https://switchback.vercel.app
#>

[CmdletBinding()]
param(
  [string] $DisplayName = 'Switchback',
  [string] $LocalUrl = 'http://localhost:3000',
  [string] $ProductionUrl,
  [string] $EnvFile = (Join-Path $PSScriptRoot '..' '.env'),
  # Years the client secret is valid for. Entra allows 2 at most.
  [ValidateRange(1, 2)] [int] $SecretYears = 2
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string] $Message) Write-Host "`n▸ $Message" -ForegroundColor Cyan }
function Write-Done { param([string] $Message) Write-Host "  $Message" -ForegroundColor Green }
function Write-Note { param([string] $Message) Write-Host "  $Message" -ForegroundColor DarkGray }

# --- prerequisites ----------------------------------------------------------

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Azure CLI not found. Install it from https://aka.ms/installazurecli, then re-run.'
}

Write-Step 'Checking your Azure sign-in'

# `az account show` succeeds off a cached token that Graph will still reject, so the real
# test is a Graph call. This one is read-only and returns your own user object.
$signedIn = $false
try {
  $me = az ad signed-in-user show 2>$null | ConvertFrom-Json
  if ($me) { $signedIn = $true; Write-Done "Signed in as $($me.userPrincipalName)" }
} catch { $signedIn = $false }

if (-not $signedIn) {
  Write-Note 'No usable token for Microsoft Graph — opening a device-code sign-in.'
  Write-Note 'A code will be printed below; enter it in the browser window that opens.'
  az login --use-device-code --allow-no-subscriptions --scope 'https://graph.microsoft.com//.default' | Out-Null
  $me = az ad signed-in-user show | ConvertFrom-Json
  Write-Done "Signed in as $($me.userPrincipalName)"
}

# --- redirect URIs ----------------------------------------------------------

$callbackPath = '/api/auth/callback/microsoft-entra-id'
$webRedirects = @("$($LocalUrl.TrimEnd('/'))$callbackPath")
if ($ProductionUrl) { $webRedirects += "$($ProductionUrl.TrimEnd('/'))$callbackPath" }

# `switchback` is the scheme in apps/mobile/app.config.ts. Keep the two in step: Entra
# rejects any redirect it was not told about, and the error it returns names the URI, not
# the mismatch.
$nativeRedirects = @('switchback://auth', 'msauth.switchback://auth', 'http://localhost:8081')

# --- registrations ----------------------------------------------------------

function Get-AppByName {
  param([string] $Name)
  # Not $matches — that name is an automatic variable PowerShell overwrites on every -match.
  $found = @(az ad app list --display-name $Name --query "[?displayName=='$Name']" | ConvertFrom-Json)
  if ($found.Count -gt 1) {
    throw "More than one app registration is named '$Name'. Delete the extras in the portal, or pass -DisplayName something unique."
  }
  return $found | Select-Object -First 1
}

Write-Step "Registering the application ('$DisplayName')"

$app = Get-AppByName -Name $DisplayName
if ($app) {
  Write-Note "Already registered — updating redirect URIs in place (appId $($app.appId))."
  az ad app update --id $app.appId `
    --web-redirect-uris @webRedirects `
    --public-client-redirect-uris @nativeRedirects | Out-Null
} else {
  $app = az ad app create `
    --display-name $DisplayName `
    --sign-in-audience AzureADandPersonalMicrosoftAccount `
    --web-redirect-uris @webRedirects `
    --public-client-redirect-uris @nativeRedirects | ConvertFrom-Json
  Write-Done "Created appId $($app.appId)"
}

# Lets the native half authenticate without a client secret. Without it Entra rejects the
# PKCE flow for wanting credentials the app deliberately does not carry.
az ad app update --id $app.appId --set isFallbackPublicClient=true | Out-Null

foreach ($uri in $webRedirects) { Write-Note "web     $uri" }
foreach ($uri in $nativeRedirects) { Write-Note "native  $uri" }

# --- client secret ----------------------------------------------------------

Write-Step 'Minting a client secret for the web half'

$credential = az ad app credential reset `
  --id $app.appId `
  --display-name 'switchback-web' `
  --years $SecretYears `
  --append false | ConvertFrom-Json

$expiry = (Get-Date).AddYears($SecretYears).ToString('yyyy-MM-dd')
Write-Done "Secret issued, valid until $expiry"
Write-Note 'Entra shows a secret exactly once. It is being written straight to .env and is not printed here.'

# --- .env -------------------------------------------------------------------

Write-Step "Writing credentials to $EnvFile"

if (-not (Test-Path $EnvFile)) {
  $example = Join-Path (Split-Path $EnvFile -Parent) '.env.example'
  if (Test-Path $example) {
    Copy-Item $example $EnvFile
    Write-Note 'No .env yet — started one from .env.example.'
  } else {
    New-Item -ItemType File -Path $EnvFile | Out-Null
  }
}

function Set-EnvValue {
  param([string] $Key, [string] $Value)
  $lines = @(Get-Content -LiteralPath $EnvFile)
  $line = "$Key=`"$Value`""
  $index = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$([regex]::Escape($Key))\s*=") { $index = $i; break }
  }
  if ($index -ge 0) { $lines[$index] = $line } else { $lines += $line }
  Set-Content -LiteralPath $EnvFile -Value $lines -Encoding utf8NoBOM
}

Set-EnvValue -Key 'AUTH_MICROSOFT_ENTRA_ID_ID'     -Value $app.appId
Set-EnvValue -Key 'AUTH_MICROSOFT_ENTRA_ID_SECRET' -Value $credential.password

# The multi-tenant issuer. "common" is what admits personal accounts alongside work ones;
# a tenant GUID here would lock sign-in to one organisation. AUTH_MICROSOFT_ENTRA_ID_MOBILE_ID
# stays unset on purpose — one registration serves both platforms, so the client id above
# verifies native identity tokens too.
Set-EnvValue -Key 'AUTH_MICROSOFT_ENTRA_ID_ISSUER' -Value 'https://login.microsoftonline.com/common/v2.0'

if (-not (Select-String -Path $EnvFile -Pattern '^\s*AUTH_SECRET\s*=\s*"..' -Quiet)) {
  # Auth.js signs session cookies with this. 32 random bytes, base64 — same shape as
  # `npx auth secret`, generated locally so the script has no network dependency.
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  Set-EnvValue -Key 'AUTH_SECRET' -Value ([Convert]::ToBase64String($bytes))
  Write-Done 'Generated AUTH_SECRET (it was empty).'
}

Write-Done 'Wrote AUTH_MICROSOFT_ENTRA_ID_ID, _SECRET, _ISSUER'

Write-Host ''
Write-Host 'Done. Sign-in is live locally:' -ForegroundColor Green
Write-Host '  npm run dev   → http://localhost:3000, then sign in with a Microsoft account'
if (-not $ProductionUrl) {
  Write-Host ''
  Write-Note 'For production, re-run with -ProductionUrl https://your-domain to add its callback,'
  Write-Note 'and set the same three variables in the Vercel project (.env is never deployed).'
}
