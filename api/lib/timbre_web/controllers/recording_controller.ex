defmodule TimbreWeb.RecordingController do
  use TimbreWeb, :controller

  def index(conn, _params) do
    recordings = Timbre.list_recordings()
    render(conn, :index, recordings: recordings)
  end

  def create(
        conn,
        %{"title" => title, "audio" => %Plug.Upload{path: temp_path, filename: original_filename}} =
          params
      ) do
    # Ensure uploads directory exists
    dir = uploads_dir()

    # Generate unique filename
    ext =
      case Path.extname(original_filename) do
        "" -> ".wav"
        other -> other
      end

    unique_filename = "#{System.system_time(:millisecond)}_#{:rand.uniform(1000)}#{ext}"
    dest_path = Path.join(dir, unique_filename)

    # Copy file from temp location
    File.cp!(temp_path, dest_path)

    # Parse duration
    duration =
      case Map.get(params, "duration_seconds") do
        val when is_binary(val) ->
          case Float.parse(val) do
            {f, _} -> f
            :error -> 0.0
          end

        val when is_number(val) ->
          val * 1.0

        _ ->
          0.0
      end

    transcript = Map.get(params, "transcript") || "No transcript provided."
    summary = Map.get(params, "summary") || "No summary provided."

    attrs = %{
      "title" => title,
      "filename" => unique_filename,
      "duration_seconds" => duration,
      "transcript" => transcript,
      "summary" => summary
    }

    case Timbre.create_recording(attrs) do
      {:ok, recording} ->
        conn
        |> put_status(:created)
        |> render(:show, recording: recording)

      {:error, changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> put_view(TimbreWeb.ChangesetJSON)
        |> render("error.json", changeset: changeset)
    end
  end

  def show(conn, %{"id" => id}) do
    recording = Timbre.get_recording!(id)
    file_path = Path.join(uploads_dir(), recording.filename)

    if File.exists?(file_path) do
      conn
      |> put_resp_content_type("audio/wav")
      |> send_file(200, file_path)
    else
      conn
      |> put_status(:not_found)
      |> put_view(TimbreWeb.ErrorJSON)
      |> render("404.json")
    end
  end

  def delete(conn, %{"id" => id}) do
    recording = Timbre.get_recording!(id)
    file_path = Path.join(uploads_dir(), recording.filename)

    if File.exists?(file_path) do
      File.rm!(file_path)
    end

    {:ok, _recording} = Timbre.delete_recording(recording)

    send_resp(conn, 204, "")
  end

  defp uploads_dir do
    dir = Path.join(System.tmp_dir!(), "timbre_uploads")
    File.mkdir_p!(dir)
    dir
  end
end
