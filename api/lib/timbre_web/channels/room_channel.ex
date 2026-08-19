defmodule TimbreWeb.RoomChannel do
  use TimbreWeb, :channel

  def join("room:" <> room_id, _payload, socket) do
    uploads_dir()
    {:ok, assign(socket, :room_id, room_id)}
  end

  # When user joins room, broadcast user_joined to sync participants list
  def handle_in("user_joined", payload, socket) do
    user_id = payload["user_id"] || socket.assigns[:user_id] || "User_Anon"
    socket = assign(socket, :user_id, user_id)
    broadcast!(socket, "user_joined", %{user_id: user_id})
    {:reply, :ok, socket}
  end

  # When recording starts, client sends "start_recording" with their user_id
  def handle_in("start_recording", payload, socket) do
    user_id = payload["user_id"] || socket.assigns[:user_id] || "User_Anon"
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
  def handle_in("audio_chunk", payload, socket) do
    room_id = socket.assigns.room_id
    user_id = payload["user_id"] || socket.assigns[:user_id]
    base64_data = payload["data"]

    if user_id && base64_data do
      file_path = temp_file_path(room_id, user_id)

      case Base.decode64(base64_data, ignore: :whitespace) do
        {:ok, binary_data} ->
          File.write!(file_path, binary_data, [:append, :binary])

        _ ->
          :ok
      end
    end

    {:noreply, socket}
  end

  # When recording stops, host sends "stop_recording"
  def handle_in("stop_recording", params, socket) do
    room_id = socket.assigns.room_id
    title = Map.get(params, "title", "Merged Multiplayer Session")
    dir = uploads_dir()

    # Find ALL temp raw audio files created for this room session
    pattern = Path.join(dir, "temp_#{room_id}_*.raw")
    existing_paths = Path.wildcard(pattern)

    paths_to_mix =
      if existing_paths != [] do
        existing_paths
      else
        fallback_file = Path.join(dir, "temp_#{room_id}_fallback.raw")
        silence_bytes = :binary.copy(<<0, 0>>, 44100)
        File.write!(fallback_file, silence_bytes, [:write, :binary])
        [fallback_file]
      end

    unique_filename = "merged_#{room_id}_#{System.system_time(:millisecond)}.wav"
    output_wav_path = Path.join(dir, unique_filename)

    # Mix PCM files
    mix_pcm_files(paths_to_mix, output_wav_path)

    # Clean up temporary raw files
    Enum.each(paths_to_mix, &File.rm/1)

    # Calculate duration (rough estimate from file size)
    # 16-bit, 44100Hz mono = 88200 bytes/sec
    duration =
      case File.stat(output_wav_path) do
        {:ok, stat} -> max(0.0, (stat.size - 44) / 88200.0)
        _ -> 0.0
      end

    # Find and combine all transcript text files for this room
    txt_pattern = Path.join(dir, "temp_#{room_id}_*.txt")
    txt_files = Path.wildcard(txt_pattern)

    transcripts =
      Enum.map(txt_files, fn txt_path ->
        content = File.read!(txt_path)
        File.rm!(txt_path)
        String.trim(content)
      end)
      |> Enum.filter(&(&1 != ""))
      |> Enum.join("\n")

    transcript =
      if transcripts != "" do
        transcripts
      else
        "Multiplayer voice session recording."
      end

    summary =
      if transcripts != "" do
        "Multiplayer mixed session. Highlights: " <> String.slice(transcript, 0, 150) <> "..."
      else
        "Multiplayer mixed session of #{Float.round(duration, 1)}s duration."
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
  end

  def handle_in("submit_transcript", payload, socket) do
    room_id = socket.assigns.room_id
    user_id = payload["user_id"] || socket.assigns[:user_id]
    transcript = payload["transcript"]

    if user_id && transcript && String.trim(transcript) != "" do
      file_path = Path.join(uploads_dir(), "temp_#{room_id}_#{user_id}.txt")
      File.write!(file_path, String.trim(transcript))
    end

    {:noreply, socket}
  end

  defp temp_file_path(room_id, user_id) do
    Path.join(uploads_dir(), "temp_#{room_id}_#{user_id}.raw")
  end

  defp uploads_dir do
    dir = Path.join(System.tmp_dir!(), "timbre_uploads")
    File.mkdir_p!(dir)
    dir
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
