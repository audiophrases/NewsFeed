# Builds the NewsFeed app without Gradle, as Play the News is built:
# aapt2 -> javac -> d8 -> zipalign -> apksigner. Run it in PowerShell from anywhere:
#   powershell -ExecutionPolicy Bypass -File android\build.ps1
# then install build\newsfeed.apk on the phone (adb install -r, or copy it over and open it).
$ErrorActionPreference = "Stop"
$SDK     = "C:\Users\Admin\AppData\Local\Android\Sdk"
$BT      = "$SDK\build-tools\36.1.0"
$ANDROID = "$SDK\platforms\android-36.1\android.jar"
$KEYTOOL = "C:\Program Files\Java\jdk-26.0.1\bin\keytool.exe"
$P       = $PSScriptRoot
$B       = "$P\build"
# Keep this key: updates of the app must be signed with it (a new key means reinstalling, which
# loses what the app keeps on the phone). It is not committed to the repository.
$KS      = "$P\newsfeed.keystore"

$buildTarget = [System.IO.Path]::GetFullPath($B)
if ($buildTarget -ne [System.IO.Path]::GetFullPath((Join-Path $P 'build'))) { throw "Unexpected build directory" }
Remove-Item -LiteralPath $buildTarget -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$B\classes" | Out-Null

# 1. one-time signing key
if (-not (Test-Path $KS)) {
    Write-Host "==> creating signing key"
    & $KEYTOOL -genkeypair -keystore $KS -alias newsfeed -keyalg RSA -keysize 2048 `
        -validity 10000 -storepass android -keypass android `
        -dname "CN=NewsFeed, O=Personal, C=US" 2>&1 | Out-Null
}

Write-Host "==> compiling resources"
& "$BT\aapt2.exe" compile --dir "$P\res" -o "$B\res.zip"
if ($LASTEXITCODE) { throw "aapt2 compile failed" }

Write-Host "==> linking resources"
& "$BT\aapt2.exe" link -o "$B\app-res.apk" -I $ANDROID `
    --manifest "$P\AndroidManifest.xml" `
    --min-sdk-version 23 --target-sdk-version 36 `
    --java "$B\gen" `
    "$B\res.zip"
if ($LASTEXITCODE) { throw "aapt2 link failed" }

Write-Host "==> compiling java"
$sources = @(Get-ChildItem "$P\src","$B\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$javacArgs = @('--release','11','-nowarn','-classpath',$ANDROID,'-d',"$B\classes") + $sources
& javac $javacArgs
if ($LASTEXITCODE) { throw "javac failed" }

Write-Host "==> dexing"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory("$B\classes", "$B\classes.jar")
& "$BT\d8.bat" --lib $ANDROID --min-api 23 --output $B "$B\classes.jar"
if ($LASTEXITCODE) { throw "d8 failed" }

Write-Host "==> packaging"
Copy-Item "$B\app-res.apk" "$B\app-unaligned.apk" -Force
$zip = [System.IO.Compression.ZipFile]::Open("$B\app-unaligned.apk", "Update")
try {
    $entry = $zip.CreateEntry("classes.dex", [System.IO.Compression.CompressionLevel]::Optimal)
    $out = $entry.Open()
    $bytes = [System.IO.File]::ReadAllBytes("$B\classes.dex")
    $out.Write($bytes, 0, $bytes.Length)
    $out.Close()
} finally { $zip.Dispose() }

Write-Host "==> aligning"
& "$BT\zipalign.exe" -f -p 4 "$B\app-unaligned.apk" "$B\app-aligned.apk"
if ($LASTEXITCODE) { throw "zipalign failed" }

Write-Host "==> signing"
& "$BT\apksigner.bat" sign --ks $KS --ks-pass pass:android --key-pass pass:android `
    --out "$B\newsfeed.apk" "$B\app-aligned.apk"
if ($LASTEXITCODE) { throw "apksigner failed" }

& "$BT\apksigner.bat" verify --print-certs "$B\newsfeed.apk" | Select-Object -First 3
Write-Host ""
Write-Host ("==> built {0} ({1:N0} bytes)" -f "$B\newsfeed.apk", (Get-Item "$B\newsfeed.apk").Length)
