"""Is there room to load a model? Loading 1 or 2 GB of weights on a machine
that does not have them free does not fail: it pushes everything else into
swap and the desktop freezes for a long time. So the engines look first and
refuse with a message the pill can show."""
import os

ASR_NEED_MB = 1200      # the speech model holds ~1.05 GB once loaded
LLM_NEED_MB = 2300      # llama-server with Qwen3.5-2B holds ~2.1 GB


def available_mb():
    """Memory the kernel says can be used without swapping (MemAvailable), in
    MB; None when it cannot be read. VOICE_HOLD_MEM_AVAILABLE_MB overrides it
    (tests, and trying the low-memory messages by hand)."""
    fake = os.environ.get('VOICE_HOLD_MEM_AVAILABLE_MB')
    if fake:
        try:
            return int(fake)
        except ValueError:
            pass
    try:
        with open('/proc/meminfo') as f:
            for line in f:
                if line.startswith('MemAvailable:'):
                    return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


def shortage(need_mb):
    """'' when `need_mb` can be loaded, else '<free>:<need>' in MB."""
    free = available_mb()
    if free is None or free >= need_mb:
        return ''
    return f'{free}:{need_mb}'
