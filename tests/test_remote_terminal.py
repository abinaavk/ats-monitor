"""Remote terminal relay: a browser terminal bound to a real session on a Global, with honest failures."""
import os
import pwd
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

import cluster_support
from cluster_support import TransportError
import remote_terminal
from remote_terminal import Relay

import ats_terminal as global_terminal


def wait_for(condition, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        if condition():
            return True
        time.sleep(0.05)
    return False


class RelayBase(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {'ATS_TERMINAL_USER': pwd.getpwuid(os.getuid()).pw_name, 'ATS_TERMINAL_ALLOW_ROOT': '1'})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(global_terminal.close_all)
        self.output, self.finished, self.calls = [], threading.Event(), []
        self.signed_in = True
        self.server = {'id': 'a' * 32, 'name': 'Build', 'local': 0, 'connected': 1, 'secret': 'b' * 64, 'domain': 'https://x.example.com'}
        self.fail_kinds = {}

    def call(self, server, payload, timeout=None):
        """Stand-in for the signed HTTPS call: the Global's real terminal code, without the network."""
        self.calls.append(payload['kind'])
        failure = self.fail_kinds.get(payload['kind'])
        if failure:
            exc = failure.pop(0) if isinstance(failure, list) and failure else (None if isinstance(failure, list) else failure)
            if exc:
                raise exc
        return global_terminal.handle(payload['kind'], payload)

    def relay(self, **extra):
        spawn = lambda function: threading.Thread(target=function, daemon=True).start()
        relay = Relay(self.server, self.output.append, self.finished.set, lambda: self.signed_in,
                      spawn=spawn, sleep=lambda seconds: time.sleep(min(seconds, 0.01)), call=self.call,
                      run=lambda function, *a, **k: function(*a, **k), **extra)
        self.addCleanup(relay.close)
        return relay

    def text(self):
        return ''.join(self.output)


class RelayTests(RelayBase):
    def test_commands_run_and_the_session_end_is_reported(self):
        relay = self.relay()
        relay.start(24, 80)
        relay.write('echo relay-$((6*7))\n')
        self.assertTrue(wait_for(lambda: 'relay-42' in self.text()), self.text())
        relay.write('exit\n')
        self.assertTrue(self.finished.wait(15), self.text())
        self.assertIn('Session ended', self.text())

    def test_input_order_is_preserved_and_resize_reaches_the_shell(self):
        relay = self.relay()
        relay.start(30, 100)
        for part in ('echo ', 'one', '-', 'two', '\n'):
            relay.write(part)
        self.assertTrue(wait_for(lambda: 'one-two' in self.text().replace('echo one-two', '')), self.text())
        relay.resize(40, 120)
        relay.write('stty size\n')
        self.assertTrue(wait_for(lambda: '40 120' in self.text()), self.text())

    def test_unicode_split_across_reads_is_not_corrupted(self):
        relay = self.relay()
        relay.start()
        relay.write("printf '\\342'; sleep .2; printf '\\202\\254-euro\\n'\n")
        self.assertTrue(wait_for(lambda: '€-euro' in self.text()), self.text())
        self.assertNotIn('�', self.text())

    def test_open_failures_are_explained_in_the_terminal(self):
        self.fail_kinds['term.open'] = TransportError('build.example.com rejected the server ID or passkey.', 'auth')
        self.relay().start()
        self.assertTrue(self.finished.wait(10))
        self.assertIn('Could not open a terminal on Build: build.example.com rejected the server ID or passkey', self.text())

    def test_an_older_global_gets_an_update_hint_not_a_generic_failure(self):
        self.fail_kinds['term.open'] = TransportError('build.example.com: Global operation failed', 'unavailable')
        self.relay().start()
        self.assertTrue(self.finished.wait(10))
        self.assertIn('Update ATS', self.text())
        self.assertNotIn('Global operation failed', self.text())

    def test_disabled_terminal_reason_from_the_global_is_shown(self):
        with patch.dict(os.environ, {'ATS_TERMINAL': 'off'}):
            self.relay().start()
            self.assertTrue(self.finished.wait(10))
        self.assertIn('Disabled on this server', self.text())

    def test_transient_network_errors_are_retried_without_losing_output(self):
        self.fail_kinds['term.read'] = [TransportError('timed out', 'timeout'), TransportError('timed out', 'timeout')]
        relay = self.relay()
        relay.start()
        relay.write('echo survived-$((1+1))\n')
        self.assertTrue(wait_for(lambda: 'survived-2' in self.text()), self.text())
        self.assertNotIn('Lost the terminal', self.text())

    def test_persistent_failure_ends_the_session_with_the_reason(self):
        self.fail_kinds['term.read'] = TransportError('build.example.com refused the connection.', 'refused')
        relay = self.relay()
        relay.start()
        self.assertTrue(self.finished.wait(15))
        self.assertIn('Lost the terminal on Build: build.example.com refused the connection', self.text())

    def test_signing_out_closes_the_remote_session(self):
        relay = self.relay()
        relay.start()
        relay.write('echo up\n')
        self.assertTrue(wait_for(lambda: 'up' in self.text()))
        self.signed_in = False
        self.assertTrue(self.finished.wait(20), self.text())
        self.assertIn('Signed out', self.text())

    def test_closing_the_browser_closes_the_session_on_the_global(self):
        relay = self.relay()
        relay.start()
        self.assertTrue(wait_for(lambda: relay.sid is not None))
        relay.close()
        self.assertTrue(wait_for(lambda: 'term.close' in self.calls))
        self.assertTrue(wait_for(lambda: relay.sid not in global_terminal._sessions))

    def test_undelivered_input_is_reported(self):
        relay = self.relay()
        relay.start()
        self.assertTrue(wait_for(lambda: relay.sid is not None))
        self.fail_kinds['term.input'] = [TransportError('timed out', 'timeout')]
        relay.write('echo lost\n')
        self.assertTrue(wait_for(lambda: 'Input was not delivered' in self.text()), self.text())

    def test_reason_shows_only_messages_written_by_ats(self):
        self.assertEqual(remote_terminal.reason(TransportError('plain reason')), 'plain reason')
        self.assertIn('Update ATS', remote_terminal.reason(KeyError('secret-looking-detail')))
        self.assertNotIn('secret-looking-detail', remote_terminal.reason(KeyError('secret-looking-detail')))


class AttachTests(unittest.TestCase):
    def sockets(self):
        sio = MagicMock()
        sio.start_background_task.side_effect = lambda function, *a: threading.Thread(target=function, args=a, daemon=True).start()
        sio.sleep = lambda seconds: time.sleep(min(seconds, 0.01))
        return sio

    def attach(self, store_server, sessions=None):
        sio, sessions = self.sockets(), sessions if sessions is not None else {}
        fake_store = MagicMock()
        if isinstance(store_server, Exception):
            fake_store.server.side_effect = store_server
        else:
            fake_store.server.return_value = store_server
        with patch.object(cluster_support, 'registry', return_value=fake_store), patch.object(remote_terminal, 'Relay') as relay:
            result = remote_terminal.attach(sio, sessions, 'sid1', 'a' * 32, 'auth', namespace='/terminal', output_event='terminal_output',
                                            exit_event='terminal_exit', authorized=lambda: True)
        return sio, sessions, relay, result

    def said(self, sio):
        wait_for(lambda: any(c.args[0] == 'terminal_exit' for c in sio.emit.call_args_list), 5)
        return ' '.join(str(c.args[1]) for c in sio.emit.call_args_list if c.args[0] == 'terminal_output')

    def test_unknown_disconnected_and_revoked_servers_are_explained(self):
        sio, sessions, relay, _ = self.attach(ValueError('Unknown server'))
        self.assertIn('Unknown server', self.said(sio))
        relay.assert_not_called()
        for state, expected in (({'id': 'a' * 32, 'name': 'Build', 'local': 0, 'connected': 0, 'secret': 'k'}, 'disconnected or revoked'),
                                ({'id': 'a' * 32, 'name': 'Build', 'local': 0, 'connected': 1, 'secret': None}, 'disconnected or revoked'),
                                ({'id': 'a' * 32, 'name': 'Local', 'local': 1, 'connected': 1, 'secret': None}, 'Unknown server')):
            sio, sessions, relay, _ = self.attach(state)
            self.assertIn(expected, self.said(sio))
            self.assertEqual(sessions, {})

    def test_a_connected_global_registers_a_relay_and_starts_it(self):
        server = {'id': 'a' * 32, 'name': 'Build', 'local': 0, 'connected': 1, 'secret': 'k'}
        sio, sessions, relay, result = self.attach(server)
        self.assertIn('sid1', sessions)
        self.assertIs(sessions['sid1']['relay'], relay.return_value)
        relay.return_value.start.assert_called_once()

    def test_the_number_of_remote_terminals_is_bounded(self):
        server = {'id': 'a' * 32, 'name': 'Build', 'local': 0, 'connected': 1, 'secret': 'k'}
        crowded = {f's{i}': {'relay': object()} for i in range(remote_terminal.MAX_RELAYS)}
        sio, sessions, relay, _ = self.attach(server, crowded)
        self.assertIn('Too many remote terminals', self.said(sio))
        relay.assert_not_called()


if __name__ == '__main__':
    unittest.main()
