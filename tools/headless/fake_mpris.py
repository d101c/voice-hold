"""A media player on the session bus that is playing, for the bench: logs
Pause / Play to the file given as argument (MPRIS=1 in run.sh)."""
import asyncio
import sys
import time

from dbus_fast.aio import MessageBus
from dbus_fast.service import ServiceInterface, dbus_property, method, PropertyAccess

LOG = sys.argv[1]


def log(what):
    with open(LOG, 'a') as f:
        f.write(f'{time.monotonic():.3f} {what}\n')


class Player(ServiceInterface):
    def __init__(self):
        super().__init__('org.mpris.MediaPlayer2.Player')
        self.status = 'Playing'

    @method()
    def Pause(self):
        log('Pause')
        self.status = 'Paused'

    @method()
    def Play(self):
        log('Play')
        self.status = 'Playing'

    @dbus_property(access=PropertyAccess.READ)
    def PlaybackStatus(self) -> 's':
        return self.status


async def main():
    bus = await MessageBus().connect()
    bus.export('/org/mpris/MediaPlayer2', Player())
    await bus.request_name('org.mpris.MediaPlayer2.benchplayer')
    log('ready Playing')
    await asyncio.Future()

asyncio.run(main())
