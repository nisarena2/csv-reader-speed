# csv-reader-speed

A faster drop-in for csv-reader 1.0.0 — it reads broken CSV files exactly as
the reference does, only faster.

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/nisarena2/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/nisarena2/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

Built for [Read broken CSV files faster, 21 November 2026](https://make.fun/bounty/csv-reader-speed-01-run-20261121) on make.fun.

## What it does

`solve.js` exports `run(input)`, which returns csv-reader 1.0.0's answer
`{columns, rows, errors}` for a case input `{text, header}` — the same
broken-row policy, in the same order: a U+FEFF at the start is dropped,
records end at LF or CRLF, empty lines are no record, a CR outside quotes
that is not followed by LF is dropped (`stray_cr`), a field that opens with
a quote runs to the next undoubled quote with `""` read as one quote and
each CRLF or lone CR inside it read as LF, text after a closing quote is
appended as it stands (`quote_junk`), a quote that never closes is a
literal and the rest is read again as unquoted (`unterminated_quote`), and
rows are padded (`short_row`) or cut (`long_row`) to the first record's
width.

## How it is faster

The reference reads one character at a time and builds every field up a
character at a time. This reader does the same reading, but in slices: it
finds the next comma, line break or quote with `indexOf` and takes whole
fields with `slice`. A whole clean line — no quote, no stray CR — is one
`split`. Quoted stretches are taken as one slice, with CRLF and lone CR
inside them turned into LF in a single pass. No dependencies, no
WebAssembly, no native code; plain Node 22 JavaScript.

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each one alone with `run`, and writes
`/output/answers.json`.

## License

MIT. See [LICENSE](LICENSE).
