defmodule TimbreWeb.FallbackController do
  use TimbreWeb, :controller

  def index(conn, _params) do
    path = Path.join(:code.priv_dir(:timbre), "static/index.html")

    if File.exists?(path) do
      conn
      |> put_resp_header("content-type", "text/html")
      |> send_file(200, path)
    else
      conn
      |> put_status(:not_found)
      |> put_resp_header("content-type", "text/plain")
      |> send_resp(404, "Static index.html not found. Please build the frontend.")
    end
  end
end
