import subprocess
import sys

from voice_hold_engine import cli


def test_commands_service_file_uses_the_running_interpreter(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_DATA_HOME', str(tmp_path))
    path = cli.install_commands_service(log=lambda s: None)
    assert path.name == 'org.griffit.VoiceHold.Commands.service'
    assert path.read_text() == ('[D-BUS Service]\nName=org.griffit.VoiceHold.Commands\n'
                                f'Exec={sys.executable} -m voice_hold_engine commands-serve\n')
    out = subprocess.run([sys.executable, '-c', 'import voice_hold_engine.commands.service'],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr


def test_interpret_cli_prints_json(capsys):
    assert cli.main(['interpret', '--no-llm', 'verrouille', 'l', 'écran']) == 0
    assert '"action": "lock"' in capsys.readouterr().out
