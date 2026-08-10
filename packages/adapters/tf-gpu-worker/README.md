# @paperclipai/adapter-tf-gpu-worker

Bounded TF-007 GPU worker lane. TF-Home stays canonical: this adapter stages an
immutable source directory to TF-007, runs one allowlisted command, and returns
checksummed artifacts. When TF-007 is offline the job is queued on TF-Home and
Paperclip receives a retryable result. Ships `enabled: false` by default.

## Provenance

This package was previously **untracked** in the paperclip working tree and was
registered as an external local-path adapter plugin. On 2026-08-05 a `git clean -fd`
in `repos/paperclip` deleted every untracked package, taking this one's
`package.json` and `src/` with it — `node_modules/` and `dist/` survived only
because they are gitignored. The adapter then failed to load on the next restart
and the live registry dropped from 16 adapters to 15, orphaning the TF-007 GPU
Worker agent.

The original TypeScript was never committed anywhere, no backup under
`~/backups/paperclip-adapter-repair` contained it, and the emitted source maps
carried no `sourcesContent`. `src/index.ts` was therefore reconstructed on
2026-08-06 by re-typing the surviving `dist/index.js` against `dist/index.d.ts`.

Fidelity is verified by construction: rebuilding this source produces `dist/index.js`,
`dist/index.d.ts`, and `dist/index.test.js` that are **byte-identical** to the
originals that were running in production.

It is tracked here so a `git clean` cannot destroy it again.
