# Synthetic PDF fixtures (F1–F3)

Small, synthetic files with no personal data (C3), used by `tests/unit/validate-pdf.test.ts` and the storage tests.

| File | Content | Expected |
|---|---|---|
| `valid.pdf` | One page with "Synthetic test document", made with `pdf-lib` | ok |
| `png-renamed.pdf` | A 1×1 PNG with a `.pdf` name | `NOT_PDF` |
| `leading-space.pdf` | `valid.pdf` with one space before `%PDF-` | `NOT_PDF` |
| `user-password.pdf` | `qpdf --encrypt user-secret owner-secret 256 -- valid.pdf user-password.pdf` | `ENCRYPTED` |
| `permissions-only.pdf` | `qpdf --encrypt "" owner-secret 256 --print=none --modify=none -- valid.pdf permissions-only.pdf` (opens without a password) | `ENCRYPTED` |
| `truncated.pdf` | The first 300 bytes of `valid.pdf` | `DAMAGED` |
| `empty.pdf` | 0 bytes | `EMPTY` |

The 5 MiB and 5 MiB + 1 byte cases are built from `valid.pdf` in the test (padded with a trailing `%` comment) rather than committed as two 5 MiB files.
