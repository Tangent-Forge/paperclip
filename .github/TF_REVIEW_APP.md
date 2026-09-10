# TF fork review App identity

- Live App: `tfrm-review` (App ID **4541043**).
- Org installation ID (separate API surface; not printed by Actions mint logs): **152517939**.
- Required repository variables: `REVIEW_APP_ID`, `REVIEW_APP_SLUG`.
- Required repository secret: `REVIEW_APP_PRIVATE_KEY` (PEM). `COMMITPERCLIP_KEY` is a compatibility alias only.
- `get-bot-token.mjs` is **fail-closed**: missing `REVIEW_APP_ID` / `REVIEW_APP_SLUG` refuses to mint. Do not reintroduce hardcoded `3718661` / `commitperclip` auth defaults on adopt.
- Upstream `commitperclip` (App **3718661**) is not the TF review identity. Org install cleanup for that App is an owner blast-radius decision, not a repair for this path.
