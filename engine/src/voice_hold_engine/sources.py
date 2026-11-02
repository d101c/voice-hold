"""Microphones known to PipeWire, and which one is the default."""
import json
import subprocess


def list_sources():
    """Returns [{'name', 'description', 'default'}], default first. Empty
    when PipeWire cannot be queried."""
    try:
        out = subprocess.run(['pw-dump'], capture_output=True, text=True, timeout=5, check=True).stdout
        objects = json.loads(out)
    except Exception:
        return []
    default = None
    nodes = []
    for obj in objects:
        t = obj.get('type', '')
        if t == 'PipeWire:Interface:Metadata' and obj.get('props', {}).get('metadata.name') == 'default':
            for entry in obj.get('metadata', []):
                if entry.get('key') == 'default.audio.source':
                    value = entry.get('value')
                    default = value.get('name') if isinstance(value, dict) else value
        elif t == 'PipeWire:Interface:Node':
            props = obj.get('info', {}).get('props', {})
            if props.get('media.class') != 'Audio/Source':
                continue
            name = props.get('node.name', '')
            if not name:
                continue
            nodes.append({
                'name': name,
                'description': props.get('node.description') or props.get('node.nick') or name,
                'default': False,
            })
    for n in nodes:
        n['default'] = n['name'] == default
    if default is None and nodes:
        nodes[0]['default'] = True
    nodes.sort(key=lambda n: (not n['default'], n['description'].lower()))
    return nodes


def describe(name=''):
    """Human name of the source `name`, or of the default source."""
    for n in list_sources():
        if (name and n['name'] == name) or (not name and n['default']):
            return n['description']
    return name or ''
