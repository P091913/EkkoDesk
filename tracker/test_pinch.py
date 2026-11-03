import unittest
from types import SimpleNamespace as P

from pinch import Hand, Pincher, measure

OPEN, PINCHED, BETWEEN = 0.6, 0.1, 0.3


def hand(ratio, x=0.5, y=0.5):
    return Hand(ratio, x, y, 'right')


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
        events = self.p.update([hand(PINCHED, 0.21), hand(OPEN, 0.79)], self.t + 16)
        self.assertEqual([(e['phase'], e['id'], e['x']) for e in events], [('move', 2, 0.21), ('up', 1, 0.79)])

    def test_pinch_outside_the_page_is_ignored(self):
        self.frame(hand(PINCHED, 1.05))
        self.assertEqual(self.frame(hand(PINCHED, 1.05)), [])


class MeasureTest(unittest.TestCase):
    def test_ratio_of_pinch_to_palm(self):
        world = [P(x=0, y=0, z=0) for _ in range(21)]
        world[5] = P(x=0, y=0.1, z=0)  # palm: 0.1
        world[4] = P(x=0.01, y=0.2, z=0)
        world[8] = P(x=0.01, y=0.2, z=0.03)  # tips 0.03 apart
        self.assertAlmostEqual(measure(world), 0.3)


if __name__ == '__main__':
    unittest.main()
