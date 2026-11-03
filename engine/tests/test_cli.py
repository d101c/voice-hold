import subprocess
import sys
from pathlib import Path

from voice_hold_engine import cli


def test_service_file_uses_the_running_interpreter(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_DATA_HOME', str(tmp_path))
    path = cli.install_service(log=lambda s: None)
    assert path == tmp_path / 'dbus-1' / 'services' / 'org.griffit.VoiceHold.service'
    text = path.read_text()
    assert text == (
        '[D-BUS Service]\n'
        'Name=org.griffit.VoiceHold\n'
        f'Exec={Path(sys.executable).resolve()} -m voice_hold_engine serve\n'
    )


def test_uninstall_removes_the_service_file(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('XDG_DATA_HOME', str(tmp_path))
    monkeypatch.setenv('VOICE_HOLD_MODELS', str(tmp_path / 'models'))
    (tmp_path / 'models').mkdir()
    cli.install_service(log=lambda s: None)
    assert cli.main(['uninstall']) == 0
    assert not (tmp_path / 'dbus-1' / 'services' / 'org.griffit.VoiceHold.service').exists()
    assert (tmp_path / 'models').exists(), 'models kept without --models'
    assert cli.main(['uninstall', '--models']) == 0
    assert not (tmp_path / 'models').exists()
    assert 'pipx uninstall' in capsys.readouterr().out


def test_module_entry_point_runs():
    out = subprocess.run([sys.executable, '-m', 'voice_hold_engine', '--version'],
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0
    assert out.stdout.strip() == cli.__version__
