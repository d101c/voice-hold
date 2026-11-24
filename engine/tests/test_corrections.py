from voice_hold_engine.corrections import correct


def test_number_after_strong_marker():
    assert correct("On se voit à 14 h, non, je veux dire 15 h.") == "On se voit à 15 h."
    assert correct("Let's have coffee at 2, actually 3.") == "Let's have coffee at 3."


def test_same_word_lines_up_after_strong_marker():
    assert correct("Send it to John, sorry, to Mary.") == "Send it to Mary."
    assert correct("Je viens lundi, je veux dire je viens mardi.") == "Je viens mardi."


def test_weak_marker_needs_a_word_of_the_same_kind():
    assert correct("Rendez-vous mardi, plutôt mercredi.") == "Rendez-vous mercredi."
    assert correct("J'appelle Marie, non, Sophie.") == "J'appelle Sophie."
    assert correct("Il a 2 enfants, non, 3.") == "Il a 3."


def test_ordinary_speech_is_left_alone():
    for s in [
        "Je ne sais pas, non, je crois pas.",
        "Ce que je veux dire, c'est que tout va bien.",
        "Je veux dire merci à tous.",
        "I actually think it works.",
        "I mean it.",
        "Je te demande pardon pour hier.",
        "C'est plutôt bien, non ?",
        "There is no way.",
        "Il a dit non 3 fois.",
        "I was going to say I'm sorry to hear about your dad.",
        "I do think we should actually do it.",
        "Je suis allé à la plage et j'ai demandé pardon à Marie.",
        "I told Mary that, actually, Paris is nice.",
        "Je veux dire que tu as raison.",
    ]:
        assert correct(s) == s, s


def test_replacement_from_the_start_takes_a_capital():
    assert correct("It costs 5 dollars, actually it costs 6 dollars.") == "It costs 6 dollars."


def test_drop_the_previous_sentence():
    assert correct("Je t'appelle demain. Oublie ça.") == ""
    assert correct("Bonjour. Je t'appelle demain. Scratch that.") == "Bonjour."
    assert correct("Oublie ça.") == ""


def test_other_sentences_untouched():
    assert correct("Bonjour Léa. Rendez-vous à 9 h, non, 10 h. À bientôt.") == \
        "Bonjour Léa. Rendez-vous à 10 h. À bientôt."


def test_empty():
    assert correct("") == ""
    assert correct("   ") == "   "


def test_leading_punctuation_is_kept():
    assert correct("... Rendez-vous à 9 h, non, 10 h.") == "... Rendez-vous à 10 h."


def test_a_phrase_said_again_is_not_written_twice():
    # The replacement repeats the start of what it replaces.
    assert correct('Le train part à sept heures dix, non, sept heures vingt.') == \
        'Le train part à sept heures vingt.'
    assert correct('On avait dit trois mille francs, non pardon, trois mille cinq cents francs, livraison comprise.') == \
        'On avait dit trois mille cinq cents francs, livraison comprise.'
    assert correct('The budget is twenty thousand, sorry, twenty-five thousand dollars.') == \
        'The budget is twenty-five thousand dollars.'
    # Nothing repeated: as before.
    assert correct('On se voit lundi, non pardon, mardi à quatorze heures.') == 'On se voit mardi à quatorze heures.'
