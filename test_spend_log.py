#!/usr/bin/env python3
"""Tests for the spend ledger reader.

Standard library only: unittest, no pytest, no third party imports, no network. Runs with
`python3 -m unittest discover -s . -p 'test_*.py'`.

The EXPECTED_* constants below are the shared contract with the TypeScript reader. Its suite
(server/src/spend/ledger.test.ts) asserts the same numbers against the same fixture, so if one
implementation drifts, one of the two suites goes red. Change these numbers only when the
fixture genuinely changes, and change them in both places in the same commit.

No em dashes or en dashes anywhere.
"""

import os
import shutil
import tempfile
import unittest

import spend_log

FIXTURE_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_fixtures", "ledger_root")
FIXTURE_PROJECT = "fixture-project"

# The shared contract. Mirrored in server/src/spend/ledger.test.ts.
EXPECTED_KNOWN_USD = 0.0033
EXPECTED_UNPARSED_ROWS = 2
EXPECTED_ENTRIES = 5
EXPECTED_INPUT_TOKENS = 3320
EXPECTED_OUTPUT_TOKENS = 148
EXPECTED_MALFORMED_LINES = 2
EXPECTED_TRANSLATION_SPENT = 0.00205
EXPECTED_EVAL_SPENT = 0.00125


def read_fixture():
    return spend_log.load(FIXTURE_PROJECT, root=FIXTURE_ROOT)


class LoadTest(unittest.TestCase):
    def test_reads_every_data_record(self):
        self.assertEqual(len(read_fixture()), EXPECTED_ENTRIES)

    def test_header_is_not_a_spend_record(self):
        # A consumer that summed the header into a total would double count. The header is
        # metadata and must not appear in the record stream.
        for record in read_fixture():
            self.assertNotEqual(record.get("record_type"), spend_log.HEADER_TYPE)

    def test_header_is_available_separately(self):
        headers = spend_log.load_headers(FIXTURE_PROJECT, root=FIXTURE_ROOT)
        self.assertEqual(len(headers), 1)
        self.assertEqual(headers[0]["project"], FIXTURE_PROJECT)

    def test_missing_ledger_raises_rather_than_reading_as_zero(self):
        # The single most important behavior in this module. "No ledger" and "spent nothing"
        # are different facts, and a budget gate that confuses them buys exactly the calls the
        # cap existed to prevent.
        with self.assertRaises(spend_log.LedgerNotFound):
            spend_log.load("no-such-project", root=FIXTURE_ROOT)

    def test_missing_ledger_is_empty_only_when_explicitly_tolerated(self):
        records = spend_log.load("no-such-project", root=FIXTURE_ROOT, missing_ok=True)
        self.assertEqual(records, [])

    def test_load_headers_never_raises_for_a_missing_ledger(self):
        # A preamble is decoration, so its absence is not a budget question the way a missing
        # spend history is.
        self.assertEqual(spend_log.load_headers("no-such-project", root=FIXTURE_ROOT), [])

    def test_malformed_lines_are_counted_not_dropped(self):
        # A silently dropped line understates a money total. Both a non JSON line and a JSON
        # array count: neither is a record object.
        self.assertEqual(
            spend_log.malformed_lines(FIXTURE_PROJECT, root=FIXTURE_ROOT),
            EXPECTED_MALFORMED_LINES,
        )

    def test_malformed_lines_is_zero_for_a_missing_ledger(self):
        self.assertEqual(spend_log.malformed_lines("no-such-project", root=FIXTURE_ROOT), 0)


class TotalsTest(unittest.TestCase):
    def setUp(self):
        self.summary = spend_log.totals(read_fixture())

    def test_known_usd_matches_the_shared_contract(self):
        self.assertAlmostEqual(self.summary["known_usd"], EXPECTED_KNOWN_USD, places=9)

    def test_unparsed_rows_are_counted_so_the_total_reads_as_a_floor(self):
        self.assertEqual(self.summary["unparsed_rows"], EXPECTED_UNPARSED_ROWS)

    def test_token_counts(self):
        self.assertEqual(self.summary["input_tokens"], EXPECTED_INPUT_TOKENS)
        self.assertEqual(self.summary["output_tokens"], EXPECTED_OUTPUT_TOKENS)

    def test_an_unrecoverable_cost_contributes_nothing_rather_than_zero(self):
        # The distinction that matters: those rows are EXCLUDED from known_usd and COUNTED in
        # unparsed_rows. Treating either as 0.0 would produce the same known_usd but a lower
        # unparsed_rows, which would present a floor as though it were exact. Two rows now: the
        # unpriced model, whose cost_usd is an explicit null, and the row that omits the key
        # entirely. Absent and null have to count the same, in both readers.
        self.assertEqual(self.summary["unparsed_rows"], 2)
        self.assertAlmostEqual(self.summary["known_usd"], EXPECTED_KNOWN_USD, places=9)

    def test_programs_are_bucketed_separately(self):
        programs = self.summary["programs"]
        self.assertEqual(sorted(programs), ["autopilot-eval", "runtime-translation"])
        self.assertAlmostEqual(
            programs["runtime-translation"]["spent_usd"], EXPECTED_TRANSLATION_SPENT, places=9
        )
        self.assertAlmostEqual(
            programs["autopilot-eval"]["spent_usd"], EXPECTED_EVAL_SPENT, places=9
        )

    def test_program_entry_counts_include_unparsed_rows(self):
        # The unparsed row still happened and still belongs to its program, even though its
        # money is unknown. Dropping it from the count would hide it entirely.
        self.assertEqual(self.summary["programs"]["runtime-translation"]["entries"], 4)
        self.assertEqual(self.summary["programs"]["autopilot-eval"]["entries"], 1)

    def test_caps_are_carried_per_program(self):
        # Also the absent key case: the last runtime row has no cap_usd at all, so the 1.5 the
        # earlier rows carried has to stand rather than being cleared.
        programs = self.summary["programs"]
        self.assertAlmostEqual(programs["runtime-translation"]["cap_usd"], 1.5)
        self.assertAlmostEqual(programs["autopilot-eval"]["cap_usd"], 10.0)

    def test_last_cap_seen_wins(self):
        # A cap raised mid program is the one in force now, so a later row's cap supersedes an
        # earlier one rather than the first being sticky.
        records = [
            {"program": "p", "cost_usd": 1.0, "cap_usd": 5.0},
            {"program": "p", "cost_usd": 1.0, "cap_usd": 20.0},
        ]
        self.assertAlmostEqual(spend_log.totals(records)["programs"]["p"]["cap_usd"], 20.0)

    def test_a_row_stating_no_cap_leaves_the_known_one_standing(self):
        records = [
            {"program": "p", "cost_usd": 1.0, "cap_usd": 5.0},
            {"program": "p", "cost_usd": 1.0, "cap_usd": None},
        ]
        self.assertAlmostEqual(spend_log.totals(records)["programs"]["p"]["cap_usd"], 5.0)

    def test_a_record_with_no_program_still_counts_toward_the_total(self):
        records = [{"program": None, "cost_usd": 2.0}]
        summary = spend_log.totals(records)
        self.assertAlmostEqual(summary["known_usd"], 2.0)
        self.assertEqual(summary["programs"], {})

    def test_a_non_numeric_cost_reads_as_corrupt_rather_than_free(self):
        # "unknown" is not zero. A string cost is unrecoverable, so it lands in unparsed_rows.
        summary = spend_log.totals([{"program": "p", "cost_usd": "not a number"}])
        self.assertEqual(summary["unparsed_rows"], 1)
        self.assertAlmostEqual(summary["known_usd"], 0.0)

    def test_a_boolean_cost_is_not_treated_as_a_number(self):
        # Python's bool is an int subclass, so a naive isinstance check would score True as 1.0
        # and invent a dollar of spend out of a corrupt row.
        summary = spend_log.totals([{"program": "p", "cost_usd": True}])
        self.assertEqual(summary["unparsed_rows"], 1)
        self.assertAlmostEqual(summary["known_usd"], 0.0)

    def test_empty_records_are_a_true_zero(self):
        summary = spend_log.totals([])
        self.assertAlmostEqual(summary["known_usd"], 0.0)
        self.assertEqual(summary["entries"], 0)
        self.assertEqual(summary["unparsed_rows"], 0)


class RenderMarkdownTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def seed(self, project, lines):
        path = os.path.join(self.tmp, "out", project)
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, spend_log.LEDGER_NAME), "w", encoding="utf-8") as handle:
            handle.write("".join(lines))

    def test_view_carries_the_generated_banner(self):
        text = spend_log.render_markdown(FIXTURE_PROJECT, root=FIXTURE_ROOT)
        self.assertIn(spend_log.GENERATED_BANNER, text)

    def test_an_unrecovered_cost_prints_as_unknown_not_as_zero(self):
        # Reading the table must not mislead. A "$0.000000" cell would read as a free call.
        text = spend_log.render_markdown(FIXTURE_PROJECT, root=FIXTURE_ROOT)
        self.assertIn("unknown", text)

    def test_a_floor_says_so(self):
        text = spend_log.render_markdown(FIXTURE_PROJECT, root=FIXTURE_ROOT)
        self.assertIn("floor", text)

    def test_a_derived_cost_is_marked_approximate(self):
        self.seed(
            "approx-project",
            ['{"program":"p","cost_usd":1.0,"cost_source":"derived","note":"x"}\n'],
        )
        text = spend_log.render_markdown("approx-project", root=self.tmp)
        self.assertIn("approx", text)

    def test_refuses_to_overwrite_a_real_view_from_an_empty_ledger(self):
        # The destructive case: an empty ledger cannot be the source of truth for a markdown
        # that already has content.
        self.seed("empty-project", [])
        target = spend_log.markdown_path("empty-project", root=self.tmp)
        with open(target, "w", encoding="utf-8") as handle:
            handle.write("# a real ledger view with real content\n")

        with self.assertRaises(spend_log.RefusedWrite):
            spend_log.render_markdown("empty-project", root=self.tmp, write=True)

        with open(target, encoding="utf-8") as handle:
            self.assertIn("a real ledger view", handle.read())

    def test_an_empty_ledger_with_no_existing_view_writes_cleanly(self):
        self.seed("fresh-project", [])
        text = spend_log.render_markdown("fresh-project", root=self.tmp, write=True)
        self.assertIn(spend_log.GENERATED_BANNER, text)

    def test_a_pipe_in_a_note_cannot_break_the_table(self):
        self.seed(
            "pipe-project",
            ['{"program":"p","cost_usd":1.0,"cost_source":"logged","note":"a|b|c"}\n'],
        )
        text = spend_log.render_markdown("pipe-project", root=self.tmp)
        row = [line for line in text.splitlines() if "a b c" in line]
        self.assertEqual(len(row), 1)


class NoDashesTest(unittest.TestCase):
    # Built from code points rather than written literally, so this file can check ITSELF.
    # A literal here would make the test find its own assertion and fail forever, which is the
    # trap that makes self-checking dash gates get deleted instead of fixed.
    EM_DASH = chr(0x2014)
    EN_DASH = chr(0x2013)

    def test_these_modules_have_no_em_or_en_dashes(self):
        # The house rule, enforced where it is cheapest to notice.
        for name in ("spend_log.py", "test_spend_log.py"):
            path = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            self.assertNotIn(self.EM_DASH, text, "%s contains an em dash" % name)
            self.assertNotIn(self.EN_DASH, text, "%s contains an en dash" % name)


if __name__ == "__main__":
    unittest.main()
