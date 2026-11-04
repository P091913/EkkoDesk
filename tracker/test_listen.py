import io
import json
import threading
import time
import unittest
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

from listen import MODEL, NO_MIC, NO_TEXT, Listener, transcribe, wav


class Speaches:
    """A stand-in speaches on a free port: records each request and answers {"text": heard}."""

    def __init__(self, heard=' Put a note on my desk. '):
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                outer.requests.append((self.path, self.headers['Content-Type'], body))
                data = json.dumps({'text': heard}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FakeMic:
    """Feeds one chunk as soon as it starts, like a microphone would."""
    samplerate = 44100

    def __init__(self, on_chunk):
        on_chunk(b'\x01\x00' * 4410)
        self.closed = False

    def stop(self):
        pass

    def close(self):
        self.closed = True


def wait_for(replies, n=1):
    deadline = time.monotonic() + 3
    while len(replies) < n and time.monotonic() < deadline:
        time.sleep(0.01)
    return replies


class TestListen(unittest.TestCase):
    def test_wav_holds_the_audio_at_its_rate(self):
        with wave.open(io.BytesIO(wav(b'\x00\x01' * 100, 44100))) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()), (1, 2, 44100, 100))

    def test_transcribe_sends_the_wav_and_model_like_the_glasses(self):
        s = Speaches()
        try:
            self.assertEqual(transcribe(s.url, b'RIFF-audio'), 'Put a note on my desk.')
            path, ctype, body = s.requests[0]
            self.assertEqual(path, '/v1/audio/transcriptions')
            self.assertTrue(ctype.startswith('multipart/form-data; boundary='))
            self.assertIn(f'name="model"\r\n\r\n{MODEL}\r\n'.encode(), body)
            self.assertIn(b'filename="talk.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF-audio\r\n', body)
            transcribe(s.url, b'RIFF-audio', 'another-model')  # --speech-model
            self.assertIn(b'name="model"\r\n\r\nanother-model\r\n', s.requests[1][2])
        finally:
            s.close()

    def test_a_question_is_recorded_between_on_and_off_then_heard(self):
        s = Speaches()
        replies, mics = [], []
        listener = Listener(s.url, replies.append, mic=lambda cb: mics.append(FakeMic(cb)) or mics[-1])
        try:
            listener.on(True)
            listener.on(True)  # already listening: one microphone, not two
            listener.on(False)
            self.assertEqual(wait_for(replies), [{'v': 1, 'type': 'heard', 'text': 'Put a note on my desk.'}])
            self.assertEqual(len(mics), 1)
            self.assertTrue(mics[0].closed)
            with wave.open(io.BytesIO(s.requests[0][2].split(b'audio/wav\r\n\r\n')[1])) as w:
                self.assertEqual((w.getframerate(), w.getnframes()), (44100, 4410))
            listener.on(False)  # not listening: nothing more is sent
            time.sleep(0.05)
            self.assertEqual(len(replies), 1)
        finally:
            s.close()

    def test_it_stops_by_itself_after_max_s(self):
        s = Speaches()
        replies = []
        try:
            Listener(s.url, replies.append, mic=FakeMic, max_s=0.05).on(True)
            self.assertEqual(wait_for(replies)[0]['text'], 'Put a note on my desk.')
        finally:
            s.close()

    def test_failures_come_back_as_sentences(self):
        def no_mic(cb):
            raise OSError('no input device')

        replies = []
        Listener('http://127.0.0.1:9', replies.append, mic=no_mic).on(True)
        self.assertEqual(replies, [{'v': 1, 'type': 'heard', 'error': NO_MIC}])

        replies = []
        down = Listener('http://127.0.0.1:9', replies.append, mic=FakeMic)  # nothing listens on port 9
        down.on(True)
        down.on(False)
        self.assertEqual(wait_for(replies), [{'v': 1, 'type': 'heard', 'error': NO_TEXT}])


if __name__ == '__main__':
    unittest.main()
