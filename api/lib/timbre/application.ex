defmodule Timbre.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      TimbreWeb.Telemetry,
      Timbre.Repo,
      {DNSCluster, query: Application.get_env(:timbre, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Timbre.PubSub},
      # Start a worker by calling: Timbre.Worker.start_link(arg)
      # {Timbre.Worker, arg},
      # Start to serve requests, typically the last entry
      TimbreWeb.Endpoint
    ]

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Timbre.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    TimbreWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
