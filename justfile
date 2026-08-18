# timbre — assignment scaffold. Phoenix API + React/Vite web + Rust→WASM.
# `just setup` once, then `just dev`. Run `just --list` to see everything.

set shell := ["bash", "-Eeuo", "pipefail", "-c"]

# Default recipe shows available commands
default:
    @just --list --unsorted

# --- setup -----------------------------------------------------------------

# One-shot: build the WASM package, install web deps, set up the API + database.
setup: build-wasm
    cd web && npm install
    cd api && mix setup

# --- database (SQLite, api/.tmp/) ------------------------------------------

# Create the database and run migrations.
db-setup:
    cd api && mix ecto.setup

# Run pending migrations.
db-migrate:
    cd api && mix ecto.migrate

# New migration: `just db-gen-migration create_recordings`.
db-gen-migration name:
    cd api && mix ecto.gen.migration {{name}}

# Drop and recreate the database from scratch.
db-reset:
    cd api && mix ecto.reset

# --- dev -------------------------------------------------------------------

# Run API (:4010) and web (:5173) together. Ctrl-C stops both.
dev:
    #!/usr/bin/env bash
    set -Eeuo pipefail
    (cd api && mix phx.server) &
    api_pid=$!
    trap 'kill $api_pid 2>/dev/null || true' EXIT
    cd web && npm run dev

# Phoenix API only, on http://localhost:4010 (IEx-attached).
api:
    cd api && iex -S mix phx.server

# Web dev server only, on http://localhost:5173 (proxies /api -> :4010).
web:
    cd web && npm run dev

# --- build -----------------------------------------------------------------

# Compile the Rust crate to WASM (web/crates/timbre_kit/pkg).
build-wasm:
    cd web && npm run build:wasm

# Production build of everything.
build: build-wasm
    cd web && npm run build
    cd api && MIX_ENV=prod mix compile

# --- quality ---------------------------------------------------------------

# Run the Rust + Elixir test suites.
# Force MIX_ENV=test — the nix shell exports MIX_ENV=dev, which would otherwise
# override `mix test`'s implicit test env and compile the wrong paths/config.
test:
    cd web/crates/timbre_kit && cargo test
    cd api && MIX_ENV=test mix test

# Type-check the web app + format-check the API.
check:
    cd web && npm run typecheck
    cd api && mix format --check-formatted
