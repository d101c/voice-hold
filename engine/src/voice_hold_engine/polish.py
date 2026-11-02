"""Optional clean-up of a final block by a local LLM (Ollama). Off by default;
on any failure the raw text is used."""
import json
import urllib.request

DEFAULT_URL = 'http://127.0.0.1:11434'
DEFAULT_MODEL = 'qwen2.5:1.5b'

PROMPT = (
    'You fix dictated text. Correct punctuation, capitalisation and obvious '
    'homophone slips in the same language as the text. Do not add, remove or '
    'reorder words, do not translate, do not answer or comment. Reply with the '
    'corrected text only.\n\nText: {text}'
)


def polish(text, url=DEFAULT_URL, model=DEFAULT_MODEL, timeout=2.5):
    if not text.strip():
        return text
    body = json.dumps({
        'model': model,
        'prompt': PROMPT.format(text=text),
        'stream': False,
        'options': {'temperature': 0, 'num_predict': max(32, len(text) // 2 + 16)},
    }).encode()
    req = urllib.request.Request(url.rstrip('/') + '/api/generate', data=body,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            out = json.loads(resp.read().decode()).get('response', '').strip()
    except Exception:
        return text
    out = out.strip('"').strip()
    # Reject answers that are not a light edit of the input.
    if not out or abs(len(out) - len(text)) > max(8, len(text) // 3):
        return text
    return out
