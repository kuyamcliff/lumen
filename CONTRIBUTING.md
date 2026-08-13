# Contributing to Lumen

Thanks for helping out. Lumen aims to be the player people reach for
without thinking about it, which means the bar for changes is less "does
it work" and more "does it still feel effortless afterwards".

## Getting started

```bash
npm install
npm run dev        # Vite dev server — open /examples/index.html
npm test           # vitest
npm run typecheck
npm run build      # ESM + UMD + type declarations
npm run size       # build, then enforce the gzip budget
```

There's no build step for the examples: they're plain HTML and JavaScript
importing `/src/index.ts` directly through Vite.

## The rules that actually matter

**1. The size budget is not negotiable.**
The core bundle must stay under 30 kB gzipped (`npm run size` enforces
this). Anything large — a demuxer, a streaming engine, a codec shim —
belongs behind a dynamic `import()` so it code-splits into its own chunk
and only downloads when a page actually needs it. `src/remux/` is the
worked example.

**2. Never surface a raw browser error to a viewer.**
`MediaError: code 4` helps nobody. Every failure path should produce a
sentence a non-technical person can act on, routed through the
`LumenError` type with a code the embedding app can branch on.

**3. Degrade in useful steps.**
When something can't work, ask what still can. An undecodable audio track
means play the video and say why. An unparseable container means name the
format and suggest converting it. Refusing the whole file is the last
resort, not the first.

**4. Accessibility is part of the feature, not a follow-up.**
New controls need keyboard operation, a visible focus ring, an ARIA label
from the string table, and a 44px minimum touch target.

**5. All user-visible text goes through `src/i18n.ts`.**
No string literals in the UI layer. Add a key to `LumenStrings`, give it
an English default, and use `strings.t("key")`.

## Testing

Tests live in `test/` and run in jsdom. Two conventions worth knowing:

- **Build fixtures in code, not binaries.** `test/helpers/mkvBuilder.ts`
  constructs Matroska files programmatically so each test states exactly
  which structure it exercises. Prefer that over committing a binary blob
  whose relevant property is invisible.
- **Verify output with an independent implementation where you can.** The
  remux tests parse the muxer's output back with `mp4box.js` rather than
  asserting against bytes we wrote ourselves — a muxer that produces
  plausible-looking garbage passes the second kind of test and fails the
  first.

For anything touching playback, also check it in a real browser. jsdom has
no media stack: it will not catch a MediaSource ordering bug, a malformed
codec string, or a decoder rejecting your sample entry. Several of the
bugs found during development were invisible to unit tests and obvious in
Chrome within seconds.

## Architecture in one paragraph

`PlaybackEngine` decides *how* to play a source (native, hls.js, or a
remuxer) and knows nothing about the DOM. `ControlsController` owns all
interaction and talks to the engine only through its public surface and
the shared `EventEmitter`. `LumenPlayer` is the custom element that wires
them together and exposes the public API. That seam is deliberate: it's
where a headless build or an alternative skin would plug in, so please
don't reach across it.

## Pull requests

- One concern per PR.
- Include a test that would have failed before your change.
- Run `npm run typecheck && npm test && npm run size` before pushing.
- If you found a bug while building, say so in the description — how a bug
  was caught is often more useful to the next person than the fix.

## License

By contributing, you agree your contributions are licensed under the MIT
license that covers the project.
