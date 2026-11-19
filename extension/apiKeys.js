// SPDX-License-Identifier: GPL-2.0-or-later

// Optional cloud providers: their API keys live in the GNOME keyring
// (libsecret), never in the settings, never in a file of ours. A key only
// leaves the machine in the header of a request to its own provider.

import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

export const PROVIDERS = [
    {
        id: 'anthropic',
        name: 'Anthropic (Claude)',
        keysUrl: 'https://platform.claude.com/settings/keys',
        // Listing the models costs nothing and proves the key.
        test: {
            url: 'https://api.anthropic.com/v1/models',
            headers: key => ({'x-api-key': key, 'anthropic-version': '2026-10-21'}),
        },
    },
    // The voice commands use only Anthropic's models for now; the other keys
    // are stored for the comparisons to come.
    {
        id: 'openai',
        name: 'OpenAI',
        keysUrl: 'https://platform.openai.com/api-keys',
        test: {
            url: 'https://api.openai.com/v1/models',
            headers: key => ({'Authorization': `Bearer ${key}`}),
        },
    },
    {
        id: 'gemini',
        name: 'Google Gemini',
        keysUrl: 'https://aistudio.google.com/app/apikey',
        test: {
            url: 'https://generativelanguage.googleapis.com/v1beta/models',
            headers: key => ({'x-goog-api-key': key}),
        },
    },
];

// Models the voice commands can use, best default first. `hint` is shown
// under the choice.
export const MODELS = {
    anthropic: [
        {id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', hint: 'recommended: checks before acting, about 4 s'},
        {id: 'claude-opus-5-5', name: 'Claude Opus 5.5', hint: 'the most careful, slower and about twice the price'},
        {id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', hint: 'the fastest and cheapest, more often wrong'},
    ],
};

export function provider(id) {
    return PROVIDERS.find(p => p.id === id) ?? null;
}

const SCHEMA = new Secret.Schema('org.griffit.VoiceHold.ApiKey', Secret.SchemaFlags.NONE, {
    provider: Secret.SchemaAttributeType.STRING,
});

function attrs(id) {
    return {provider: id};
}

// The stored key, or null.
export function loadKey(id) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, attrs(id), null, (_o, res) => {
            try {
                resolve(Secret.password_lookup_finish(res) || null);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function storeKey(id, key) {
    const label = `Voice Hold — ${provider(id)?.name ?? id} API key`;
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, attrs(id), Secret.COLLECTION_DEFAULT, label, key, null, (_o, res) => {
            try {
                resolve(Secret.password_store_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function clearKey(id) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(SCHEMA, attrs(id), null, (_o, res) => {
            try {
                resolve(Secret.password_clear_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Ask the provider whether the key works (a free request). Resolves to
// {ok: true} or {ok: false, status, reason}.
export function testKey(id, key, session = null) {
    const p = provider(id);
    if (!p || !key)
        return Promise.resolve({ok: false, status: 0, reason: 'no-key'});
    session ??= new Soup.Session({user_agent: 'voice-hold', timeout: 20});
    const msg = Soup.Message.new('GET', p.test.url);
    for (const [k, v] of Object.entries(p.test.headers(key)))
        msg.get_request_headers().append(k, v);
    return new Promise(resolve => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                s.send_and_read_finish(res);
            } catch (e) {
                resolve({ok: false, status: 0, reason: e.message});
                return;
            }
            const status = msg.get_status();
            if (status === Soup.Status.OK)
                resolve({ok: true});
            else
                // Gemini answers 400 (API_KEY_INVALID) where the others say 401.
                resolve({ok: false, status, reason: [400, 401, 403].includes(status) ? 'rejected' : `http ${status}`});
        });
    });
}

// What the user sees of a stored key: its start and end only.
export function maskKey(key) {
    if (!key)
        return '';
    if (key.length <= 12)
        return '•'.repeat(key.length);
    return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
