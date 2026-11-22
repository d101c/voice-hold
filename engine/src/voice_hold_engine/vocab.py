"""Personal vocabulary and replacements, applied to each recognised block.

Vocabulary: names, brands and jargon the recogniser spells its own way. The
speech model takes no hints, so the words are fixed after recognition: a
run of one to three recognised words that sounds like an entry (same
phonetic key, or a close one for longer words) is written the entry's way.
"parakeet" -> "Parakeet", "griffite" -> "Griffit", "voice old" -> "Voice Hold".

Replacements: a spoken phrase becomes a fixed text, which may span lines
(an address, a signature). Whole words only, whatever the case; a block
that is nothing but the phrase becomes the text alone, without the
punctuation the recogniser put around it.
"""
import json
import re
import unicodedata

_WORD_RE = re.compile(r"[\w'’-]+")
_P = ',.;:!?…'


def _strip_accents(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


_RULES = [
    (r'eaux?', 'o'), (r'au', 'o'), (r'ph', 'f'), (r'ck', 'k'), (r'qu', 'k'), (r'c(?=[eiy])', 's'), (r'c', 'k'),
    (r'(?:ch|sh)', 'x'), (r'th', 't'), (r'h', ''), (r'w', 'v'), (r'y', 'i'), (r'z', 's'), (r'(?:ou|oo)', 'u'),
    (r'(?:ee|ea)', 'i'), (r'(?:ai|ei)', 'e'), (r'g(?=[eiy])', 'j'), (r'(.)\1+', r'\1'),
]


def key(text):
    """A rough phonetic key, the same for French and English spellings of a
    name: lower case, no accents, no spaces, a few sound rules, no silent
    final letter."""
    s = re.sub(r'[^a-z0-9]', '', _strip_accents(text.lower()))
    for pattern, repl in _RULES:
        s = re.sub(pattern, repl, s)
    return re.sub(r'(?<=.)[estdx]$', '', s) if len(s) > 3 else s


def _distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _close(a, b):
    if a == b:
        return True
    n = max(len(a), len(b))
    if n < 5:
        return False
    return _distance(a, b) <= (1 if n < 10 else 2)


class Vocabulary:
    def __init__(self, words=(), replacements=None):
        self.words = [(w.strip(), key(w)) for w in words if w and w.strip() and key(w)]
        self.replacements = [(said.strip(), text) for said, text in (replacements or {}).items()
                             if said and said.strip()]
        self._said_re = [
            (re.compile(rf"(?<![\w'’-]){re.escape(said)}(?![\w'’-])", re.IGNORECASE), text)
            for said, text in sorted(self.replacements, key=lambda r: -len(r[0]))
        ]

    @classmethod
    def from_options(cls, words_json, replacements_json):
        """From the JSON strings of the Start options; bad JSON is no list."""
        def load(s, kind):
            try:
                v = json.loads(s) if s else kind()
            except ValueError:
                return kind()
            return v if isinstance(v, kind) else kind()
        words = [w for w in load(words_json, list) if isinstance(w, str)]
        repl = {k: v for k, v in load(replacements_json, dict).items() if isinstance(k, str) and isinstance(v, str)}
        return cls(words, repl)

    def __bool__(self):
        return bool(self.words or self.replacements)

    def apply(self, text):
        if not text or not self:
            return text
        return self._replace(self._fix_words(text))

    def _fix_words(self, text):
        for entry, k in self.words:
            n = len(entry.split())
            words = list(_WORD_RE.finditer(text))
            spans = []
            i = 0
            while i < len(words):
                done = False
                for size in sorted({n, n + 1, max(1, n - 1)}, key=lambda s: abs(s - n)):
                    if i + size > len(words):
                        continue
                    start, end = words[i].start(), words[i + size - 1].end()
                    run = text[start:end]
                    if '\n' in run or (size > 1 and re.search(r'[.!?;:]', run)):
                        continue
                    if run != entry and _close(key(run), k):
                        spans.append((start, end))
                        i += size
                        done = True
                        break
                if not done:
                    i += 1
            for start, end in reversed(spans):
                text = text[:start] + entry + text[end:]
        return text

    def _replace(self, text):
        for said, out in self.replacements:
            if re.fullmatch(rf"[\s{_P}]*{re.escape(said)}[\s{_P}]*", text, re.IGNORECASE):
                return out
        for pattern, out in self._said_re:
            text = pattern.sub(lambda _m, out=out: out, text)
        return text
