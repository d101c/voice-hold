import asyncio

from voice_hold_engine import models, wakeword
from voice_hold_engine.service import Engine


def test_first_switch_on_downloads_the_model_then_listens(monkeypatch):
    calls = {'setup': 0, 'listen': []}
    state = {'missing': True}
    monkeypatch.setattr(wakeword, 'missing', lambda base=None: ['encoder'] if state['missing'] else [])

    def fake_setup(base=None, log=None):
        calls['setup'] += 1
        state['missing'] = False
        return []
    monkeypatch.setattr(models, 'setup_wake', fake_setup)

    async def run():
        engine = Engine(lambda *a: None, loop=asyncio.get_running_loop(), idle_unload_s=0)
        real_listen = engine.listen

        async def spy(options):
            calls['listen'].append(dict(options))
            if not state['missing']:
                return 'started'           # past the download: stop here
            return await real_listen(options)
        engine.listen = spy
        first = await real_listen({'enabled': True})
        assert first == 'wake-downloading'
        assert engine.status()['wake'].value == 'downloading'
        again = await real_listen({'enabled': True})   # a retry does not download twice
        assert again == 'wake-downloading'
        while engine._wake_download is not None:
            await asyncio.sleep(0.01)
    asyncio.run(run())
    assert calls['setup'] == 1
    assert calls['listen'] and calls['listen'][-1]['enabled'] is True


def test_switched_off_during_the_download_does_not_listen(monkeypatch):
    state = {'missing': True}
    monkeypatch.setattr(wakeword, 'missing', lambda base=None: ['encoder'] if state['missing'] else [])
    monkeypatch.setattr(models, 'setup_wake', lambda base=None, log=None: state.update(missing=False) or [])

    async def run():
        engine = Engine(lambda *a: None, loop=asyncio.get_running_loop(), idle_unload_s=0)
        await engine.listen({'enabled': True})
        await engine.listen({'enabled': False})
        while engine._wake_download is not None:
            await asyncio.sleep(0.01)
        assert engine._wake is None
    asyncio.run(run())
