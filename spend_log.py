#!/usr/bin/env python3
"""API spend ledger CLI: reads the append only JSONL, prints totals, regenerates the view.

The ledger itself is WRITTEN by server/src/spend/ledger.ts, because spend happens live in
process while a call is running and shelling out to Python on a latency sensitive path would
be the wrong shape. This module is the reading half: a standard library only CLI over the same
file, so Python tooling (and anyone at a terminal) works against this repo unchanged.

The JSONL is the source of truth. spend_log.md beside it is a GENERATED VIEW, never parsed and
never hand edited.

One JSON object per line, one line per API call:

    ts                          ISO 8601, or null for a row with no readable timestamp
    project                     project slug
    program                     the named cap this call draws against
    kind                        translation, term-extraction, eval, or verification
    model                       the model that was called
    room                        truncated sha256 of the room code, never the code itself
    user_id                     opaque account id the spend is attributed to: the room's HOST,
                                whoever spoke (docs/PLAN.md, D9 and D10). Never an email or a
                                display name. null for spend that belongs to no account
                                (verification, eval). Rows older than the field have no key at
                                all; absent and null both read as "unattributed".
    input_tokens, output_tokens as the API reported them
    unit_cost_in_usd_per_mtok   documented price, or null for an unpriced model
    unit_cost_out_usd_per_mtok
    cost_usd                    computed cost, or null when it could not be recovered. This is
                                the number the cap gate adds up, so a figure that contradicts
                                the row's own arithmetic is refused at write time rather than
                                stored.
    cost_source                 logged, derived, or unparsed (see COST_SOURCES)
    cumulative_usd              running total for the program as the row recorded it
    cap_usd                     the cap in force for the program on this row
    note                        free text

Rows written before 2026-08 also carry image_count, always 0. Nothing reads it: this project
renders nothing, and the dashboard's reader already treats an absent key as zero. It is not
written any more, and old rows keep it because the ledger is append only.

Nothing here spends money or touches the network.

Standard library only. No em dashes or en dashes anywhere.
"""

import json
import os

# Where cost_usd came from, worst to best. A consumer that wants to show only trustworthy
# money can filter on "logged".
#
#   logged    the API response reported its own token usage and the price is documented
#   derived   computed by differencing cumulative totals within a program. Real, but
#             approximate.
#   unparsed  no amount could be recovered. cost_usd is null, never zero: a zero would
#             silently understate the total.
COST_SOURCES = ("logged", "derived", "unparsed")

# Six decimal places, matching server/src/spend/pricing.ts and the dashboard's Ruby
# SpendLedger. All three round identically on purpose, so a figure read off the cockpit and one
# printed here cannot differ in the tail.
MONEY_PRECISION = 6

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))

LEDGER_NAME = "spend_log.jsonl"
MARKDOWN_NAME = "spend_log.md"

DEFAULT_PROJECT = "translatv"

# Stamped into every generated markdown view, so a future migration can refuse to parse a
# generated file as though it were a hand written source.
GENERATED_BANNER = "Generated from %s." % LEDGER_NAME

# A header record carries metadata rather than spend, so load keeps it out of the record
# stream that totals sums. A consumer that summed headers would double count.
HEADER_TYPE = "header"


class LedgerNotFound(Exception):
    """Raised when a project has no JSONL ledger at all.

    Deliberately not an empty list: a project with no ledger has UNKNOWN spend, and a budget
    gate must not read that as zero spent and wave a paid call through against a cap it cannot
    see.
    """


class RefusedWrite(Exception):
    """Raised rather than overwrite a real markdown view with an empty one."""


def ledger_path(project=DEFAULT_PROJECT, root=None):
    base = REPO_ROOT if root is None else root
    return os.path.join(base, "out", project, LEDGER_NAME)


def markdown_path(project=DEFAULT_PROJECT, root=None):
    base = REPO_ROOT if root is None else root
    return os.path.join(base, "out", project, MARKDOWN_NAME)


def _read_lines(project, root=None):
    """Every parseable JSON object in the ledger, plus a count of the lines that were not.

    A line that is not a JSON object is SKIPPED and COUNTED rather than either taking the whole
    ledger down or vanishing: a silently dropped line understates a money total, which is the
    one failure this module exists to prevent.
    """
    path = ledger_path(project, root=root)
    if not os.path.isfile(path):
        raise LedgerNotFound("no ledger at %s" % path)

    records = []
    malformed = 0
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except ValueError:
                malformed += 1
                continue
            if isinstance(value, dict):
                records.append(value)
            else:
                malformed += 1
    return records, malformed


def load(project=DEFAULT_PROJECT, root=None, missing_ok=False):
    """Every spend record for a project, in file order.

    A missing ledger RAISES LedgerNotFound. It is not an empty list: "this project has no
    ledger" and "this project spent nothing" are different facts, and the budget gate must
    never confuse them. A caller that genuinely tolerates a missing ledger opts in explicitly
    with missing_ok=True.

    Header records are metadata rather than spend and are not returned here. Use load_headers.
    """
    try:
        records, _ = _read_lines(project, root=root)
    except LedgerNotFound:
        if missing_ok:
            return []
        raise
    return [r for r in records if r.get("record_type") != HEADER_TYPE]


def load_headers(project=DEFAULT_PROJECT, root=None):
    """The project's metadata records, or an empty list.

    Never raises for a missing ledger: a preamble is decoration, so its absence is not a budget
    question the way a missing spend history is.
    """
    try:
        records, _ = _read_lines(project, root=root)
    except LedgerNotFound:
        return []
    return [r for r in records if r.get("record_type") == HEADER_TYPE]


def malformed_lines(project=DEFAULT_PROJECT, root=None):
    """How many lines could not be read as a JSON object. Non zero means totals are a floor."""
    try:
        _, malformed = _read_lines(project, root=root)
    except LedgerNotFound:
        return 0
    return malformed


def _numeric(value):
    """A float, or None for anything that is not a number.

    A non numeric cost is CORRUPT rather than free, so it reads as unrecoverable and lands in
    unparsed_rows instead of being coerced to zero.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _round(amount):
    return round(float(amount), MONEY_PRECISION)


def attributed_user(record):
    """The account a record is attributed to, or None for an unattributed one.

    Only a non empty string counts. An absent key (a row older than the field), an explicit
    null, and anything corrupt (a number, a boolean, an empty string) are all unattributed:
    charging money to a value that is not an id would bill an account that never spent it.
    server/src/spend/ledger.ts attributedUser() applies the same rule.
    """
    value = record.get("user_id")
    if isinstance(value, str) and value:
        return value
    return None


def _user_bucket():
    return {"spent_usd": 0.0, "unparsed_rows": 0, "entries": 0}


def totals(records):
    """Aggregate records into the numbers the cockpit and the cap gate both read.

    known_usd sums only the costs that were recovered. unparsed_rows counts what could not be,
    so the total can be presented as a floor with an honest caveat rather than as a precise
    figure that quietly omits rows.

    Where a program's cap was raised mid program, the last cap seen wins: that is the one in
    force now.

    users holds a bucket per attributed account, keyed by user_id, and unattributed holds every
    row that names none. A separate bucket rather than a reserved key, so no real id can collide
    with it, and so the buckets always add back up to the whole. Each carries its own
    unparsed_rows, because a per account figure is a floor for the same reason the total is.
    """
    known = 0.0
    unparsed = 0
    input_tokens = 0
    output_tokens = 0
    programs = {}
    users = {}
    unattributed = _user_bucket()

    for record in records:
        cost = _numeric(record.get("cost_usd"))
        if cost is None:
            unparsed += 1
        else:
            known += cost

        input_tokens += int(_numeric(record.get("input_tokens")) or 0)
        output_tokens += int(_numeric(record.get("output_tokens")) or 0)

        # Before the program bucket, which skips a row with no program: a row's account is a
        # separate fact from its program.
        user = attributed_user(record)
        owner = unattributed if user is None else users.setdefault(user, _user_bucket())
        owner["entries"] += 1
        if cost is None:
            owner["unparsed_rows"] += 1
        else:
            owner["spent_usd"] = _round(owner["spent_usd"] + cost)

        program = record.get("program")
        # Only a non empty string names a program. A list or dict here raised TypeError (it cannot
        # key a dict), a number or boolean raised when the report sorted it, and either took down
        # `totals`, `render` and check:spend-view. Read as no program, as ledger.ts does.
        if not isinstance(program, str) or not program:
            continue
        bucket = programs.setdefault(
            program, {"program": program, "spent_usd": 0.0, "cap_usd": None, "entries": 0}
        )
        bucket["entries"] += 1
        if cost is not None:
            bucket["spent_usd"] = _round(bucket["spent_usd"] + cost)
        cap = _numeric(record.get("cap_usd"))
        if cap is not None:
            bucket["cap_usd"] = cap

    return {
        "known_usd": _round(known),
        "unparsed_rows": unparsed,
        "entries": len(records),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "programs": programs,
        "users": users,
        "unattributed": unattributed,
    }


def _user_line(label, bucket):
    unknown = bucket["unparsed_rows"]
    return "user    %-26s $%10.6f across %d entries%s" % (
        label,
        bucket["spent_usd"],
        bucket["entries"],
        ", %d with no recoverable cost" % unknown if unknown else "",
    )


def format_totals(summary, malformed):
    """The `totals` subcommand's report, as lines.

    The per user section appears only once some row names an account. A ledger that has never
    seen user_id prints exactly what it printed before the field existed, byte for byte, so
    nothing reading this output has to learn about a field its ledger does not contain.
    """
    lines = [
        "known spend $%.6f across %d calls" % (summary["known_usd"], summary["entries"]),
        "%d input tokens, %d output tokens" % (summary["input_tokens"], summary["output_tokens"]),
    ]
    if summary["unparsed_rows"] or malformed:
        lines.append(
            "%d rows with no recoverable cost, %d malformed lines: the total is a FLOOR."
            % (summary["unparsed_rows"], malformed)
        )
    lines.append("")
    for name, bucket in sorted(summary["programs"].items()):
        cap = bucket["cap_usd"]
        lines.append(
            "program %-26s $%10.6f%s across %d entries"
            % (
                name,
                bucket["spent_usd"],
                " of $%.2f cap" % cap if cap is not None else "",
                bucket["entries"],
            )
        )
    if summary["users"]:
        lines.append("")
        for user_id, bucket in sorted(summary["users"].items()):
            lines.append(_user_line(user_id, bucket))
        if summary["unattributed"]["entries"]:
            lines.append(_user_line("(unattributed)", summary["unattributed"]))
    return lines


def _cost_cell(record):
    cost = _numeric(record.get("cost_usd"))
    if cost is None:
        return "unknown"
    marker = "" if record.get("cost_source") == "logged" else " approx"
    return "$%.*f%s" % (MONEY_PRECISION, cost, marker)


def render_markdown(project=DEFAULT_PROJECT, root=None, write=False):
    """Regenerate the human readable ledger from the JSONL.

    The markdown is a view now, not the source of truth, so it is safe to rebuild at any time.
    An unrecovered cost prints as "unknown" rather than as a zero, so reading the table cannot
    mislead.
    """
    records = load(project, root=root)
    summary = totals(records)
    target = markdown_path(project, root=root)

    if write and not records and os.path.isfile(target):
        # An empty ledger cannot be the source of truth for a markdown that already has
        # content. Writing here would replace a real record with a "$0.00" table, which is the
        # destructive case this guards.
        raise RefusedWrite("refusing to overwrite %s from an empty ledger" % target)

    lines = [
        "# %s API spend ledger" % project,
        "",
        "%s Do not edit by hand: append through the ledger module and" % GENERATED_BANNER,
        "regenerate this view.",
        "",
        "Known spend $%.4f across %d calls, %d input and %d output tokens."
        % (
            summary["known_usd"],
            summary["entries"],
            summary["input_tokens"],
            summary["output_tokens"],
        ),
    ]
    if summary["unparsed_rows"]:
        lines.append(
            "%d entries carry no recoverable cost, so the total above is a floor."
            % summary["unparsed_rows"]
        )

    lines += [
        "",
        "| ts | program | kind | model | in | out | cost | cap | note |",
        "|----|---------|------|-------|----|-----|------|-----|------|",
    ]

    for record in records:
        cap = _numeric(record.get("cap_usd"))
        lines.append(
            "| %s | %s | %s | %s | %s | %s | %s | %s | %s |"
            % (
                record.get("ts") or "",
                record.get("program") or "",
                record.get("kind") or "",
                record.get("model") or "",
                record.get("input_tokens") if record.get("input_tokens") is not None else "",
                record.get("output_tokens") if record.get("output_tokens") is not None else "",
                _cost_cell(record),
                "$%.2f" % cap if cap is not None else "",
                (record.get("note") or "").replace("|", " "),
            )
        )

    text = "\n".join(lines) + "\n"
    if write:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(text)
    return text


def _main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    totals_cmd = sub.add_parser("totals", help="print spend totals for a project")
    totals_cmd.add_argument("project", nargs="?", default=DEFAULT_PROJECT)

    render_cmd = sub.add_parser("render", help="regenerate the markdown view")
    render_cmd.add_argument("project", nargs="?", default=DEFAULT_PROJECT)
    render_cmd.add_argument(
        "--execute", action="store_true", help="write the file (default prints it)"
    )
    # Defaults to None, which ledger_path resolves to REPO_ROOT (the directory this script
    # lives in), so ordinary use against this repository's own out/ tree is unaffected. Exists
    # so a test can point the real CLI at a fixture ledger elsewhere on disk, the same way
    # render_markdown's own root parameter already lets a Python caller do, without that test
    # needing to write into or read from this repository's live spend ledger.
    render_cmd.add_argument(
        "--root", default=None, help="ledger root directory (default: this repository)"
    )

    args = parser.parse_args(argv)

    if args.command == "totals":
        try:
            records = load(args.project)
        except LedgerNotFound as error:
            # Not "spent nothing". An unreadable ledger is unknown spend, and saying zero here
            # is what lets a cap be blown through.
            print("%s" % error)
            print("Spend is UNKNOWN, which is not the same as zero.")
            return 1

        summary = totals(records)
        for line in format_totals(summary, malformed_lines(args.project)):
            print(line)
        return 0

    text = render_markdown(args.project, root=args.root, write=args.execute)
    if not args.execute:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
