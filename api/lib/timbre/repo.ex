defmodule Timbre.Repo do
  use Ecto.Repo,
    otp_app: :timbre,
    adapter: Ecto.Adapters.SQLite3
end
