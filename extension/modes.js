// SPDX-License-Identifier: GPL-2.0-or-later

// Dictation modes: how the text of a dictation is shaped before it is
// written, chosen by the kind of application it goes to. "As said" writes
// the words as they come, block by block; the other modes wait for the end
// of the dictation and have a language model rewrite the whole text (the
// cloud one when switched on, else the local one). Pure, unit-tested.

export const MODES = ['as-said', 'message', 'email', 'notes', 'custom'];
export const CATEGORIES = ['email', 'chat', 'code', 'other'];

const APPS = {
    email: ['thunderbird', 'org.mozilla.thunderbird', 'evolution', 'org.gnome.evolution', 'geary',
        'org.gnome.geary', 'mailspring', 'betterbird', 'eu.betterbird.betterbird', 'kmail', 'claws-mail'],
    chat: ['slack', 'com.slack.slack', 'discord', 'com.discordapp.discord', 'telegram', 'telegramdesktop',
        'org.telegram.desktop', 'signal', 'org.signal.signal', 'element', 'im.riot.riot', 'whatsapp',
        'whatsapp-for-linux', 'teams', 'teams-for-linux', 'fractal', 'org.gnome.fractal', 'zapzap', 'beeper',
        'polari', 'org.gnome.polari', 'chatterino'],
    code: ['code', 'code-oss', 'codium', 'vscodium', 'com.visualstudio.code', 'zed', 'dev.zed.zed',
        'cursor', 'org.gnome.builder', 'jetbrains-idea', 'jetbrains-pycharm', 'jetbrains-webstorm',
        'jetbrains-clion', 'jetbrains-goland', 'jetbrains-rider', 'sublime_text', 'emacs', 'kate',
        'gnome-terminal-server', 'org.gnome.ptyxis', 'kitty', 'alacritty', 'org.wezfurlong.wezterm',
        'com.mitchellh.ghostty', 'foot', 'org.gnome.console'],
};
// Web mail and chat in a browser, told by the window title.
const TITLES = {
    email: /\b(?:gmail|outlook|proton ?mail|fastmail|infomaniak mail|yahoo mail|zoho mail)\b/i,
    chat: /\b(?:slack|discord|whatsapp|messenger|telegram web|microsoft teams|google chat)\b/i,
};

export function categoryOf(wmClass, title = '') {
    const c = (wmClass ?? '').toLowerCase();
    for (const cat of ['email', 'chat', 'code']) {
        if (c && APPS[cat].includes(c))
            return cat;
    }
    for (const cat of ['email', 'chat']) {
        if (TITLES[cat].test(title ?? ''))
            return cat;
    }
    return 'other';
}

const INSTRUCTIONS = {
    'message': 'Clean up this dictated message: fix grammar, spelling and punctuation, remove hesitations, ' +
        'false starts and repetitions. Keep the wording, the tone and the language; add nothing.',
    'email': 'Turn this dictated text into the body of an email: a greeting line when the text has one or ' +
        'names the person, short paragraphs, a closing line when the text has one. Fix grammar and ' +
        'punctuation, keep the meaning, the tone and the language; invent no fact and no signature.',
    'notes': 'Turn this dictated text into short notes: one idea per line, each line starting with "- ", ' +
        'tasks first when there are any. Keep the language and every name, number and date.',
};

// The instruction for `mode`, '' when the words are written as said.
export function instructionFor(mode, customPrompt = '') {
    if (mode === 'custom')
        return (customPrompt ?? '').trim();
    return INSTRUCTIONS[mode] ?? '';
}

// What cleans a block after the rules: 'rules' (nothing more), 'local' (the
// language model on this computer) or 'cloud' (the fast cloud model).
// The old `polish` switch, still on, means local. The cloud only counts
// when it is switched on with a provider the engine can talk to; else the
// rules alone, without a wait.
export function cleanupMode(settings) {
    let mode = settings.get_string('cleanup-model');
    if (mode === 'rules' && settings.get_boolean('polish'))
        mode = 'local';
    if (mode === 'cloud' &&
        !(settings.get_boolean('cloud-enabled') && settings.get_string('cloud-provider') === 'anthropic'))
        mode = 'rules';
    return mode;
}
