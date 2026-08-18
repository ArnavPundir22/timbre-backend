# timbre

A starter scaffold for a full-stack assignment. Stack: **Elixir/Phoenix API +
React web + Rust/WASM**.

> This is an interview take-home assignment.

## Layout

- `api/` — Phoenix 1.8 JSON API on **:4010**, backed by a SQLite database
  (Ecto; the db file lives in `api/.tmp/`, gitignored).
- `web/` — Vite + React + Tailwind on **:5173**; proxies `/api/*` → :4010, so
  there is one origin and no CORS.
- `web/crates/timbre_kit/` — Rust compiled to WebAssembly (`wasm-pack`). This is
  the DSP seam: the browser hands raw PCM audio to Rust and gets samples back.

## Commands

The toolchain is pinned by the Nix flake — run `direnv allow` (or
`nix develop --impure`) to enter the dev shell before anything else. Without Nix,
install Elixir 1.18+, Node 22+, Rust via rustup, `wasm-pack`, and `just`.

- `just setup` — build WASM, install web + Elixir deps (run once).
- `just dev` — API (:4010) + web (:5173) together.
- `just test` — Rust (`cargo test`) + Elixir (`mix test`) suites.
- `just check` — web typecheck + Elixir format check.

Run `just --list` for the rest (`api`, `web`, `build-wasm`, `build`).

## Notes

- The web app is a pure Phoenix client — no server logic in `web/`; new backend
  behavior is a controller in `api/lib/timbre_web/` plus a route in `router.ex`.
- Persistence is SQLite via Ecto (`Timbre.Repo`). Add a migration with
  `just db-gen-migration <name>`, then `just db-migrate`.
- `web/crates/timbre_kit/Cargo.toml` pins `wasm-bindgen` to the flake's
  `wasm-bindgen-cli` version — bump both together or `wasm-pack` will rebuild it.
