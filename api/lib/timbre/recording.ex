defmodule Timbre.Recording do
  use Ecto.Schema
  import Ecto.Changeset

  schema "recordings" do
    field(:title, :string)
    field(:filename, :string)
    field(:duration_seconds, :float)
    field(:transcript, :string)
    field(:summary, :string)

    timestamps()
  end

  @doc false
  def changeset(recording, attrs) do
    recording
    |> cast(attrs, [:title, :filename, :duration_seconds, :transcript, :summary])
    |> validate_required([:title, :filename])
  end
end
