defmodule Timbre.Repo.Migrations.CreateRecordings do
  use Ecto.Migration

  def change do
    create table(:recordings) do
      add :title, :string
      add :filename, :string
      add :duration_seconds, :float

      timestamps()
    end
  end
end
