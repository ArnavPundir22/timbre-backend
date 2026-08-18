defmodule Timbre.Repo.Migrations.AddTranscriptAndSummaryToRecordings do
  use Ecto.Migration

  def change do
    alter table(:recordings) do
      add :transcript, :text
      add :summary, :text
    end
  end
end
