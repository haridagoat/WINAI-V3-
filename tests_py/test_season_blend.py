import json, os, sys, tempfile, unittest, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import season_blend as sb


class Weights(unittest.TestCase):
    def test_curve(self):
        self.assertEqual(sb.prior_weight(0), 1.0)
        self.assertAlmostEqual(sb.prior_weight(1), 0.45)
        self.assertAlmostEqual(sb.prior_weight(5), 0.25)
        self.assertAlmostEqual(sb.prior_weight(10), 0.15)
        self.assertAlmostEqual(sb.prior_weight(20), 0.15)
        self.assertAlmostEqual(sb.prior_weight(40), 0.10)
        self.assertAlmostEqual(sb.prior_weight(60), 0.05)
        self.assertAlmostEqual(sb.prior_weight(82), 0.05)

    def test_never_increases_with_more_games_and_new_season_always_dominates_after_a_few_games(self):
        w = [sb.prior_weight(g) for g in range(0, 83)]
        self.assertTrue(all(a >= b - 1e-12 for a, b in zip(w, w[1:])))
        self.assertTrue(all(x <= 0.5 for x in w[3:]))        # from game 3 on, this season is at least half


class Blend(unittest.TestCase):
    def player(self, **o):
        r = {'PLAYER_ID': 1, 'TEAM_ID': 10, 'PLAYER_NAME': 'A', 'AGE': 25, 'GP': 70, 'W': 35, 'L': 35, 'MIN': 2100.0, 'PTS': 1400, 'REB': 420, 'FG_PCT': 0.45, 'PTS_RANK': 20}
        r.update(o); return r

    def test_identical_seasons_change_nothing(self):
        a = self.player()
        out = sb.blend_rows('player_stats', [dict(a)], [dict(a)])
        self.assertEqual(out, [a])

    def test_totals_are_blended_per_game_and_scaled_to_this_seasons_games(self):
        new = self.player(GP=5, PTS=100, MIN=170.0, W=3, L=2)                 # 20 ppg, 34 mpg
        old = self.player(GP=70, PTS=700, MIN=2100.0, W=35, L=35)             # 10 ppg, 30 mpg
        out = sb.blend_rows('player_stats', [new], [old])[0]
        w0 = sb.prior_weight(5)
        self.assertAlmostEqual(out['PTS'], 5 * ((1 - w0) * 20 + w0 * 10), places=2)
        self.assertAlmostEqual(out['MIN'], 5 * ((1 - w0) * 34 + w0 * 30), places=2)
        self.assertEqual(out['GP'], 5)                                          # games played stays honest
        self.assertAlmostEqual(out['PTS'] / out['GP'], 17.5, places=2)          # total / GP is still a per-game number

    def test_rates_are_blended_directly(self):
        new = self.player(GP=30, FG_PCT=0.50); old = self.player(GP=70, FG_PCT=0.40)
        out = sb.blend_rows('player_stats', [new], [old])[0]
        self.assertAlmostEqual(out['FG_PCT'], 0.5 * (1 - sb.prior_weight(30)) + 0.4 * sb.prior_weight(30), places=5)

    def test_minutes_is_a_total_in_some_files_and_an_average_in_others(self):
        new = self.player(GP=10, MIN=340.0); old = self.player(GP=70, MIN=2100.0)
        self.assertAlmostEqual(sb.blend_rows('player_stats', [new], [old])[0]['MIN'], 10 * (0.85 * 34 + 0.15 * 30), places=2)
        newa = self.player(GP=10, MIN=34.0); olda = self.player(GP=70, MIN=30.0)
        self.assertAlmostEqual(sb.blend_rows('player_advanced', [newa], [olda])[0]['MIN'], 0.85 * 34 + 0.15 * 30, places=4)

    def test_identity_ranks_and_team_come_from_this_season(self):
        new = self.player(GP=8, TEAM_ID=99, AGE=26, PTS_RANK=3); old = self.player(GP=70, TEAM_ID=10, AGE=25, PTS_RANK=50)
        out = sb.blend_rows('player_stats', [new], [old])[0]
        self.assertEqual((out['TEAM_ID'], out['AGE'], out['PTS_RANK'], out['PLAYER_NAME']), (99, 26, 3, 'A'))

    def test_early_season_leans_on_last_season_more(self):
        old = self.player(GP=70, PTS=1400)                                       # 20 ppg
        one = sb.blend_rows('player_stats', [self.player(GP=1, PTS=40)], [old])[0]      # 40 in one game
        ten = sb.blend_rows('player_stats', [self.player(GP=10, PTS=400)], [old])[0]    # 40 ppg over ten
        self.assertAlmostEqual(one['PTS'], 40 * 0.55 + 20 * 0.45, places=2)
        self.assertAlmostEqual(ten['PTS'] / 10, 40 * 0.85 + 20 * 0.15, places=2)
        self.assertGreater(ten['PTS'] / 10, one['PTS'])                          # more evidence, more weight on this season

    def test_rookies_keep_their_row_and_players_not_yet_seen_keep_last_seasons(self):
        rookie = self.player(PLAYER_ID=2, GP=4, PTS=40)
        absent = self.player(PLAYER_ID=3, GP=60, PTS=900)
        out = sb.blend_rows('player_stats', [rookie, self.player(GP=4, PTS=80)], [self.player(), absent])
        by = {r['PLAYER_ID']: r for r in out}
        self.assertEqual(by[2], rookie)
        self.assertTrue(by[3]['PRIOR_SEASON_ONLY']); self.assertEqual(by[3]['PTS'], 900)
        self.assertNotIn('PRIOR_SEASON_ONLY', by[1])

    def test_a_team_missing_from_this_season_is_not_resurrected(self):
        out = sb.blend_rows('team_traditional', [{'TEAM_ID': 1, 'GP': 8, 'PTS': 900}], [{'TEAM_ID': 1, 'GP': 82, 'PTS': 9500}, {'TEAM_ID': 2, 'GP': 82, 'PTS': 9000}])
        self.assertEqual([r['TEAM_ID'] for r in out], [1])

    def test_rows_without_gp_use_the_teams_games_so_far(self):
        new = [{'PLAYER_ID': 1, 'SPEED': 4.6}]; old = [{'PLAYER_ID': 1, 'SPEED': 4.2}]
        out = sb.blend_rows('tracking_speeddistance_player', new, old, team_games=6)
        self.assertAlmostEqual(out[0]['SPEED'], 4.6 * (1 - sb.prior_weight(6)) + 4.2 * sb.prior_weight(6), places=4)

    def test_a_player_with_no_games_yet_keeps_last_seasons_numbers_on_the_new_team(self):
        out = sb.blend_rows('player_stats', [self.player(GP=0, TEAM_ID=77, PTS=0)], [self.player(PTS=1400)])[0]
        self.assertEqual((out['PTS'], out['TEAM_ID'], out['GP']), (1400, 77, 70))

    def test_missing_or_non_numeric_values_are_left_alone(self):
        new = self.player(GP=10, FG_PCT=None, PTS=300); old = self.player(GP=70, FG_PCT=0.4, PTS=1400)
        out = sb.blend_rows('player_stats', [new], [old])[0]
        self.assertIsNone(out['FG_PCT'])

    def test_empty_inputs(self):
        self.assertEqual(sb.blend_rows('player_stats', [], [self.player()]), [self.player()])
        self.assertEqual(sb.blend_rows('player_stats', [self.player()], []), [self.player()])
        self.assertEqual(sb.blend_rows('x', [{'a': 1}], [{'a': 2}]), [{'a': 1}])         # no key column: leave it


class Folder(unittest.TestCase):
    def test_blend_dir_end_to_end(self):
        with tempfile.TemporaryDirectory() as d:
            raw, prior, out = (os.path.join(d, n) for n in ('raw', 'prior', 'out'))
            for p in (raw, prior, out): os.makedirs(p)
            json.dump([{'TEAM_ID': 1, 'GP': 6, 'PTS': 700, 'W': 4, 'L': 2}], open(os.path.join(raw, 'team_traditional.json'), 'w'))
            json.dump([{'TEAM_ID': 1, 'GP': 82, 'PTS': 8200, 'W': 41, 'L': 41}], open(os.path.join(prior, 'team_traditional.json'), 'w'))
            json.dump([{'TEAM_ID': 1, 'GP': 6, 'X': 5.0}], open(os.path.join(raw, 'only_new.json'), 'w'))
            wrote = sb.blend_dir(raw, prior, out, log=lambda *_: None)
            self.assertEqual(sorted(wrote), ['only_new.json', 'team_traditional.json'])
            t = sb._load(os.path.join(out, 'team_traditional.json'))[0]
            w0 = sb.prior_weight(6)
            self.assertAlmostEqual(t['PTS'], 6 * ((1 - w0) * 700 / 6 + w0 * 100), places=2)
            self.assertEqual(sb._load(os.path.join(out, 'only_new.json')), [{'TEAM_ID': 1, 'GP': 6, 'X': 5.0}])


class Season(unittest.TestCase):
    def test_current_season_name(self):
        D = datetime.date
        self.assertEqual(sb.current_nba_season(D(2026, 10, 26)), '2026-27')
        self.assertEqual(sb.current_nba_season(D(2026, 12, 31)), '2026-27')
        self.assertEqual(sb.current_nba_season(D(2027, 3, 1)), '2026-27')
        self.assertEqual(sb.current_nba_season(D(2027, 9, 30)), '2026-27')       # the off season still points at the season just finished
        self.assertEqual(sb.current_nba_season(D(2027, 10, 1)), '2027-28')


if __name__ == '__main__':
    unittest.main()


class Bridge(unittest.TestCase):
    """The helpers in predict_tonight.py (importing it needs nba_api, which the bridge needs anyway)."""
    @classmethod
    def setUpClass(cls):
        import predict_tonight
        cls.pt = predict_tonight

    def test_previous_season_name(self):
        self.assertEqual(self.pt.prev_season('2026-27'), '2025-26')
        self.assertEqual(self.pt.prev_season('2000-01'), '1999-00')

    def test_season_average_leans_on_this_season_with_last_season_as_a_slight_prior(self):
        cur = {'pts': 40.0, 'min': 36.0, 'fg_pct': 50.0}
        prior = {'pts': 20.0, 'min': 30.0, 'fg_pct': 40.0}
        out = self.pt.blend_avgs(cur, prior, 0.25)
        self.assertEqual(out['pts'], 35.0)
        self.assertEqual(out['min'], 34.5)
        self.assertEqual(self.pt.blend_avgs(cur, {}, 0.25), cur)                 # no prior: this season as it is
        self.assertEqual(self.pt.blend_avgs({}, prior, 1.0), prior)              # nothing yet this season: last season
        self.assertEqual(self.pt.blend_avgs(cur, prior, 0.0), cur)

    def test_values_missing_from_one_side_are_kept(self):
        out = self.pt.blend_avgs({'pts': 10.0, 'x': 1.0}, {'pts': 20.0}, 0.5)
        self.assertEqual((out['pts'], out['x']), (15.0, 1.0))
