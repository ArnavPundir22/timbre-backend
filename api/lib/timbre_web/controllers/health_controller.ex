defmodule TimbreWeb.HealthController do
  @moduledoc """
  Unauthenticated ops probes. `/healthz` is liveness (always 200 while the app
  runs); `/readyz` is readiness — it pings the database and returns 503 if it's
  unreachable. Neither goes through the `:accepts` plug, so bare load-balancer
  probes (no Accept header) work.
  """
  use TimbreWeb, :controller

  alias Timbre.Repo

  def live(conn, _params), do: json(conn, %{status: "ok"})

  def ready(conn, _params) do
    case Ecto.Adapters.SQL.query(Repo, "SELECT 1", []) do
      {:ok, _} ->
        json(conn, %{status: "ok"})

      {:error, _} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{status: "unavailable", check: "database"})
    end
  end
end
