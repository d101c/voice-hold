# Autocritique — Accent Hold 2.1 et Voice Hold 0.1

Date : 3 novembre 2026. Rédigé par l'assistant (Claude) à la demande de
l'auteur, avant toute publication de Voice Hold sur extensions.gnome.org.
Deux relectures indépendantes (agents sans mon biais d'auteur, règles de
revue EGO sous les yeux) nourrissent les parties 2 et 3 ; la partie 1 est ma
lecture de ce que j'ai décidé et fait.

## 1. Ce que je me reproche (produit et méthode)

### 1.1 Les deux extensions

- **J'ai réutilisé mes propres recettes sans les remettre en cause.** Le
  patch du prototype `IBus.InputContext.process_key_event_async`, l'usage
  de `Main.inputMethod._cursorRect` (membre privé), le nom de raccourci
  `trigger` : copiés d'Accent Hold vers Voice Hold tels quels. Résultat
  immédiat : les deux extensions se sont neutralisées (« Trying to re-add
  keybinding "trigger" »), bug que mon banc headless ne pouvait pas voir
  puisqu'il ne chargeait qu'une extension à la fois. **Leçon :** le banc
  doit charger l'ensemble des extensions de l'utilisateur, et un nom de
  raccourci doit être préfixé (`accent-hold-…`, `voice-hold-…`).
- **Deux extensions qui patchent le même prototype** se restaurent chacune
  « à l'aveugle » dans `destroy()`. Dans le bon ordre ça marche ; dans le
  mauvais ordre (une qui plante à l'activation, un changement de mode de
  session), l'une des deux laisse un wrapper mort qui journalise une erreur
  à chaque touche. À corriger des deux côtés : ne restaurer que si le
  prototype porte encore *son* wrapper, sinon neutraliser le wrapper.
- **« Testé sur GNOME 45 à 50 » n'est vrai que pour 50.** Je déclare les
  six versions dans `metadata.json` sans en avoir lancé une seule autre que
  celle de la machine. Or l'API bouge entre 45 et 46 (`getSurroundingText`
  rend 2 valeurs sur 45, 3 ensuite) et `findMonitorForPoint` n'existe pas
  sur 45. Soit on teste (VM GNOME 45/46/48), soit on réduit la liste.
- **Couleurs en dur** (`rgba(40,40,40,.95)`, `#3584e4`) : la « famille
  visuelle sombre » ignore le thème clair et le contraste élevé. C'est un
  choix assumé pour l'identité, mais il faudrait au moins une variante
  claire pilotée par `prefers-dark`/la couleur d'accent de GNOME 47+.
- **Processus** : au tout début de ce projet, mon banc de test a écrit dans
  le vrai dconf de l'utilisateur (sources clavier, extensions activées,
  thème). Corrigé depuis (env XDG privé posé *avant* `dbus-run-session`),
  mais c'était une faute, et la question du thème sombre d'origine est
  restée sans réponse.

### 1.2 Accent Hold 2.1 (déjà publié)

- La promesse « la lettre maintenue ne se répète pas » dépend de qui gère
  la répétition : sur GNOME 49/50 avec un client récent, c'est le
  compositeur et l'extension avale ses répétitions ; sur 45–48, ou avec un
  client Wayland plus ancien (Electron, vieux GTK3, Firefox selon la
  version), **le client se répète tout seul** et l'extension ne voit rien :
  « eeeeeè ». Je l'ai écrit dans le README et dans la description EGO sans
  l'avoir vérifié ailleurs que sur 50. C'est le point le plus grave.
- Le sélecteur `Super+E` passe par le presse-papiers + `Shift+Insert` avec
  une restauration après 300 ms : une course, pas un protocole. Un
  presse-papiers image est effacé (`get_text` rend null), PRIMARY n'est
  jamais restauré, et une appli lente peut coller l'ancien contenu (un mot
  de passe, par exemple) à la place de l'accent. Ma réponse au relecteur
  EGO (« restores your previous clipboard content ») promettait plus que
  le code ne tient.
- Espace et Entrée *confirment* la variante : une hésitation de 400 ms sur
  « e » puis espace donne « thé » au lieu de « the », et Entrée dans un
  chat envoie « é » au lieu du message. Choix d'ergonomie que j'ai pris
  pour de la fluidité ; c'est un piège.
- La version 6 (correctif) a été poussée sur la release GitHub v2.1 avec
  `--clobber`, en remplaçant un fichier déjà publié sous le même nom. Il
  aurait fallu une v2.1.1.
- Le message pour This Week in GNOME : la règle du salon exige des mots de
  l'auteur ; j'ai fourni un exemple complet que l'auteur a posté tel quel.
  J'avais prévenu, mais j'aurais dû fournir une trame courte à réécrire,
  pas un texte prêt à coller.
- Le dépôt traîne du poids mort visible depuis la page EGO (`legacy/`,
  `tools/` qui référencent un démon disparu, un `.mo` et des `target/`
  suivis par git).

### 1.3 Voice Hold 0.1 (pas encore publié)

- **Le « un clic » d'EGO est faux pour cette extension** : il faut aussi
  `pipx install` + 650 Mo de modèles + un service D-Bus. L'extension seule
  affiche un message d'erreur et un lien. C'est honnête, mais c'est une
  expérience à deux étages qu'il faut assumer dans la description, et les
  relecteurs EGO demanderont pourquoi un service externe.
- **1,1 Go de RAM** quand le modèle est chargé, sur une machine de 14 Go
  déjà bien occupée. Le déchargement après 5 min est une rustine ; la
  vraie question est « est-ce que le modèle 0,6 B est le bon pour ce type
  de machine ? ». J'ai écarté Whisper base pour ses erreurs en français,
  mais un Parakeet plus petit (ou un Zipformer multilingue) n'a pas été
  cherché sérieusement.
- **L'aperçu redécode la fenêtre courante en entier** toutes les 0,7 s :
  coût qui grimpe avec la longueur de la phrase, d'où le « ça cale » ressenti
  sur un long monologue. Une vraie solution serait un modèle streaming pour
  l'aperçu, ou un décodage incrémental ; j'ai seulement réduit la fenêtre
  (6 s) et forcé la coupure à 8 s.
- **Sécurité locale** : n'importe quel processus de la session peut appeler
  `Start()` et lire les signaux `Final` (le texte dicté). Même utilisateur,
  donc même niveau de confiance que le micro lui-même, mais ce n'est écrit
  nulle part.
- **Licences** : le README ne crédite ni NVIDIA (Parakeet, CC-BY-4.0, qui
  exige l'attribution), ni Silero (MIT), ni sherpa-onnx (Apache-2.0). À
  corriger avant toute publication.
- **Tests** : la machine à états et le découpeur sont testés ; la pastille,
  les réglages et le bus D-Bus ne le sont que par capture d'écran headless.
  Aucun test ne couvre `sources.py` ni l'interface D-Bus elle-même.
- **Ergonomie de la pastille** : texte sur une ligne tronqué par le début,
  pas de retour visuel quand le micro ne capte rien (niveau nul pendant
  3 s devrait le dire), pas d'indication du mode (maintien / mains libres)
  autrement que par le libellé.
- Trois déconnexions/reconnexions imposées à l'utilisateur en une soirée,
  parce que GNOME Wayland ne recharge pas le JS. C'est le prix d'itérer en
  direct ; j'aurais dû regrouper les changements d'extension.

## 2. Relecture indépendante d'Accent Hold 2.1

(Voir le rapport complet dans l'annexe A ; résumé des constats retenus.)

| # | Gravité | Constat | Correctif |
|---|---|---|---|
| B1 | haute | Répétition de touche côté client (45–48, clients anciens) : « eeeeeè » | Envoyer le relâchement au client à l'ouverture de la fenêtre, ou supprimer le bon nombre de lettres via `delete_surrounding`, et dire honnêtement la limite |
| B2 | haute | Fenêtre hors écran (y jamais borné), `_cursorRect` périmé après changement d'appli | Borner x et y, multi-écran, invalider le rect au changement de focus |
| B3 | haute | Nom de raccourci `trigger` global, collision avec toute extension du même nom | Renommer `accent-hold-trigger` (migration de l'ancienne valeur) |
| B4 | haute | Restauration du prototype dépendante de l'ordre ; wrapper mort = erreur par touche | Restaurer seulement si on possède encore le prototype ; wrapper neutralisable |
| B5 | moyenne | Espace/Entrée confirment → « thé », Entrée envoie « é » | Espace/Entrée ferment la fenêtre et passent à l'appli |
| B6 | moyenne | Re-presser la lettre maintenue est avalé | Marquer le relâchement, traiter la nouvelle pression comme une nouvelle touche |
| B7 | haute | Presse-papiers image effacé, PRIMARY perdu, course de 300 ms | Restaurer tout type de contenu, attendre l'événement de collage plutôt qu'un délai |
| B8 | moyenne | `commit` différé de 120 ms peut atterrir dans une autre fenêtre ; `getSurroundingText` à 2 valeurs sur 45 | Annuler `_commitId` sur perte de focus ; gérer l'arité 45 |
| B9 | basse | Table JSON non validée → machine bloquée | Valider la forme (objet de chaînes → tableau de chaînes) |
| B10 | moyenne | Une lettre seule acceptée comme raccourci → la lettre détournée partout | Exiger un modificateur ou une touche de fonction |

Autres : « Activé » ne coupe que le raccourci, pas l'appui long ; `layouts`
gate aussi l'appui long sans le dire ; pavé numérique sans NumLock ferme
la fenêtre ; dans un terminal en mode normal (vim), BackSpace + commit
font n'importe quoi ; Qt passe souvent par son propre client IBus (le
README dit « most Qt apps » sans preuve) ; tests : 5 cas, rien sur `_key()`
ni `_canDeleteBeforeCursor`, pas de CI.

## 3. Relecture indépendante de Voice Hold 0.1

(Rapport complet en annexe B ; constats retenus.)

| # | Gravité | Constat | Correctif |
|---|---|---|---|
| C1 | critique | Maintenir Super+**R** fait répéter la touche R → le raccourci retire toutes les 30 ms → stop/start en boucle. Mon banc tapait R et ne maintenait que Super, donc ne le voyait pas | `Meta.KeyBindingFlags.IGNORE_AUTOREPEAT` |
| C2 | critique | Si le moteur meurt en pleine dictée, rien ne finit jamais : pastille et aperçu gris restent, timer à 60 ms pour toujours | Surveiller `g-name-owner`, finir la session à la perte ; délai de garde après `Stop` |
| H1 | haute | Le texte est commité dans la fenêtre qui a le focus *au moment du Final*, pas celle de la dictée (dialogue de mot de passe, notification) | Mémoriser la fenêtre au départ, refuser commit/partiel si elle a changé |
| H2 | haute | Relancer le raccourci pendant que le moteur finit de décoder : `Start` ignoré en silence, puis le `Stopped` de l'ancienne session tue la nouvelle | `Start` pendant une session active = erreur D-Bus ; ou file d'attente côté extension |
| H3 | haute | Même piège de prototype qu'Accent Hold (B4) : désactiver Accent Hold d'abord casse Échap ici, puis laisse un wrapper mort | Restauration gardée + wrapper neutralisable, dans les deux extensions |
| H4 | haute | Erreurs de démarrage (`models-missing`, `audio:`) sans `Stopped` → session à moitié ouverte | Émettre `Stopped('error')` ; l'extension clôt sur `Error` sans suite |
| M1 | moyenne | Espacement faux sur GNOME 45 (`getSurroundingText` à 2 valeurs) et dans les applis sans texte environnant : espace en début de ligne après « nouvelle ligne » | Le puits retient le dernier caractère commité |
| M2 | moyenne | Relancer pendant le fondu de la pastille la détruit pour toute la session suivante | `remove_all_transitions()` dans `show()` |
| M3 | moyenne | Course stop/cancel/start côté moteur : la session suivante perd sa source et `pw-record` garde le micro ouvert | `_finish` arrête la source ; `stop()` revérifie la génération |
| M4 | moyenne | Entre 6 et 8 s de parole continue, l'aperçu perd son début (fenêtre 6 s < coupure 8 s) | Fenêtre ≥ coupure, ou préfixe de texte conservé |
| M5 | moyenne | Ouvrir le menu de l'indicateur lance le moteur (ListSources sans `NO_AUTO_START`) | `NO_AUTO_START` |
| L1–L5 | basse | `findMonitorForPoint` absent sur 45 ; `_cursorRect` privé et périmé ; 31 signaux `Level`/s ; délai `Stop` de 15 s dépassable ; erreur journalisée à la désactivation rapide | Voir annexe |

Moteur : `pw-record` qui meurt passe pour une fin d'audio normale ;
`pw-dump` synchrone dans `Start` ; le polissage bloque le décodeur ; pas de
somme de contrôle sur les téléchargements ; **commandes « nouvelle ligne »
détectées au milieu des phrases** (« il a une nouvelle ligne de vêtements »
→ saut de ligne), avec une assertion de test rendue inoffensive par un
`or True` — c'est le genre de chose que je ne devrais jamais laisser ;
`unload()` ne rend que 400 Mo sur 1,1 Go (682 Mo restent résidents sans
`malloc_trim`) : la promesse « le modèle quitte la mémoire » est fausse en
l'état ; licences absentes (Parakeet CC-BY-4.0, Silero MIT, sherpa-onnx
Apache-2.0 → l'« or-later » du GPL est ce qui rend le moteur distribuable) ;
« Dictate the macOS way » est une référence de marque à reformuler ; le
bouton « copier » des réglages touche au presse-papiers et doit être
déclaré ; GNOME 51 est sorti et n'est pas dans `shell-version`.

## 4. Nom, icône, description

### Nom

Je recommande de garder **Voice Hold**. Arguments : il dit le geste
(*hold*) et la matière (*voice*), il forme une famille lisible avec Accent
Hold sur la page EGO et dans les dépôts, il se cherche bien (« voice hold
gnome » ne renvoie rien d'autre), et il n'évoque ni Whisper ni une marque.
Alternatives considérées et écartées : *Hold to Speak* (trois mots, pas de
famille), *Dictée* / *Dictate Hold* (trop proche de l'app Windows « Voice
Typing » et des « Dictation » Apple), *Talk Hold* (plat), *Whisper Hold*
(fausse piste technique).

### Icône

Trois pistes dans le style du « é » d'Accent Hold (glyphe plein, sombre,
sans fond) : micro seul (générique), **micro avec deux barres de niveau**
(dit « voix qui entre », se distingue du micro de GNOME), micro dans une
touche de clavier (dit « maintenir une touche » mais illisible à 16 px).
Recommandation : la deuxième, en symbolique 16 px pour la barre et en
128 px pour EGO.

### Description EGO (proposition)

> Dictate the macOS way: hold Super+R, speak, release. The words are typed
> where your cursor is while you talk, block by block, with a live grey
> preview. A quick tap keeps listening hands-free. Everything runs on your
> computer, offline (Parakeet TDT v3 via sherpa-onnx): French, English and
> 23 other European languages with punctuation; no account, no cloud.
>
> Requires the voice-hold-engine helper (Python, one install command, ~650 MB
> of models) and PipeWire; the settings page shows the command and the
> engine status. Wayland only; applications must use the GNOME input method
> (GTK, most Electron builds with Wayland; terminals get the text without the
> preview). Optional: a local Ollama model can polish each block (off by
> default).

## 5. Plan de publication (comme Accent Hold)

1. Corriger ce qui est marqué « haute » ci-dessus dans les deux dépôts.
2. Accent Hold 2.2 : correctifs + nouvelle release GitHub (pas de
   `--clobber`), nouvelle version EGO avec notes de version honnêtes.
3. Voice Hold 0.2 : licences, préfixes, prototype sûr, tests D-Bus, README
   d'installation vérifié depuis un dépôt public (pipx), puis `pack.sh`,
   upload EGO, icône 128 px, capture d'écran et GIF.
4. Promo : mêmes canaux qu'Accent Hold (TWIG en mots de l'auteur, tips
   presse, LinuxFr, Mastodon, Show HN), en liant les deux extensions comme
   une famille.
