"""Spoken self-corrections, by rules, in French and English.

    "on se voit à 14 h, non, je veux dire 15 h"  -> "on se voit à 15 h"
    "send it to John, sorry, to Mary"             -> "send it to Mary"
    "rendez-vous mardi, plutôt mercredi"          -> "rendez-vous mercredi"
    "Je t'appelle demain. Oublie ça."             -> ""

A correction is a marker ("non, je veux dire", "I mean", "plutôt"...) with
what is replaced before it and the replacement after it, in the same
sentence. The replacement takes the place of the end of what came before,
from the last word it lines up with: the same word ("to John ... to Mary",
strong markers only), or a word of the same kind (a number, a weekday, a
month, a name). Nothing lines up: the text is left as it is, since words
such as "je veux dire", "actually" or "plutôt" are ordinary speech far more
often than corrections. The local LLM (polish.py) stays the option for the
rest.
"""
import re

# Strong markers: a correction is likely; the same word lines up. Those
# that are also ordinary words need a pause mark before them (_NEED_PAUSE).
_STRONG = [
    r'non,?\s+je\s+veux\s+dire', r'je\s+veux\s+dire', r'non,?\s+pardon', r'pardon',
    r'enfin\s+non', r'ou\s+plutôt', r'non\s+attends?', r'je\s+me\s+suis\s+trompée?',
    r'no,?\s+i\s+mean', r'i\s+mean', r'sorry', r'actually', r'or\s+rather', r'no,?\s+wait', r'correction',
]
# Weak markers: also ordinary words; only a word of the same kind lines up.
_WEAK = [r'non', r'plutôt', r'no']
_NEED_PAUSE = re.compile(r'^(?:je veux dire|pardon|i mean|sorry|actually|correction|non|plutôt|no)$', re.IGNORECASE)
# A sentence that ends with one of these is dropped, with the one before it.
_DROP = [r'oublie\s+ça', r'efface\s+ça', r'annule\s+ça', r'scratch\s+that', r'never\s*mind', r'forget\s+that']

_P = r'[,;:]'
_MARKER_RE = re.compile(
    rf'(?:\s*(?P<pause>{_P})\s*|\s+)(?P<m>{"|".join(_STRONG + _WEAK)})(?:\s*{_P})?\s+',
    re.IGNORECASE)
_STRONG_RE = re.compile(rf'^(?:{"|".join(_STRONG)})$', re.IGNORECASE)
_DROP_RE = re.compile(rf'^\s*(?:{"|".join(_DROP)})\s*[.!]?\s*$', re.IGNORECASE)
_SENTENCES_RE = re.compile(r'[^.!?]*(?:[.!?]+|$)\s*')
_WORD_RE = re.compile(r"[\w'’-]+")

WEEKDAYS = {
    'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
}
MONTHS = {
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre',
    'novembre', 'décembre', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december',
}
NUMBER_WORDS = {
    'un', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze',
    'vingt', 'trente', 'cent', 'mille', 'midi', 'minuit',
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'twenty', 'thirty', 'hundred', 'thousand', 'noon', 'midnight',
}
_FUNCTION_WORDS = {
    'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'le', 'la', 'les', 'un', 'une', 'des',
    'i', 'you', 'he', 'she', 'we', 'they', 'it', 'the', 'a', 'an',
}


def _kind(word, sentence_start=False):
    w = word.lower()
    if any(c.isdigit() for c in w) or w in NUMBER_WORDS:
        return 'number'
    if w in WEEKDAYS:
        return 'weekday'
    if w in MONTHS:
        return 'month'
    if word[:1].isupper() and not sentence_start and w not in _FUNCTION_WORDS:
        return 'name'
    return None


def _fix_sentence(sentence):
    """One correction per pass; repeated until nothing changes."""
    for m in _MARKER_RE.finditer(sentence):
        marker = re.sub(r'\s+', ' ', m.group('m').strip())
        if _NEED_PAUSE.match(marker) and not m.group('pause'):
            continue                          # "I'm sorry to hear", "should actually do it"
        left = sentence[:m.start()]
        right = sentence[m.end():]
        words = list(_WORD_RE.finditer(left))
        rwords = _WORD_RE.findall(right)
        first = _WORD_RE.search(right)
        if not words or not first:
            continue
        r0 = first.group(0)
        strong = bool(_STRONG_RE.match(marker))
        kind = _kind(r0)
        # A name lines up with an earlier name only when the replacement is
        # that name ("Marie, non, Sophie"), not a sentence that starts with one.
        if kind == 'name' and len(rwords) > 2:
            kind = None
        r1 = _kind(rwords[1]) if len(rwords) > 1 else None
        cut = None
        for i in range(len(words) - 1, max(-1, len(words) - 9), -1):
            w = words[i].group(0)
            if strong and w.lower() == r0.lower() and w.lower() not in ('non', 'no'):
                # A short or common word only lines up when the next word is the
                # same, or of the same kind, on both sides ("to John ... to Mary").
                nxt = words[i + 1].group(0) if i + 1 < len(words) else ''
                same_next = len(rwords) > 1 and nxt.lower() == rwords[1].lower()
                if (len(w) >= 4 and w.lower() not in _FUNCTION_WORDS) or same_next or \
                        (r1 and _kind(nxt) == r1):
                    cut = words[i].start()
                    break
            if kind and _kind(w, sentence_start=(i == 0)) == kind:
                cut = words[i].start()
                break
        if cut is None:
            continue
        out = left[:cut] + right[first.start():]
        if cut == 0 or not left[:cut].strip():
            lead = len(out) - len(out.lstrip())
            out = out[:lead] + out[lead:lead + 1].upper() + out[lead + 1:]
        return out, True
    return sentence, False


def correct(text):
    """Apply the spoken self-corrections of `text`; see above."""
    if not text or not text.strip():
        return text
    sentences = _SENTENCES_RE.findall(text)
    if not sentences:
        return text
    out = []
    for s in sentences:
        if _DROP_RE.match(s):
            if out:
                out.pop()
            continue
        for _ in range(4):
            s, changed = _fix_sentence(s)
            if not changed:
                break
        out.append(s)
    result = ''.join(out)
    return result.strip() if result != text else text
