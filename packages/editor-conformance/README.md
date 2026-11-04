# Editor conformance

Checks highlighting, Quick Info and editing of TS++ sources without anyone looking at an editor. It runs the real TextMate
engine with the real TypeScript grammar and several themes, and the built tsserver over its protocol, on every example.
Nothing is compared with an expected colour: what a thing is must decide how it renders, and where it stands must not.

```bash
pnpm --filter @tspp/editor-conformance test
```

```bash
node src/report.cjs [--grammar|--tree|--service|--editing] [project filter]
```

| Rules | What they hold |
| --- | --- |
| `grammar/*` | Plugin grammars stay out of comments and strings, no state leaks into later statements, `export` changes nothing else, and syntax in `test/editor-parity.json` of a plugin renders like the TypeScript beside it. |
| `tree/*` | Parsing a file, with a character removed or cut off at any token, ends, and gives a tree whose children lie inside their parents. |
| `service/*` | Semantic tokens are whole words, sorted and without overlaps. |
| `hover/*` | Quick Info exists, covers the word, and shows no `any`, `(Missing)`, lowering or generated names. |
| `consistency/*` | One symbol, plugin role or keyword renders one way in every theme. |
| `editing/*` | Everything an editor asks after a keystroke answers, within a time limit, and an edited file answers like a fresh one. |

`known-gaps.json` counts the findings not fixed yet, by rule and file, and can only shrink: more findings than it lists
fail the test, and so do fewer, until it is updated with `node src/report.cjs --write-gaps`. Never raise a count to get a
test to pass without saying why in review.
