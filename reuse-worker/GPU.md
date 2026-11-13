# Générations GPU : images et modèles 3D

Le hub fait générer des images et des modèles 3D par les PC workers RE-USE (aujourd'hui `gpu-box`, RX 6950 XT
16 Go), avec la même file, le même planning horaire et les mêmes jetons de machine. Le hub ne calcule rien.

## Pour un agent : trois appels

Jeton = votre jeton de membre du hub (celui de votre salon), si le salon est autorisé (`HUB_GPU_MEMBERS`).

```bash
H=https://hub.example.com; A="Authorization: Bearer $MEMBER_TOKEN"
curl -H "$A" "$H/api/gpu/capabilities"     # types, modèles, paramètres, machines prêtes ou prochain créneau

# 1. demander une image (seul prompt est obligatoire)
curl -H "$A" -H 'Content-Type: application/json' \
     -d '{"prompt":"a red ceramic teapot on a wooden table, soft morning light","size":"1024x768"}' "$H/api/gpu/jobs"
# -> 201 {"job":{"id":42,"status":"pending","params":{"width":1024,"height":768,"steps":8,"seed":123456,...},"queue_position":1}}

# 2. attendre la fin (réponse dès que c'est fini, au plus 120 s ; relancer tant que status vaut pending ou claimed)
curl -H "$A" "$H/api/gpu/jobs/42?wait=120"

# 3. récupérer le fichier (PNG ou GLB), puis le supprimer du hub
curl -H "$A" -o teapot.png "$H/api/gpu/jobs/42/result"
curl -X DELETE -H "$A" "$H/api/gpu/jobs/42"
```

Modèle 3D à partir d'une image (type expérimental, voir plus bas) :

```bash
jq -n --arg img "$(base64 -w0 objet.png)" '{type:"3d", image:$img}' | curl -H "$A" -H 'Content-Type: application/json' -d @- "$H/api/gpu/jobs"
```

Image à partir d'une image : même chose avec `type: "image"`, un `prompt` et `strength` (0,05 à 1, 0,75 par défaut).

Paramètres de l'image (Z-Image Turbo) : `width` et `height` (256 à 1536, multiples de 64, 1024 par défaut), ou
`size: "1024x768"` ; `steps` (8) ; `seed` (tirée au hasard et renvoyée si absente : refaire la même image = même
graine) ; `cfg_scale` (1) ; `sampler` (euler, euler_a, heun, dpm++2m, lcm) ; `negative_prompt` (sans effet à
cfg 1) ; `priority` (-10 à 10). La 3D accepte `res` (512 ou 1024), `steps` (12), `seed`, `texture` (true).
Paramètres de premier niveau ou sous `params`. Alias compris : `w`, `h`, `cfg`, `negative`, `image_base64`.
Une valeur hors bornes est ramenée dans les bornes et signalée dans `adjusted`. Une clé inconnue est ignorée et
listée dans `ignored`. Une erreur (400) dit ce qui est attendu.

États : `pending` (en file, `queue_position`), `claimed` (en cours, `progress` 0 à 1 et `stage` : téléchargement
du modèle la première fois, puis calcul), `done` (`result.url`, `result.sha256`, `compute_s`, `result.device`),
`failed` (`error`), `cancelled`. `POST /api/gpu/jobs/:id/cancel` arrête aussi un calcul en cours (la carte est
libérée en moins de 15 s). `GET /api/gpu/jobs` liste vos travaux, du plus récent au plus ancien.

À savoir avant d'attendre : la machine ne calcule que dans son créneau (gpu-box : voir son planning), un seul travail à la fois, et un nettoyage RE-USE en cours finit d'abord. `capabilities` donne
`ready_now` et `next_start_at`. Le premier travail d'un type télécharge le modèle (environ 11 Go pour l'image),
ce qui prend de 10 à 30 minutes. Un travail que personne n'a pris en 48 h passe en échec. Les résultats sont
effacés du hub 72 h après la fin.

Un type qu'aucune machine ne propose est refusé tout de suite (409), pour ne pas attendre pour rien.

## FLUX 3 Image Klein : texte et images de référence

Même route, même suivi. On ajoute `"model": "flux3-klein"` et, si on veut, `references`, une liste d'images en base64.

```bash
jq -n --arg r "$(base64 -w0 tasse.png)" '{type:"image", model:"flux3-klein", size:"1024x1024",
  prompt:"The red mug from the first image on a rustic oak kitchen table by a window, soft morning light, steam rising, photo.",
  references:[$r]}' | curl -H "$A" -H 'Content-Type: application/json' -d @- "$H/api/gpu/jobs"
```

- `references` :
  - de 0 à 4 images, PNG ou JPEG, de 4 Mo au plus chacune. ComfyUI les ramène à 1 mégapixel (lanczos), on peut donc
    envoyer la photo telle quelle ;
  - le modèle en accepte jusqu'à 10. On s'arrête à 4 : chaque référence ajoute environ 4 000 jetons d'image au calcul
    de chaque étape, sur une carte de 16 Go déjà pleine aux trois quarts avec les poids ;
  - dans le prompt, on les cite dans l'ordre : « the first image », « the second image »…
  - les références passent par le mécanisme natif de Klein (nœud ReferenceMultiLatent, workflow de référence de BFL),
    pas par l'image vers image. `image` est refusé pour ce modèle.
- Le prompt : écrire une description complète de la scène, en anglais, comme une légende détaillée. Le hub n'ajoute pas
  l'agrandisseur de prompt de BFL (Qwen3.5 9B, 18,8 Go), qui ne tiendrait ni sur la carte ni dans le plafond du dossier.
  Un prompt court donne une image générique.
- Taille : 1024x1024 conseillé, et 1248 au plus pour du carré. Largeur et hauteur vont de 256 à 1536, en multiples de 16.
- `steps` : 16 par défaut (modèle distillé, sans guidage), de 4 à 32. `seed` : comme pour Z-Image.
- Le modèle par défaut reste Z-Image Turbo. Un travail Klein ne va qu'à une machine qui annonce le modèle
  (`info.gpu_models`), c'est-à-dire qui a passé l'essai `comfyui`. Sinon le hub répond 409.
- Temps : `compute_s` dans le job. `engine` donne :
  - `s_per_step` et `executed_s` (temps donné par ComfyUI) ;
  - `wall_s` ;
  - `server_start_s` au premier travail d'une série. ComfyUI reste chargé `gpu_keep_loaded_s`, 10 minutes par défaut.
- **Lenteur du job 52 (13/11), 232 s par étape.** ComfyUI n'autorise pas le fp16 pour Flux3 : sur RDNA2, qui n'a pas de
  bf16, il calculait donc en fp32 (« manual cast »). Le DiT ne tenait plus en mémoire vidéo, et le chargement dynamique
  relisait les poids à chaque étape. Réglages admin du modèle (ils relancent ComfyUI) :
  - `unet_dtype` : default par défaut, soit des poids bf16 calculés en fp32. Sans référence, c'est 4,73 s par étape et
    une image juste (job 56). En fp16, l'image sort noire (NaN, job 56). Si on impose fp16 et que l'image sort unie, le
    job est refait en default, sauf avec le jeton `no_fallback` ;
  - `dynamic_vram` : false par défaut (`--disable-dynamic-vram`) ;
  - `attention` : quad par défaut, ou split ou pytorch ;
  - `ref_megapixels` : 1,0 par défaut, 0,25 au plus petit ;
  - `vram_mode` : high par défaut (`--highvram`).
    - Cause du job 53 (260 s par étape en fp16) : en mode normal, ComfyUI réserve pour l'échantillonnage une estimation
      prudente. Avec l'attention quad, c'est environ 9 Go à 1024 avec une référence.
    - Il ne chargeait donc que 6,2 Go du DiT de 11,1 Go, et faisait passer le reste à chaque étape.
    - En high, le DiT est chargé en entier.
  - `comfyui_options` : des jetons d'essai pris dans une liste fermée, sans redéployer (voir le catalogue) ;
  - `text_encoder` : gpu par défaut, 60 à 95 s avant le DiT (contre 422 s sur le processeur, job 54). Ancien défaut :
    cpu. L'encodeur, 8,9 Go en fp16, calcule sur le processeur, et le DiT reste seul sur la
    carte d'un travail à l'autre. Avec gpu, l'encodeur passe sur la carte, puis il est déchargé avant le DiT.
- **Mesures de la nuit du 13/11** (gpu-box, 1024, poids bf16 calculés en fp32, attention quad sauf mention) :

  | Job | Références | Temps par étape | Image |
  |---|---|---|---|
  | 56 | aucune | 4,73 s, 16 étapes | juste (en fp16 : noire) |
  | 60 | 1 à 0,5 Mpx | environ 50 s | juste |
  | 58 | 1 à 1 Mpx | environ 125 s | juste |
  | 59 | 1 à 1 Mpx, attention split | environ 86 s | juste |
  | 61 | 1 à 1 Mpx, encodeur sur le processeur | plus de 110 s | annulé |

  - La première étape est rapide (6 à 16 s), les suivantes lentes.
  - Le temps grandit bien plus vite que le nombre de jetons (4 100, 6 100, 8 200).
  - Ce n'est ni la précision, ni l'encodeur resté sur la carte, ni la forme d'attention seule.
  - Piste en cours : l'état mémoire après la première étape (allocateur, mémoire partagée de Windows). Les jetons
    `alloc_expandable`, `alloc_gc`, `kitchen_hip_off`, `no_comfy_compiler` et `reserve_vram_2` servent à la vérifier.
- **Diagnostic dans `engine` du job** :
  - `weight_dtype` et `compute_dtype`, la précision réelle ;
  - `dit_load` et `te_load`, les lignes de chargement du DiT et de l'encodeur (complet ou partiel). `load` est la
    dernière ligne de chargement ;
  - `before_dit_s`, le temps avant le chargement du DiT : encodage du texte et des références ;
  - `vram_free_min_mib`, la mémoire vidéo libre au plus bas pendant l'échantillonnage ;
  - `vram_state` ;
  - `vram_free_before_mib` et `vram_free_after_mib` ;
  - `comfyui_flags` ;
  - `s_per_step`, la médiane des étapes après la première ; `step_times` donne chaque étape, `tqdm_s_per_step` la
    moyenne lissée de tqdm ;
  - `try_first` et `try_second` : ce qu'a donné chaque passage quand un repli a eu lieu ;
  - `log`, un extrait du journal de ComfyUI.
- **Trop lent pour le plafond (30 min)** : dès deux étapes mesurées, le worker arrête le job s'il ne peut pas finir à
  temps. Le message donne la raison chiffrée. L'échec est définitif (`final`) : le hub ne relance pas un calcul qui
  referait la même chose.
- Place : 20,3 Go de poids (modèle 11,1, encodeur 8,9, VAE 0,3). Avec le reste du dossier `gpu\`, il faut relever
  `gpu_max_gb` à 75.
- Provenance des fichiers : le dépôt officiel de BFL (`black-forest-labs/flux-3-image-klein-comfy`) exige une connexion
  Hugging Face, que le PC n'a pas. Les fichiers viennent donc du miroir `rootlocalghost/flux-3-image-klein-comfy`, à un
  commit épinglé.
  - Les empreintes du modèle et du VAE sont identiques sur un second miroir indépendant (`ml-resources`).
  - Les trois fichiers ont été rehachés au téléchargement.

## Modèles retenus (11/2026)

| Type | Modèle | Moteur | Licence | Disque |
|---|---|---|---|---|
| image | Z-Image Turbo 6B (Tongyi-MAI), diffusion Q8_0 + encodeur Qwen3-4B Q8_0 + VAE | stable-diffusion.cpp master-1091-b9d7176, Vulkan | Apache-2.0 | 11,2 Go |
| 3d (expérimental) | TRELLIS.2 4B (Microsoft), GGUF q8 | trellis.cpp v0.8.1, Vulkan | MIT, DINOv3 sous licence Meta | 10 Go |
| image (`model: "flux3-klein"`) | FLUX 3 Image Klein 5.6B distillé (Black Forest Labs), BF16, encodeur Qwen3-VL-4B BF16, VAE FLUX.2 | ComfyUI v0.45.0 + PyTorch ROCm (même environnement que le banc) | FLUX Kommunity License (non commercial, sorties commerciales si CA < 5 M$) | 20,3 Go |
| banc d'essai | Z-Image Turbo bf16 (Comfy-Org) | ComfyUI v0.45.0 + PyTorch 2.13.0 ROCm 10.0 gfx1030 | GPL-3.0, MIT, Apache-2.0, BSD | 27 Go |

Le choix de l'image vient du classement « open weights » d'Artificial Analysis (11/2026). Z-Image Turbo y est
le premier modèle à licence permissive qui tient dans 16 Go, devant ERNIE Image Turbo, Qwen-Image (20 milliards
de paramètres, 20 étapes, beaucoup plus lent), FLUX.2 klein 4B et FLUX.1 schnell. FLUX.3 klein, Qwen-Image-2.1
et SD3.5 ne sont pas sous licence libre. Hunyuan3D est exclu : sa licence ne couvre pas l'UE.

Tout est épinglé dans `gpu-catalog.json` : version du moteur, commit Hugging Face de chaque fichier, taille et
SHA-256. Ce fichier est lu par le hub (validation, `capabilities`) et par le worker (installation, ligne de
commande). Pour ajouter un modèle, on ajoute une entrée au catalogue, sans toucher au code.

## Côté PC : propre et borné

- Tout est installé sous le dossier du worker, dans `gpu\` :
  - `engines\` : binaires décompressés, un dossier par version ;
  - `models\` : les poids ;
  - `logs\` : la dernière sortie de chaque moteur.
- Rien dans le registre ni dans Program Files. Aucun service, aucun pilote, pas de Python en plus (sauf le banc
  ComfyUI, sous `gpu\comfyui`). Le Python portable du worker suffit. Le calcul passe par le pilote graphique déjà
  installé (Vulkan).
- L'installation est paresseuse : rien n'est téléchargé avant le premier travail du type. Un fichier vérifié
  porte un témoin `.ok`, il n'est donc pas re-haché à chaque travail. Un téléchargement coupé reprend où il en
  était.
- **Taille du dossier `gpu\` : 30 Go au plus par défaut.** L'image prend 11,2 Go, la 3D 10 Go en plus. On règle ce
  plafond avec `"gpu_max_gb"` dans `reuse-worker.config.json`. Il est vérifié avant tout téléchargement : un
  travail qui le dépasserait échoue avec la raison, et rien n'est téléchargé. Les versions que le catalogue ne
  cite plus sont supprimées d'abord.
- **Carte : 14 Go de mémoire vidéo au moins** (`min_vram_gb` du catalogue, lu dans la liste des cartes Vulkan du
  moteur RE-USE). Une machine plus petite, comme `dev-box` et sa GTX 1060 de 6 Go, ne propose pas le type : elle
  téléchargerait 11 Go pour rater chaque travail. Elle le dit dans son journal au démarrage.
- **Disque : 10 Go restent toujours libres.** Un téléchargement qui laisserait moins de place libre sur le disque
  est refusé de la même façon, même sous le plafond (`"gpu_keep_free_gb"`).
- Le moteur tourne en priorité basse (`"low_priority": false` pour l'enlever), un travail à la fois, sur la carte
  dédiée demandée explicitement (`--backend gpu` : jamais le processeur ni une carte intégrée).
- **Moteur image résident.** Charger les 11 Go de poids coûtait environ 580 s par travail (mesure du 12/11, jobs 3
  et 4 identiques en 1024 et en 512). Le moteur (`sd-server`, fourni dans le même paquet) reste donc chargé
  entre deux travaux. Seul le premier travail d'une série paie le chargement. Il écoute sur 127.0.0.1 seulement,
  rien n'est ouvert au réseau. Il est arrêté et la carte libérée après 10 minutes sans travail
  (`"gpu_keep_loaded_s"`, 0 pour un processus par travail), à l'annulation d'un travail et à l'arrêt du worker.
  S'il refuse de démarrer, le travail passe par `sd-cli` comme avant.
- Réglages facultatifs de la config :
  - `"gpu": false` : aucune génération sur cette machine ;
  - `"enable_3d": true` : propose la 3D ;
  - `"gpu_device": 0` : numéro de carte Vulkan, si le PC en a plusieurs ;
  - `"gpu_max_gb": 30` ;
  - `"gpu_keep_free_gb": 10` ;
  - `"gpu_keep_loaded_s": 600`.
- **Réglages du moteur, réservés au jeton admin** :
  - `flash_attn` : auto (défaut : la sonde de sd.cpp décide, elle la coupe sur RDNA2), diffusion (imposée au DiT), on
    ou off. Mesure sur la RX 6950 XT en 1024 : 21,8 s par étape sans, 26,8 s avec ;
  - `mmap` : true par défaut. Les poids sont chargés par projection mémoire, et non par la lecture par flux de sd.cpp,
    qui plafonne à 25 Mo/s même quand les fichiers sont en cache. Mesure du job 15 : chargement en 1 s environ,
    premier démarrage en 131 s au lieu de 559 s ;
  - `text_encoder` : cpu (défaut) ou gpu. En 1024, cpu libère 4 Go de mémoire vidéo et donne 13,3 s par étape au lieu
    de 21,7 s (mesure du 12/11) ;
  - `vae_tiling` : true par défaut ;
  - `threads` : 0 par défaut, soit un fil par cœur.

  Un membre qui les passe voit ses valeurs ignorées, et listées dans `ignored`. Changer un réglage relance le
  moteur résident, qui relit alors les poids.

  Pourquoi ces défauts, d'après les mesures du 12/11 en 8 étapes avec le moteur déjà chargé :
  - l'attention classique coûte 1,4 s par étape en 512, 9,9 s en 768 et 21,6 s en 1024, alors que la sonde de
    sd.cpp avait coupé la flash attention sur RDNA2. En 1024, sa matrice dépasse les 2 Go par allocation du pilote
    AMD Windows (ggml-vulkan, llama.cpp #30697). Référence publiée sur la même carte : Flux.1-dev 12B en 1024, 6,7 s
    par étape (stable-diffusion.cpp #2291) ;
  - sans tuiles, le VAE dépasse en 1024 la taille de tampon permise par le pilote : une partie du décodage passe
    sur le processeur, soit 34 à 41 s.
- Un texte (prompt, negative_prompt) qui contient `sd_cpp_extra_args` est refusé. Le worker le retire aussi : sd-server
  lit dans le texte des réglages cachés, dont des chemins de fichiers.
- **Lecture des poids.** sd.cpp lit les tenseurs avec un fil par cœur, à des endroits différents des fichiers.
  Sur gpu-box, cela donne 15 à 25 Mo/s, soit 7 à 11 minutes pour 11 Go à chaque démarrage du moteur, sans profiter
  du cache. Avant chaque démarrage, le worker lit donc les fichiers une fois du début à la fin, d'un seul lecteur,
  par blocs de 16 Mo. Cela remplit le cache de Windows, et le moteur lit ensuite en mémoire.
  - Si la mémoire libre ne peut pas tout garder, cette lecture est sautée.
  - Le débit mesuré est remonté dans `engine` (`prefetch_mb_s`). S'il reste lui aussi sous 30 Mo/s, la limite vient
    du disque ou de l'antivirus, pas de la manière de lire.
  - `"gpu_prefetch": false` dans la config la désactive.
- **Ce que dit le moteur** est remonté au hub pendant le calcul. On le lit dans `engine` de
  `GET /api/gpu/jobs/:id` :
  - la carte réellement utilisée (`device`) et le choix de calcul de sd.cpp (`backend`, `cpu` s'il est retombé
    sur le processeur) ;
  - la mémoire vidéo et la RAM libres (`vram_free_mib`, `ram_free_mib`) ;
  - les temps : chargement (`load_s`), texte (`encode_s`), étapes (`sampling_s`, `s_per_step`), décodage
    (`decode_s`) ;
  - les lignes utiles du journal (`log`).

  `stage` dit l'étape en cours (« étape 3/8 (4.2 s par étape) »). Le journal complet reste sur le PC, dans
  `gpu\logs\`.
- Pour tout retirer : supprimer le dossier `gpu\` (ComfyUI seul : essai `comfyui_remove`).

## La 3D est expérimentale : derrière un drapeau, non prouvée

trellis.cpp v0.8.1 précède le correctif d'un bug Vulkan qui touche les cartes RDNA2 (RX 6000). Avec le pilote AMD
Windows, la multiplication entière Q8_0 de ggml-vulkan rend des NaN quand la dimension contractée est petite (K = 32
ou 64). Six matrices des poids q8 sont dans ce cas :
- le flux de forme tourne alors sur du bruit, sans le dire (NaN mis à zéro) ;
- puis le décodeur plante en [5/7], code 0xC0000409.

Où en est le correctif :
- issue #50, corrigé dans main le 23/10/2026 (PR #55) ;
- le 13/11/2026, aucune version publiée ne le contient (dernière : v0.8.1 du 25/09). Les binaires de main ne sont
  pas téléchargeables sans compte GitHub.

Le catalogue garde donc le contournement `GGML_VK_DISABLE_INTEGER_DOT_PRODUCT=1`.
- L'auteur du correctif l'a validé sur un iGPU RDNA2 (gfx1036) avec le pilote AMD Windows : chaîne complète, GLB texturé.
- Il n'a jamais été essayé sur une RX 6000 dédiée.

C'est pourquoi une machine ne propose la 3D que si `enable_3d` est vrai, dans sa config ou posé par le hub.

L'essai 3D le vérifie.
- Demandé par le hub, il part de `gpu-test-object.png`, livrée avec le worker : une tasse rouge sur fond blanc,
  rendue maison par `scripts/render-gpu-test-object.py`, donc sans licence tierce. Il ne dépend donc pas du moteur
  image, et deux essais se comparent sur la même entrée.
- En local, sans `--gpu-input`, il prend l'image du dernier essai image, ou en fait une en 512 d'abord.
- Le rapport donne :
  - `glb` : sommets, triangles, textures et boîte englobante. Un GLB sans triangle est un échec ;
  - `nan_lines` : les lignes du journal qui parlent de NaN ;
  - `log` : la fin du journal du moteur, avec les étapes [1/7] à [7/7].

Essai local, worker arrêté (fichier `STOP`, attendre qu'il s'arrête) :

```powershell
$py = 'C:\reuse-worker\runtime\python-3.14.10\python.exe'
& $py C:\reuse-worker\app\reuse_worker.py --base C:\reuse-worker --gpu-test image   # image 512x512, logs\gpu-test.png
& $py C:\reuse-worker\app\reuse_worker.py --base C:\reuse-worker --gpu-test 3d      # GLB à partir de cette image
```

Le rapport est écrit dans `logs\gpu-test.json`. La sortie brute du moteur est dans `gpu\logs\last-<type>.log`.

## Essais et réglages à distance (sans toucher au PC)

Tout passe par le jeton admin RE-USE. Le worker reçoit les ordres à son prochain échange avec le hub.

```bash
H=https://hub.example.com/api/reuse/workers/gpu-box; A="Authorization: Bearer $HUB_REUSE_ADMIN_TOKEN"; J='Content-Type: application/json'
curl -H "$A" -H "$J" -d '{"kind":"3d"}' $H/tests                 # 201 {test:{id,status:"pending"}[, warning]}
curl -H "$A" $H/tests/7                                          # status, stage, progress, puis ok, error, result
curl -H "$A" -o essai.glb $H/tests/7/output                       # le PNG ou le GLB produit, pour le regarder
curl -H "$A" -X POST $H/tests/7/cancel                           # arrêt sous 30 s
curl -H "$A" -H "$J" -d '{"enable_3d":true}' $H/settings         # null retire le réglage : la config du PC revaut
curl -H "$A" $H/settings                                         # réglages posés + journal (qui, quand, avant, après)
```

Ce que fait un essai :
- Types d'essai :
  - `image` (512 par défaut ; paramètres width, height, steps, seed) ;
  - `3d` (res, steps, seed, texture) ;
  - `comfyui` (width, height, steps, seed, runs) ;
  - `comfyui_remove`.
- Le worker le lance entre deux travaux, dans son créneau horaire et hors pause. Il n'y a qu'un essai ouvert à la fois
  par machine. Tant qu'un essai attend, la machine ne reçoit pas de nouveau travail, mais seulement si sa version
  annonce ce type d'essai (`info.tests`). Sinon elle continue ses travaux, et le `warning` du test dit pourquoi il attend.
- L'essai s'arrête dans les 20 s environ dans trois cas : pause, fin du créneau, fichier `STOP` sur le PC. Le moteur
  est arrêté et la carte rendue. Le rapport partiel reste lisible : statut `cancelled`, raison dans `error`.
  Ce qui est installé ou téléchargé reste en place : l'essai suivant reprend là où celui-ci s'est arrêté
  (téléchargements repris, étapes d'installation déjà faites sautées).
- Pendant l'essai, le worker envoie son étape toutes les 20 s.
- Un essai devient un échec dans deux cas :
  - plus de nouvelles pendant 15 minutes (worker redémarré) ;
  - jamais démarré en 24 h.
- Un essai n'est jamais redonné après un redémarrage, pour qu'il ne puisse pas tourner en boucle.
- Le rapport (32 Ko au plus sur le hub) est aussi écrit sur le PC, dans `logs\gpu-test.json`.
- Le fichier produit (PNG de l'image ou de ComfyUI, GLB de la 3D) est envoyé au hub avant le rapport, vérifié
  (empreinte, format), et gardé pour les 10 derniers essais de chaque machine : `output.url` dans le test.
- `warning`, à la création, dit pourquoi l'essai risque d'attendre :
  - version du worker sans essais à distance (envoyer d'abord `{"update":true}` à `/order`) ;
  - hors créneau ;
  - en pause.

Réglages que le hub peut poser, et aucun autre :
- `enable_3d` (vrai ou faux) ;
- `gpu_max_gb` (5 à 200) ;
- `gpu_keep_loaded_s` (0 à 7200).

Ils sont envoyés à chaque échange. Le worker les pose sur sa config en mémoire, sans réécrire le fichier du PC.

## ComfyUI : banc d'essai seulement

Pourquoi : comparer ComfyUI (IP-Adapter, LoRA, tuiles, nœuds) à stable-diffusion.cpp sur la même carte et le même
modèle, avec des mesures. ComfyUI n'est pas un type de travail : l'essai l'installe, le mesure, puis l'arrête.

Voie retenue (recherche du 13/11/2026) : les roues PyTorch ROCm stables d'AMD (projet TheRock, index
`stable.repo.amd.com/rocm/whl-next`), dans un Python 3.13 embarqué, sans droits admin ni HIP SDK.
- torch 2.13.0+rocm10.0.0, avec les noyaux `device-gfx1030`. TheRock classe gfx1030 « Release Ready » sous Windows.
- Les autres voies sont écartées :
  - le portable AMD officiel de ComfyUI (v0.45.0) ne contient aucun noyau gfx1030 ;
  - ZLUDA exige le HIP SDK, donc des droits admin ;
  - torch-directml est arrêté à torch 2.4, alors que ComfyUI demande au moins 2.7.
- ComfyUI v0.45.0 est lancé sur 127.0.0.1 sans interface, sans nœuds additionnels ni nœuds d'API, avec
  `--use-quad-cross-attention` (pas d'AOTriton pour gfx1030).
- Le workflow est la référence officielle de Comfy-Org (`benchmarks/image_z_image_turbo.json`) : Z-Image Turbo bf16,
  calcul en fp16 sur RDNA2, 1024x1024, 8 étapes, `res_multistep`.
- `runs` passages (2 par défaut) :
  - le premier paie le chargement ;
  - le second donne `s_per_step`, comparé aux 13,2 s par étape de sd.cpp (`speedup_vs_sdcpp`).
- Une image unie (NaN en fp16) est un échec.

Place sur le disque : environ 27 Go dans `gpu\comfyui`.
- 20,7 Go de poids. Le VAE est partagé avec le moteur image par un lien physique quand c'est possible.
- Environ 5,5 Go pour Python, PyTorch ROCm et les dépendances.
- Avec l'image (11,2 Go) et la 3D (10 Go), le total dépasse le plafond de 30 Go par défaut. L'essai le dit avant tout
  téléchargement, chiffres à l'appui (`disk`). Pour aller plus loin, relever `gpu_max_gb` depuis le hub (55 suffit).
  Les 10 Go laissés libres sur le disque restent garantis.

Tout est rangé sous `gpu\comfyui` : Python, ComfyUI, poids, sorties, base SQLite, mais aussi les fichiers temporaires
de pip, les caches MIOpen, Hugging Face et torch (variables d'environnement), et pip sans cache.
- Versions épinglées : Python, pip, setuptools et l'archive ComfyUI par SHA-256, les poids par commit Hugging Face et
  SHA-256, torch à la version exacte.
- Les dépendances de ComfyUI (`requirements.txt`) viennent de PyPI, torch bloqué par contrainte.

Pour tout retirer : essai `comfyui_remove`, ou supprimer le dossier `gpu\comfyui`.

## Côté hub

- **Activation** : les générations sont actives quand la file RE-USE l'est (`HUB_REUSE_*`) et que
  `gpu-catalog.json` est publié dans le dossier du worker. Sinon `/api/gpu/*` répond 404.
- **Variable `HUB_GPU_MEMBERS`** : elle liste les membres autorisés.
  - `@12` : tous les membres du salon 12 ;
  - `Nom@12` : un seul membre de ce salon ;
  - un nom seul est refusé, car un nom est libre dans n'importe quel salon.
- **Jeton admin RE-USE** : il voit et gère tous les travaux.
- **Variables facultatives** :
  - `HUB_GPU_MAX_INPUT_SIZE` (12 Mo) ;
  - `HUB_GPU_MAX_OUTPUT_SIZE` (96 Mo) ;
  - `HUB_GPU_MAX_STORAGE` (2 Go en tout) ;
  - `HUB_GPU_RETENTION_HOURS` (72) ;
  - `HUB_GPU_PENDING_HOURS` (48) ;
  - `HUB_GPU_LEASE_SECONDS` (600) ;
  - `HUB_GPU_MAX_WAITING` (20 travaux en attente par membre) ;
  - `HUB_GPU_DIR` (`<HUB_REUSE_DIR>/gpu`).
- **Ordonnancement**, dans `POST /api/reuse/next` :
  1. le travail RE-USE que la machine calcule déjà ;
  2. le travail GPU qu'elle calcule déjà ;
  3. la vérification du planning et de la pause ;
  4. un nouveau travail GPU, mais seulement d'un type que la machine annonce (`info.gpu`) ;
  5. un nouveau morceau RE-USE.

  Une machine qui n'annonce rien (ancienne version du worker) ne reçoit jamais de travail GPU.
- **Pilotage à distance** : réglages et essais GPU d'une machine (voir plus haut). Tables `reuse_worker_settings`,
  `reuse_worker_events` (journal), `reuse_worker_tests` ; route du worker `POST /api/reuse/worker/tests/:id`.
- **Contrôle des résultats** : le hub vérifie ce qu'il reçoit. Une image doit être un PNG de la taille demandée,
  un modèle 3D un GLB 2.0 dont l'en-tête annonce la bonne longueur. Sinon il répond 422, l'essai compte, et après
  deux essais le travail passe en échec.
