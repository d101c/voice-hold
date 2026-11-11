// "Not enough memory" errors of the engines, turned into words. Pure, so it
// runs under plain gjs. The engines send '<prefix>:<free MB>:<needed MB>'
// ('low-memory:640:1200' from the speech engine, 'llm-low-memory:900:2300'
// as the reason of an unknown command). The sentences are short: the pill
// shows one line and cuts its start.

// 640 -> '640 MB', 2300 -> '2.2 GB' (units through gettext: Mo, Go).
export function size(mb, _ = s => s) {
    return mb < 1000 ? _('%d MB').replace('%d', String(Math.round(mb)))
        : _('%s GB').replace('%s', (mb / 1024).toFixed(1));
}

// {free, need} in MB when `message` is such an error, else null.
export function parseLowMemory(message, prefix = 'low-memory') {
    const m = new RegExp(`^${prefix}:(\\d+):(\\d+)$`).exec(message ?? '');
    return m ? {free: Number(m[1]), need: Number(m[2])} : null;
}

export function speechLowMemory(message, _ = s => s) {
    const m = parseLowMemory(message);
    return m && _('Not enough memory: %s free, %s needed')
        .replace('%s', size(m.free, _)).replace('%s', size(m.need, _));
}

export function llmLowMemory(reason, _ = s => s) {
    const m = parseLowMemory(reason, 'llm-low-memory');
    return m && _('Language model: not enough memory (%s free, %s needed)')
        .replace('%s', size(m.free, _)).replace('%s', size(m.need, _));
}
