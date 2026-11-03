"""`python -m voice_hold_engine`: what the D-Bus service file runs."""
import sys

from .cli import main

sys.exit(main())
