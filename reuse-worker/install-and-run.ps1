# Worker de nettoyage de voix NVIDIA RE-USE - lanceur Windows.
#
# UN SEUL FICHIER A LANCER. Le poser dans un dossier vide (ex. C:\reuse-worker), puis :
#     clic droit > "Executer avec PowerShell"
#  ou powershell -ExecutionPolicy Bypass -File install-and-run.ps1
#
# Au premier lancement il demande l'adresse du hub et le jeton de cette machine, les ecrit dans
# reuse-worker.config.json (a cote), installe tout dans ce dossier (Python portable, moteur, modele),
# s'inscrit au demarrage de la session, puis travaille en boucle : il reclame un job au hub, nettoie,
# renvoie, recommence. Il se met a jour seul et se relance seul. Aucun droit administrateur.
#
#   -NoStartup      ne pas s'inscrire au demarrage        -RemoveStartup  retirer l'inscription et sortir
#   -CrashTest      essai complet sans hub ni jeton (reuse_worker.py pose a cote) : rapport logs\crash-test.json
#   -Fingerprint    afficher l'empreinte du jeton de cette machine (le cree s'il n'existe pas) et sortir
#   -HubUrl URL     adresse du hub pour la premiere config (sinon variable HUB_URL, sinon demandee)
#   Arreter : creer un fichier nomme STOP dans le dossier (le supprimer pour repartir).
#   Journal : logs\worker.log      Etat : logs\state.json
#
# Ce fichier reste volontairement court et en ASCII : toute la logique est dans app\reuse_worker.py,
# que le hub met a jour. Ici : installation de Python, premier telechargement, relance, retour arriere.
param([switch]$NoStartup, [switch]$RemoveStartup, [switch]$CrashTest, [switch]$Fingerprint, [string]$HubUrl = $env:HUB_URL)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Base = Split-Path -Parent $MyInvocation.MyCommand.Path
$Self = $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Base 'reuse-worker.config.json'
$App = Join-Path $Base 'app'
$Prev = Join-Path $Base 'app.prev'
$LogDir = Join-Path $Base 'logs'
$TaskName = 'RE-USE worker'
$IsWin = ($env:OS -eq 'Windows_NT')

# Python portable officiel (python.org, sinon la meme archive relayee par le hub), empreinte verifiee avant decompression
$PyVersion = '3.14.10'
$PyUrl = "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-embed-amd64.zip"
$PySha256 = '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159'
$PyDir = Join-Path $Base "runtime\python-$PyVersion"
$UserAgent = 'reuse-worker-launcher/1.0 (Windows; PowerShell)'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say([string]$Message) {
    $line = '{0} | LANCEUR | {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try { Add-Content -Path (Join-Path $LogDir 'worker.log') -Value $line -Encoding UTF8 } catch { }
}

# SHA-256 par .NET plutot que Get-FileHash : lance depuis un pwsh 7, powershell.exe herite de PSModulePath
# et Get-FileHash peut etre introuvable.
function Get-Sha256([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::OpenRead($Path)
    try { ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLower() } finally { $fs.Dispose(); $sha.Dispose() }
}

function Remove-Startup {
    if ($IsWin) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
}

# Tache planifiee de l'utilisateur, sans droit administrateur : relancee toutes les 5 minutes si elle
# ne tourne pas (donc apres un redemarrage du PC, une fermeture de session ou un plantage) ; si elle
# tourne deja, Windows ne lance rien (IgnoreNew), et un verrou protege en plus contre les doublons.
function Install-Startup {
    if (-not $IsWin) { return }
    # conhost --headless (Windows 11) : aucune fenetre, meme pas le bref clignotement de -WindowStyle Hidden.
    $psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Self`" -NoStartup"
    $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
    if (Test-Path $conhost) { $action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless powershell.exe $psArgs" -WorkingDirectory $Base }
    else { $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs -WorkingDirectory $Base }
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Nettoyage de voix RE-USE pilote par le hub' -Force | Out-Null
    Say "Inscrit au demarrage (tache planifiee '$TaskName', verification toutes les 5 minutes)."
}

# Jeton cree sur ce PC : il ne quitte jamais ce dossier. Seule son empreinte SHA-256 est affichee,
# a declarer au hub sous la forme nom:sha256:... (l'empreinte ne permet pas de retrouver le jeton).
function New-LocalToken {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-Fingerprint([string]$Token) {
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Token))
    return 'sha256:' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Write-Config([string]$Url, [string]$Token) {
    $json = (@{ hub_url = $Url.Trim(); token = $Token.Trim(); backend = 'auto' } | ConvertTo-Json)
    [IO.File]::WriteAllText($ConfigPath, $json, (New-Object Text.UTF8Encoding($false)))
    Say "Config ecrite : $ConfigPath"
}

function Show-Fingerprint([string]$Token) {
    Say "Empreinte a declarer au hub (ce n'est pas le jeton) : $(Get-Fingerprint $Token.Trim())"
}

function Read-Config {
    if (-not (Test-Path $ConfigPath)) {
        if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
            Say "Config absente : $ConfigPath. Lancer ce script une fois a la main pour la creer."
            exit 2
        }
        Write-Host ''
        Write-Host 'Premiere installation du worker RE-USE.'
        $url = $HubUrl
        while (-not $url -or -not $url.Trim()) { $url = Read-Host 'Adresse du hub (ex. https://hub.example.com)' }
        $token = Read-Host 'Jeton de cette machine (Entree = en creer un ici)'
        if ($token -and $token.Trim()) { Write-Config $url $token }
        else {
            $token = New-LocalToken
            Write-Config $url $token
            Show-Fingerprint $token
            Say "Le worker reessaie seul chaque minute jusqu'a ce que le hub connaisse cette empreinte."
        }
    }
    $cfg = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
    if (-not $cfg.hub_url -or -not $cfg.token) { Say "Config incomplete (hub_url, token) : $ConfigPath"; exit 2 }
    return $cfg
}

# Telecharge l'archive Python depuis une source ; $true seulement si son empreinte est celle attendue.
function Save-PythonZip([string]$Url, [string]$Dest, [hashtable]$Headers, [string]$From) {
    try {
        if (Test-Path $Dest) { Remove-Item $Dest -Force }
        Invoke-WebRequest -Uri $Url -Headers $Headers -UserAgent $UserAgent -OutFile $Dest -UseBasicParsing -TimeoutSec 300
        $got = Get-Sha256 $Dest
        if ($got -eq $PySha256) { return $true }
        Say "Python depuis $From : empreinte inattendue ($got), fichier rejete."
    } catch {
        Say "Python depuis $From : telechargement impossible ($($_.Exception.Message))."
    }
    if (Test-Path $Dest) { Remove-Item $Dest -Force -ErrorAction SilentlyContinue }
    return $false
}

function Get-Python($Config) {
    if (-not $IsWin) {   # hors Windows (tests) : Python du systeme
        foreach ($name in 'python3', 'python') { $c = Get-Command $name -ErrorAction SilentlyContinue; if ($c) { return $c.Source } }
        throw 'python3 introuvable'
    }
    $exe = Join-Path $PyDir 'python.exe'
    if (Test-Path $exe) { return $exe }
    Say "Installation de Python $PyVersion portable (12 Mo)..."
    $zip = Join-Path $Base 'runtime\python.zip'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $zip) | Out-Null
    # python.org d'abord ; s'il refuse ou ne repond pas, la meme archive officielle relayee par le hub.
    # Le jeton n'est envoye qu'au hub. Quelle que soit la source, seule l'empreinte attendue est acceptee.
    $sources = @(@{ Name = 'python.org'; Url = $PyUrl; Headers = @{} })
    if ($Config -and $Config.hub_url -and $Config.token) {
        $sources += @{ Name = 'le hub'; Url = "$($Config.hub_url.TrimEnd('/'))/api/reuse/worker/python"; Headers = @{ Authorization = "Bearer $($Config.token)" } }
    }
    $ready = $false
    foreach ($s in $sources) {
        if (Save-PythonZip $s.Url $zip $s.Headers $s.Name) { Say "Python telecharge depuis $($s.Name), empreinte verifiee."; $ready = $true; break }
    }
    if (-not $ready) { throw "Python $PyVersion introuvable (sources essayees : $(($sources | ForEach-Object { $_.Name }) -join ', '))" }
    if (Test-Path $PyDir) { Remove-Item $PyDir -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $PyDir -Force
    Remove-Item $zip -Force
    return $exe
}

# Premier telechargement du programme (ensuite il se met a jour lui-meme) : manifeste du hub,
# chaque fichier verifie par son empreinte, mis en place seulement si tout est bon.
function Install-App($cfg) {
    $headers = @{ Authorization = "Bearer $($cfg.token)" }
    $hub = $cfg.hub_url.TrimEnd('/')
    $manifest = Invoke-RestMethod -Uri "$hub/api/reuse/worker/manifest" -Headers $headers -TimeoutSec 60
    $tmp = Join-Path $Base 'app.new'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    foreach ($f in $manifest.files) {
        if ($f.name -notmatch '^[\w.-]+$') { throw "nom de fichier refuse : $($f.name)" }
        $dest = Join-Path $tmp $f.name
        Invoke-WebRequest -Uri "$hub/api/reuse/worker/files/$($f.name)" -Headers $headers -OutFile $dest -UseBasicParsing -TimeoutSec 120
        if ((Get-Sha256 $dest) -ne $f.sha256) { throw "empreinte incorrecte pour $($f.name)" }
    }
    if (-not (Test-Path (Join-Path $tmp 'reuse_worker.py'))) { throw 'le hub ne publie pas reuse_worker.py' }
    [IO.File]::WriteAllText((Join-Path $tmp 'version.txt'), [string]$manifest.version)
    Move-Item $tmp $App
    Say "Programme installe (version $($manifest.version))."
}

# Tant que l'installation echoue, le programme (qui met d'habitude ce lanceur a jour) ne tourne pas :
# le lanceur va alors chercher lui-meme sa version publiee par le hub. $true s'il vient d'etre remplace.
function Update-Self($Config) {
    $headers = @{ Authorization = "Bearer $($Config.token)" }
    $hub = $Config.hub_url.TrimEnd('/')
    $name = Split-Path -Leaf $Self
    $manifest = Invoke-RestMethod -Uri "$hub/api/reuse/worker/manifest" -Headers $headers -TimeoutSec 60
    $entry = $manifest.files | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $entry -or $entry.sha256 -eq (Get-Sha256 $Self)) { return $false }
    $new = "$Self.new"
    try {
        Invoke-WebRequest -Uri "$hub/api/reuse/worker/files/$name" -Headers $headers -OutFile $new -UseBasicParsing -TimeoutSec 120
        if ((Get-Sha256 $new) -ne $entry.sha256) { throw 'empreinte incorrecte' }
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($new, [ref]$null, [ref]$errors)
        if ($errors.Count) { throw 'erreur de syntaxe' }
        Copy-Item $Self "$Self.prev" -Force
        Move-Item $new $Self -Force
    } catch {
        if (Test-Path $new) { Remove-Item $new -Force -ErrorAction SilentlyContinue }
        Say "Nouveau lanceur refuse ($($_.Exception.Message)) : l'ancien reste en place."
        return $false
    }
    return $true
}

# Passe la main au lanceur qui vient d'etre remplace (le verrou est rendu avant)
function Restart-Self {
    Say 'Lanceur mis a jour : relance.'
    $script:lock.Close(); $script:lock = $null
    if ($IsWin) { Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$Self`" -NoStartup" }
    else { & $Self -NoStartup }
    exit 0
}

function Get-AppVersion {
    $v = Join-Path $App 'version.txt'
    if (Test-Path $v) { return (Get-Content -Raw $v).Trim() }
    return 'inconnue'
}

# Une version qui plante au demarrage est notee mauvaise et remplacee par la precedente
function Undo-Version {
    $bad = Get-AppVersion
    Add-Content -Path (Join-Path $Base 'bad-versions.txt') -Value $bad
    $trash = Join-Path $Base 'app.bad'
    if (Test-Path $trash) { Remove-Item $trash -Recurse -Force }
    Move-Item $App $trash
    if (Test-Path $Prev) {
        Move-Item $Prev $App
        Say "La version $bad plante au demarrage : retour a la version $(Get-AppVersion). Fichiers fautifs gardes dans app.bad."
    } else {
        Say "La version $bad plante au demarrage et il n'y a pas de version precedente : nouveau telechargement dans 5 minutes."
        Start-Sleep -Seconds 300
    }
}

# ---------------------------------------------------------------------------------------------
if ($RemoveStartup) { Remove-Startup; Say 'Inscription au demarrage retiree.'; exit 0 }

# Essai sans hub : aucun jeton, aucune inscription au demarrage. Code 0 = reussi.
if ($CrashTest) {
    $script = Join-Path $App 'reuse_worker.py'
    if (-not (Test-Path $script)) { $script = Join-Path $Base 'reuse_worker.py' }
    if (-not (Test-Path $script)) { Say 'Essai impossible : poser reuse_worker.py a cote de ce script.'; exit 2 }
    $python = Get-Python $null   # essai sans hub : python.org seulement
    & $python $script --base $Base --crash-test
    exit $LASTEXITCODE
}

# Empreinte du jeton de cette machine, sans rien lancer. Le jeton est cree s'il n'y a pas encore de config.
if ($Fingerprint) {
    if (Test-Path $ConfigPath) {
        $token = ''
        try { $token = [string](Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json).token } catch { }   # l'erreur citerait le contenu
        if (-not $token.Trim()) { Say "Config illisible ou sans jeton : $ConfigPath"; exit 2 }
    } else {
        if (-not $HubUrl -or -not $HubUrl.Trim()) { Say 'Adresse du hub manquante : -HubUrl https://... ou variable HUB_URL.'; exit 2 }
        $token = New-LocalToken
        Write-Config $HubUrl $token
    }
    Show-Fingerprint $token
    exit 0
}

# Un seul lanceur a la fois par dossier
$lock = $null
try { $lock = [IO.File]::Open((Join-Path $Base '.lock'), 'OpenOrCreate', 'ReadWrite', 'None') } catch { exit 0 }

$cfg = Read-Config
if (-not $NoStartup) { try { Install-Startup } catch { Say "Inscription au demarrage impossible ($($_.Exception.Message)). Le worker tourne quand meme." } }

$fails = 0
while ($true) {
    if (Test-Path (Join-Path $Base 'STOP')) { Say 'Fichier STOP present : arret. Le supprimer pour repartir.'; break }
    try {
        $python = Get-Python $cfg
        if (-not (Test-Path (Join-Path $App 'reuse_worker.py'))) { Install-App $cfg }
    } catch {
        Say "Installation impossible pour l'instant ($($_.Exception.Message)). Nouvel essai dans 60 s."
        $replaced = $false
        try { $replaced = Update-Self $cfg } catch { }   # hub injoignable : meme attente, meme nouvel essai
        if ($replaced) { Restart-Self }
        Start-Sleep -Seconds 60
        continue
    }
    $started = Get-Date
    & $python (Join-Path $App 'reuse_worker.py') --base $Base --launcher $Self
    $code = $LASTEXITCODE
    if ($code -eq 0) { break }                       # arret demande
    if ($code -eq 42) { $fails = 0; continue }       # mise a jour installee : relancer tout de suite
    if ($code -eq 43) { Restart-Self }               # le lanceur a ete remplace : relancer le nouveau
    if ($code -eq 2) { Say 'Config refusee (voir le message ci-dessus dans le journal). Nouvel essai dans 5 minutes.'; Start-Sleep -Seconds 300; continue }
    if ($code -eq 3) { Say 'Installation du moteur incomplete (voir ci-dessus). Nouvel essai dans 60 s.'; Start-Sleep -Seconds 60; continue }
    # Plantage. Une version n'est jugee mauvaise que si elle n'a jamais fini de demarrer (pas de app\.ok).
    $quick = ((Get-Date) - $started).TotalSeconds -lt 300
    if ($quick -and -not (Test-Path (Join-Path $App '.ok'))) { $fails++ } else { $fails = 0 }
    Say "Le worker s'est arrete (code $code). Relance dans 15 s."
    if ($fails -ge 3) { Undo-Version; $fails = 0 }
    Start-Sleep -Seconds 15
}
if ($lock) { $lock.Close() }
