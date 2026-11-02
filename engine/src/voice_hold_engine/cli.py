"""Command line: `voice-hold-engine [serve|setup|status|transcribe FILE|install-service|uninstall]`."""
import argparse
import asyncio
import os
import shutil
import sys
from pathlib import Path

from . import BUS_NAME, __version__, models

SERVICE_FILE = f'{BUS_NAME}.service'


def service_dir():
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local' / 'share'))
    return data / 'dbus-1' / 'services'


def executable():
    exe = shutil.which('voice-hold-engine') or sys.argv[0]
    return str(Path(exe).resolve())


def install_service(log=print):
    d = service_dir()
    d.mkdir(parents=True, exist_ok=True)
    path = d / SERVICE_FILE
    path.write_text(f'[D-BUS Service]\nName={BUS_NAME}\nExec={executable()} serve\n')
    log(f'D-Bus service installed: {path}')
    return path


def cmd_setup(args):
    log = lambda s: (sys.stderr.write(s), sys.stderr.flush())
    base = models.models_dir()
    print(f'Models directory: {base}')
    miss = models.setup(base, log)
    if miss:
        print('Still missing: ' + ', '.join(miss), file=sys.stderr)
        return 1
    print('Models ready.')
    install_service()
    print('Done. Enable the Voice Hold extension and hold Super+R in a text field.')
    return 0


def cmd_status(args):
    base = models.models_dir()
    miss = models.missing(base)
    print(f'voice-hold-engine {__version__}')
    print(f'models: {base} ({"ready" if not miss else "missing: " + ", ".join(miss)})')
    svc = service_dir() / SERVICE_FILE
    print(f'D-Bus service file: {svc} ({"present" if svc.exists() else "absent"})')
    print(f'pw-record: {shutil.which("pw-record") or "NOT FOUND"}')
    return 0 if not miss and svc.exists() else 1


def cmd_transcribe(args):
    from .asr import Recognizer
    from .audio import FileSource
    rec = Recognizer()
    audio = FileSource.read(args.file)
    rec.load()
    print(f'[loaded in {rec.load_seconds:.1f}s]', file=sys.stderr)
    import time
    t0 = time.perf_counter()
    print(rec.transcribe(audio))
    dur = len(audio) / 16000
    print(f'[{dur:.1f}s audio decoded in {time.perf_counter() - t0:.2f}s]', file=sys.stderr)
    return 0


def cmd_serve(args):
    from .service import serve
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
    return 0


def cmd_uninstall(args):
    svc = service_dir() / SERVICE_FILE
    if svc.exists():
        svc.unlink()
        print(f'Removed {svc}')
    if args.models:
        base = models.models_dir()
        if base.exists():
            shutil.rmtree(base)
            print(f'Removed {base}')
    print('Now run: pipx uninstall voice-hold-engine  (or: uv tool uninstall voice-hold-engine)')
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog='voice-hold-engine', description=__doc__)
    p.add_argument('--version', action='version', version=__version__)
    sub = p.add_subparsers(dest='cmd')
    sub.add_parser('serve', help='run the D-Bus service (default)').set_defaults(fn=cmd_serve)
    sub.add_parser('setup', help='download the models and install the D-Bus service').set_defaults(fn=cmd_setup)
    sub.add_parser('status', help='check models and service').set_defaults(fn=cmd_status)
    sub.add_parser('install-service', help='(re)write the D-Bus service file').set_defaults(fn=lambda a: (install_service(), 0)[1])
    t = sub.add_parser('transcribe', help='transcribe a WAV file (debug)')
    t.add_argument('file')
    t.set_defaults(fn=cmd_transcribe)
    u = sub.add_parser('uninstall', help='remove the D-Bus service file (and models with --models)')
    u.add_argument('--models', action='store_true')
    u.set_defaults(fn=cmd_uninstall)
    args = p.parse_args(argv)
    fn = getattr(args, 'fn', cmd_serve)
    return fn(args)


if __name__ == '__main__':
    sys.exit(main())
