"""Open requests go to the local LLM (llama.cpp server, see ..llamacpp) with
its output constrained to a JSON schema. The prompt is long and constant so the server's prefix cache
makes every call after the first cheap. Anything that goes wrong returns
None: the caller then answers "LLM unavailable"."""
import json
import re
import urllib.error
import urllib.request

from .. import llamacpp

ACTIONS = [
    'open_app', 'close_window', 'close_all_windows', 'set_volume', 'change_volume',
    'set_brightness', 'change_brightness', 'toggle_dark_mode', 'toggle_dnd',
    'toggle_wifi', 'toggle_bluetooth', 'switch_workspace', 'screenshot', 'lock',
    'power', 'run_shell', 'answer', 'unknown',
]

SCHEMA = {
    'type': 'object',
    'properties': {
        'action': {'type': 'string', 'enum': ACTIONS},
        'name': {'type': 'string'},
        'percent': {'type': 'integer'},
        'delta': {'type': 'integer'},
        'enable': {'type': 'boolean'},
        'n': {'type': ['integer', 'string']},
        'target': {'type': 'string', 'enum': ['screen', 'window', 'area']},
        'power_action': {'type': 'string', 'enum': ['suspend', 'reboot', 'shutdown', 'logout']},
        'command': {'type': 'string'},
        'needs_confirmation': {'type': 'boolean'},
        'text': {'type': 'string'},
    },
    'required': ['action'],
}

SYSTEM = """You are the intent parser of an offline voice assistant that controls a GNOME Linux desktop (Ubuntu). The user speaks French or English (sometimes mixed, with hesitations like "euh" or speech-recognition mistakes). You receive the transcript and must answer with ONE JSON object and nothing else.

Available actions and their fields:
- open_app {name}: launch an application. name = the application as spoken (firefox, terminal, settings, files, spotify...).
- close_window {}: close the active window.
- close_all_windows {}: close every window.
- set_volume {percent}: set the output volume, 0-100. "mute" / "coupe le son" = 0. "half" / "la moitié" = 50.
- change_volume {delta}: raise (+10) or lower (-10) the volume when no exact value is given.
- set_brightness {percent}: set screen brightness 0-100.
- change_brightness {delta}: raise (+10) or lower (-10) brightness.
- toggle_dark_mode {enable}: true = dark theme, false = light theme.
- toggle_dnd {enable}: true = do not disturb on (notifications silenced), false = notifications back on.
- toggle_wifi {enable}, toggle_bluetooth {enable}: true = on, false = off.
- switch_workspace {n}: n is a 1-based integer, or "next" / "prev".
- screenshot {target}: "screen" (whole screen), "window" (active window) or "area".
- lock {}: lock the screen.
- power {power_action, needs_confirmation}: suspend | reboot | shutdown | logout. needs_confirmation is always true.
- run_shell {command, needs_confirmation}: anything else that can be done with a Linux shell command (git, apt, df, free, ping, find...). Write a single bash command line. needs_confirmation = true when the command modifies the system or files (install, update, remove, delete, kill, sudo, write), false when it is read-only (df, free, ls, git status, ping, cat).
- answer {text}: the user asks a question that needs no command; text = a one-sentence answer.
- unknown {}: the request is ambiguous, incomplete, chit-chat, or nothing to do (e.g. "thanks", "never mind", "open the thing", "set the volume" without a value).

Rules:
1. Output only the JSON object. No prose, no markdown.
2. Never invent a destructive command for a vague request ("optimise the computer", "format the usb key"): either use unknown, or run_shell with needs_confirmation true and a safe, explicit command.
3. Prefer the dedicated GNOME action over run_shell when one exists (volume, brightness, dark mode, lock, screenshot, workspace, wifi, bluetooth, opening apps).
4. Keep names as spoken, lower case ("fire fox" -> "firefox").
5. The home folder is ~, the development folder is ~/DEVELOPEMENT. GitHub repos "owner slash repo" mean https://github.com/owner/repo.

Examples:
"ouvre firefox" -> {"action":"open_app","name":"firefox"}
"mets le volume à 30" -> {"action":"set_volume","percent":30}
"passe en mode sombre" -> {"action":"toggle_dark_mode","enable":true}
"quelle est la place libre sur le disque" -> {"action":"run_shell","command":"df -h ~","needs_confirmation":false}
"installe vlc" -> {"action":"run_shell","command":"sudo apt install -y vlc","needs_confirmation":true}
"redémarre" -> {"action":"power","power_action":"reboot","needs_confirmation":true}
"merci" -> {"action":"unknown"}
"""

TIMEOUT_S = 30.0         # once the model is loaded and the prompt cached
COLD_TIMEOUT_S = 90.0    # first call: the weights and the system prompt are read
WARM_UP_TEXT = 'bonjour'


class Timeout(Exception):
    """The server was reached but did not answer in time."""


def _messages(text):
    return [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': text}]


def _timed_out(e):
    if isinstance(e, TimeoutError):
        return True
    reason = getattr(e, 'reason', None)
    return isinstance(reason, TimeoutError) or 'timed out' in str(reason or e)


def interpret(text, *, timeout=None, opener=None):
    """Return the parsed intent dict, or None when the server is unreachable
    or answers garbage. Raises Timeout when it is reached but too slow."""
    try:
        content = llamacpp.chat(_messages(text), schema=SCHEMA,
                                timeout=TIMEOUT_S if timeout is None else timeout, opener=opener)
    except (OSError, ValueError) as e:
        if _timed_out(e):
            raise Timeout()
        return None
    return parse(content)


def parse(content):
    """Pull one JSON object out of a model answer. None if there is none or it
    has no valid action."""
    if not isinstance(content, str):
        return None
    s = content.strip()
    s = re.sub(r'^```(?:json)?\s*|\s*```$', '', s)
    try:
        obj = json.loads(s)
    except ValueError:
        m = re.search(r'\{.*\}', s, re.S)
        if not m:
            return None
        try:
            obj = json.loads(m.group())
        except ValueError:
            return None
    if not isinstance(obj, dict) or obj.get('action') not in ACTIONS:
        return None
    return obj


def warm_up(opener=None):
    """Run the system prompt through the model once, so the first real
    request only pays for its own few words: the server keeps the prompt
    prefix in its cache. (Without it the first command waited some twenty
    seconds on a laptop CPU.) Returns True when the model answered."""
    try:
        llamacpp.chat(_messages(WARM_UP_TEXT), schema=SCHEMA, max_tokens=8,
                      timeout=COLD_TIMEOUT_S, opener=opener)
        return True
    except (OSError, ValueError):
        return False


SUMMARY_CHARS = 700


def summarize(transcript, command, output, *, timeout=None, opener=None):
    """One spoken sentence about a command's output, in the user's language,
    through the same system prompt (so the prompt cache stays warm) and the
    `answer` action. '' when the model has nothing usable."""
    out = (output or '').strip()
    if len(out) > SUMMARY_CHARS:
        out = out[:SUMMARY_CHARS].rstrip() + '\n…'
    text = (f'The user asked: "{transcript}"\nThe command `{command}` printed:\n{out}\n\n'
            'Tell the user what this means in ONE short spoken sentence, in the language of the '
            'question, with the key figure if there is one. Answer with {"action":"answer","text":"..."}.')
    try:
        intent = parse(llamacpp.chat(_messages(text), schema=SCHEMA, max_tokens=80,
                                     timeout=TIMEOUT_S if timeout is None else timeout, opener=opener))
    except (OSError, ValueError):
        return ''
    if not intent or intent.get('action') != 'answer':
        return ''
    return ' '.join(str(intent.get('text', '')).split())
