import Config

# SQLite test database. The sandbox pool isolates each test in a transaction.
config :timbre, Timbre.Repo,
  database: Path.expand("../.tmp/timbre_test.db", __DIR__),
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: 5

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :timbre, TimbreWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "NSQjb4xXC/ukIOQDpFk+KhoVIMcM1vmGr7pEbBUrctGRgpGRABQnrB4FMVpjeGbh",
  server: false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true
