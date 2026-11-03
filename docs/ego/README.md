# extensions.gnome.org — dossier de soumission (préparé le 3 novembre 2026)

Rien ici n'est envoyé : ce dossier rassemble ce qu'il faut pour les deux
uploads, à faire depuis le navigateur de l'utilisateur (compte EGO `jg__`),
après fusion des PR.

## 1. Accent Hold 2.2 (mise à jour de l'extension 10265)

- Préalable : fusionner `d101c/accent-hold#9` (fix-2.2) et `#8` (demo-gif),
  puis sur `master` : `./pack.sh` → `accent-hold@griffit.gmail.com.shell-extension.zip`.
- Tag et release GitHub `v2.2` avec ce zip (nouvelle release, jamais `--clobber`).
- Upload sur https://extensions.gnome.org/upload/ (cocher les deux cases :
  licence compatible, conditions acceptées — la case licence est à cocher
  par l'utilisateur).
- Commentaire auteur à poster sur la revue qui s'ouvre, en anglais :

> 2.2 is a maintenance release after an independent code review. Changes a
> reviewer may want to know about: the shortcut picker no longer uses the
> clipboard at all (it commits through the shell input method; the clipboard
> declaration is gone from the description); the keybinding key is namespaced
> (`accent-hold-shortcut`, old value migrated once); the IBus prototype wrapper
> is only installed while press-and-hold is on and is restored only if it is
> still ours, so it coexists with other extensions patching the same method;
> both popups are clamped to the monitor; Space and Enter dismiss instead of
> inserting an accent. 54 unit tests run with plain gjs. I used AI assistance
> to write and review this code and can explain every line.

## 2. Voice Hold 0.2 (première soumission)

- Préalable : fusionner `d101c/voice-hold#1` (fix-0.2), puis sur `master` :
  `./pack.sh` → `voice-hold@griffit.gmail.com.shell-extension.zip` (19 fichiers).
- Rendre le dépôt GitHub public (il est privé) : l'URL est dans `metadata.json`.
- Release GitHub `v0.2` avec le zip et une note d'installation du moteur.
- Upload du zip sur https://extensions.gnome.org/upload/ (mêmes deux cases).
- Sur la fiche créée : icône `docs/icon/voice-hold-128.png`, capture
  `docs/ego/voice-hold-screenshot.png`.
- Description : celle de `extension/metadata.json` (déjà sans « macOS »,
  déclare le moteur séparé GPL, le presse-papiers du bouton Copier, Wayland).
- Commentaire auteur à poster dès la première revue, en anglais :

> Voice Hold needs a separate helper (`voice-hold-engine`, Python, GPL-2.0-or-later,
> same repository) that does the speech recognition offline with sherpa-onnx.
> The extension only talks to it over the session bus (`org.griffit.VoiceHold`,
> D-Bus activation) and shows the install command in its preferences; it never
> spawns anything itself. Two points a reviewer may ask about: (1) it wraps
> `IBus.InputContext.prototype.process_key_event_async` while a hands-free
> session is running, to catch Escape, and restores it only if the wrapper is
> still its own; (2) it reads `Main.inputMethod._cursorRect` to place the pill
> under the text cursor, falling back to the pointer. The Copy button in the
> preferences writes the install command to the clipboard, as declared.
> I used AI assistance to write and review this code and can explain every line.

## 3. Réponses attendues des relecteurs

- EGO-A-005 (clipboard) sur Voice Hold : bouton Copier des préférences,
  déclaré, texte seulement, jamais lu.
- Patch de prototype : justification ci-dessus ; `keyHook.js` / `imPatch.js`.
- Membre privé `_cursorRect` : repli pointeur si absent ; aucune écriture.
- « AI-generated » : réponse honnête (outil, code assumé), comme pour la 2.1.

## 4. Après acceptation

- Mettre à jour `docs/posts.md` et préparer les textes TWIG / forums avec les
  mots de l'utilisateur (règle : jamais un texte prêt à coller).
- Suivi : les tâches planifiées `accent-hold-bilan-weekend` (8/11) et
  `accent-hold-bilan-semaine-2` (14/11) ajoutent Voice Hold à leur bilan.
