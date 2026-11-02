# Fonts

The three typefaces the platform renders in, committed here so that no build and
no deploy depends on Google's servers. Loaded by `app/layout.tsx` through
`next/font/local`; the roles (Archivo is signage, Figtree is anything a person
reads, JetBrains Mono is data) are explained there and in
`WHY-ITS-BUILT-THIS-WAY.md`.

**These are the exact files Google Fonts was serving** to `next/font/google` for
`subsets: ["latin"]` on 2026-10-30: the latin-subset, weight-axis variable
woff2 for each family. Switching from the Google loader to these files changed
no glyph. Each is a variable font, so one file covers every weight the layout
declares.

| File | Family | Weights declared | Fetched from |
|---|---|---|---|
| `archivo-latin-wght.woff2` | Archivo | 500 to 700 | `https://fonts.gstatic.com/s/archivo/v25/k3kPo8UDI-1M0wlSV9XAw6lQkqWY8Q82sLydOxI.woff2` |
| `figtree-latin-wght.woff2` | Figtree | 400 to 600 | `https://fonts.gstatic.com/s/figtree/v9/_Xms-HUzqDCFdgfMm4S9DQ.woff2` |
| `jetbrains-mono-latin-wght.woff2` | JetBrains Mono | 400 to 500 | `https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2` |

All three are under the SIL Open Font License 1.1; the licence text for each is
beside it (`OFL-*.txt`, from the `google/fonts` repository). The OFL permits
bundling and redistribution with the software that uses them.

## Refreshing a file

Only if a family ships a fix worth having. Ask Google's CSS API for the family
with a browser user agent (it serves woff2 only to a browser that says it can
take it), take the URL from the `/* latin */` block, download it over the
existing name, and check that the `font-weight` axis still spans what
`app/layout.tsx` declares:

```
curl -A "Mozilla/5.0 ... Chrome/130.0.0.0 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap"
```

Do not add `next/font/google` back; `tests/design-tokens.test.ts` fails the
build if it is imported anywhere under `app/`.
