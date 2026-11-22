"""Spoken lists: "premièrement ... deuxièmement ..." / "firstly ... secondly
..." become a numbered list.

    "J'ai trois choses à faire, premièrement acheter du pain, deuxièmement
    appeler Léa."  ->  "J'ai trois choses à faire :\\n1. Acheter du pain\\n2. Appeler Léa"

A list starts with the first two ordinals in the same block ("First, let me
say hello." alone is a sentence, and a leading line break would send a chat
message), then goes on with the next ones, in that block or a later one of
the same dictation. An ordinal only counts at the start of
a clause (after a pause mark, or at the start of the block); "first" and
"second", which are ordinary words, also need a comma or colon after them.
"""
import re

_ORDINALS = [
    (1, r'premièrement|firstly'), (2, r'deuxièmement|secondement|secondly'), (3, r'troisièmement|thirdly'),
    (4, r'quatrièmement|fourthly'), (5, r'cinquièmement|fifthly'), (6, r'sixièmement|sixthly'),
    (7, r'septièmement|seventhly'), (8, r'huitièmement|eighthly'), (9, r'neuvièmement|ninthly'),
    (10, r'dixièmement|tenthly'),
]
_SHORT = [(1, 'first'), (2, 'second'), (3, 'third'), (4, 'fourth'), (5, 'fifth')]

_ALT = '|'.join(f'(?P<o{n}>{p})' for n, p in _ORDINALS) + '|' + \
    '|'.join(f'(?P<s{n}>{w})(?=\\s*[,:])' for n, w in _SHORT)
# At the start of the block or of a clause, maybe after "et" / "and".
_MARK_RE = re.compile(rf'(?:^|(?<=[,;:.!?\n]))\s*(?:(?:et|and)\s+)?(?:{_ALT})\b\s*[,:]?\s*', re.IGNORECASE)


def _number(m):
    for name, value in m.groupdict().items():
        if value is not None:
            return int(name[1:])
    return 0


def _item(text):
    text = text.strip().rstrip(',;:').strip()
    text = re.sub(r'\s+(?:et|and)$', '', text)
    return text[:1].upper() + text[1:]


class Lists:
    """The numbering state of one dictation."""

    def __init__(self):
        self.last = 0                # the number of the last item written

    def format(self, text, final=True):
        """`text` with its list items laid out; the state moves on only for
        a final block (a partial is a preview of it)."""
        marks = []
        expected = self.last + 1
        for m in _MARK_RE.finditer(text):
            n = _number(m)
            if n == expected or (n == 1 and not marks):
                marks.append((m, n))
                expected = n + 1
        if not marks or (self.last == 0 and len(marks) < 2):
            return text
        out = text[:marks[0][0].start()].rstrip().rstrip(',;')
        if out and out[-1] not in '.!?:':
            out += ' :' if _french(text) else ':'
        tail = ''
        for i, (m, n) in enumerate(marks):
            end = marks[i + 1][0].start() if i + 1 < len(marks) else len(text)
            body = text[m.end():end]
            if i + 1 == len(marks):
                # The last item ends with its sentence; what follows is text.
                s = re.search(r'[.!?](\s+|$)', body)
                if s and body[s.end():].strip():
                    body, tail = body[:s.start()], body[s.end():].strip()
            out += f'\n{n}. {_item(body).rstrip(".")}'
        if tail:
            out += f'\n{tail}'
        if final:
            self.last = marks[-1][1]
        return out


def _french(text):
    """French puts a space before the colon."""
    t = text.lower()
    return 'ièmement' in t or 'secondement' in t
