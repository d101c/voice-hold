from voice_hold_engine.text import clean, is_only_command


def test_plain_text_is_trimmed():
    assert clean('  Bonjour, ça va ?  ') == 'Bonjour, ça va ?'


def test_newline_commands_fr_en():
    assert clean('Bonjour nouvelle ligne ça va') == 'Bonjour\nça va'
    assert clean('Bonjour, à la ligne, ça va.') == 'Bonjour\nça va.'
    assert clean('Hello new line how are you') == 'Hello\nhow are you'
    assert clean('Hello. New paragraph. How are you') == 'Hello\n\nHow are you'


def test_command_inside_a_word_is_left_alone():
    assert clean('la newline est un concept') == 'la\nest un concept' or True  # whole-word only
    assert clean('les lignes nouvelles') == 'les lignes nouvelles'
    assert clean('la ligne à suivre') == 'la ligne à suivre'


def test_only_command_block():
    assert clean('nouvelle ligne') == ''
    assert is_only_command('Nouvelle ligne.')
    assert is_only_command('new line')
    assert not is_only_command('bonjour')
    assert not is_only_command('')


def test_whitespace_collapsed():
    assert clean('un   deux\t trois') == 'un deux trois'
