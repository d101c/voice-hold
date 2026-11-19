"""Clean up recognised text and apply the few spoken commands.

A spoken command ("nouvelle ligne", "new line", "new paragraph"...) is
honoured only where it cannot be ordinary speech:
  - the block is nothing but the command        -> "\\n" (or "\\n\\n");
  - the command ends the block                  -> trailing newline;
  - the command starts the block and is followed by punctuation
    ("Nouvelle ligne, bonjour")                  -> leading newline.
Inside a sentence it is left alone: "il a une nouvelle ligne de vêtements",
"the new line of products", "à la ligne 12" are words, not commands.
Blocks are what the voice activity detector cuts at pauses, so saying the
command alone, or at the end of a phrase, is the natural way.
"""
import re

NEWLINE_COMMANDS = (
    'nouvelle ligne', 'à la ligne', 'a la ligne', 'retour à la ligne',
    'new line', 'newline', 'line break',
)
PARAGRAPH_COMMANDS = (
    'nouveau paragraphe', 'new paragraph',
)

_ALT = '|'.join(re.escape(c) for c in NEWLINE_COMMANDS + PARAGRAPH_COMMANDS)
_P = ',.;:!?'                      # punctuation the recogniser may add around a command
_NOT_IN_WORD = r"(?<![\w'’-])(" + _ALT + r")(?![\w'’-])"

# The whole block is a command (with any punctuation around it).
_ONLY_RE = re.compile(rf"^[\s{_P}]*({_ALT})[\s{_P}]*$", re.IGNORECASE)
# The command ends the block. A sentence-ending mark before it stays
# ("See you. New paragraph." keeps its period); a comma or colon, which the
# pause before the command produces, goes.
_TRAIL_RE = re.compile(rf"[\s,;:]*{_NOT_IN_WORD}[\s{_P}]*$", re.IGNORECASE)
# The command starts the block and is set off by punctuation.
_LEAD_RE = re.compile(rf"^[\s{_P}]*{_NOT_IN_WORD}\s*[{_P}]+\s*", re.IGNORECASE)


def _newline(phrase):
    return '\n\n' if phrase.lower() in PARAGRAPH_COMMANDS else '\n'


def clean(text):
    """Normalise whitespace and turn spoken line-break commands at the edges
    of the block into newlines. A block that is only a command becomes the
    newline itself."""
    text = re.sub(r'[ \t]+', ' ', text.strip())
    if not text:
        return ''
    m = _ONLY_RE.match(text)
    if m:
        return _newline(m.group(1))
    m = _TRAIL_RE.search(text)
    if m and m.start() > 0:
        text = text[:m.start()].rstrip() + _newline(m.group(1))
    m = _LEAD_RE.match(text)
    if m and m.end() < len(text):
        text = _newline(m.group(1)) + text[m.end():]
    return text


def is_only_command(text):
    """True when the block was nothing but a command (e.g. just 'new line')."""
    return bool(_ONLY_RE.match(text.strip()))


# -- tidy: hesitations and stutters ------------------------------------------
#
# Spoken hesitations ("euh", "uh", "hum") are dropped with the comma or
# ellipsis the recogniser hangs on them, and a word or short phrase said
# twice in a row ("assez assez", "le uh le contrôle") is kept once. Some
# doublings are French or English as written ("nous nous voyons", "très
# très", "non non") and stay. Nothing else is touched: rewording a sentence
# is the LLM's job (polish.py), and only when asked.

FILLERS = (
    'euh', 'euhh', 'heu', 'heuu', 'eeuh', 'uh', 'uhh', 'uhm', 'um', 'umm', 'erm',
    'hum', 'hmm', 'hm', 'mmh', 'mh', 'bah',
)
KEEP_DOUBLED = {
    'nous', 'vous', 'ça', 'très', 'non', 'oui', 'si', 'no', 'yes', 'so', 'very',
    'bye', 'bla', 'toc', 'vite', 'that', 'had',
}

_WORD = r"[\w'’-]+"
_CAP = '\x00'                      # marks a letter to capitalise
_FILLER_RE = re.compile(
    r"(?<![\w'’-])(?:" + '|'.join(FILLERS) + r")(?![\w'’-])[,…]*(?:\.\.\.)?\s*",
    re.IGNORECASE)
_REPEAT_RE = re.compile(rf"(?<![\w'’-])((?:{_WORD}\s+){{0,2}}{_WORD})(?:\s+\1)+(?![\w'’-])", re.IGNORECASE)


def _drop_filler(m):
    before = m.string[:m.start()].rstrip()
    sentence_start = not before or before[-1] in '.!?\n'
    return _CAP if sentence_start else ''


def _collapse(m):
    words = m.group(1).split()
    if len(words) == 1 and words[0].lower() in KEEP_DOUBLED:
        return m.group(0)
    return m.group(1)


def _capitalise(m):
    return m.group(1).upper()


def tidy(text):
    """Drop hesitations and collapse stuttered words; see above."""
    if not text.strip():
        return text
    out = _FILLER_RE.sub(_drop_filler, text)
    out = _REPEAT_RE.sub(_collapse, out)
    if out == text:
        return text
    # Punctuation left orphaned by a removed word. French keeps its space
    # before ; : ! ? so only commas and full stops are pulled back.
    out = re.sub(r'\s+([,.…])', r'\1', out)
    out = re.sub(r',(\s*[,.;:!?])', r'\1', out)
    out = re.sub(r'^[\s,;:' + _CAP + r']*,\s*', _CAP, out)
    out = re.sub(r'[ \t]+', ' ', out).strip(' ')
    out = re.sub(_CAP + r'+\s*([\w])', _capitalise, out)
    out = out.replace(_CAP, '')
    return out if re.search(r'\w', out) else ''
