"""cloud.interpret() against a fake Anthropic client: the tool loop, the final
intents, the error codes, and the read-only filter."""
from types import SimpleNamespace as NS

import anthropic
import httpx2 as httpx
import pytest

from voice_hold_engine.commands import cloud, probes
from voice_hold_engine.commands.interpreter import Interpreter


def text(t):
    return NS(type='text', text=t)


def use(name, args, id='u1'):
    return NS(type='tool_use', name=name, input=args, id=id)


def msg(*content, stop='end_turn'):
    return NS(content=list(content), stop_reason=stop)


class FakeClient:
    """Answers with `replies` in turn; records the requests."""

    def __init__(self, *replies, error=None):
        self.replies = list(replies)
        self.requests = []
        self.error = error
        self.messages = NS(create=self._create)
        self.beta = NS(messages=NS(create=self._create))

    def _create(self, **kw):
        self.requests.append(kw)
        if self.error:
            raise self.error
        return self.replies.pop(0)


def test_plain_answer_after_a_probe(monkeypatch):
    monkeypatch.setattr(probes, 'firewall', lambda: {'verdict': 'firewall OFF'})
    c = FakeClient(msg(use('check', {'topic': 'firewall'}), stop='tool_use'),
                   msg(text('Non, ton pare-feu est désactivé.')))
    intent = cloud.interpret('mon pare-feu est activé ?', client=c)
    assert intent == {'action': 'answer', 'text': 'Non, ton pare-feu est désactivé.', 'looked': ['check:firewall']}
    tool_result = c.requests[1]['messages'][-1]['content'][0]
    assert 'firewall OFF' in tool_result['content']


def test_sonnet_asks_for_the_refusal_fallback():
    c = FakeClient(msg(text('ok')))
    cloud.interpret('bonjour', client=c, model='claude-sonnet-5-5')
    req = c.requests[0]
    assert req['model'] == 'claude-sonnet-5-5'
    assert req['fallbacks'] == 'default' and req['betas'] == ['server-side-fallback-2026-07-01']
    assert req['output_config'] == {'effort': 'low'}


def test_unknown_model_falls_back_to_the_first():
    c = FakeClient(msg(text('ok')))
    cloud.interpret('bonjour', client=c, model='gpt-9')
    assert c.requests[0]['model'] == cloud.DEFAULT_MODEL


def test_final_tools_become_intents():
    c = FakeClient(msg(use('propose_command', {'command': 'sudo ufw enable', 'summary': 'Activer le pare-feu.'}), stop='tool_use'))
    i = cloud.interpret('active le pare-feu', client=c)
    assert i['action'] == 'run_shell' and i['command'] == 'sudo ufw enable' and i['needs_confirmation']
    c = FakeClient(msg(use('gnome_action', {'action': 'toggle_dark_mode', 'enable': True, 'say': 'Mode sombre.'}), stop='tool_use'))
    i = cloud.interpret('mode sombre', client=c)
    assert i['action'] == 'toggle_dark_mode' and i['enable'] is True and i['say'] == 'Mode sombre.'
    c = FakeClient(msg(use('power', {'power_action': 'reboot'}), stop='tool_use'))
    assert cloud.interpret('redémarre', client=c)['action'] == 'power'


def test_errors_become_reason_codes():
    req = httpx.Request('POST', 'https://api.anthropic.com/v1/messages')
    bad = anthropic.AuthenticationError('no', response=httpx.Response(401, request=req), body=None)
    with pytest.raises(cloud.CloudError, match='cloud-key-rejected'):
        cloud.interpret('x', client=FakeClient(error=bad))
    with pytest.raises(cloud.CloudError, match='cloud-unreachable'):
        cloud.interpret('x', client=FakeClient(error=anthropic.APIConnectionError(request=req)))


def test_no_key(monkeypatch):
    monkeypatch.setattr(cloud, 'api_key', lambda provider: None)
    with pytest.raises(cloud.CloudError, match='cloud-no-key'):
        cloud.interpret('x')
    with pytest.raises(cloud.CloudError, match='cloud-provider-unsupported'):
        cloud.interpret('x', provider='openai')


def test_run_readonly_filter():
    assert cloud.run_readonly('cat ~/.ssh/id_rsa').startswith('NOT RUN: private')
    assert cloud.run_readonly('rm -rf /tmp/x').startswith('NOT RUN')
    assert cloud.run_readonly('sudo ufw status').startswith('NOT RUN')
    assert 'Linux' in cloud.run_readonly('uname -s')


def test_interpreter_rules_first_then_cloud_then_local_when_offline():
    calls = []

    def fake_cloud(text, context=None, **kw):
        calls.append(kw)
        raise cloud.CloudError('cloud-unreachable')

    it = Interpreter(cloud_fn=fake_cloud, llm_fn=lambda t: {'action': 'answer', 'text': 'local'})
    it.cloud = {'provider': 'anthropic', 'model': 'claude-sonnet-5-5'}
    assert it.interpret('mets le volume à 30')['source'] == 'rules'
    assert calls == []
    out = it.interpret('est-ce que mon pare-feu est activé')
    assert calls and out['source'] == 'llm' and out['text'] == 'local'


def test_interpreter_reports_a_rejected_key():
    def fake_cloud(text, context=None, **kw):
        raise cloud.CloudError('cloud-key-rejected')
    it = Interpreter(cloud_fn=fake_cloud, llm_fn=lambda t: {'action': 'answer', 'text': 'local'})
    it.cloud = {'provider': 'anthropic', 'model': 'claude-sonnet-5-5'}
    out = it.interpret('est-ce que mon pare-feu est activé')
    assert out['action'] == 'unknown' and out['reason'] == 'cloud-key-rejected'


def test_firewall_probe_reads_the_config(monkeypatch):
    files = {'/etc/ufw/ufw.conf': 'IPV6=yes\nENABLED=no\n'}
    monkeypatch.setattr(probes, '_read', lambda p: files.get(str(p)))
    monkeypatch.setattr(probes, '_run', lambda args, timeout=6: 'active' if args[-1] == 'ufw' else 'inactive')
    fw = probes.firewall()
    assert fw['ufw_enabled_in_config'] is False and fw['ufw_service'] == 'active'
    assert fw['verdict'].startswith('firewall OFF')
    files['/etc/ufw/ufw.conf'] = 'ENABLED=yes\n'
    assert probes.firewall()['verdict'] == 'firewall ON'


def test_root_encryption_is_found_through_luks():
    plain = [{'name': 'sda', 'type': 'disk', 'children': [{'name': 'sda5', 'type': 'part', 'mountpoints': ['/']}]}]
    luks = [{'name': 'nvme0n1', 'type': 'disk', 'children': [{'name': 'p3', 'type': 'part', 'children': [
        {'name': 'luks', 'type': 'crypt', 'children': [{'name': 'root', 'type': 'lvm', 'mountpoints': ['/']}]}]}]}]
    assert probes._root_encrypted(plain) is False
    assert probes._root_encrypted(luks) is True


def test_questions_and_requests():
    for q in ["Est-ce que mon porfeu est activé?", "combien de place il me reste", "Quel Wi-Fi ?",
              "is my firewall on", "mon pare-feu est activé ?"]:
        assert cloud.is_question(q), q
    for r in ["Active le pare-feu", "Est-ce que tu peux activer le pare-feu ?", "peux-tu vider le cache ?",
              "fais-moi de la place", "can you turn on the firewall?"]:
        assert not cloud.is_question(r), r


def test_a_question_never_ends_in_an_action():
    c = FakeClient(msg(use('propose_command', {'command': 'sudo ufw enable', 'summary': 'Activer.'}), stop='tool_use'),
                   msg(text("Non, il est désactivé. Voulez-vous que je l'active ?")))
    intent = cloud.interpret('Est-ce que mon pare-feu est activé ?', client=c)
    assert intent['action'] == 'answer' and 'désactivé' in intent['text']
    sent_back = c.requests[1]['messages'][-1]['content'][0]
    assert sent_back['is_error'] and 'question' in sent_back['content']


def test_the_previous_exchange_is_kept_for_a_follow_up():
    seen = []

    def fake_cloud(text, context=None, **kw):
        seen.append(context)
        if text.startswith('Est-ce'):
            return {'action': 'answer', 'text': "Non. Voulez-vous que je l'active ?"}
        return {'action': 'run_shell', 'command': 'sudo ufw enable', 'summary': 'Activer le pare-feu.'}

    it = Interpreter(cloud_fn=fake_cloud, use_llm=False)
    it.cloud = {'provider': 'anthropic', 'model': 'claude-sonnet-5-5'}
    it.interpret('Est-ce que mon pare-feu est activé ?')
    out = it.interpret('oui vas-y')
    assert seen[0] is None
    assert seen[1] == ['Est-ce que mon pare-feu est activé ?', "Non. Voulez-vous que je l'active ?"]
    assert out['command'] == 'sudo ufw enable'
