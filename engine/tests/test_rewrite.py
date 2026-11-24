from types import SimpleNamespace

from voice_hold_engine import rewrite as rw


class FakeClient:
    def __init__(self, text='', stop='end_turn', fail=False):
        self.calls = []
        self.messages = self
        self._text, self._stop, self._fail = text, stop, fail

    def create(self, **kw):
        self.calls.append(kw)
        if self._fail:
            raise RuntimeError('boom')
        return SimpleNamespace(stop_reason=self._stop, content=[SimpleNamespace(type='text', text=self._text)])


def test_cloud_answer_is_cleaned(monkeypatch):
    monkeypatch.setattr(rw, 'rewrite_local', lambda *a, **k: 'LOCAL')
    c = FakeClient('"Bonjour Léa,\n\nÀ jeudi."')
    out = rw.rewrite('bonjour léa à jeudi', 'formal email', cloud={'provider': 'anthropic', 'model': ''}, client=c)
    assert out == 'Bonjour Léa,\n\nÀ jeudi.'
    sent = c.calls[0]
    assert sent['model'] == rw.CLOUD_MODEL
    assert '<text>\nbonjour léa à jeudi\n</text>' in sent['messages'][0]['content']
    assert 'formal email' in sent['messages'][0]['content']


def test_cloud_failure_or_refusal_falls_back_to_local(monkeypatch):
    monkeypatch.setattr(rw, 'rewrite_local', lambda *a, **k: 'LOCAL')
    assert rw.rewrite('x', 'y', cloud={'provider': 'anthropic'}, client=FakeClient(fail=True)) == 'LOCAL'
    assert rw.rewrite('x', 'y', cloud={'provider': 'anthropic'}, client=FakeClient('no', stop='refusal')) == 'LOCAL'


def test_no_cloud_uses_local_only(monkeypatch):
    monkeypatch.setattr(rw, 'rewrite_local', lambda *a, **k: 'LOCAL')
    assert rw.rewrite('x', 'y') == 'LOCAL'


def test_local_missing_model_gives_nothing(monkeypatch):
    monkeypatch.setattr(rw.llamacpp, 'missing', lambda: ['model'])
    assert rw.rewrite_local('x', 'y') == ''


def test_local_answer_is_cleaned(monkeypatch):
    monkeypatch.setattr(rw.llamacpp, 'missing', lambda: [])
    monkeypatch.setattr(rw.llamacpp, 'ensure', lambda: True)
    monkeypatch.setattr(rw.llamacpp, 'chat', lambda msgs, **k: '<text>\nPlus court.\n</text>')
    assert rw.rewrite_local('un texte bien trop long', 'shorter') == 'Plus court.'


def test_empty_text_or_instruction():
    assert rw.rewrite('', 'shorter') == ''
    assert rw.rewrite('text', '  ') == ''
