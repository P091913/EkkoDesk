"""Ask Ekko (PLAN.md): records the PC's microphone between `listen` on and off from the desk, at most 15 s, and turns it
into text with speaches, the speech server Ekko's glasses and Telegram use. The audio stays in memory."""
import io
import json
import threading
import urllib.request
import uuid
import wave

MAX_S = 15
SPEECH = 'http://127.0.0.1:8000'  # speaches on this PC; the tracker stays on the PC in phase 4
MODEL = 'Systran/faster-distil-whisper-small.en'  # the same as Ekko's glasses and Telegram
NO_MIC = "I can't open the PC's microphone."
NO_TEXT = "I couldn't transcribe that right now."


def wav(pcm: bytes, rate: int) -> bytes:
    """16-bit mono PCM as a WAV file."""
    out = io.BytesIO()
    with wave.open(out, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


def transcribe(speech: str, audio: bytes, model: str = MODEL, timeout: float = 60) -> str:
    """What speaches heard in a WAV ("" for silence); raises if it can't be asked. 60 s: its first request after a restart loads the model."""
    b = uuid.uuid4().hex
    body = (f'--{b}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{model}\r\n'
            f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="talk.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode()
    req = urllib.request.Request(speech.rstrip('/') + '/v1/audio/transcriptions', body + audio + f'\r\n--{b}--\r\n'.encode(),
                                 {'Content-Type': f'multipart/form-data; boundary={b}'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return (json.load(r).get('text') or '').strip()


def microphone(on_chunk):
    """The PC's default microphone, 16-bit mono at its own rate (speaches resamples), already started."""
    import sounddevice as sd  # loaded only when asked, so the tests and a PC without a microphone never need PortAudio
    s = sd.RawInputStream(channels=1, dtype='int16', callback=lambda data, frames, t, status: on_chunk(bytes(data)))
    s.start()
    return s


class Listener:
    """`on(True)` starts recording; `on(False)`, or MAX_S, stops it and hands a `heard` message to `reply`."""

    def __init__(self, speech: str, reply, model: str = MODEL, mic=microphone, max_s: float = MAX_S):
        self.speech, self.reply, self.model, self.mic, self.max_s = speech, reply, model, mic, max_s
        self.lock = threading.Lock()
        self.stream = None
        self.timer = None
        self.chunks: list[bytes] = []

    def on(self, listening: bool):
        self.start() if listening else self.stop()

    def start(self):
        with self.lock:
            if self.stream:
                return
            self.chunks = []
            try:
                self.stream = self.mic(self.chunks.append)
            except Exception as e:  # no microphone, or it's in use
                print(f'microphone: {e!r}')
                self.reply({'v': 1, 'type': 'heard', 'error': NO_MIC})
                return
            self.timer = threading.Timer(self.max_s, self.stop)
            self.timer.daemon = True
            self.timer.start()
        print('listening')

    def stop(self):
        with self.lock:
            if not self.stream:
                return
            stream, self.stream = self.stream, None
            self.timer.cancel()
            stream.stop()
            stream.close()
            pcm, rate = b''.join(self.chunks), int(stream.samplerate)
        # speaches can take a while: off the desk connection's thread, so it keeps receiving.
        threading.Thread(target=self.send, args=(pcm, rate), daemon=True).start()

    def send(self, pcm: bytes, rate: int):
        try:
            msg = {'text': transcribe(self.speech, wav(pcm, rate), self.model) if pcm else ''}
        except Exception as e:  # refused, timed out, or not JSON
            print(f'speaches: {e!r}')
            msg = {'error': NO_TEXT}
        self.reply({'v': 1, 'type': 'heard', **msg})
