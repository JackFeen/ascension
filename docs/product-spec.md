# Daily Ascent — Product Spec v0.1 (original draft)

> The founding product spec, kept verbatim for vision and intent. Where the built game differs, the **Decision log** in `CLAUDE.md` wins and explains why.

Working title. Version 0.1 · Draft for vibe-coding

## 1. Overview

Daily Ascent is a free, browser-based daily word game. Every day, all players get the same seven open-ended categories (for example, Things in a pencil case or Countries that border the Mediterranean). In a short time limit per category, players type as many valid answers as they can. Obvious answers earn a little altitude; rare but valid answers earn a lot. The player's total altitude places them on an illustrated Mount Everest, with milestones from a Sherpa tea house up to the summit.
Pitch in one line: Wordle's daily ritual and Scattergories' rare-answer tension, played as a climb up Everest.

**Assumptions in this draft**

- The mountain is the real Everest (South Col route) using a short, memorable set of milestones (see Section 4). A fictional peak is a drop-in swap (see Open Questions).
- It is a daily shared puzzle: same seven categories for everyone, one scored attempt per day.
- Rarity scoring is deterministic and seed-based at launch, with crowd data blended in later (see Section 5).
- The name "Krillion" and its ocean branding belong to another game. This product should have its own name, art, and category content.

**Goals**

- A satisfying 90-second daily session that feels different every day.
- A clear sense of progress: "I got to Base Camp today."
- Rewarding creativity and depth of knowledge over typing speed alone.
- Beautiful, shareable results.

**Non-goals (v1)**

- Real-time multiplayer or head-to-head modes.
- User-generated categories.
- Native mobile apps (a responsive web app only).

## 2. Core Gameplay Loop

1. Player opens the app and sees today's mountain, their streak, and a Begin Climb button.
2. A round consists of seven legs, one category per leg.
3. In each leg the player sees the category and a countdown. They type an answer and press Enter. Valid answers instantly raise the climber on the mountain. They keep typing until time runs out.
4. Between legs there is a brief transition (about 2.5 seconds) showing altitude gained and the next landmark.
5. After leg seven, the results screen shows final altitude, the milestone reached, the best finds of the day, and a share button.
The central tension: every second can be spent banking quick common answers (safe, small gains) or digging for rare answers (slower, big gains). The multiple-answer format means players do both within a single leg.

## 3. Round Structure and Timing

**Legs and timers**

The timer shortens as the climber gains altitude, as a nod to thin air. It is shorter than the 20 seconds of the game that inspired this one, to compensate for players being able to enter many answers - but later legs get more points as well. (1x,1x, 1.2x...)
- Leg 1: 20 seconds
- Leg 2: 20 seconds
- Leg 3: 15 seconds
- Leg 4: 15 seconds
- Leg 5: 15 seconds
- Leg 6: 10 seconds
- Leg 7: 10 seconds
All values are tunable constants. Start at these and playtest.

**Timer rules**

- The timer starts when the category appears and the input is focused. A 3-2-1 countdown precedes leg 1 only.
- Duplicate answers (already accepted this leg) are ignored with no penalty and a subtle "already found" nudge.
- A hard cap of 30 accepted answers per leg prevents pathological scripting and keeps the UI manageable.
- The timer is server-authoritative (see Section 11). The client displays it, but the server decides the leg is over.

## 4. The Mountain: Altitude and Milestones

Altitude is continuous across the whole round. The seven legs are narrative sections of the climb, not separate altitude scales.

**Starting point and goal**

- Start: Lukla, 2,860 m
- Goal: Everest summit, 8,849 m
- Total to climb: 5,989 m, roughly 855 m per leg on average for a summit

**Milestones**

Each milestone is an illustrated landmark on the mountain and appears on the results screen and share card.
- Lukla, 2,860 m (start)
- The Tea House (Namche Bazaar), 3,440 m
- Everest Base Camp, 5,364 m
- Camp 1, 6,065 m
- Camp 2, 6,400 m
- The Death Zone, 8,000 m
- Summit, 8,849 m

**Target outcome distribution (calibration goal)**

The scoring in Section 5 should be tuned in playtesting so that outcomes land roughly like this across all players:
- Lukla to the Tea House (under 5,364 m): about 20%
- Base Camp: about 20%
- Camp 1 and Camp 2: about 20%
- The Death Zone: 15%
- Summit: 5%
The summit should be genuinely rare. That scarcity is what makes it worth posting.

## 5. The Answer System

This is the heart of the product and the hardest part to build well.

### 5.1 Input rules

- A single text field. Enter submits. Multi-word answers ("Burkina Faso") are supported because Enter, not space, is the delimiter.
- No autocomplete or suggestions, since they would reveal answers.
- The field clears instantly after submit and stays focused. On mobile the keyboard never dismisses during a leg.
- Pasting is disabled during a leg.
- A minimum of 150 ms between submissions is enforced server-side.

### 5.2 Normalization

Before matching, every input is normalized:
1. Lowercase and trim whitespace.
2. Strip diacritics ("café" becomes "cafe") and punctuation.
3. Collapse repeated spaces.
4. Remove leading articles ("the", "a", "an").
5. Apply simple singular/plural folding ("horses" matches "horse").

### 5.3 Matching pipeline

Each submission passes through these stages in order, stopping at the first success:
1. Exact match against the category's canonical answer table.
2. Alias match. Each canonical answer has aliases ("USA", "United States", "America" all resolve to one entry).
3. Fuzzy match. Accept an edit distance of 1 for answers of 5 to 8 characters and 2 for longer ones, but only if exactly one candidate qualifies. Ambiguous fuzzy matches go to stage 4.
4. LLM judge. For anything still unresolved, an asynchronous call to a fast LLM returns a structured verdict (see 5.5).
5. Reject. The answer is invalid.
Stages 1 to 3 resolve in milliseconds. The LLM judge can take one to two seconds, so the UI shows the answer as a pending chip ("checking…") and resolves it when the verdict returns. Because of this latency, only ambiguous or novel answers reach the judge.

### 5.4 Seed data

Each category ships with a seed answer list generated before the category goes live:
- An LLM generates 150 to 400 valid answers per category, each tagged with an estimated commonness score from 0 (nobody would say this) to 1 (everyone would).
- A human reviewer skims the list for invalid entries and badly mis-rated commonness.
- Aliases are generated alongside answers.
Categories are rejected at the curation stage if they have fewer than about 150 plausible valid answers or if validity is too subjective.

### 5.5 The LLM judge

For an answer not in the seed list, the judge receives the category, the normalized answer, and a short instruction. It returns JSON:
- valid: true or false
- canonical: the standardized form of the answer
- commonness: estimated 0 to 1
- confidence: 0 to 1
Handling:
- High confidence valid: accept and score at the estimated tier.
- Low confidence: accept at no higher than Uncommon tier, so a shaky judgment cannot hand out Legendary points.
- High confidence invalid: reject.
- Every verdict is cached by category plus canonical form, so each novel answer is judged at most once. Accepted novel answers are queued for human review and added to the seed list if approved.
- A "report this answer" button on the results screen feeds a review queue. Corrections apply to future scoring, not to past leaderboards.

### 5.6 Rarity tiers

Commonness maps to six tiers. Tier names and colors are themed to the mountain:
- Common (commonness 0.60 or higher): Trail dust, grey
- Familiar (0.30 to 0.60): Cairn, tan
- Uncommon (0.10 to 0.30): Pine, green
- Rare (0.03 to 0.10): Glacier, blue
- Epic (0.01 to 0.03): Aurora, purple
- Legendary (under 0.01 but valid): Summit gold
Tiers are always shown as both color and a distinct icon shape plus a text label, so color alone never carries meaning.

### 5.7 Crowd data (phased in)

- v1: rarity is fully seed-based and deterministic. Every player is scored against the same table, which keeps the early game fair (the first player of the day is not disadvantaged against the last).
- After each day: the actual answer frequencies are logged. They are used to correct the seed commonness values for future reuse of the category and to validate the seed's accuracy.
- v2: blend crowd share into commonness as player counts grow, using a weight that moves from seed to crowd. Scores for the day would finalize after the day closes.

## 6. Scoring Formulas

### 6.1 Altitude gain per answer

Base gain by tier:
- Crawler: +15 m
- Hiker: +90 m
- Mountaineer: +180 m
- Sherpa: +600 m

### 6.2 Chain bonus

Each consecutive valid answer within a leg adds +5% to the gain, up to +25%. An invalid answer resets the chain. This rewards steady, confident play without making slow, careful play worthless.

### 6.3 Leg cap

To stop one category from carrying the whole run:
- Raw gains up to 900 m in a single leg count in full.
- Gains beyond 900 m count at 50%.
- Effective gain per leg is capped at 1,200 m.

### 6.4 Final altitude

Final altitude is the starting altitude (2,860 m) plus the sum of effective gains across all seven legs, capped at 8,849 m.
6.5 Calibration examples (to validate in playtesting)
- Casual player: 3 to 4 common/familiar answers per leg, about 130 m per leg, finishing around 3,770 m (just past the Tea House).
- Solid player: 8 answers per leg with an uncommon or two, about 250 m per leg, finishing around 4,600 m (between the Tea House and Base Camp).
- Strong player: a handful of rare answers per leg, about 450 m per leg, finishing around 6,000 m (just below Camp 1).
- Summit: requires averaging about 855 m per leg, which means multiple Epic or Legendary finds in most categories.
All base values, caps, and chain bonuses live in one config file so they can be tuned without code changes.

## 7. Categories

### 7.1 Design criteria

A good category:
- Is open-ended, with at least 150 valid answers.
- Has a wide spread from obvious to obscure answers, so every tier is reachable.
- Has unambiguous validity. Players should be able to tell why an answer is right or wrong.
- Is understandable at a glance in about two seconds.

### 7.2 Daily mix

Each day's seven categories should include:
- Two broad, forgiving categories (legs 1 and 2), such as Things in a kitchen.
- Three mid-difficulty categories mixing knowledge types: geography, pop culture, science, everyday objects.
- One harder knowledge category.
- One "wildcard": a playful or lateral category, such as Things that can be cracked.
Difficulty should rise gently across the legs but never become a wall. The first leg must be a confidence-builder.

### 7.3 Content pipeline

1. LLM proposes candidate categories in bulk.
2. Automated filters check for too few valid answers or overly narrow categories.
3. Human reviewer approves and schedules categories on a calendar.
4. A 60-day buffer of approved categories is maintained.

## 8. Features

### 8.1 Daily play

- One scored attempt per day per account or device.
- The day resets at midnight in the player's local time zone for the start of the new puzzle, with the global puzzle number staying the same for all players that calendar date. (Open Question: single global reset time vs. local.)
- If a player leaves mid-round, the round is forfeited and scored on what they submitted so far. Closing the tab does not pause the timer.

### 8.2 Results screen

- Final altitude and milestone reached, shown as the climber at their landmark on the mountain.
- Altitude gained per leg.
- Best finds: the player's top three rarest answers, shown with tier badges.
- Missed gems: a few rare valid answers the player did not find, as a teaser and a learning tool.
- Personal best comparison and streak status.
- Share button.

### 8.3 Share card

A text block that pastes cleanly anywhere and an optional image version. The text version:
    Daily Ascent #42 ⛰️
    ⛺ Camp 2 · 6,512 m
    ⬜🟫🟩🟦🟪🟦🟩
    (rarest find per leg)
    [link]
The image version is a rendered card of the mountain with the climber at their milestone. Spoilers are avoided: the share never shows actual answers.

### 8.4 Streaks and stats

- Daily streak counter, with a forgiving "one rest day" token earned every 14 days.
- Lifetime stats: average altitude, best altitude, summits reached, rarest answer ever found, tier distribution.
- Badges for milestones such as First Base Camp, First Summit, 10 Legendary finds, and a 30-day streak.

### 8.5 Leaderboards

- Daily global leaderboard by final altitude (ties broken by number of rare finds).
- Friends leaderboard once friends exist (v1.5).
- Leaderboards show altitude and milestone only, never answers, to prevent leaking.

### 8.6 Accounts

- Players start anonymously with a device ID so there is zero friction.
- Optional sign-in (email magic link or Google) to save streaks across devices.

### 8.7 Archive and practice (post-launch)

- Replay previous days' puzzles in unscored practice mode.
- "Expedition packs": themed sets of categories (v2).

## 9. Screens and UX

### 9.1 Home

The full mountain illustration with a faint ghost marker showing the player's personal best altitude. The streak counter, today's puzzle number, and a prominent Begin Climb button sit on top. If today is complete, the button becomes View Results and a countdown to the next puzzle appears.

### 9.2 Leg screen (the core screen)

Layout, top to bottom:
- A slim progress strip showing legs 1 to 7.
- The category text, large and centered.
- The countdown, as a ring or bar that visibly tightens in the final three seconds.
- The text input, always focused.
- A feed of accepted answers as chips beneath the input, each colored by tier with its "+meters" gain. New chips animate in and older ones fade.
- The mountain illustration fills the background and scrolls upward as altitude increases, with the climber moving smoothly up the route.

### 9.3 Feedback per answer

- Crawler: a small tick and a subtle chime.
- Hiker: a brighter chip, a larger altitude bump, a distinct sound.
- Mountaineer: a brief burst of light on the mountain, a rising chime, and a light haptic pulse on mobile.
- Sherpa: Something even more grand
- Invalid: the input shakes briefly, a soft thud, and the timer visibly ticks down 1 second.
- Duplicate: a gentle pulse on the existing chip.

### 9.4 Leg transition

A 2.5-second beat: the camera pans up the mountain to the next stretch, shows altitude gained this leg, and previews the next landmark. The next category appears as the pan settles.

### 9.5 How-to-play

A 20-second interactive demo on first launch: one sample category with a practice timer, so players learn by doing. A "?" button reopens the rules at any time.

## 10. Visual and Audio Design

### 10.1 Art direction

A tall, illustrated mountain, flat-shaded with layered parallax rather than photorealistic. The mood is warm and inviting at the base and increasingly stark and majestic as you climb.
Palette by altitude zone:
- Foothills (2,860 to 4,000 m): lush greens, warm wood tea houses, prayer flags, soft morning light
- Mid-mountain (4,000 to 5,400 m): rocky browns, glacial blues, the Base Camp tent village
- Icefall and camps (5,400 to 8,000 m): bright white snow, deep blue shadows, tents and fixed ropes
- Death Zone (8,000 m and up): dark sky, sharp contrast, thin wind streaks, stars visible at the summit

### 10.2 Dynamic scene elements

- Time of day: the sky shifts from dawn at the start of the round toward golden hour at higher altitudes.
- Climber: a small, charming figure with animation frames for walking, pausing, and celebrating a rare find.

### 10.3 Typography and UI

A clean, readable sans serif for UI and a slightly characterful display face for category text. High contrast, generous touch targets, and a dark mode that is the default for the Death Zone legs.

### 10.4 Audio

Optional and off by default on first load, with a clear toggle. Ambient wind and soft music, plus tier-specific answer chimes. All audio is short and non-fatiguing.

### 10.5 Accessibility

- Tiers are conveyed by color, icon shape, and text.
- A reduced-motion setting disables parallax and scene animation, leaving a static mountain with a simple altitude marker.
- Full keyboard operation and screen-reader labels for chips, timer, and altitude.
- Timer extension option (+50% time) in settings for players who need it, flagged privately and excluded from the global leaderboard.

## 11. Technical Architecture

### 11.1 Recommended stack

- Front end: React with Vite (or Next.js), TypeScript. The mountain is a layered SVG scene with CSS transforms for parallax and the climber.
- Back end: Supabase (Postgres, auth, edge functions) or Cloudflare Workers with D1 or KV.
- LLM: one fast, inexpensive model  for offline seed generation.
- Hosting: Tepmorarily github pages - should be able to migrate to a domain in the future

### 11.2 Data model (core tables)

- categories: id, text, scheduled_date, difficulty, status
- answers: id, category_id, canonical, commonness, tier, source (seed, judge, crowd), reviewed
- aliases: answer_id, alias
- rounds: id, player_id, puzzle_date, started_at, final_altitude, completed
- submissions: id, round_id, leg, raw_input, answer_id (nullable), result (accepted, invalid, duplicate, pending), tier, gain, submitted_at
- players: id, device_id, user_id (nullable), streak, stats
- judge_cache: category_id, normalized_input, verdict

### 11.3 Server authority and anti-cheat

- The server issues each leg's start time and decides when it ends. Submissions past the deadline plus a small network grace window are discarded.
- All scoring happens on the server. The client never receives the answer list, only verdicts.
- Rate limiting on submissions per player per leg.
- Detect and flag implausible patterns, such as perfectly uniform inter-answer timing or pasted input.
- One scored round per player per day enforced by account and device ID.

### 11.4 Performance targets

- Seed-table verdict under 100 ms.
- First load under 2 seconds on a mid-range phone.

### 11.5 Cost control

The judge cache means the LLM is called once per novel answer per category. Because most answers resolve from the seed list, expect the large majority of submissions to cost nothing. Set a daily spend alarm and a circuit breaker that falls back to "accept low-confidence at Uncommon" if the budget is hit.

## 12. Metrics

- Retention: day-1, day-7, and day-30 return rates; average streak length.
- Engagement: completion rate of rounds, share rate, average time to complete.
- Balance: altitude distribution against the targets in Section 4; distribution of tiers; percentage of rounds with at least one invalid-answer penalty.
- Answer quality: judge acceptance rate, report rate, percentage of novel answers later approved.
- Content: per-category performance, to retire categories that are too easy, too hard, or too ambiguous.

## 13. Roadmap

**MVP (build first)**

- Home, leg screen, results screen with a simple mountain scene.
- Seven legs, timers, penalties, caps.
- Seed-based matching.
- Altitude scoring and milestones.
- Text share card.
- Anonymous play; 30 days of categories.

**v1**

- Full art pass: parallax, weather, climber animations, audio.
- Accounts, streaks, stats, badges.
- Daily leaderboard.
- Image share card.
- Human review tooling for the answer queue.

## 14. Risks and Open Questions

**Risks**

- Cold-start rarity: seed commonness is an LLM estimate and will be wrong in places. Mitigation: human review, the report button, and post-day crowd correction.
- Typing-speed bias: fast typists could dominate. Mitigation: rare answers are worth far more than common ones, and the leg cap limits volume farming.
- Spam and gaming: random-word submission or scripting. Mitigation: invalid penalties, rate limits, server authority, and the 30-answer cap.
- Similarity to an existing game: mitigated by distinct name, art, theme, and the multi-answer mechanic, which changes the gameplay meaningfully.

**Open questions**

1. Real Everest with simplified landmarks, or an original fictional peak with custom landmarks?
2. A single global daily reset time, or local-midnight reset?
3. Should invalid answers cost time, altitude, or both?
4. Should the leg order stay fixed, or should players ever choose their leg order?
5. How should the product be named, and what visual identity separates it clearly from similar games?
6. Do we want an optional hard mode, such as shorter timers or no chain bonus, for experienced players?
