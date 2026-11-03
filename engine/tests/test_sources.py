"""parse_sources() on a frozen, trimmed `pw-dump` output."""
from voice_hold_engine.sources import describe, list_sources, parse_sources

DUMP = [
    {'id': 0, 'type': 'PipeWire:Interface:Core', 'info': {}},
    {
        'id': 30, 'type': 'PipeWire:Interface:Metadata',
        'props': {'metadata.name': 'default'},
        'metadata': [
            {'subject': 0, 'key': 'default.audio.sink', 'type': 'Spa:String:JSON', 'value': {'name': 'alsa_output.pci-0000_00_1f.3.analog-stereo'}},
            {'subject': 0, 'key': 'default.audio.source', 'type': 'Spa:String:JSON', 'value': {'name': 'alsa_input.usb-Blue_Yeti-00.analog-stereo'}},
        ],
    },
    {
        'id': 31, 'type': 'PipeWire:Interface:Metadata',
        'props': {'metadata.name': 'route-settings'},
        'metadata': [],
    },
    {
        'id': 40, 'type': 'PipeWire:Interface:Node',
        'info': {'props': {'media.class': 'Audio/Sink', 'node.name': 'alsa_output.pci-0000_00_1f.3.analog-stereo', 'node.description': 'Built-in Audio Analog Stereo'}},
    },
    {
        'id': 41, 'type': 'PipeWire:Interface:Node',
        'info': {'props': {'media.class': 'Audio/Source', 'node.name': 'alsa_input.pci-0000_00_1f.3.analog-stereo', 'node.description': 'Built-in Audio Analog Stereo', 'node.nick': 'Internal Mic'}},
    },
    {
        'id': 42, 'type': 'PipeWire:Interface:Node',
        'info': {'props': {'media.class': 'Audio/Source', 'node.name': 'alsa_input.usb-Blue_Yeti-00.analog-stereo', 'node.description': 'Yeti Stereo Microphone'}},
    },
    {
        'id': 43, 'type': 'PipeWire:Interface:Node',
        'info': {'props': {'media.class': 'Audio/Source', 'node.name': 'bluez_input.AA_BB', 'node.nick': 'Headset'}},
    },
    {
        'id': 44, 'type': 'PipeWire:Interface:Node',
        'info': {'props': {'media.class': 'Audio/Source/Virtual', 'node.name': 'echo-cancel-source', 'node.description': 'Echo-Cancel Source'}},
    },
    {
        'id': 45, 'type': 'PipeWire:Interface:Node',
        'info': {'props': {'media.class': 'Audio/Source', 'node.description': 'nameless'}},
    },
    {'id': 50, 'type': 'PipeWire:Interface:Client', 'info': {}},
]


def test_parse_default_first_then_alphabetical():
    out = parse_sources(DUMP)
    assert [s['name'] for s in out] == [
        'alsa_input.usb-Blue_Yeti-00.analog-stereo',
        'alsa_input.pci-0000_00_1f.3.analog-stereo',
        'bluez_input.AA_BB',
    ]
    assert out[0] == {'name': 'alsa_input.usb-Blue_Yeti-00.analog-stereo', 'description': 'Yeti Stereo Microphone', 'default': True}
    assert out[1]['description'] == 'Built-in Audio Analog Stereo'
    assert out[2]['description'] == 'Headset', 'nick when there is no description'
    assert [s['default'] for s in out] == [True, False, False]


def test_parse_without_default_metadata_picks_the_first():
    dump = [o for o in DUMP if o.get('type') != 'PipeWire:Interface:Metadata']
    out = parse_sources(dump)
    assert out[0]['default'] is True
    assert sum(s['default'] for s in out) == 1


def test_parse_string_default_value():
    dump = [dict(o) for o in DUMP]
    dump[1] = {**dump[1], 'metadata': [{'key': 'default.audio.source', 'value': 'bluez_input.AA_BB'}]}
    out = parse_sources(dump)
    assert out[0]['name'] == 'bluez_input.AA_BB'


def test_parse_garbage_is_empty():
    assert parse_sources([]) == []
    assert parse_sources([None, 3, 'x', {}]) == []


def test_list_sources_without_pw_dump(monkeypatch):
    monkeypatch.setattr('voice_hold_engine.sources.subprocess.run', lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError('pw-dump')))
    assert list_sources() == []


def test_describe(monkeypatch):
    monkeypatch.setattr('voice_hold_engine.sources.list_sources', lambda: parse_sources(DUMP))
    assert describe() == 'Yeti Stereo Microphone'
    assert describe('bluez_input.AA_BB') == 'Headset'
    assert describe('unknown.node') == 'unknown.node'
