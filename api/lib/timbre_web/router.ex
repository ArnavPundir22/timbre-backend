defmodule TimbreWeb.Router do
  use TimbreWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  # Ops probes — unauthenticated, no `:accepts` plug so bare LB/k8s probes work.
  scope "/", TimbreWeb do
    get "/healthz", HealthController, :live
    get "/readyz", HealthController, :ready
  end

  scope "/api", TimbreWeb do
    pipe_through :api

    get "/hello", HelloController, :show
    resources "/recordings", RecordingController, only: [:index, :create, :show, :delete]
  end

  scope "/", TimbreWeb do
    get "/*path", FallbackController, :index
  end
end
