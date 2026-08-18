{
  description = "timbre — Phoenix + React + Rust/WASM assignment scaffold";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-unstable,
      flake-utils,
      rust-overlay,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };
        pkgs-unstable = import nixpkgs-unstable { inherit system; };

        # Rust toolchain with the wasm target baked in. This bundles `rust-lld`
        # (the wasm linker) and the wasm32 std, so `wasm-pack build` works out of
        # the box — no `brew install lld`, no cargo-installing wasm-bindgen-cli.
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          targets = [ "wasm32-unknown-unknown" ];
        };

        baseDeps = with pkgs; [
          # Elixir toolchain (erlang 27 / elixir 1.18).
          erlang_27
          beam.packages.erlang_27.elixir_1_18

          # Web toolchain
          nodejs_22

          # Rust + WASM toolchain. wasm-bindgen-cli is pinned by nixpkgs; the
          # crate version in web/crates/timbre_kit/Cargo.toml is pinned to match,
          # so wasm-pack reuses this binary instead of building its own.
          rustToolchain
          wasm-pack
          wasm-bindgen-cli
          binaryen # wasm-opt, used by wasm-pack release builds

          # Tooling used by the justfile
          just
          jq
        ];

        devExtra =
          if builtins.getEnv "CI" != "true" then
            with pkgs;
            [
              nixfmt-rfc-style
              fswatch
              entr
            ]
            ++ [
              pkgs-unstable.fzf
            ]
          else
            [ ];

        all = baseDeps ++ devExtra;

        inherit (pkgs) inotify-tools terminal-notifier;
        inherit (pkgs.lib) optionals;
        inherit (pkgs.stdenv) isDarwin isLinux;

        linuxDeps = optionals isLinux [ inotify-tools ];
        darwinDeps = optionals isDarwin [ terminal-notifier ];
      in
      {
        devShells = {
          default = pkgs.mkShell {
            packages = all ++ linuxDeps ++ darwinDeps;
            shellHook = ''
              # this allows mix to work on the local directory
              mkdir -p .nix-mix .nix-hex
              export MIX_HOME=$PWD/.nix-mix
              export HEX_HOME=$PWD/.nix-hex
              # make hex from Nixpkgs available
              # `mix local.hex` will install hex into MIX_HOME and should take precedence
              export MIX_PATH="${pkgs.beam.packages.erlang_27.hex}/lib/erlang/lib/hex/ebin"
              export PATH=${pkgs.erlang_27}/bin:$MIX_HOME/bin:$HEX_HOME/bin:$MIX_HOME/escripts:$PWD/bin:$PATH
              export LANG=C.UTF-8
              # keep your shell history in iex
              export ERL_AFLAGS="-kernel shell_history enabled"

              export MIX_ENV=dev
            '';
          };
        };
      }
    );
}
