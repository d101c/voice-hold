from voice_hold_engine.vocab import Vocabulary, key


def test_case_is_fixed():
    v = Vocabulary(['Parakeet', 'GNOME'])
    assert v.apply("le modèle parakeet tourne sous gnome.") == "le modèle Parakeet tourne sous GNOME."


def test_spelling_by_sound():
    v = Vocabulary(['Griffit', 'Voice Hold', 'Kubernetes'])
    assert v.apply("Merci Griffith pour Voice Old.") == "Merci Griffit pour Voice Hold."
    assert v.apply("on déploie sur cubernétes") == "on déploie sur Kubernetes"
    assert v.apply("voisold marche") == "Voice Hold marche"


def test_short_words_need_the_same_sound():
    v = Vocabulary(['Léa'])
    assert v.apply("bonjour lea") == "bonjour Léa"
    assert v.apply("la maison") == "la maison"


def test_unrelated_words_untouched():
    v = Vocabulary(['Griffit', 'Kubernetes', 'Voice Hold'])
    for s in ["Le café est chaud.", "Il fait beau à Genève.", "Hold on, voice mail."]:
        assert v.apply(s) == s, s


def test_replacement_inside_a_sentence():
    v = Vocabulary([], {'mon adresse': '12 rue du Rhône, 1204 Genève'})
    assert v.apply("Envoie-le à mon adresse, merci.") == "Envoie-le à 12 rue du Rhône, 1204 Genève, merci."


def test_replacement_alone_drops_the_punctuation():
    v = Vocabulary([], {'ma signature': 'Bien à vous,\nJulien'})
    assert v.apply("Ma signature.") == "Bien à vous,\nJulien"


def test_replacement_whole_words_only():
    v = Vocabulary([], {'arobase': '@'})
    assert v.apply("julien arobase exemple point com") == "julien @ exemple point com"
    assert v.apply("arobases") == "arobases"


def test_from_options_tolerates_bad_json():
    assert not Vocabulary.from_options('', '')
    assert not Vocabulary.from_options('nope', '{bad')
    v = Vocabulary.from_options('["Parakeet", 3]', '{"stp": "s\'il te plaît", "x": 1}')
    assert v.apply("parakeet stp") == "Parakeet s'il te plaît"


def test_key_matches_french_and_english_spellings():
    assert key('Philippe') == key('Filip')
    assert key('Kubernetes') == key('cubernétes')


def test_short_names_never_replace_ordinary_words():
    v = Vocabulary(['Louis', 'Marie', 'Marc'])
    for s in ["Je lui ai dit.", "Son mari arrive.", "Une marque connue.", "Mark my words."]:
        assert v.apply(s) == s, s
    assert v.apply("louis et marie") == "Louis et Marie"
