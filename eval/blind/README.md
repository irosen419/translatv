# Blind translation test set

`sentences.jsonl` is the input to the blind model comparison planned in `docs/HANDOFF.md`
section 6 and run by `npm run blind` (see TESTING.md).

The 625 lines are SYNTHETIC. They were written for this test, as short invented conversations. They are not real call transcripts, nobody's
speech was recorded or kept to make them, and they contain no personal data. That is also why
the run outputs built from them may be committed.

One JSON object per line:

| field     | meaning                                                                   |
|-----------|---------------------------------------------------------------------------|
| `id`      | `b0001` to `b0625`, in file order                                         |
| `conv`    | the conversation the line belongs to; its lines are consecutive in the file |
| `seq`     | position in the conversation, from 1                                      |
| `src`     | dialect the line is spoken in                                             |
| `tgt`     | dialect it is translated into                                             |
| `text`    | the line                                                                  |
| `address` | who the line speaks to: `singular`, `plural`, or `none`                   |
| `tags`    | any of short, long, numbers, names, idiom, loanword, ambiguous            |

The five targets (es-AR, es-CO, es-MX, es-ES, en-US) have 125 lines each. `address` is what
lets the dialect marker checks run only where they mean something: voseo can only show up
when one person is spoken to, and vosotros only when several are.

## Validate

    python3 eval/blind/validate_sentences.py

Standard library only. It asserts the counts, the per target balance, the conversation
structure, that no line is duplicated, and that there is no em or en dash anywhere, then prints
a per target summary.
