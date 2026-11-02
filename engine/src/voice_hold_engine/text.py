"""Clean up recognised text and apply the few spoken commands."""
import re

# Spoken commands, matched as whole phrases (case and trailing punctuation
# insensitive). Only line breaks: the recogniser already punctuates.
NEWLINE_COMMANDS = (
    'nouvelle ligne', 'à la ligne', 'a la ligne', 'retour à la ligne',
    'new line', 'newline', 'line break',
)
PARAGRAPH_COMMANDS = (
    'nouveau paragraphe', 'new paragraph',
)

_CMD_RE = re.compile(
    r"[ \t]*[,.;:!?]*[ \t]*(?<![\w'’-])(" +
    '|'.join(re.escape(c) for c in NEWLINE_COMMANDS + PARAGRAPH_COMMANDS) +
    r")(?![\w'’-])[,.;:!?]*",
    re.IGNORECASE)


def _replace(m):
    phrase = m.group(1).lower()
    return '\n\n' if phrase in PARAGRAPH_COMMANDS else '\n'


def clean(text):
    """Normalise whitespace and turn spoken line-break commands into newlines."""
    text = text.strip()
    if not text:
        return ''
    text = _CMD_RE.sub(_replace, text)
    # Collapse spaces around the newlines we inserted and inside lines.
    text = re.sub(r'[ \t]*\n[ \t]*', '\n', text)
    text = re.sub(r'[ \t]{2,}', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    # A line break never starts or ends a block.
    return text.strip('\n ').strip() if text.strip() != '' else ''


def is_only_command(text):
    """True when the block was nothing but a command (e.g. just 'new line')."""
    return clean(text) == '' and bool(_CMD_RE.search(text.strip()))
