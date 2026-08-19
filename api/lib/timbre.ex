defmodule Timbre do
  @moduledoc """
  Timbre keeps the contexts that define your domain
  and business logic.

  Contexts are also responsible for managing your data, regardless
  if it comes from the database, an external API or others.
  """

  alias Timbre.Repo
  alias Timbre.Recording

  def list_recordings do
    Repo.all(Recording)
  end

  def get_recording!(id), do: Repo.get!(Recording, id)

  def get_recording(id), do: Repo.get(Recording, id)

  def create_recording(attrs \\ %{}) do
    %Recording{}
    |> Recording.changeset(attrs)
    |> Repo.insert()
  end

  def delete_recording(%Recording{} = recording) do
    Repo.delete(recording)
  end
end
