# Stage 1: Build the Rust WASM package
FROM rust:1.80-slim AS rust-builder
RUN apt-get update && apt-get install -y curl pkg-config build-essential libssl-dev
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
RUN npm install -g wasm-pack
WORKDIR /app/web
COPY web/crates/crates.md ./crates/
COPY web/crates/timbre_kit/Cargo.toml ./crates/timbre_kit/
COPY web/crates/timbre_kit/src ./crates/timbre_kit/src/
RUN wasm-pack build ./crates/timbre_kit --target web

# Stage 2: Build the React static assets
FROM node:22-slim AS node-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY --from=rust-builder /app/web/crates/timbre_kit/pkg ./crates/timbre_kit/pkg/
RUN npm run build

# Stage 3: Build the Phoenix release
FROM hexpm/elixir:1.17.2-erlang-27.0.1-debian-bookworm-20240612-slim AS elixir-builder
RUN apt-get update -y && apt-get install -y build-essential git && apt-get clean -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app/api
RUN mix local.hex --force && mix local.rebar --force
ENV MIX_ENV="prod"
COPY api/mix.exs api/mix.lock ./
RUN mix deps.get --only prod
RUN mix deps.compile
COPY api/config ./config
COPY api/lib ./lib
COPY api/priv ./priv
COPY --from=node-builder /app/web/dist ./priv/static/
RUN mix compile
RUN mix release

# Stage 4: Execution runner image
FROM debian:bookworm-slim
RUN apt-get update -y && apt-get install -y libsqlite3-0 openssl curl && apt-get clean -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=elixir-builder /app/api/_build/prod/rel/timbre ./
ENV PORT=8080
ENV DATABASE_PATH="/data/timbre.db"
ENV MIX_ENV="prod"
ENV PHX_SERVER="true"
RUN mkdir -p /data
EXPOSE 8080
CMD ["/app/bin/timbre", "start"]
