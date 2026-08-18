defmodule TimbreWeb.HelloController do
  @moduledoc """
  Trivial demo endpoint proving the web client can reach Phoenix through the
  Vite proxy. Replace/extend this with the real API surface for your feature.
  """
  use TimbreWeb, :controller

  @vsn Mix.Project.config()[:version]

  def show(conn, _params) do
    json(conn, %{
      service: "timbre-api",
      version: @vsn,
      message: "Phoenix is up. Build your feature here."
    })
  end
end
