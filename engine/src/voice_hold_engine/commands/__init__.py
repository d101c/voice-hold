"""Voice commands (optional): intent rules, a small local LLM served by
llama.cpp for what the rules leave, guard rails and shell jobs, behind a
second session D-Bus service."""

BUS_NAME = 'org.griffit.VoiceHold.Commands'
OBJECT_PATH = '/org/griffit/VoiceHold/Commands'
INTERFACE = 'org.griffit.VoiceHold.Commands'
