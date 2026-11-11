# Blind translation test, run 20261111T141905

Generated from outputs.jsonl, judge.jsonl and the spend ledger by `npm run blind`. Every number below is
computed from those files; regenerate it by rerunning the same command with `--run-id 20261111T141905`.

## Read this first

- The 625 source lines are SYNTHETIC, written for this test (eval/blind/README.md), not real call transcripts.
  Real speech is messier: recognition errors, fragments, crosstalk.
- The judge is an LLM (claude-sonnet-5-5), rating blind: it was told it was rating blind, was never told the models, and saw
  the candidates under the labels 1, 2, 3 in a seeded random order, identical outputs shown once and scored once. Its scores
  are a PRELIMINARY signal. The real test is the human sheet, rating_sheet.csv, filled in by native speakers.
- No glossary was used: the set is synthetic and has none. Production adds a room's glossary to the prompt; that path is
  not measured here.
- Each conversation is one person speaking, so the context lines all come from one speaker, unlike a real two person call.
- Latency is measured here without production's 6 second timeout, one call at a time per worker, from this machine. It is a comparison between arms, not a production figure.
- 624 of 625 items were judged. The judge pass rates items interleaved across the five targets, so a partial pass is a balanced sample, but a smaller one.
- 1 judge calls ended without a usable rating (refusal, truncated, invalid, or a retriable error).
- Marker checks are automatic word checks for the form of address each target asks for (src/eval/blind/markers.ts). They
  run only where the item's address makes them meaningful, and a line with no deciding word is inconclusive, not a pass:
  the rate is passes over decided checks.

## Arms

| arm | model | how it was asked |
|-----|-------|------------------|
| A | claude-haiku-4-5 | Claude Haiku 4.5, as production calls it: temperature 0.2, no thinking field, no effort field, max_tokens 512 |
| B | claude-haiku-5-5 | Claude Haiku 5.5, thinking disabled: no temperature, thinking disabled, no effort field, max_tokens 512 |
| C | claude-haiku-5-5 | Claude Haiku 5.5, adaptive thinking at effort low: no temperature, thinking adaptive, effort low, max_tokens 8192 |

## Overall

625 items. Mean score is the judge's 0 to 100. Cost per call is the ledger's, per answered call; per call hour projects it at 20 translations a minute.

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 625/625 | 0 | 0 | 0 | 624 | 80.9 | 95.7% | 100.0% (141/141, 131 inconclusive) | 512 | 747 | 436 | 22 | $0.000544 | $0.65 |
| B | 625/625 | 0 | 0 | 0 | 624 | 81.3 | 95.2% | 99.3% (133/134, 138 inconclusive) | 763 | 1613 | 621 | 27 | $0.000076 | $0.09 |
| C | 625/625 | 0 | 0 | 0 | 624 | 82.0 | 95.5% | 99.3% (140/141, 131 inconclusive) | 775 | 1682 | 622 | 28 | $0.000076 | $0.09 |

Paired difference in judge score against arm A, mean with a 2000 resample bootstrap 95 percent interval:

- B minus A: +0.42 [-1.08, 1.91], n=624
- C minus A: +1.13 [-0.32, 2.63], n=624

An interval that includes 0 means this run cannot tell the two arms apart on the judge's scores.

## es-AR: Rioplatense Spanish as spoken in Buenos Aires

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 125/125 | 0 | 0 | 0 | 124 | 78.7 | 91.9% | 100.0% (29/29, 52 inconclusive) | 529 | 752 | 481 | 22 | $0.000592 | $0.71 |
| B | 125/125 | 0 | 0 | 0 | 124 | 75.5 | 90.3% | 95.0% (19/20, 61 inconclusive) | 769 | 1590 | 687 | 29 | $0.000083 | $0.10 |
| C | 125/125 | 0 | 0 | 0 | 124 | 76.2 | 89.5% | 96.0% (24/25, 56 inconclusive) | 839 | 1688 | 688 | 32 | $0.000085 | $0.10 |

- B minus A: -3.18 [-7.15, 0.83], n=124
- C minus A: -2.48 [-6.59, 1.45], n=124

## es-CO: Colombian Spanish as spoken in Bogota

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 125/125 | 0 | 0 | 0 | 125 | 78.2 | 94.4% | 100.0% (12/12, 69 inconclusive) | 516 | 763 | 437 | 22 | $0.000547 | $0.66 |
| B | 125/125 | 0 | 0 | 0 | 125 | 78.3 | 92.8% | 100.0% (15/15, 66 inconclusive) | 767 | 1667 | 636 | 28 | $0.000078 | $0.09 |
| C | 125/125 | 0 | 0 | 0 | 125 | 83.3 | 95.2% | 100.0% (19/19, 62 inconclusive) | 789 | 1740 | 637 | 28 | $0.000078 | $0.09 |

- B minus A: +0.11 [-4.06, 4.20], n=125
- C minus A: +5.10 [1.55, 8.54], n=125

## es-MX: Mexican Spanish

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 125/125 | 0 | 0 | 0 | 125 | 79.1 | 98.4% | 100.0% (77/77, 0 inconclusive) | 510 | 768 | 418 | 22 | $0.000531 | $0.64 |
| B | 125/125 | 0 | 0 | 0 | 125 | 85.4 | 99.2% | 100.0% (77/77, 0 inconclusive) | 782 | 1640 | 599 | 28 | $0.000074 | $0.09 |
| C | 125/125 | 0 | 0 | 0 | 125 | 82.8 | 97.6% | 100.0% (77/77, 0 inconclusive) | 761 | 1670 | 600 | 28 | $0.000074 | $0.09 |

- B minus A: +6.34 [3.64, 9.40], n=125
- C minus A: +3.74 [0.34, 6.98], n=125

## es-ES: Peninsular Spanish

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 125/125 | 0 | 0 | 0 | 125 | 81.2 | 94.4% | 100.0% (23/23, 10 inconclusive) | 521 | 761 | 429 | 23 | $0.000543 | $0.65 |
| B | 125/125 | 0 | 0 | 0 | 125 | 80.6 | 94.4% | 100.0% (22/22, 11 inconclusive) | 799 | 1597 | 607 | 28 | $0.000075 | $0.09 |
| C | 125/125 | 0 | 0 | 0 | 125 | 81.5 | 96.0% | 100.0% (20/20, 13 inconclusive) | 749 | 1754 | 608 | 29 | $0.000075 | $0.09 |

- B minus A: -0.60 [-3.58, 2.56], n=125
- C minus A: +0.36 [-3.30, 3.99], n=125

## en-US: American English

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 125/125 | 0 | 0 | 0 | 125 | 87.3 | 99.2% | n/a | 500 | 669 | 415 | 18 | $0.000506 | $0.61 |
| B | 125/125 | 0 | 0 | 0 | 125 | 86.7 | 99.2% | n/a | 720 | 1502 | 577 | 22 | $0.000069 | $0.08 |
| C | 125/125 | 0 | 0 | 0 | 125 | 86.2 | 99.2% | n/a | 750 | 1525 | 578 | 22 | $0.000069 | $0.08 |

- B minus A: -0.59 [-3.04, 1.55], n=125
- C minus A: -1.09 [-3.36, 1.06], n=125

## Error tags the judge gave

| arm | mistranslation | omission | addition | wrong_register | wrong_dialect | grammar | fluency |
|-----|---|---|---|---|---|---|---|
| A | 67 | 11 | 12 | 11 | 21 | 63 | 119 |
| B | 63 | 31 | 25 | 12 | 14 | 69 | 73 |
| C | 62 | 14 | 21 | 9 | 20 | 51 | 79 |

## Spend

This run (ledger program blind-test, room c20466e840e9dcb8): 2500 rows, $2.625238 in all, $0.434810 on translations and $2.190428 on the judge, against a budget of $5.98 (judge $4.00).
Every call answered, so every row carries its real cost.

The whole ledger, by program, known costs only:

| program | spent | calls |
|---------|-------|-------|
| blind-test | $2.641890 | 2533 |

Known total: $2.641890 across 2533 calls.

