"""Read-only probes of the computer's state, for the cloud assistant.

A model left to pick its own commands draws plausible but wrong
conclusions: "the firewall is active" because the ufw service runs, when
ufw itself is switched off in its configuration. These probes look where
the answer really is and return plain facts, so the model only has to put
them into words. Nothing here changes anything; every command has a
timeout; a probe that cannot see something says so instead of guessing.
"""
import json
import os
import re
import subprocess
from pathlib import Path

HOME = Path.home()


def _run(args, timeout=6):
    """stdout of `args` (a list, no shell), '' when it fails or times out."""
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return ''
    return p.stdout.strip()


def _read(path):
    try:
        return Path(path).read_text(errors='replace')
    except OSError:
        return None


def _gsettings(schema, key):
    out = _run(['gsettings', 'get', schema, key])
    return out or None


def _gib(n_bytes):
    return round(n_bytes / 2**30, 1)


# -- the probes -----------------------------------------------------------------

def disk():
    """Size, used and free space of / and of the home folder's filesystem."""
    res = {}
    for label, path in (('system', '/'), ('home', str(HOME))):
        try:
            st = os.statvfs(path)
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        res[label] = {'size_gib': _gib(total), 'free_gib': _gib(free),
                      'used_percent': round(100 * (total - free) / total) if total else None}
    if res.get('home') == res.get('system'):
        res.pop('home', None)
        res['note'] = 'home is on the system filesystem'
    return res


def disk_hogs():
    """What takes space and could be freed, largest first. Sizes in GiB."""
    found = []

    def size_of(path, timeout=20):
        out = _run(['du', '-sx', '--block-size=1', str(path)], timeout=timeout)
        m = re.match(r'(\d+)', out)
        return int(m.group(1)) if m else None

    cache = HOME / '.cache'
    out = _run(['du', '-x', '--max-depth=1', '--block-size=1', str(cache)], timeout=30)
    for line in out.splitlines():
        size, _, path = line.partition('\t')
        if path and path != str(cache) and size.isdigit() and int(size) > 300 * 2**20:
            name = Path(path).name
            found.append({'what': f'cache: {name}', 'path': path, 'gib': _gib(int(size)),
                          'how': _CACHE_CLEAN.get(name, 'rebuilt by its program when needed')})
    trash = HOME / '.local/share/Trash'
    for path, what, how in ((trash, 'trash', 'gio trash --empty'),
                            (HOME / 'Downloads', 'downloads folder', 'personal files: user decides'),
                            (HOME / 'Téléchargements', 'downloads folder', 'personal files: user decides'),
                            (Path('/var/cache/apt/archives'), 'apt package cache', 'sudo apt-get clean')):
        if path.exists():
            n = size_of(path)
            if n and n > 100 * 2**20:
                found.append({'what': what, 'path': str(path), 'gib': _gib(n), 'how': how})
    journal = _run(['journalctl', '--disk-usage'])
    m = re.search(r'take up ([\d.,]+)([KMGT])', journal)
    if m:
        mult = {'K': 2**10, 'M': 2**20, 'G': 2**30, 'T': 2**40}[m.group(2)]
        n = float(m.group(1).replace(',', '.')) * mult
        if n > 200 * 2**20:
            found.append({'what': 'system logs (journal)', 'gib': _gib(n),
                          'how': 'sudo journalctl --vacuum-size=200M'})
    old_snaps = [l for l in _run(['snap', 'list', '--all']).splitlines() if 'disabled' in l]
    if old_snaps:
        found.append({'what': f'{len(old_snaps)} old disabled snap revisions', 'gib': None,
                      'how': 'sudo snap remove NAME --revision=REV for each'})
    found.sort(key=lambda f: f.get('gib') or 0, reverse=True)
    return {'free': disk(), 'candidates': found}


_CACHE_CLEAN = {
    'uv': 'uv cache clean',
    'pip': 'pip cache purge',
    'huggingface': 'downloaded AI models: deleting them means downloading again',
    'thumbnails': 'rm -rf ~/.cache/thumbnails (rebuilt automatically)',
    'yarn': 'yarn cache clean',
    'npm': 'npm cache clean --force',
    'go-build': 'go clean -cache',
    'JetBrains': 'IDE caches: close the IDE first',
}


def memory():
    """RAM and swap use, and the programs using the most (summed over their
    processes, so a browser counts once)."""
    info = {}
    for line in (_read('/proc/meminfo') or '').splitlines():
        k, _, v = line.partition(':')
        m = re.match(r'\s*(\d+)', v)
        if m:
            info[k] = int(m.group(1)) * 1024
    by_prog = {}
    for line in _run(['ps', '-eo', 'rss=,comm=']).splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            by_prog[parts[1]] = by_prog.get(parts[1], 0) + int(parts[0]) * 1024
    top = sorted(by_prog.items(), key=lambda kv: kv[1], reverse=True)[:6]
    total = info.get('MemTotal', 0)
    return {
        'total_gib': _gib(total),
        'available_gib': _gib(info.get('MemAvailable', 0)),
        'swap_used_gib': _gib(info.get('SwapTotal', 0) - info.get('SwapFree', 0)),
        'top_programs': [{'name': n, 'gib': _gib(b)} for n, b in top],
    }


def battery():
    devices = [d for d in _run(['upower', '-e']).splitlines() if 'BAT' in d]
    if not devices:
        return {'battery': 'none found'}
    out = _run(['upower', '-i', devices[0]])

    def field(name):
        m = re.search(rf'^\s*{name}:\s*(.+)$', out, re.MULTILINE)
        return m.group(1).strip() if m else None
    ac = None
    for p in Path('/sys/class/power_supply').glob('*/online'):
        ac = (_read(p) or '').strip() == '1' or bool(ac)
    return {
        'percentage': field('percentage'),
        'state': field('state'),
        'on_mains': ac,
        'health_capacity': field('capacity'),
        'charge_cycles': field('charge-cycles'),
        'time_to_empty': field('time to empty'),
    }


def network():
    wifi = []
    for line in _run(['nmcli', '-t', '-f', 'ACTIVE,SSID,FREQ,SIGNAL,SECURITY', 'dev', 'wifi']).splitlines():
        parts = line.split(':')
        if len(parts) >= 5 and parts[0] == 'yes':
            freq = int(re.sub(r'\D', '', parts[2]) or 0)
            wifi.append({'ssid': parts[1], 'band': '5 GHz' if freq >= 5000 else '2.4 GHz' if freq else None,
                         'freq_mhz': freq or None, 'signal_percent': parts[3], 'security': parts[4]})
    return {
        'connectivity': _run(['nmcli', 'networking', 'connectivity']) or None,
        'wifi': wifi or None,
        'devices': _run(['nmcli', '-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']).splitlines(),
    }


def versions():
    os_release = dict(re.findall(r'^(\w+)="?([^"\n]*)"?$', _read('/etc/os-release') or '', re.MULTILINE))
    return {
        'system': os_release.get('PRETTY_NAME'),
        'gnome_shell': _run(['gnome-shell', '--version']) or None,
        'kernel': _run(['uname', '-r']) or None,
    }


def processes():
    load = (_read('/proc/loadavg') or '').split()[:3]
    top = _run(['ps', '-eo', 'pid=,comm=,%cpu=,%mem=', '--sort=-%cpu'])
    return {
        'cpu_count': os.cpu_count(),
        'load_average_1_5_15min': load,
        'top_cpu': [' '.join(l.split()) for l in top.splitlines()[:6]],
        'memory': memory(),
    }


def firewall():
    """Whether a firewall really filters: ufw's own switch, not its service."""
    res = {'ufw_installed': Path('/usr/sbin/ufw').exists()}
    conf = _read('/etc/ufw/ufw.conf')
    if conf is not None:
        m = re.search(r'^\s*ENABLED\s*=\s*(\w+)', conf, re.MULTILINE)
        res['ufw_enabled_in_config'] = (m.group(1).lower() == 'yes') if m else None
    res['ufw_service'] = _run(['systemctl', 'is-active', 'ufw']) or None
    res['firewalld_active'] = _run(['systemctl', 'is-active', 'firewalld']) == 'active'
    on = bool(res.get('ufw_enabled_in_config')) or res['firewalld_active']
    res['verdict'] = 'firewall ON' if on else 'firewall OFF (nothing filters incoming connections)'
    res['note'] = ('The ufw service being "active" only means its boot script ran; '
                   'filtering depends on ENABLED in /etc/ufw/ufw.conf.')
    res['how_to_enable'] = 'sudo ufw enable' if res['ufw_installed'] else 'sudo apt install ufw && sudo ufw enable'
    return res


def security():
    """A security check-up of the usual weak points."""
    res = {'firewall': firewall()}
    tree = _run(['lsblk', '-J', '-o', 'NAME,TYPE,MOUNTPOINTS'])
    try:
        res['disk_encrypted'] = _root_encrypted(json.loads(tree)['blockdevices'])
    except (ValueError, KeyError):
        res['disk_encrypted'] = None
    sb = _run(['mokutil', '--sb-state'])
    res['secure_boot'] = ('enabled' in sb.lower()) if sb else None
    auto = _read('/etc/apt/apt.conf.d/20auto-upgrades') or ''
    res['automatic_security_updates'] = bool(re.search(r'Unattended-Upgrade\s+"1"', auto))
    pending = [l for l in _run(['apt', 'list', '--upgradable'], timeout=15).splitlines() if '/' in l]
    res['pending_updates'] = len(pending)
    res['screen_lock'] = {
        'lock_enabled': _gsettings('org.gnome.desktop.screensaver', 'lock-enabled'),
        'idle_delay_s': _gsettings('org.gnome.desktop.session', 'idle-delay'),
        'lock_delay_s': _gsettings('org.gnome.desktop.screensaver', 'lock-delay'),
    }
    gdm = _read('/etc/gdm3/custom.conf') or ''
    res['automatic_login'] = bool(re.search(r'^\s*AutomaticLoginEnable\s*=\s*true', gdm, re.MULTILINE | re.IGNORECASE))
    res['ssh_server_running'] = _run(['systemctl', 'is-active', 'ssh']) == 'active'
    return res


def _root_encrypted(devices, encrypted=False):
    for d in devices:
        crypt = encrypted or d.get('type') == 'crypt'
        if '/' in (d.get('mountpoints') or []):
            return crypt
        found = _root_encrypted(d.get('children') or [], crypt)
        if found is not None:
            return found
    return None


PROBES = {
    'disk': disk, 'disk_hogs': disk_hogs, 'memory': memory, 'battery': battery,
    'network': network, 'versions': versions, 'processes': processes,
    'firewall': firewall, 'security': security,
}


def check(topic):
    fn = PROBES.get(topic)
    if fn is None:
        return json.dumps({'error': f'unknown topic {topic!r}', 'topics': sorted(PROBES)})
    return json.dumps(fn(), ensure_ascii=False)
