import gzip
import json
import tempfile
import unittest
from pathlib import Path

from pinch import Hand, OneEuro, Pincher, hands_from, measure, mirror, read_clip

OPEN, PINCHED, BETWEEN = 0.6, 0.1, 0.3
RECORDINGS = Path(__file__).with_name('recordings')
# Each clip and how many pinches it holds; see the README for how to record them.
CLIPS = {'still': 1, 'slow-drags': 3, 'fast-drags': 3, 'open-hand': 0, 'two-hands': 2}


def hand(ratio, x=0.5, y=0.5):
    return Hand(ratio, x, y, 'right')


def frame(t, ratio, x=0.5, y=0.5):
    """A synthetic frame: every image landmark at (x, y), and thumb and index tips `ratio` palms apart."""
    world = [[0, 0, 0]] * 21
    world[5] = [0, 0.1, 0]
    world[4], world[8] = [0, 0.05, 0], [ratio * 0.1, 0.05, 0]
    return {'t': t, 'hands': [{'label': 'right', 'img': [[x, y]] * 21, 'world': world}]}


def replay(frames, to_page=mirror):
    p, events = Pincher(), []
    for f in frames:
        events += p.update(hands_from(f, to_page), f['t'])
    return events + (p.end(frames[-1]['t']) if frames else [])


class PincherTest(unittest.TestCase):
    def setUp(self):
        self.p = Pincher()
        self.t = 0

    def frame(self, *hands, dt=16):
        self.t += dt
        return [(e['phase'], e['id']) for e in self.p.update(list(hands), self.t)]

    def test_starts_after_two_frames(self):
        self.assertEqual(self.frame(hand(PINCHED)), [])
        self.assertEqual(self.frame(hand(PINCHED)), [('down', 1)])

    def test_one_frame_dip_is_ignored(self):
        self.frame(hand(PINCHED))
        self.frame(hand(OPEN))
        self.assertEqual(self.frame(hand(PINCHED)), [])

    def test_hysteresis_holds_then_up(self):
        self.frame(hand(PINCHED))
        self.frame(hand(PINCHED))
        self.assertEqual(self.frame(hand(BETWEEN)), [])
        self.assertEqual(self.frame(hand(OPEN)), [('up', 1)])

    def test_move_only_when_moved(self):
        self.frame(hand(PINCHED))
        self.frame(hand(PINCHED))
        self.assertEqual(self.frame(hand(PINCHED, 0.5001)), [])  # rounds to the same point
        self.assertEqual(self.frame(hand(PINCHED, 0.52)), [('move', 1)])

    def test_lost_hand_cancels_after_grace(self):
        self.frame(hand(PINCHED))
        self.frame(hand(PINCHED))
        self.assertEqual(self.frame(dt=200), [])
        self.assertEqual(self.frame(dt=100), [('cancel', 1)])
        self.assertEqual(self.p.tracks, [])

    def test_hand_back_within_grace_keeps_its_pinch(self):
        self.frame(hand(PINCHED))
        self.frame(hand(PINCHED))
        self.frame(dt=200)
        self.assertEqual(self.frame(hand(PINCHED, 0.55)), [('move', 1)])

    def test_two_hands_get_two_ids(self):
        a, b = hand(PINCHED, 0.2), hand(PINCHED, 0.8)
        self.frame(a, b)
        self.assertEqual(self.frame(b, a), [('down', 1), ('down', 2)])
        # Listed in the other order next frame, each hand still keeps its own id.
        self.assertEqual(self.frame(hand(PINCHED, 0.21), hand(OPEN, 0.79)), [('move', 2), ('up', 1)])

    def test_pinch_outside_the_page_is_ignored(self):
        self.frame(hand(PINCHED, 1.05))
        self.assertEqual(self.frame(hand(PINCHED, 1.05)), [])

    def test_end_cancels_held_pinches(self):
        self.frame(hand(PINCHED))
        self.frame(hand(PINCHED))
        self.assertEqual([e['phase'] for e in self.p.end(self.t)], ['cancel'])


class OneEuroTest(unittest.TestCase):
    def test_damps_jitter_when_still(self):
        f = OneEuro()
        out = [f(0.5 + (0.004 if i % 2 else -0.004), i * 33) for i in range(60)]
        self.assertLess(max(out[30:]) - min(out[30:]), 0.002)

    def test_keeps_up_with_a_fast_move(self):
        f = OneEuro()
        for i in range(30):  # 1 page per second for 1 s
            x = f(i / 30, i * 33)
        self.assertLess(abs(x - 29 / 30), 0.05)


class ClipTest(unittest.TestCase):
    def test_measure(self):
        world = [[0, 0, 0]] * 21
        world[5] = [0, 0.1, 0]  # palm: 0.1
        world[4], world[8] = [0.01, 0.2, 0], [0.01, 0.2, 0.03]  # tips 0.03 apart
        self.assertAlmostEqual(measure(world), 0.3)

    def test_a_clip_round_trips(self):
        frames = [frame(i * 33, PINCHED if 5 <= i < 20 else OPEN, x=0.3) for i in range(30)]
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'clip.jsonl.gz'
            with gzip.open(path, 'wt', encoding='utf-8') as f:
                f.writelines(json.dumps(fr) + '\n' for fr in frames)
            events = replay(read_clip(path))
        self.assertEqual([e['phase'] for e in events], ['down', 'up'])
        self.assertEqual(events[0]['x'], 0.7)  # mirrored


class RecordingTest(unittest.TestCase):
    """Replays your recordings; each one must give exactly its pinches, each one ended."""

    def test_clips(self):
        for name, pinches in CLIPS.items():
            with self.subTest(name):
                path = RECORDINGS / f'{name}.jsonl.gz'
                if not path.exists():
                    self.skipTest(f'{path.name} not recorded yet')
                events = replay(read_clip(path))
                phases = [e['phase'] for e in events]
                self.assertEqual(phases.count('down'), pinches)
                self.assertEqual(phases.count('up') + phases.count('cancel'), pinches)

    def test_still_pinch_is_steady(self):
        path = RECORDINGS / 'still.jsonl.gz'
        if not path.exists():
            self.skipTest('still.jsonl.gz not recorded yet')
        events = replay(read_clip(path))
        down = next(e for e in events if e['phase'] == 'down')
        end = next(e for e in events if e['phase'] in ('up', 'cancel'))
        # The middle of the hold, away from the hand settling in and letting go.
        held = [e for e in events if down['t'] + 500 <= e['t'] <= end['t'] - 500] or [down]
        for axis, px in (('x', 1280), ('y', 720)):
            spread = (max(e[axis] for e in held) - min(e[axis] for e in held)) * px
            self.assertLessEqual(spread, 5, f'{axis} wanders {spread:.1f} px while held still')


if __name__ == '__main__':
    unittest.main()
