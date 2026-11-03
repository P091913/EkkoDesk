"""Frames of hand landmarks -> pointer events (down/move/up/cancel), as in PROTOCOL.md.

Plain numbers in and dicts out: no MediaPipe or camera, so tests and recordings can drive it directly.
A frame is {"t": ms, "hands": [{"label", "img": 21 x [x, y] (0-1 of the camera frame), "world": 21 x [x, y, z] (metres)}]}.
"""
import gzip
import json
import math
from dataclasses import dataclass, field

# Starting values; tune them from recordings.
START = 0.25  # a pinch starts after START_FRAMES frames below this...
END = 0.40  # ...and ends above this. The gap between them is the hysteresis.
START_FRAMES = 2
GRACE_MS = 250  # how long a lost hand keeps its pinch before `cancel`
MATCH = 0.2  # the furthest a hand can move between frames (0-1 units) and still be the same hand
MIN_CUTOFF = 1.0  # One Euro filter, in Hz: lower is steadier when the hand is slow...
BETA = 10.0  # ...and higher has less lag when it's fast (positions are 0-1, so speeds are pages per second)


class OneEuro:
    """The One Euro filter (Casiez et al., 2012): heavy smoothing when slow, little lag when fast."""

    def __init__(self, min_cutoff=MIN_CUTOFF, beta=BETA, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.x = self.dx = self.t = None

    @staticmethod
    def _alpha(dt, cutoff):
        return 1 / (1 + 1 / (2 * math.pi * cutoff * dt))

    def __call__(self, x: float, t: int) -> float:
        if self.t is None:
            self.x, self.dx, self.t = x, 0.0, t
            return x
        dt = max((t - self.t) / 1000, 1e-3)
        self.dx += self._alpha(dt, self.d_cutoff) * ((x - self.x) / dt - self.dx)
        self.x += self._alpha(dt, self.min_cutoff + self.beta * abs(self.dx)) * (x - self.x)
        self.t = t
        return self.x


@dataclass
class Hand:
    """One hand in one frame: its pinch ratio and its pinch point, 0-1 across the page."""
    ratio: float
    x: float
    y: float
    label: str


@dataclass
class _Track:
    x: float
    y: float
    label: str
    seen: int
    below: int = 0  # frames in a row below START
    id: int | None = None  # pinch id while pinched
    fx: OneEuro = field(default_factory=OneEuro)
    fy: OneEuro = field(default_factory=OneEuro)


def measure(world) -> float:
    """Thumb tip to index tip over palm size (wrist to index knuckle), from 3D world landmarks."""
    return math.dist(world[4], world[8]) / max(math.dist(world[0], world[5]), 1e-6)


def mirror(x: float, y: float) -> tuple[float, float]:
    """The mapping until calibration.json exists: the camera frame is the page, mirrored for a webcam facing you."""
    return 1 - x, y


def hands_from(frame: dict, to_page) -> list[Hand]:
    """A live or recorded frame -> hands, each pinch point (midway between thumb and index tips) mapped onto the page."""
    hands = []
    for hd in frame['hands']:
        img = hd['img']
        x, y = to_page((img[4][0] + img[8][0]) / 2, (img[4][1] + img[8][1]) / 2)
        hands.append(Hand(measure(hd['world']), x, y, hd['label']))
    return hands


def read_clip(path) -> list[dict]:
    """A recording made with main.py --record: gzipped, one frame per line."""
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


class Pincher:
    def __init__(self):
        self.tracks: list[_Track] = []
        self.next_id = 1

    def update(self, hands: list[Hand], t: int) -> list[dict]:
        """Feed one frame's hands at time t (ms); returns the events to send."""
        events = []
        matched = self._match(hands)
        for h, tr in zip(hands, matched):
            if tr is None:
                tr = _Track(h.x, h.y, h.label, t)
                self.tracks.append(tr)
            # 3 decimals is about 1 px at 720p; rounding stops invisible jitter from sending moves.
            x, y = round(tr.fx(h.x, t), 3), round(tr.fy(h.y, t), 3)
            moved = (x, y) != (tr.x, tr.y)
            tr.x, tr.y, tr.label, tr.seen = x, y, h.label, t

            if tr.id is None:
                tr.below = tr.below + 1 if h.ratio < START else 0
                if tr.below >= START_FRAMES and 0 <= x <= 1 and 0 <= y <= 1:
                    tr.id, self.next_id = self.next_id, self.next_id + 1
                    events.append(self._event('down', tr, t))
            elif h.ratio > END:
                events.append(self._event('up', tr, t))
                tr.id, tr.below = None, 0
            elif moved:
                events.append(self._event('move', tr, t))

        for tr in [tr for tr in self.tracks if t - tr.seen > GRACE_MS]:
            if tr.id is not None:
                events.append(self._event('cancel', tr, t))
            self.tracks.remove(tr)
        return events

    def end(self, t: int) -> list[dict]:
        """No more frames: cancel every pinch still held."""
        return self.update([], t + GRACE_MS + 1)

    def _match(self, hands: list[Hand]) -> list[_Track | None]:
        """MediaPipe gives hands no ids, so pair each hand with the nearest track from earlier frames, closest pairs first."""
        pairs = sorted(
            (math.dist((tr.x, tr.y), (h.x, h.y)), i, j)
            for i, tr in enumerate(self.tracks)
            for j, h in enumerate(hands)
        )
        out: list[_Track | None] = [None] * len(hands)
        used = set()
        for d, i, j in pairs:
            if d <= MATCH and i not in used and out[j] is None:
                out[j] = self.tracks[i]
                used.add(i)
        return out

    @staticmethod
    def _event(phase: str, tr: _Track, t: int) -> dict:
        return {'v': 1, 'type': 'pointer', 'phase': phase, 'id': tr.id, 'hand': tr.label, 'x': tr.x, 'y': tr.y, 't': t}
