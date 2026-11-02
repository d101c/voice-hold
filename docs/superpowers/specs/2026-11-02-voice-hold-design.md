# Voice Hold — design

Date : 2026-11-02. Auteur : Julien Griffit, avec un assistant IA (Claude).

## Intention

Apporter à GNOME la dictée « appuie et parle » de macOS (double appui sur Fn) :
on maintient un raccourci, on parle, le texte s'écrit **dans le champ où se
trouve le curseur**, bloc par bloc, pendant qu'on parle. Tout tourne en local,
sans réseau : ça marche dans l'avion.

Deuxième membre de la famille « Hold » après Accent Hold : même geste
(maintenir une touche), même visuel sombre, même mode de diffusion
(extensions.gnome.org, un clic).

## Objectifs

- Rapide à l'usage : le premier texte apparaît moins d'une seconde après le
  début de la parole ; chaque phrase est posée moins d'une seconde après la
  pause qui la termine.
- Lisible : on voit ce qui se passe. Une pastille sombre sous le curseur
  montre le niveau du micro et l'état ; le texte en cours s'affiche en
  « pré-édition » (gris, souligné par l'application) puis se fige bloc par
  bloc. Jamais un monobloc qui tombe d'un coup à la fin.
- Hors-ligne, sans LLM : la reconnaissance seule ponctue et met les
  majuscules. Un LLM local (Ollama) est **facultatif**, éteint par défaut.
- Français et anglais sans réglage (le modèle détecte la langue, mélange
  compris).
- Sobre : rien ne tourne quand on ne dicte pas (ni micro, ni calcul). Le
  modèle se décharge de la mémoire après un délai d'inactivité.
- Publiable sur extensions.gnome.org comme Accent Hold : l'extension est du
  GJS pur ; le moteur est un programme séparé installé en une commande.

## Non-objectifs

- Pas de commandes vocales de mise en forme (gras, sélection…). Seules
  « nouvelle ligne / à la ligne / new line / new paragraph » sont reconnues.
- Pas de transcription de réunion ni de fichier : c'est de la dictée courte,
  dans un champ texte.
- Pas de support X11 ni des applications sans `text-input` Wayland dans la
  v1 (les terminaux fonctionnent : ils acceptent `commit`, pas la pré-édition).
- Pas de GPU.

## Anti-objectifs (ce qui serait un échec)

- Un texte qui n'arrive qu'à la fin.
- Une machine qui chauffe en permanence (RAM/CPU occupés hors dictée).
- Des réglages système modifiés (dconf de l'utilisateur, sources de clavier).
- Une dépendance au réseau ou à une clé d'API pour le mode de base.

## Contraintes

- Machine de référence : i7-8565U (4 cœurs), 14 Go, pas de GPU. Si ça ne
  tourne pas là, ça ne tourne nulle part.
- GNOME Shell 45 → 50, Wayland.
- Python ≥ 3.12 côté moteur (3.14 testé), PipeWire pour le micro.

## Choix du moteur (banc du 2/11, audio synthétique fr/en, 4 threads)

| Moteur | RTF | WER fr | WER en | Ponctuation | RAM | Verdict |
|---|---|---|---|---|---|---|
| Parakeet TDT 0.6B v3 int8 (sherpa-onnx) | 0,10 | 0–14 % | 0–7 % | oui, casse aussi | 1,1 Go | **retenu** |
| Whisper base int8 (faster-whisper) | 0,14 | 0–32 % | 0–13 % | oui | 0,4 Go | trop d'erreurs en fr |
| Whisper small int8 | 0,6–1,0 | 5–21 % | 0 % | oui | 1,0 Go | trop lent |
| Zipformer fr streaming int8 | 0,15 | 5–21 % | — | non, majuscules | 0,2 Go | fr seul, brut |

Parakeet v3 couvre 25 langues européennes avec détection automatique, sort une
ponctuation propre et « GNOME » bien orthographié. Son coût est la RAM
(1,1 Go chargé) : d'où le déchargement après inactivité.

Le « streaming » visible se fait sans modèle streaming : le détecteur de
voix (Silero VAD, 2 Mo, ~1 % de CPU) découpe la parole aux pauses ≥ 400 ms ;
chaque segment terminé est décodé et **posé** (bloc) ; pendant qu'un segment
est en cours, le moteur redécode la fenêtre courante (≤ 8 s) toutes les
~800 ms et envoie un **partiel** affiché en pré-édition. À 0,1× temps réel,
un partiel de 6 s coûte 0,6 s : la cadence s'adapte (jamais plus d'un
partiel en vol).

## Architecture

```
┌───────────────── GNOME Shell (GJS) ─────────────────┐   D-Bus session   ┌──── voice-hold-engine (Python) ────┐
│ extension.js   raccourci, état hold/tap/toggle      │ ───────────────▶ │ org.griffit.VoiceHold               │
│ hud.js         pastille sombre : niveau + état      │ ◀─── signaux ─── │  Start/Stop/Cancel, Level, Partial, │
│ textSink.js    pré-édition / commit via inputMethod │                  │  Final, State, Error                │
│ engine.js      proxy D-Bus, installation manquante  │                  │ audio: pw-record 16 kHz mono        │
│ prefs.js       réglages (Adw)                       │                  │ vad: Silero · asr: Parakeet v3 int8 │
└──────────────────────────────────────────────────────┘                  │ polish: Ollama (option)             │
                                                                          └──────────────────────────────────────┘
```

### Extension (`extension/`, UUID `voice-hold@griffit.gmail.com`)

- **Raccourci** : `<Super>r` par défaut (libre dans GNOME et Ubuntu ; R comme
  *record*), configurable.
- **Geste** (machine à états `holdMachine.js`, testable en gjs pur) :
  - À l'activation, écoute immédiate.
  - Si Super est encore enfoncé 350 ms après l'activation → **mode maintien** :
    relâcher Super termine la dictée (poll du masque de modificateurs via
    `global.get_pointer()` toutes les 50 ms, uniquement pendant l'écoute).
  - Sinon (appui bref) → **mode bascule** : on dicte mains libres ; le même
    raccourci, Échap ou un silence de `auto-stop-s` (défaut 6 s) termine.
  - Échap pendant l'écoute = annuler : le partiel en pré-édition est effacé,
    les blocs déjà posés restent.
  - Changement de fenêtre focalisée = terminer proprement (le partiel est
    posé).
- **Insertion** (`textSink.js`), via `Main.inputMethod` comme Accent Hold :
  - partiel → `set_preedit_text(texte, len, len, CLEAR)` ;
  - bloc final → pré-édition effacée puis `commit(texte)` ;
  - espacement intelligent : un espace est ajouté devant un bloc si le
    caractère avant le curseur (texte environnant, quand l'application le
    fournit) n'est pas un espace, un saut de ligne ou une parenthèse ouvrante ;
    sans texte environnant, un espace est ajouté entre deux blocs de la même
    session de dictée ;
  - « nouvelle ligne » & co → `\n` ;
  - pas d'`inputMethod` actif (aucun champ texte focalisé) → la pastille le
    dit (« Cliquez dans un champ texte ») et rien n'est tapé.
- **Pastille** (`hud.js`) : `St.BoxLayout` dans `uiGroup`, placée sous le
  curseur texte (`_cursorRect`) sinon sous le pointeur ; fond
  `rgba(40,40,40,0.95)`, rayon 12, comme `.accent-popup`. Contenu : icône
  micro, 7 barres de niveau (bleu `#3584e4`, mises à jour par le signal
  `Level` toutes les 50 ms, retombée amortie), libellé d'état (« Écoute… »,
  « … » pendant un décodage, « Modèle en chargement… », « Super+R pour
  arrêter »). Disparaît 400 ms après le dernier bloc. Elle ne prend jamais le
  focus.
- **Moteur absent** : la pastille affiche l'erreur en une ligne et les
  réglages montrent la commande d'installation + un bouton « Tester le
  moteur ». L'extension ne télécharge rien et ne lance rien d'autre que
  l'activation D-Bus.
- **Indicateur** de barre supérieure (option, comme Accent Hold) : icône,
  interrupteur « Activé », « Réglages ».
- **Réglages** (`prefs.js`, Adw) : raccourci, mode (auto / maintien seul /
  bascule seule), arrêt automatique sur silence, langue forcée (auto / fr /
  en…), LLM facultatif (interrupteur, modèle Ollama, URL), état du moteur,
  indicateur.

### Moteur (`engine/`, paquet Python `voice-hold-engine`)

- Service D-Bus session `org.griffit.VoiceHold`, objet `/org/griffit/VoiceHold`,
  activable (fichier `.service` installé dans
  `~/.local/share/dbus-1/services/` par `voice-hold-engine install`).
  Bibliothèque : `dbus-fast` (asyncio, pur Python possible).
- Interface :
  - méthodes `Start(options: a{sv})`, `Stop()` (termine et pose le dernier
    bloc), `Cancel()`, `Status() → a{sv}` (modèle prêt, chargé, version) ;
  - signaux `State(s)` (`idle|loading|listening|decoding`), `Level(d)` (RMS
    0–1 toutes les 50 ms), `Partial(s)`, `Final(s)`, `Error(s)`.
- Audio : `pw-record --rate 16000 --channels 1 --format s16 -` en sous-
  processus, lu par tranches de 32 ms ; lancé à `Start`, tué à `Stop`.
- VAD Silero via `sherpa_onnx.VoiceActivityDetector` (seuil 0,5, silence
  400 ms, parole mini 250 ms, segment maxi 15 s).
- ASR `sherpa_onnx.OfflineRecognizer` (Parakeet TDT v3 int8, 4 threads).
  Partiels : fenêtre courante (≤ 8 s) redécodée dès que le décodage précédent
  est fini et qu'au moins 700 ms d'audio neuf sont arrivées. Décodages dans
  un thread, un à la fois ; un final a priorité sur un partiel.
- Modèles dans `~/.local/share/voice-hold/models/` ; `voice-hold-engine
  setup` télécharge Parakeet (≈ 650 Mo) et Silero depuis les releases GitHub
  de sherpa-onnx, avec vérification de taille. Rien n'est téléchargé à
  l'insu de l'utilisateur.
- Déchargement du modèle après `idle-unload-s` (défaut 300 s) sans dictée ;
  le processus quitte après 2 × ce délai. Rechargement au `Start` suivant
  (signal `State('loading')`, la pastille le dit).
- LLM facultatif : si activé, chaque bloc final passe par Ollama
  (`POST /api/generate`, modèle choisi, consigne fixe « corrige ponctuation et
  casse, ne change aucun mot », délai 2 s) avant d'être émis ; en cas
  d'échec, le texte brut part tel quel. Le partiel n'est jamais poli.
- Mode fichier pour les tests et la démo : `Start({"audio-file": path})`
  rejoue un WAV à vitesse réelle à la place du micro.

### Protocole de test

- `holdMachine.js` et le calcul d'espacement : tests gjs purs.
- Moteur : pytest sur le découpeur de blocs (faux VAD), l'espacement/les
  commandes, la sérialisation D-Bus ; un test d'intégration qui lance le
  service sur un bus privé (`dbus-run-session`) avec un WAV et vérifie la
  séquence `State/Partial/Final`.
- Bout en bout : le banc headless d'Accent Hold (gnome-shell `--headless`,
  env XDG privé **posé avant** `dbus-run-session`) avec le mode fichier ;
  sert aussi à produire le GIF de démo.

### Installation (README)

```
pipx install git+https://github.com/d101c/voice-hold#subdirectory=engine   # ou uv tool install
voice-hold-engine setup      # télécharge les modèles (~650 Mo), installe le service D-Bus
```
puis l'extension depuis extensions.gnome.org (ou `pack.sh` + `gnome-extensions install`).

## Laissé au constructeur

- Dessin de l'icône (micro dans le style d'`accent-hold-symbolic.svg`).
- Valeurs exactes de l'amortissement des barres et des délais d'affichage.
- Textes des traductions fr (gettext, comme Accent Hold).
- Gestion fine des erreurs micro (pas de PipeWire, micro muet : message
  explicite dans la pastille).
