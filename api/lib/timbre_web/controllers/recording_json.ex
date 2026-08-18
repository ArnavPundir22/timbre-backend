defmodule TimbreWeb.RecordingJSON do
  alias Timbre.Recording

  def index(%{recordings: recordings}) do
    %{data: Enum.map(recordings, &data/1)}
  end

  def show(%{recording: recording}) do
    %{data: data(recording)}
  end

  def data(%Recording{} = recording) do
    %{
      id: recording.id,
      title: recording.title,
      filename: recording.filename,
      duration_seconds: recording.duration_seconds,
      transcript: recording.transcript,
      summary: recording.summary,
      inserted_at: recording.inserted_at,
      url: "/api/recordings/#{recording.id}"
    }
  end
end
