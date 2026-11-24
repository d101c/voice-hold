# Dossier d'article : « le texte s'écrit pendant que vous parlez »

Préparé le 24 novembre 2026. C'est de la matière, pas un texte à publier : d'après
`gnome-pack/LANCEMENT.md`, les annonces sont écrites par toi (r/gnome et le forum GNOME retirent les
messages générés), et l'usage de l'IA est dit comme pour Accent Hold. Tout ce qui suit est sourcé ;
ce qui n'est pas mesuré est marqué comme tel.

## Pourquoi cette fonction

- C'est la seule chose que les concurrents ne font presque pas : Superwhisper pour Linux colle le
  texte au relâchement, Aqua réserve le temps réel à son plan le plus cher, Wispr Flow n'a pas de
  version Linux (relevé dans `~/DEVELOPEMENT/reports/2026-11-24-voice-landing-language.md`).
- Elle est dans la version sortie (0.8), donc un lecteur qui installe voit ce que l'article décrit.
- L'histoire technique est défendable ligne par ligne, ce qui répond d'avance au soupçon sur l'IA.

Rappel : le plan de lancement prévoit Accent Hold d'abord, puis Scroll Speed. Cet article peut
attendre son tour ou servir de troisième vague.

## L'angle, en une phrase

Sur un portable de 2018 sans carte graphique, sous GNOME, on tient deux touches, on parle, et la
phrase est dans le document avant qu'on ait fini de la dire : voici comment, sans modèle « temps
réel » et sans rien envoyer nulle part.

## Où le proposer

| Support | Forme | Ce qu'il attend |
|---|---|---|
| This Week in GNOME | 4 à 6 lignes + une image | le fait nouveau, un lien |
| OMG! Ubuntu, It's FOSS | message court à la rédaction | ce que ça fait, pour qui, une démo |
| LinuxFr.org | dépêche longue, en français | le détail technique, les mesures, les limites |
| Blog ou page « How it works » | article technique en anglais | les trois difficultés ci-dessous |

## Plan proposé (article technique, 900 à 1 200 mots)

### 1. Le geste
- Maintenir `Ctrl`+`Espace`, parler, relâcher. Un appui bref garde les mains libres.
- Le texte arrive par blocs dans le champ sous le curseur : d'abord en gris (aperçu), puis définitif.
- Image : la première scène de https://gnome-details.web.app/voice-hold/ ou un GIF neuf (voir « Visuels »).

### 2. Pourquoi ce n'est pas évident
- Les modèles qui écrivent bien (ponctuation, majuscules, français et anglais) ne sont pas des modèles
  « en continu » : ils veulent une phrase entière.
- Les modèles en continu essayés écrivent tout en majuscules, sans ponctuation (zipformer français),
  ou font trop d'erreurs.
- Sous Wayland, une extension ne peut pas « taper » dans une application comme un clavier : il faut
  passer par la méthode de saisie de GNOME.

### 3. Comment c'est fait
- **Découper aux pauses.** Un détecteur de parole (Silero) coupe l'audio aux silences. Chaque segment
  fini est reconnu en entier par Parakeet TDT 0.6B « Ultra » (via sherpa-onnx).
- **Redécoder ce qui est en cours.** Pendant qu'on parle, le segment courant est redécodé environ
  toutes les 0,8 s : c'est l'aperçu gris. Possible parce que le modèle reconnaît dix fois plus vite
  que le temps réel sur ce processeur.
- **Écrire par la méthode de saisie.** L'aperçu est du texte de « pré-édition » (souligné par
  l'application), le bloc fini est validé. C'est le même objet (`Main.inputMethod`) qu'Accent Hold.
- **Deux programmes.** L'extension (GJS) fait le geste, la pastille et l'écriture. Un petit service
  D-Bus en Python fait le micro et la reconnaissance. Rien ne tourne quand on ne dicte pas ; le modèle
  quitte la mémoire après quelques minutes.

### 4. Les mesures
Toutes prises sur un Intel i7-8565U (2018), 14 Go, sans carte graphique.

| Quoi | Valeur | D'où vient le chiffre |
|---|---|---|
| Vitesse de reconnaissance | 7 à 10 fois le temps réel (4,7 s de son en 0,49 s) | `voice-hold-engine transcribe`, relancé le 24 nov. ; banc du 11 nov. |
| Mémoire pendant la dictée | environ 1 Go, rendue ensuite | mesure du 3 nov. (1,1 Go chargé, 79 Mo après) |
| Chargement du modèle après une pause | 4 à 6 s, pendant lesquelles rien de ce qui est dit n'est perdu | observé au banc |
| Français spontané, taux d'erreur | 10,6 % avec Ultra contre 42 % avec Parakeet v3, qui glissait vers l'anglais | banc du 11 nov., `voice-hold-bench`, corpus SUMM-RE |
| Mots perdus entre deux blocs | corrigé : de 12,6 % à 10,5 % d'erreurs sur du français lu | banc du 23 nov., 205 extraits |
| Tout redécoder à la fin (option « précision d'abord ») | 7,8 % sur le même jeu | même banc |

### 5. Trois choses apprises en route (le cœur de l'article)
1. **Le modèle changeait de langue en cours de phrase.** Parakeet v3 basculait en anglais sur du
   français parlé naturellement (8,5 % des extraits contaminés). Le remplaçant, de même taille et de
   même vitesse, n'en a aucun. Leçon : mesurer sur de la parole spontanée, pas sur de la lecture.
2. **Des mots disparaissaient entre deux blocs.** Le détecteur de parole jetait ce qu'il prenait pour
   du silence, et avec lui des syllabes faibles (« les pousse à »). Correction : découper dans le flux
   continu au lieu de ne garder que les segments « parlés ».
3. **Sous GNOME, le champ de saisie actif est un seul et même objet pour toutes les fenêtres.** On ne
   peut donc pas savoir qu'on a changé de fenêtre en le comparant à lui-même ; il faut regarder la
   fenêtre active. Découvert le 24 nov. en faisant suivre la dictée après un Alt+Tab (branche 0.9).

Autres pièges courts, utiles à des auteurs d'extensions : le nom d'un raccourci Mutter est global à
toutes les extensions ; il faut ignorer la répétition automatique de la touche tenue ; un aperçu
s'efface avec une chaîne vide, pas avec `null`.

### 6. Les limites, dites franchement
- Wayland seulement, GNOME 45 à 51.
- Les applications qui n'utilisent pas la méthode de saisie de GNOME reçoivent le texte collé à la fin.
- Environ 500 Mo à télécharger (moteur et modèle), 1 Go de mémoire pendant la dictée.
- Les sessions réelles couvrent une seule machine et une seule voix ; le reste vient d'un banc
  automatique.
- La fiche extensions.gnome.org attend encore sa revue : l'installation passe par GitHub ou le site.

## Ce qu'il ne faut pas écrire
- **Aucun chiffre « x fois plus rapide que le clavier »** : rien n'a été mesuré là-dessus.
- **« Hors ligne, toujours » sans nuance** : la dictée l'est, mais une option cloud existe (éteinte par
  défaut, texte seulement, jamais l'audio). Écrire « hors ligne par défaut » ou limiter à la dictée.
- **Les nouveautés de la 0.9 comme si elles étaient sorties** : mot appris par correction, suivi après
  Alt+Tab, baisse du son, page Usage sont sur une branche, pas dans la 0.8.
- **Le mot d'éveil comme fiable** : 0 faux réveil en 3,1 h et 86 % de détection, mais sur des voix de
  synthèse ; jamais essayé avec ta voix.
- **Des noms de concurrents en comparaison directe**, sauf faits vérifiables et datés.

## Questions qu'on te posera
- **Pourquoi pas Whisper ?** Essayé le 2 et le 11 nov. : la version rapide fait trop d'erreurs en
  français, les versions justes sont plus lentes que le temps réel sur ce processeur.
- **Faut-il une carte graphique ?** Non, tout a été conçu et mesuré sans.
- **Pourquoi une extension plus un programme Python ?** Une extension n'a pas le droit d'embarquer un
  moteur de reconnaissance ; le service démarre à la demande par D-Bus et s'arrête seul.
- **Est-ce que ma voix sort de l'ordinateur ?** Non. Avec l'option cloud, seul le texte d'une demande
  part, avec ta propre clé.
- **C'est écrit par une IA ?** Le README le dit (ligne « Written with an AI coding assistant ») :
  conçu, relu et testé par l'auteur. À aligner sur la formule d'Accent Hold (« How it was made »).
- **Et Superwhisper, livré par défaut sur Omarchy ?** Il cible Hyprland d'abord ; sur GNOME il colle
  le texte au relâchement et passe par le presse-papiers. Voice Hold ne fait que GNOME, et écrit
  pendant qu'on parle. (Source : leurs notes de version, lues le 24 nov.)

## Titres possibles (matière brute, à réécrire à ta façon)
- Live dictation on GNOME, without a GPU: how the words arrive while you speak
- Hold two keys and talk: building real-time dictation for GNOME on a 2018 laptop
- Dictée en direct sous GNOME : le texte s'écrit pendant qu'on parle, sans carte graphique
- What it takes to type with your voice on Wayland

## Visuels
| Visuel | État |
|---|---|
| Scènes animées de la page produit | en ligne, à filmer à l'écran si besoin |
| `docs/demo-dictation.gif` | date de la 0.4 (pastille sous la barre du haut) : à refaire avec `tools/headless/make-gif.sh`, pastille en bas |
| Capture des réglages (accueil « Hold Ctrl+Space and speak ») | faite au banc pour la 0.9, pas pour la 0.8 |
| Schéma micro → détecteur → modèle → méthode de saisie | à dessiner |
| Courbe ou tableau des mesures | les chiffres sont dans ce dossier |

## Liens
- Page : https://gnome-details.web.app/voice-hold/
- Code : https://github.com/d101c/voice-hold
- Version 0.8 : https://github.com/d101c/voice-hold/releases/tag/v0.8
- Conception d'origine : `docs/superpowers/specs/2026-11-02-voice-hold-design.md`
- Bancs : `~/DEVELOPEMENT/voice-hold-bench/` (non publié)

## Avant de publier
1. Essayer la 0.8 (ou la 0.9) en session réelle pendant quelques jours : rien de récent ne l'a été.
2. Mettre d'accord la page produit et la version installable : la page montre déjà des nouveautés de
   la 0.9. Soit sortir la 0.9, soit retirer ces scènes en attendant.
3. Ajouter au README la section « How it was made », comme pour Accent Hold.
4. Refaire le GIF de démonstration.
5. Décider si les bancs de mesure sont publiés : un lecteur voudra vérifier les chiffres.
