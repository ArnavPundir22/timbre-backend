defmodule TimbreWeb.RoomChannel do
  use TimbreWeb, :channel

  @uploads_dir Path.expand("priv/static/uploads", File.cwd!())

  def join("room:" <> room_id, _payload, socket) do
    File.mkdir_p!(@uploads_dir)
    {:ok, assign(socket, :room_id, room_id)}
  end

  # When recording starts, client sends "start_recording" with their user_id
  def handle_in("start_recording", %{"user_id" => user_id}, socket) do
    room_id = socket.assigns.room_id
    file_path = temp_file_path(room_id, user_id)

    # Initialize/clear file
    File.write!(file_path, <<>>, [:write, :binary])

    # Track user_id in socket state
    socket = assign(socket, :user_id, user_id)
    broadcast!(socket, "recording_started", %{user_id: user_id})
    {:reply, :ok, socket}
  end

  # Stream audio chunks: client sends raw PCM bytes in base64 format
  def handle_in("audio_chunk", %{"data" => base64_data}, socket) do
    room_id = socket.assigns.room_id
    user_id = socket.assigns.user_id

    if user_id do
      file_path = temp_file_path(room_id, user_id)
      binary_data = Base.decode64!(base64_data)
      File.write!(file_path, binary_data, [:append, :binary])
    end

    {:noreply, socket}
  end

  # When recording stops, host sends "stop_recording" with list of user_ids in the session
  def handle_in("stop_recording", %{"user_ids" => user_ids, "title" => title}, socket) do
    room_id = socket.assigns.room_id

    # Find all temp files for this room session
    file_paths = Enum.map(user_ids, fn uid -> temp_file_path(room_id, uid) end)
    existing_paths = Enum.filter(file_paths, &File.exists?/1)

    if existing_paths != [] do
      unique_filename = "merged_#{room_id}_#{System.system_time(:millisecond)}.wav"
      output_wav_path = Path.join(@uploads_dir, unique_filename)

      # Mix PCM files
      mix_pcm_files(existing_paths, output_wav_path)

      # Clean up temporary raw files
      Enum.each(existing_paths, &File.rm/1)

      # Calculate duration (rough estimate from file size)
      # 16-bit, 44100Hz mono = 88200 bytes/sec
      duration =
        case File.stat(output_wav_path) do
          {:ok, stat} -> max(0.0, (stat.size - 44) / 88200.0)
          _ -> 0.0
        end

      # Read transcripts from temporary text files submitted by participants
      transcripts =
        Enum.map(user_ids, fn uid ->
          txt_path = Path.join(@uploads_dir, "temp_#{room_id}_#{uid}.txt")

          if File.exists?(txt_path) do
            content = File.read!(txt_path)
            File.rm!(txt_path)
            "#{uid}: #{String.trim(content)}"
          else
            nil
          end
        end)
        |> Enum.filter(& &1)
        |> Enum.join("\n")

      transcript =
        if transcripts != "" do
          transcripts
        else
          "No speech detected in this multiplayer session."
        end

      summary =
        if transcripts != "" do
          "Multiplayer mixed session. Highlights: " <> String.slice(transcript, 0, 150) <> "..."
        else
          "Multiplayer mixed session of #{Float.round(duration, 1)}s with no speech detected."
        end

      attrs = %{
        "title" => title,
        "filename" => unique_filename,
        "duration_seconds" => duration,
        "transcript" => transcript,
        "summary" => summary
      }

      case Timbre.create_recording(attrs) do
        {:ok, recording} ->
          recording_json = TimbreWeb.RecordingJSON.data(recording)
          broadcast!(socket, "recording_merged", %{recording: recording_json})
          {:reply, {:ok, %{recording: recording_json}}, socket}

        {:error, _changeset} ->
          {:reply, {:error, %{message: "Database insertion failed"}}, socket}
      end
    else
      {:reply, {:error, %{message: "No audio streams found"}}, socket}
    end
  end

  def handle_in("submit_transcript", %{"transcript" => transcript}, socket) do
    room_id = socket.assigns.room_id
    user_id = socket.assigns.user_id

    if user_id && String.trim(transcript) != "" do
      file_path = Path.join(@uploads_dir, "temp_#{room_id}_#{user_id}.txt")
      File.write!(file_path, String.trim(transcript))
    end

    {:noreply, socket}
  end

  defp temp_file_path(room_id, user_id) do
    Path.join(@uploads_dir, "temp_#{room_id}_#{user_id}.raw")
  end

  defp mix_pcm_files(file_paths, output_wav_path, sample_rate \\ 44100) do
    binaries = Enum.map(file_paths, &File.read!/1)
    mixed_binary = mix_binaries(binaries, []) |> :erlang.list_to_binary()
    write_wav(output_wav_path, mixed_binary, sample_rate)
  end

  defp mix_binaries(binaries, acc) do
    if Enum.all?(binaries, &(&1 == <<>>)) do
      Enum.reverse(acc)
    else
      {sum, next_binaries} =
        Enum.map_reduce(binaries, 0, fn
          <<sample::signed-integer-size(16)-little, rest::binary>>, acc_sum ->
            {rest, acc_sum + sample}

          <<>>, acc_sum ->
            {<<>>, acc_sum}

          _other, acc_sum ->
            {<<>>, acc_sum}
        end)

      clamped = max(min(sum, 32767), -32768)
      mix_binaries(next_binaries, [<<clamped::signed-integer-size(16)-little>> | acc])
    end
  end

  defp write_wav(path, data_binary, sample_rate) do
    data_size = byte_size(data_binary)
    file_size = 36 + data_size

    header = <<
      "RIFF",
      file_size::little-integer-size(32),
      "WAVE",
      "fmt ",
      # format chunk size
      16::little-integer-size(32),
      # PCM format
      1::little-integer-size(16),
      # 1 channel (mono)
      1::little-integer-size(16),
      sample_rate::little-integer-size(32),
      # byte rate
      sample_rate * 2::little-integer-size(32),
      # block align
      2::little-integer-size(16),
      # bits per sample
      16::little-integer-size(16),
      "data",
      data_size::little-integer-size(32)
    >>

    File.write!(path, header <> data_binary)
  end
end
