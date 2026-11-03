"""Hands seen each frame -> pointer events (down/move/up/cancel), as in PROTOCOL.md.

Plain numbers in and dicts out: no MediaPipe or camera, so tests can drive it directly.
"""
import math
from dataclasses import dataclass

# Starting values; phase 2 tunes them from recordings.
START = 0.25  # a pinch starts after START_FRAMES frames below this...
END = 0.40  # ...and ends above this. The gap between them is the hysteresis.
START_FRAMES = 2
GRACE_MS = 250  # how long a lost hand keeps its pinch before `cancel`
MATCH = 0.2  # the furthest a hand can move between frames (0-1 units) and still be the same hand


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


def measure(world) -> float:
    """Thumb tip to index tip over palm size (wrist to index knuckle), from 3D world landmarks."""
    def d(a, b):
        return math.dist((world[a].x, world[a].y, world[a].z), (world[b].x, world[b].y, world[b].z))
    return d(4, 8) / max(d(0, 5), 1e-6)


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
            x, y = round(h.x, 3), round(h.y, 3)
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
