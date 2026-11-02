# Voice Hold

**Maintenir une touche, parler, et les mots s'écrivent là où est le
curseur.** La dictée « appuie et parle » de macOS, pour GNOME, entièrement
hors-ligne.

[English version](README.md)

![Maintenir Super+R et parler](docs/demo-dictation.gif)

- **Maintenez `Super+R`** et parlez ; relâchez pour arrêter. **Tapez**-le
  brièvement pour dicter mains libres (un second appui, `Échap` ou quelques
  secondes de silence arrêtent).
- Le texte arrive **dans le champ sous le curseur**, bloc par bloc, pendant
  que vous parlez : un aperçu gris en direct, puis chaque phrase est tapée
  pour de bon.
- Une pastille sombre à côté du curseur montre le niveau du micro et les mots.
- **Hors-ligne.** Français, anglais et 23 autres langues européennes, avec
  ponctuation et majuscules, reconnus sur votre processeur par Parakeet TDT
  0.6B v3 (via sherpa-onnx). Ni compte, ni réseau, ni cloud. Ça marche dans
  l'avion.
- Dites *nouvelle ligne* / *à la ligne* / *nouveau paragraphe* pour un saut
  de ligne.
- En option : un LLM local (Ollama) peut polir chaque bloc. Éteint par
  défaut.
- Rien ne tourne quand vous ne dictez pas ; le modèle quitte la mémoire après
  5 minutes d'inactivité.

Deuxième membre de la famille *Hold* après
[Accent Hold](https://github.com/d101c/accent-hold).

## Installation

Deux parties : le moteur (un petit programme Python) et l'extension.

```bash
pipx install git+https://github.com/d101c/voice-hold#subdirectory=engine
voice-hold-engine setup
```

`setup` télécharge les modèles (~650 Mo, une fois) et enregistre le moteur
comme service D-Bus que GNOME Shell lance à la demande. `uv tool install`
marche aussi. Nécessite Python ≥ 3.12 et PipeWire (tout GNOME récent).

Puis l'extension depuis extensions.gnome.org (bientôt), ou depuis les
sources :

```bash
git clone https://github.com/d101c/voice-hold && cd voice-hold
./pack.sh && gnome-extensions install --force voice-hold@griffit.gmail.com.shell-extension.zip
```

Déconnectez-vous puis reconnectez-vous (Wayland), activez *Voice Hold*,
cliquez dans un champ texte, maintenez `Super+R` et parlez.

## Prérequis et limites

- GNOME Shell 45 à 50 sous Wayland.
- Fonctionne dans les applications qui utilisent le protocole Wayland
  text-input (GTK 4, GTK 3, Qt, Electron en Wayland, Firefox…). Les
  terminaux reçoivent les blocs finaux mais pas l'aperçu gris. Les
  applications X11 ne sont pas prises en charge.
- Processeur seulement. Sur un portable quatre cœurs de 2019, une phrase de
  5 secondes est tapée environ une demi-seconde après la pause ; le modèle
  occupe ~1,1 Go de RAM quand il est chargé et met ~5 s à se charger la
  première fois.

## Réglages

Raccourci, geste (maintien / appui / les deux), seuil d'appui, délai de
silence, polissage Ollama facultatif (modèle, URL), pastille et indicateur
de barre supérieure. La page de réglages montre aussi l'état du moteur et la
commande d'installation.

## Transparence

Écrit avec un assistant de code IA (Claude), conçu, relu et testé à la main
par l'auteur, qui le maintient.

## Licence

GPL-2.0-or-later.
