defmodule TimbreWeb.ChangesetJSON do
  @doc """
  Renders changeset errors.
  """
  def render("error.json", %{changeset: changeset}) do
    # Simply serialize the errors into a map of field -> list of messages
    %{errors: Ecto.Changeset.traverse_errors(changeset, &translate_error/1)}
  end

  defp translate_error({msg, opts}) do
    # You can be more sophisticated here, but this is simple and robust
    Enum.reduce(opts, msg, fn {key, value}, acc ->
      String.replace(acc, "%{#{key}}", to_string(value))
    end)
  end
end
