# timbre

A **Phoenix + React + Rust/WASM** scaffold — the starting point for the
full-stack engineering assignment. You'll be given a feature to build on top of
it. Using AI tools is expected and allowed — what matters is that you deeply
understand and can reason about the code you submit.

```
timbre/
├── api/                        Phoenix 1.8 JSON API + SQLite (Ecto) — :4010
│   └── lib/timbre_web/         controllers (health, hello) + router
├── web/                        Vite + React 19 + Tailwind 4 — :5173
│   ├── src/                    App.tsx — status of the API + WASM legs
│   └── crates/timbre_kit/      Rust → WASM (the DSP seam)
├── flake.nix                   pinned toolchain (Elixir, Node, Rust + wasm)
├── justfile                    setup / dev / build / test / db-*
└── ASSIGNMENT.md               the assignment brief
```

## Quick start

The whole toolchain (Elixir/OTP, Node, Rust + the `wasm32` target, `wasm-pack`,
`wasm-bindgen`, `just`) is pinned by the **Nix flake** — you don't install any of
it by hand.

```bash
# with Nix (flakes) + direnv:
direnv allow          # drops you into the dev shell automatically (uses flake.nix)
# ...or without direnv:
nix develop --impure  # same shell, one-off

just setup     # build WASM, install web deps, set up the API + SQLite DB
just dev       # API :4010 + web :5173 together
```

No Nix? Install the toolchain yourself — Elixir 1.18+, Node 22+, Rust via
[rustup](https://rustup.rs) (bundles the wasm linker), plus
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/) and
[`just`](https://github.com/casey/just) — then run the same `just` commands.

Open http://localhost:5173 — when both status dots turn blue, the full stack
(Phoenix API + Rust/WASM) is wired.

| Command          | What                                             |
| ---------------- | ------------------------------------------------ |
| `just setup`     | build WASM + install all deps                    |
| `just dev`       | run API and web together                         |
| `just api`       | Phoenix only (IEx-attached), :4010               |
| `just web`       | Vite dev server only, :5173                      |
| `just build-wasm`| recompile the Rust crate to WASM                 |
| `just build`     | production build of web + API                    |
| `just db-migrate`| run pending SQLite migrations                    |
| `just test`      | Rust (`cargo test`) + Elixir (`mix test`) suites |
| `just check`     | web typecheck + API format check                 |

Run `just --list` for everything else (`db-setup`, `db-gen-migration`, `db-reset`).

---

## 🎙️ Submission Notes — What Was Built

This repository has been updated with a complete implementation of the voice recording and processing assignment:

* **What was built**: A collaborative voice recorder where you can record audio locally, apply in-browser DSP audio effects (Gain, Normalize, Low-pass filter) via a Rust WebAssembly module (`timbre_kit`), save/delete files from the backend API, and join multiplayer sessions via a shared link to record and merge multiple microphone streams in real-time.
* **Architecture & Details**: Complete production-grade system documentation is structured into the following pages:
  * 📑 **[System Documentation Index](docs/README.md)** — Architectural overview and guide.
  * 🎛️ **[Rust WASM DSP Module](docs/wasm_dsp.md)** — In-browser audio processing and effects.
  * 💻 **[React Frontend Architecture](docs/frontend.md)** — Audio recording, playback, and Speech Recognition.
  * ⚙️ **[Phoenix Elixir API & DB Schema](docs/backend.md)** — Database models, Ecto migrations, and controllers.
  * 👥 **[Multiplayer Real-time Collaboration](docs/multiplayer.md)** — Real-time WebSockets, streaming, and channel mixing.
* **Deployed URL**: **[https://timbre-arnav.vercel.app](https://timbre-arnav.vercel.app)** (connected to Render API backend at `https://timbre-api-1eny.onrender.com`)

---

## 🚀 How to Run the App (Without Nix)

Since this workspace does not utilize Nix, the toolchain has been installed directly on the system. Run the following commands to start the servers:

1. **Load Environment & Toolchain**:
   Ensure Rustup and Elixir paths are loaded in your shell:
   ```bash
   . $HOME/.cargo/env
   export PATH=/home/dell/.local/elixir/bin:$PATH
   ```

2. **Run Development Servers**:
   Start both the backend Phoenix server and the frontend Vite server concurrently:
   ```bash
   just dev
   ```

3. **Verify and Play**:
   Navigate to [http://localhost:5173](http://localhost:5173) in your browser.


