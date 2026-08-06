# WIN AI — Player Prop Modeling Methodology

WIN AI's core analytical framework is league-agnostic: the same pipeline, features, and simulation approach apply whether the target is an NBA or WNBA player. This document lays out the shared framework once, then calls out where NBA and WNBA data sourcing and adjustments diverge.

---

## 1. Shared Framework

### 1.1 Data Pipeline & Real-Time Stats

To feed the analyzer up-to-date data without breaking the bank, you need a dynamic pipeline that automatically refreshes game logs and rosters daily.

* **Roster & Injury Tracking:** This is where most models fail. Your data pipeline must continuously check injury reports. A missing starter doesn't just mean more shots for the backup; it completely reshapes the team's entire usage tree.
* **Refresh cadence:** Stats and lineups should be re-pulled at least once daily (WIN AI runs [fetch_stats.py](fetch_stats.py) via cron each morning), with lineup/injury checks closer to tip-off since those change same-day.

### 1.2 Quantitative Model Features

When predicting Over/Under lines (Points, Rebounds, Assists, or Threes), the model should weigh these components, ranked from highest to lowest mathematical importance:

**Layer A — Predictive Volume Metrics (The Foundation)**
Instead of looking at points per game, look at the opportunity metrics that *create* points.
* **Usage Percentage (USG%):** The percentage of team plays a player finishes while on the floor. If a star player's line is 18.5 points but her/his USG% has spiked over the last three games due to a tactical shift, the *Over* becomes high-value.
* **Minutes Floor:** Look at a rolling 5-game average of minutes played, cross-referenced with foul trouble. If a player averages 30 minutes but recently got benched early due to 4 quick fouls, the standard box score will look artificially low.

**Layer B — Pace & Matchup Factors**
* **Possessions Per Game (Pace):** A player on a fast-paced team will naturally get more opportunities than a player on a slow-paced, half-court team. If a fast team plays a slow team, adjust the player's projection down.
* **Defensive Rating by Position:** Don't just look at a team's overall defense. If a team gives up a high percentage of points to a specific position (due to poor size or scheme), target that opposing position's *Over*.

**Layer C — Splits and Environmental Context**
* **Home/Away Splits:** Role players historically perform significantly better at home, while elite stars remain relatively consistent anywhere.
* **Rest Gradients:** Look for back-to-backs or a team playing its 3rd game in 5 nights. Fatigue drastically decreases shooting percentages and defensive hustle (inflating opponents' props).

### 1.3 The Analytical Structure

A standard workflow follows a sequential path to a clear probability percentage for Over vs. Under.

1. **Calculate the Base Projection (Baseline Evaluation):** Take the player's weighted rolling average (e.g., 50% last 5 games, 30% last 10 games, 20% season average) for the target stat to find their true baseline.
2. **Apply Team and Pace Adjustments (Matchup Normalization):** Multiply the baseline projection against the opponent's defensive efficiency rating and the projected pace factor of the game to scale expected stats up or down.
3. **Inject Roster Lineup Modifiers (Contextual Adjustments):** Scan for inactive teammates. If a primary ball-handler is out, mathematically reallocate a percentage of their missing Usage (USG%) and Assist Rate to the remaining healthy players.
4. **Run a Monte Carlo Simulation (Probability Distribution):** Simulate the game 10,000 times using a Poisson or Normal distribution based on the player's variance profile. This determines the *exact probability* of the player hitting over or under a given sportsbook line.

### 1.4 Advanced "Edge" Metrics

* **Gravity Ratings:** How tightly defenders stick to a player. High gravity opens up driving lanes for secondary players, driving up *their* point or assist props.
* **Coaching Tendencies:** Some coaches strictly bench a player after early foul trouble, regardless of who it is. A "Foul-Bench Risk Factor" based on coaching history saves you from devastating *Unders*.

> **Edge Detection Rule:** Never place a wager just because your model predicts an "Over." Only bet if your model's simulated probability provides **value** against the implied odds of the sportsbook line (e.g., your model says 65% chance of an Over, but the sportsbook odds imply only 52%).

---

## 2. NBA-Specific Considerations

WIN AI's current pipeline ([server.js](server.js), [predict_tonight.py](predict_tonight.py), [fetch_stats.py](fetch_stats.py)) is built around NBA data sources:

* **Data sources:** `nba_api` (primary, direct from nba.com), ESPN's `basketball/nba` site API, BallDontLie, and RapidAPI/Tank01 for lineups; The Odds API's `basketball_nba` sport key for live prop lines.
* **82-game season / load management:** Star players are more frequently rested on the second night of back-to-backs or in nationally-uneventful games late in the season. Check injury/rest reports closer to tip-off than for WNBA games, where rest patterns are less common.
* **Deeper benches, more pace variance:** 15-man active rosters and a wider range of team paces (sub-95 possessions to 105+) mean the Pace & Matchup adjustment (Layer B) carries more weight game-to-game.
* **Longer rolling windows are more stable:** With an 82-game season, a 10-game rolling average is a smaller share of the season than in the WNBA's 40-game season, so weighting toward the most recent 5 games matters relatively less unless there's a clear role change (trade, injury to a teammate, new starting lineup).

## 3. WNBA-Specific Considerations

* **Data sources:** Public scrapers (Apify's WNBA Stats Scraper, or a custom Python `BeautifulSoup`/`Playwright` script against `WNBA.com/stats` or `Basketball-Reference.com`) for free/low-cost access; SportsDataIO or Sportradar for live, pre-formatted JSON feeds with real-time lineup changes and sportsbook odds if a paid tier is worth it.
* **Shorter, denser season:** A 40-game regular season means each game log carries more statistical weight — small usage or role shifts show up faster in the rolling averages than they would in the NBA.
* **Stricter rotations:** WNBA rotations tend to be tighter than the NBA's. Certain coaches will bench a player after her 2nd foul in the first half regardless of matchup or score, making the Foul-Bench Risk Factor (Section 1.4) especially predictive.
* **Pace extremes:** Fast-paced teams (e.g., Dallas, Las Vegas) versus slow, half-court teams create larger relative pace mismatches than typically seen across the NBA, so the Pace & Matchup adjustment (Layer B) should be weighted heavily.
* **Thinner benches:** With smaller rosters, a single missing starter reallocates a larger share of USG% and Assist Rate to the remaining players than an equivalent NBA absence would — the Roster Lineup Modifier step (Section 1.3, Step 3) should use a higher reallocation coefficient for the WNBA.
