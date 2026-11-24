"""Rules first, then the cloud assistant when it is switched on (cloud.py),
else the local LLM, then the guard rails. Produces the intent dict the
extension executes, with a short `say` line for the pill. When the cloud
cannot be reached the local LLM answers instead: offline still works."""
import time

from . import cloud, llm, rules, safety

CONTEXT_S = 120.0

CLOSED = {
    'open_app', 'close_window', 'close_all_windows', 'set_volume', 'change_volume',
    'set_brightness', 'change_brightness', 'toggle_dark_mode', 'toggle_dnd',
    'toggle_wifi', 'toggle_bluetooth', 'switch_workspace', 'screenshot', 'lock', 'power',
}


class Interpreter:
    def __init__(self, *, use_llm=True, llm_fn=None, apps=None, work_dir='', cloud_fn=None):
        self.use_llm = use_llm
        self._llm_fn = llm_fn or llm.interpret
        self._cloud_fn = cloud_fn or cloud.interpret
        # {'provider', 'model'} while the cloud is switched on, else None.
        self.cloud = None
        # The last cloud exchange (monotonic time, request, answer), kept
        # CONTEXT_S so that "oui, vas-y" can follow a question it asked.
        self._last = None
        self._rules = rules.RuleParser(apps)
        self.work_dir = work_dir

    def reload_apps(self):
        self._rules = rules.RuleParser()

    def interpret(self, text):
        t0 = time.perf_counter()
        intent = self._rules.parse(text)
        source = 'rules'
        why = ''
        # With the cloud on, the rules keep only what they do instantly and
        # surely (desktop actions, apps, the time); a shell command they would
        # guess ("fais de la place" -> df) is the assistant's to work out.
        if self.cloud and intent is not None and intent.get('action') == 'run_shell':
            intent = None
        if intent is None and self.cloud:
            try:
                context = None
                if self._last and time.monotonic() - self._last[0] < CONTEXT_S:
                    context = list(self._last[1:])
                intent = self._cloud_fn(text, context=context, **self.cloud)
                source = 'cloud'
                reply = intent.get('text') or intent.get('summary') or intent.get('say') or ''
                self._last = (time.monotonic(), text, reply) if reply else None
            except cloud.CloudError as e:
                why = str(e)
                # Offline, or the provider is down: the local model answers.
                if why not in ('cloud-unreachable', 'cloud-timeout') or not self.use_llm:
                    intent = {'action': 'unknown', 'reason': why}
                    source = 'none'
            if intent is not None and intent.get('action') == 'open_app' and 'app_id' not in intent:
                app, _ = self._rules.index.lookup(intent.get('name', ''))
                if app:
                    intent = {**intent, 'app_id': app['id'], 'name': app.get('name_fr') or app['name']}
                else:
                    intent = {'action': 'unknown', 'reason': f"no app named {intent.get('name', '')!r}"}
        if intent is None:
            if self.use_llm:
                try:
                    intent = self._llm_fn(text)
                    why = 'llm-unavailable'
                except llm.Timeout:
                    intent = None
                    why = 'llm-timeout'
                except llm.Unavailable as e:
                    intent = None
                    why = str(e)
                source = 'llm'
                if intent is None:
                    intent = {'action': 'unknown', 'reason': why}
                    source = 'none'
                elif intent.get('action') == 'open_app':
                    # The model names the app; the rules know what is installed.
                    app, _ = self._rules.index.lookup(intent.get('name', ''))
                    if app:
                        intent = {'action': 'open_app', 'app_id': app['id'], 'name': app.get('name_fr') or app['name']}
                    else:
                        intent = {'action': 'unknown', 'reason': f"no app named {intent.get('name', '')!r}"}
            else:
                intent = {'action': 'unknown', 'reason': 'llm-off'}
                source = 'none'
        intent = dict(intent)
        intent['source'] = source
        intent['ms'] = round((time.perf_counter() - t0) * 1000)
        return self._finish(intent, text)

    def _finish(self, intent, text):
        action = intent.get('action', 'unknown')
        intent.setdefault('needs_confirmation', False)
        intent['refused'] = False
        if action == 'run_shell':
            cmd = ' '.join(str(intent.get('command', '')).split())
            intent['command'] = cmd
            intent.setdefault('cwd', self.work_dir)
            level, why = safety.classify(cmd)
            if level == safety.REFUSE:
                intent['refused'] = True
                intent['reason'] = why
            # A command that only looks something up runs by itself, silently,
            # and its output goes to the pill. Everything else is confirmed.
            quiet = level == safety.OK and safety.read_only(cmd)
            intent['quiet'] = quiet
            intent['needs_confirmation'] = not quiet
            intent['warning'] = why if level == safety.CONFIRM else ''
        elif action == 'power':
            intent['needs_confirmation'] = True
        elif action == 'answer' and intent.get('text') == 'time':
            intent['text'] = time.strftime('%H:%M')
        elif action in ('click', 'keys'):
            intent['needs_confirmation'] = True
        elif action not in CLOSED and action not in ('answer', 'unknown', 'type_text', 'point'):
            intent['action'] = 'unknown'
            intent['reason'] = f'unsupported action {action!r}'
        intent['transcript'] = text
        return intent
