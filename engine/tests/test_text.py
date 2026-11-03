from voice_hold_engine.text import clean, is_only_command


def test_plain_text_is_trimmed():
    assert clean('  Bonjour, ça va ?  ') == 'Bonjour, ça va ?'


def test_whitespace_collapsed():
    assert clean('un   deux\t trois') == 'un deux trois'


def test_only_command_block_becomes_a_newline():
    assert clean('nouvelle ligne') == '\n'
    assert clean('Nouvelle ligne.') == '\n'
    assert clean('new line') == '\n'
    assert clean('À la ligne') == '\n'
    assert clean('New paragraph.') == '\n\n'
    assert is_only_command('Nouvelle ligne.')
    assert is_only_command('new line')
    assert not is_only_command('bonjour')
    assert not is_only_command('')


def test_command_at_the_end_of_a_block():
    assert clean('Bonjour à tous, nouvelle ligne') == 'Bonjour à tous\n'
    assert clean('Bonjour à tous nouvelle ligne.') == 'Bonjour à tous\n'
    assert clean('Hello everyone, new line') == 'Hello everyone\n'
    assert clean('See you tomorrow. New paragraph.') == 'See you tomorrow.\n\n'


def test_command_at_the_start_needs_punctuation():
    assert clean('Nouvelle ligne, bonjour') == '\nbonjour'
    assert clean('New line. How are you') == '\nHow are you'
    # No punctuation after it: these are words.
    assert clean('à la ligne 12') == 'à la ligne 12'
    assert clean('New line of products') == 'New line of products'


def test_command_inside_a_sentence_is_text():
    assert clean('il a une nouvelle ligne de vêtements') == 'il a une nouvelle ligne de vêtements'
    assert clean('the new line of products') == 'the new line of products'
    assert clean('Bonjour nouvelle ligne ça va') == 'Bonjour nouvelle ligne ça va'
    assert clean('Hello. New paragraph. How are you') == 'Hello. New paragraph. How are you'


def test_command_inside_a_word_is_left_alone():
    assert clean('les lignes nouvelles') == 'les lignes nouvelles'
    assert clean('la ligne à suivre') == 'la ligne à suivre'
    assert clean("l'alignement") == "l'alignement"
    assert clean('newlines') == 'newlines'
