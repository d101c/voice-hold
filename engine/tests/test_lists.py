from voice_hold_engine.lists import Lists


def test_list_in_one_block_french():
    out = Lists().format("J'ai trois choses à faire, premièrement acheter du pain, deuxièmement appeler Léa, "
                         "et troisièmement réserver le train.")
    assert out == "J'ai trois choses à faire :\n1. Acheter du pain\n2. Appeler Léa\n3. Réserver le train"


def test_list_in_one_block_english():
    out = Lists().format("Two things. First, buy bread. Second, call Mary.")
    assert out == "Two things.\n1. Buy bread\n2. Call Mary"
    assert Lists().format("Two things, firstly bread, secondly milk") == "Two things:\n1. Bread\n2. Milk"


def test_list_across_blocks():
    lists = Lists()
    assert lists.format("Premièrement, acheter du pain, deuxièmement, du lait.") == \
        "\n1. Acheter du pain\n2. Du lait"
    assert lists.format("Troisièmement, appeler Léa.", final=False) == "\n3. Appeler Léa"
    assert lists.format("Troisièmement, appeler Léa.") == "\n3. Appeler Léa"
    assert lists.format("Quatrièmement, partir.") == "\n4. Partir"


def test_one_ordinal_alone_is_a_sentence():
    for s in ["First, let me say hello.", "Premièrement, merci."]:
        assert Lists().format(s) == s


def test_partial_does_not_move_the_state():
    lists = Lists()
    lists.format("Premièrement, du pain, deuxièmement, du lait.", final=False)
    assert lists.last == 0
    assert lists.format("Deuxièmement, du lait.") == "Deuxièmement, du lait."


def test_text_after_the_last_item():
    out = Lists().format("Premièrement le pain, deuxièmement le lait. Merci beaucoup.")
    assert out == "\n1. Le pain\n2. Le lait\nMerci beaucoup."


def test_ordinary_words_are_not_items():
    for s in ["He came first in the race.", "Wait a second, please.", "It is the first time.",
              "Le second semestre commence.", "Deuxièmement, il pleut."]:
        assert Lists().format(s) == s, s
