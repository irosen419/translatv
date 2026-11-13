# Blind translation test, run 20261111T141838

Generated from outputs.jsonl, judge.jsonl and the spend ledger by `npm run blind`. Every number below is
computed from those files; regenerate it by rerunning the same command with `--run-id 20261111T141838`.

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
- 3 of 10 items were judged. The judge pass rates items interleaved across the five targets, so a partial pass is a balanced sample, but a smaller one.
- 0 judge calls ended without a usable rating (refusal, truncated, invalid, or a retriable error).
- Marker checks are automatic word checks for the form of address each target asks for (src/eval/blind/markers.ts). They
  run only where the item's address makes them meaningful, and a line with no deciding word is inconclusive, not a pass:
  the rate is passes over decided checks.

## The run stopped early

- judge stopped: the judge budget of $0.35 would be exceeded: $0.000000 spent, $0.273372 in flight at worst case, $0.091104 for the next call

## Arms

| arm | model | how it was asked |
|-----|-------|------------------|
| A | claude-haiku-4-5 | Claude Haiku 4.5, as production calls it: temperature 0.2, no thinking field, no effort field, max_tokens 512 |
| B | claude-haiku-5-5 | Claude Haiku 5.5, thinking disabled: no temperature, thinking disabled, no effort field, max_tokens 512 |
| C | claude-haiku-5-5 | Claude Haiku 5.5, adaptive thinking at effort low: no temperature, thinking adaptive, effort low, max_tokens 8192 |

## Overall

10 items. Mean score is the judge's 0 to 100. Cost per call is the ledger's, per answered call; per call hour projects it at 20 translations a minute.

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 10/10 | 0 | 0 | 0 | 3 | 64.3 | 66.7% | 100.0% (1/1, 3 inconclusive) | 517 | 661 | 395 | 18 | $0.000487 | $0.58 |
| B | 10/10 | 0 | 0 | 0 | 3 | 78.3 | 66.7% | 100.0% (1/1, 3 inconclusive) | 1045 | 1863 | 564 | 22 | $0.000067 | $0.08 |
| C | 10/10 | 0 | 0 | 0 | 3 | 78.3 | 66.7% | 100.0% (1/1, 3 inconclusive) | 646 | 1161 | 565 | 23 | $0.000068 | $0.08 |

Paired difference in judge score against arm A, mean with a 2000 resample bootstrap 95 percent interval:

- B minus A: +14.00 [5.00, 23.00], n=3
- C minus A: +14.00 [5.00, 23.00], n=3

An interval that includes 0 means this run cannot tell the two arms apart on the judge's scores.

## es-AR: Rioplatense Spanish as spoken in Buenos Aires

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 2/2 | 0 | 0 | 0 | 1 | 55.0 | 0.0% | n/a (0/0, 1 inconclusive) | 460 | 661 | 443 | 15 | $0.000515 | $0.62 |
| B | 2/2 | 0 | 0 | 0 | 1 | 60.0 | 0.0% | n/a (0/0, 1 inconclusive) | 1561 | 1641 | 636 | 18 | $0.000073 | $0.09 |
| C | 2/2 | 0 | 0 | 0 | 1 | 60.0 | 0.0% | n/a (0/0, 1 inconclusive) | 579 | 2069 | 637 | 18 | $0.000073 | $0.09 |

- B minus A: +5.00 [5.00, 5.00], n=1
- C minus A: +5.00 [5.00, 5.00], n=1

## es-CO: Colombian Spanish as spoken in Bogota

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 2/2 | 0 | 0 | 0 | 1 | 72.0 | 100.0% | n/a (0/0, 2 inconclusive) | 462 | 615 | 408 | 14 | $0.000478 | $0.57 |
| B | 2/2 | 0 | 0 | 0 | 1 | 95.0 | 100.0% | n/a (0/0, 2 inconclusive) | 652 | 1778 | 593 | 17 | $0.000068 | $0.08 |
| C | 2/2 | 0 | 0 | 0 | 1 | 95.0 | 100.0% | n/a (0/0, 2 inconclusive) | 554 | 628 | 594 | 17 | $0.000068 | $0.08 |

- B minus A: +23.00 [23.00, 23.00], n=1
- C minus A: +23.00 [23.00, 23.00], n=1

## es-MX: Mexican Spanish

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 2/2 | 0 | 0 | 0 | 1 | 66.0 | 100.0% | 100.0% (1/1, 0 inconclusive) | 530 | 746 | 385 | 28 | $0.000525 | $0.63 |
| B | 2/2 | 0 | 0 | 0 | 1 | 80.0 | 100.0% | 100.0% (1/1, 0 inconclusive) | 721 | 1045 | 552 | 34 | $0.000072 | $0.09 |
| C | 2/2 | 0 | 0 | 0 | 1 | 80.0 | 100.0% | 100.0% (1/1, 0 inconclusive) | 633 | 698 | 553 | 36 | $0.000074 | $0.09 |

- B minus A: +14.00 [14.00, 14.00], n=1
- C minus A: +14.00 [14.00, 14.00], n=1

## es-ES: Peninsular Spanish

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 2/2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | 453 | 550 | 398 | 19 | $0.000491 | $0.59 |
| B | 2/2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | 811 | 1963 | 563 | 23 | $0.000067 | $0.08 |
| C | 2/2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | 646 | 825 | 564 | 24 | $0.000069 | $0.08 |

- B minus A: n/a (no paired ratings)
- C minus A: n/a (no paired ratings)

## en-US: American English

| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |
|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|
| A | 2/2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | 459 | 517 | 343 | 17 | $0.000428 | $0.51 |
| B | 2/2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | 702 | 1863 | 477 | 20 | $0.000058 | $0.07 |
| C | 2/2 | 0 | 0 | 0 | 0 | n/a | n/a | n/a | 658 | 1161 | 478 | 20 | $0.000058 | $0.07 |

- B minus A: n/a (no paired ratings)
- C minus A: n/a (no paired ratings)

## Error tags the judge gave

| arm | mistranslation | omission | addition | wrong_register | wrong_dialect | grammar | fluency |
|-----|---|---|---|---|---|---|---|
| A | 1 | 0 | 0 | 0 | 1 | 1 | 2 |
| B | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| C | 1 | 0 | 0 | 0 | 1 | 0 | 0 |

## Spend

This run (ledger program blind-test, room c629f44b107ebda9): 33 rows, $0.016652 in all, $0.006226 on translations and $0.010426 on the judge, against a budget of $0.50 (judge $0.35).
Every call answered, so every row carries its real cost.

The whole ledger, by program, known costs only:

| program | spent | calls |
|---------|-------|-------|
| blind-test | $0.016652 | 33 |

Known total: $0.016652 across 33 calls.

