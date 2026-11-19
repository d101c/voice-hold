from voice_hold_engine.text import tidy


def test_hesitations_are_dropped():
    assert tidy('Euh, je voulais te dire que, euh, le rapport est prêt.') == \
        'Je voulais te dire que, le rapport est prêt.'
    assert tidy('Il y a uh un problème.') == 'Il y a un problème.'
    assert tidy("C'est bon hum.") == "C'est bon."
    assert tidy('So um I think, uh, we can go.') == 'So I think, we can go.'


def test_capital_after_a_dropped_hesitation_at_a_sentence_start():
    assert tidy('Bonjour. Euh, on commence ?') == 'Bonjour. On commence ?'
    assert tidy('Uh oui.') == 'Oui.'


def test_stutters_are_collapsed():
    assert tidy('Une confusion assez assez évidente.') == 'Une confusion assez évidente.'
    assert tidy('entre le Uh Le contrôle espace') == 'entre le contrôle espace'
    assert tidy('de Gardez Uh Gardez ouvert le micro') == 'de Gardez ouvert le micro'
    assert tidy('pour pour le concert') == 'pour le concert'
    assert tidy('je pense que je pense que oui') == 'je pense que oui'
    assert tidy("c'est c'est bon") == "c'est bon"


def test_legitimate_doublings_stay():
    assert tidy('Nous nous voyons demain.') == 'Nous nous voyons demain.'
    assert tidy('vous vous trompez') == 'vous vous trompez'
    assert tidy("C'est très très bien.") == "C'est très très bien."
    assert tidy('Non non, merci.') == 'Non non, merci.'


def test_words_that_contain_a_filler_stay():
    assert tidy('Un humble humoriste, Bahia, umbrella, hmmmm.') == 'Un humble humoriste, Bahia, umbrella, hmmmm.'
    assert tidy('Le euro et le heurt.') == 'Le euro et le heurt.'


def test_a_block_of_hesitations_only_is_empty():
    assert tidy('Euh...') == ''
    assert tidy('Hum, euh.') == ''


def test_plain_text_is_unchanged():
    for s in ['Bonjour, ça va ?', 'Le rendez-vous est à 10 h.', '\n', 'Hello world\n']:
        assert tidy(s) == s
