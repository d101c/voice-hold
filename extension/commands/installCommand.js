import GLib from 'gi://GLib';

// How to run `voice-hold-engine setup --commands` (the command helper and
// its language model) from the preferences. The speech engine was installed
// by the Installation page, by pipx or in a venv: whichever it was, its
// D-Bus service file says how it is started, and the same interpreter with
// `setup --commands` instead of `serve` installs the rest. No Shell or GTK
// import: testable with plain gjs.

export const SPEECH_SERVICE = 'org.griffit.VoiceHold.service';
export const MANUAL_COMMAND = 'voice-hold-engine setup --commands';

// The argv that installs the commands, from the text of the speech engine's
// service file; null when its Exec line is not one of ours.
//   Exec=/path/python3 -m voice_hold_engine serve
//   Exec=/usr/bin/env PYTHONPATH=… /usr/bin/python3 -m voice_hold_engine serve
//   Exec=/path/voice-hold-engine serve
export function setupArgv(serviceText) {
    const line = String(serviceText ?? '').split('\n').find(l => l.startsWith('Exec='));
    if (!line)
        return null;
    let argv;
    try {
        [, argv] = GLib.shell_parse_argv(line.slice(5));
    } catch {
        return null;
    }
    if (!argv || argv.length < 2 || argv[argv.length - 1] !== 'serve')
        return null;
    const what = argv.slice(0, -1).join(' ');
    if (!what.includes('voice_hold_engine') && !what.includes('voice-hold-engine'))
        return null;
    return [...argv.slice(0, -1), 'setup', '--commands'];
}

// The speech engine's service file: the user's first, then the system's.
export function findServiceFile(dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]) {
    for (const dir of dirs) {
        const file = GLib.build_filenamev([dir, 'dbus-1', 'services', SPEECH_SERVICE]);
        if (GLib.file_test(file, GLib.FileTest.EXISTS))
            return file;
    }
    return null;
}

// setupArgv() of the installed speech engine, or null when there is none.
export function installedSetupArgv() {
    const file = findServiceFile();
    if (!file)
        return null;
    try {
        const [, bytes] = GLib.file_get_contents(file);
        return setupArgv(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

// The last line worth showing of what the installer printed so far: the
// text after the last line break or carriage return (progress lines are
// rewritten in place), trimmed, at most `max` characters.
export function lastLine(text, max = 110) {
    const lines = String(text ?? '').split(/[\r\n]+/).map(l => l.trim()).filter(l => l);
    const last = lines[lines.length - 1] ?? '';
    const chars = Array.from(last);
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : last;
}
