# WIN AI: how the numbers are worked out

This describes what the code does today ([lib/projection.js](lib/projection.js), [lib/market.js](lib/market.js), [lib/params.js](lib/params.js)). Every tuned number lives in [model_params.json](model_params.json). `npm run lab` refits them from graded results, so the numbers here can drift from the file; the file is the truth.

The short version: **the sportsbook line is the starting point, and the model is a small nudge on top of it.** On the app's own graded picks the posted line predicted the stat better than the model did, and once the books' price was known the model's chance added almost nothing. The one real edge left in a pick is price shopping: the best price on a side against what all the books together say is the fair chance.

## 1. The projection (what the model says will happen)

1. **Baseline.** The last 10 games (5 if that is all there is), pulled toward the season average by how many recent games back it up (`n / (n + 8)`). Games decided by a blowout are clipped toward the player's median so garbage time cannot distort a role. Head-to-head history against tonight's opponent is blended in, recent meetings counting more.
2. **Minutes first.** Tonight's minutes are projected (role, injuries, recent trend), and everything after is minutes × rate. Points are built as minutes × shot attempts × shooting efficiency; other stats as minutes × a per-minute rate.
3. **Adjustments**, each capped, then a combined cap (about -35% to +54%) so signals cannot compound without limit:
   - **Usage when a teammate is out.** Others take on a share of the missing production. The fitted lift was too big when checked game by game, so it is scaled down (about 0.4 to 0.5 of the fitted size), and part of it lands on minutes so it is not counted twice.
   - **Opponent.** Their defense and pace; for rebounds, assists, threes, steals and blocks also what they allow to that player's position group (guards, forwards, centers), from the FantasyPros table, capped at about 6%.
   - **Game context.** The game total, the spread and back-to-backs, capped at 15%.
4. **Learned bias correction.** The nightly fit scales the number by how much the model has run high or low on graded results (points and assists about 8% lower).
5. **Spread.** The standard deviation comes from the player's own game-to-game variance, never narrower than a fitted floor measured on graded picks (points: 4.5 + 0.13 × projection). Steals, blocks and threes are small counts, so they use a count distribution (variance = φ × mean) rather than a bell curve.

Things that were tried, measured and **left out** because they did not help: home/away splits, a back-to-back fatigue penalty (measured about zero once the player plays), and a rebound-allowed matchup factor (real but under 0.5%, below the bar for adopting).

## 2. From a projection to a pick

- **Fair price from the books.** Each book's margin is removed (power method), then books are combined into a consensus line and fair chance.
- **Displayed projection** is about 15% model and 85% market (points 10%, assists 5%); with fewer than 4 books behind a line the model keeps a little more of the say.
- **Win chance** blends the model's chance with the market's on the log-odds scale, with only 3 to 5% weight on the model. With no market at all, the model's chance is pulled halfway toward 50%, because its raw chances ran far too high.
- **EV** is expected profit per $1 at the best available price, allowing for the chance of a push on whole-number lines. A prop counts as a pick at EV of 3% or more.
- **The call (OVER or UNDER) is the side the model's projection leans**, measured against the books' consensus line, and the price is judged separately. Before 2026-11-17 the call was whichever side had the better price after the books' margin, which put it on the opposite side of the projection on about a third of props. On 1,373 graded props the projection's side hit 52.2% and the better-price side 48.9%; where the two disagreed, the projection won 54.9% of 437. The better price is still tracked (`scan.best`, and shown as "price favors..." when it has a positive EV on the other side), and the value-pick record is scored from it. With the projection exactly on the line there is no lean and the better price decides. Nothing beats break-even at -110 yet, and the projection is least reliable when it is far from the line (about a coin flip beyond 1.5 points), so treat the call as a lean, not a bet.
- **Edge** shown in the app is projection minus line, capped at 10.

## 3. Confidence is not win chance

Confidence (25 to 97) says how reliable the projection is, not how likely the bet is to win. It combines consistency of the stat (30%), minutes reliability (15%), sample depth (15%), how much data was available (20%) and how stable the situation is (20%), spread over its range by a logistic curve. Bands: thin under 55, lean 55 to 74, strong 75 and up.

The headline **Top 3** is the three most confident props of the day (one per player), frozen until tomorrow. Per-game picks rank by EV instead, so the two lists answer different questions and can disagree.

## 4. Leagues

NBA and WNBA share the pipeline. Where they differ: the WNBA has no play-type data, its game logs come from ESPN, its stats from stats.nba.com with `LeagueID=10`, and its shot charts from stats.wnba.com (which covers the 2026 expansion teams). A WNBA season is about half the length of the NBA's 82 games, so each game carries more weight and a missing starter moves usage more than the same absence in the NBA.

## 5. Checking itself

Every scanned prop is stored and graded after the game. The backtest scores win rate, probability calibration and EV by slice; calibration stays off until 60 picks are graded; best bets and the Top 3 are tracked separately from the rest. All of it is on the History tab and the admin page.

> **Edge rule:** a model that says "Over" is not a reason to bet. Only a price better than the books' fair chance is, and even then the sample is small. WIN AI is analytics, not betting advice. Must be 21+. Problem gambling help: 1-800-GAMBLER.
