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
- Description : celle de `extension/metadata.json` (sans « macOS »,
  déclare le moteur séparé GPL, le presse-papiers des boutons Copier, le réseau,
  les fichiers écrits et l'absence de bouton de désinstallation ; Wayland).
- Commentaire auteur à poster dès la première revue, en anglais :

> Voice Hold needs a separate helper (`voice-hold-engine`, Python, GPL-2.0-or-later,
> same repository) that does the speech recognition offline with sherpa-onnx.
> The extension only talks to it over the session bus (`org.griffit.VoiceHold`,
> D-Bus activation) and shows the install command in its preferences. (Since
> 0.5 the preferences, and only on a click, spawn the installed helper once
> with `setup --commands` through `Gio.Subprocess`; the shell process spawns
> nothing.) Two points a reviewer may ask about: (1) it wraps
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

## 5. Voice Hold 0.4 (préparé le 10 novembre 2026, pas encore envoyé)

- Changement visible : la pastille est un « îlot » qui sort de la barre du
  haut (réglage `hud-position`, `cursor` garde l'ancien placement).
- `./pack.sh` → zip ; l'upload remplace la 0.3 encore en file (#77772).
- Capture : `docs/ego/voice-hold-screenshot.png` est désormais une vraie image
  du banc headless (`SNAP=1 tools/headless/run.sh`), plus une maquette SVG.
- Commentaire auteur, en anglais :

> 0.4 moves the pill: by default it is now a small capsule that slides out
> of the top bar (an actor added to `Main.layoutManager.uiGroup`, never
> reactive, destroyed when the dictation ends) instead of following the text
> cursor; the old placement is still a setting, and only that one reads
> `Main.inputMethod._cursorRect`. The capsule reads the panel's background
> colour from its theme node and `panelBox`'s geometry; it writes nothing to
> the panel. The Installation page lost the parts that served another
> extension: it only downloads the speech engine and its models now, and is
> laid out as three numbered steps with a field to try the dictation in.
> First run: when the engine is not on the session bus, the extension shows
> one notification (its MessageTray source is destroyed in disable()) whose
> button calls openPreferences(); pressing the shortcut without the engine
> does the same. After writing the D-Bus service file the preferences call
> org.freedesktop.DBus.ReloadConfig so no logout is needed. The default
> shortcut is now Ctrl+Space. No new prototype patch, no subprocess. I used AI assistance to write and review
> this code and can explain every line.

## 6. Voice Hold 0.5 (envoyé le 11 novembre 2026)

- Zip : `./pack.sh` sur `master` ; icône `docs/icon/voice-hold-256.png`
  (source `voice-hold-ego.svg`) ; capture `docs/ego/voice-hold-screenshot.png`
  (deux vraies images du banc headless, légendées).
- Commentaire auteur, en anglais :

> 0.5 adds optional voice commands, off by default (`commands-enabled`), on a
> second keybinding (Ctrl+Alt+Space). Their code lives in `commands/` and is
> imported lazily, only when the setting is on. What a reviewer may ask about:
> (1) the extension itself never runs a shell command: it sends the transcript
> to a second D-Bus service of the same separate helper
> (`org.griffit.VoiceHold.Commands`), which classifies it; GNOME actions
> (volume, dark mode, workspace, launching an app through `Gio.DesktopAppInfo`)
> are done in the extension, and a shell command is only run by the helper, in
> a visible terminal, after the user confirmed it in a modal dialog;
> (2) the Commands page of the preferences has one Install button that spawns
> the already-installed helper with `setup --commands` (`Gio.Subprocess`, from
> prefs.js only, never from the Shell process) to download a local language
> model; nothing is downloaded without that click; (3) the pill reads
> `org.gnome.desktop.interface font-name` to use the system font, and has four
> entrance animations done with `ease()`. The speech model changed (Parakeet
> "Ultra"); there is no Ollama dependency any more. No new prototype patch.
> I used AI assistance to write and review this code and can explain every line.

## 7. Voice Hold 0.6 (préparé le 13 novembre 2026, branche `ego-0.6`, pas encore envoyé)

- Avant l'upload : créer le tag `v0.6` sur `d101c/hold-setup` (le manifeste y
  est lu : `setup.js`, constante `MANIFEST_URL`), puis `./pack.sh`.
- La description déclare maintenant : réseau seulement après un clic sur
  Installer, fichiers écrits (`~/.local/share/hold`, `voice-hold`,
  `dbus-1/services/org.griffit.VoiceHold.service`), sous-processus (prefs,
  sur clic), presse-papiers (boutons Copier, jamais lu), et l'absence de
  bouton de désinstallation (les commandes de retrait sont données).
- Commentaire auteur, en anglais :

> 0.6 is a cleanup after the review of 0.5. Changes: the preferences no longer
> touch the network when opened; the manifest of the installer is fetched only
> after a click on Install, and it is pinned to the `v0.6` tag of the
> `hold-setup` repository, not to a branch; files are still checked against its
> SHA-256 before being unpacked. The description now lists the network use,
> the files written under `~/.local/share`, the clipboard (Copy buttons, write
> only) and says honestly that there is no uninstall button. The only
> subprocess is `Gio.Subprocess` for `setup --commands`, in prefs.js, on a
> click; the shell process spawns nothing. Signals use connectObject /
> disconnectObject, the confirmation `ModalDialog` is destroyed after it
> closed, dead code and redundant fallbacks were removed, and the package now
> carries the LICENSE file and SPDX headers. As in 0.4 and 0.5, the wrapper of
> `IBus.InputContext.prototype.process_key_event_async` is installed in
> `enable()`, passes every key through unless a hands-free session is live
> (it then swallows only Escape), and is restored in `disable()` only if the
> prototype still holds our wrapper; the voice commands are off by default. I used AI assistance to write
> and review this code and can explain every line.
