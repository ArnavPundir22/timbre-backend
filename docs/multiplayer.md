# Multiplayer Channels & Audio Sum-Mix Engine

Collaborative, multi-user recording sessions are coordinated using **Phoenix Channels** over real-time WebSockets. This allows multiple browser clients to synchronize recording states and stream microphone audio simultaneously.

---

## 🔌 1. Real-Time Streaming Flow

The multiplayer communication follows this sequence:

```
Participant A (JS) ──> [PCM Chunks] ──(WebSocket Base64)──> [RoomChannel] ──> Append to temp_room_A.raw
Participant B (JS) ──> [PCM Chunks] ──(WebSocket Base64)──> [RoomChannel] ──> Append to temp_room_B.raw
```

1. **Join Room**: Clients connect to the UserSocket (`ws://localhost:5173/socket`) and join a specific room channel topic: `"room:<room_id>"`.
2. **Start Session**: When the host starts recording:
   * A `"start_recording"` event is sent to the server.
   * The server initializes empty temporary raw PCM files on disk for each participant: `priv/static/uploads/temp_<room_id>_<user_id>.raw`.
3. **Audio Streaming**: 
   * The client's microphone captures audio buffers.
   * The client converts these buffers to 16-bit signed PCM integers, encodes them into Base64, and pushes them through the WebSocket.
   * The server decodes the Base64 chunks and appends the binary bytes in-place to the participant's `.raw` file.

---

## 🎚️ 2. Audio Merging & Sum-Mix Engine

When the host clicks **Stop & Merge Session**:
1. A `"stop_recording"` request is sent with the list of participant IDs.
2. The server reads all `.raw` temporary streams for that room.
3. It mixes the streams together sample-by-sample using a **Sum-and-Clamp mixing algorithm** in Elixir.

### The Sum-and-Clamp Mixing Algorithm:
When combining multiple audio streams, we must add the corresponding amplitude samples. However, simply adding them can exceed the maximum boundary of a 16-bit integer (\(-32768\) to \(32767\)), causing severe digital clipping distortion.

To prevent this, the mixer clamps the summed value to the minimum/maximum bounds:

```elixir
# In Elixir (room_channel.ex):
sum = Enum.sum(samples_at_t)
clamped_sample = max(min(sum, 32767), -32768)
```

### Steps executed during merge:
1. **Read Streams**: Reads the raw binary bytes of all participant files.
2. **Convert to Ints**: Matches the little-endian 16-bit signed integers: `for <<val::signed-integer-size(16)-little <- binary>>, do: val`.
3. **Length Matching**: Identifies the longest stream and pads shorter streams with zeros (silence) so all tracks are aligned.
4. **Mix & Clamp**: Combines corresponding samples and clamps them to the valid Int16 range.
5. **WAV Encoding**: Encodes the mixed data back into binary bytes, prefixes it with a standard 44-byte WAVE header (44.1kHz, Mono, 16-bit), and writes the `.wav` file to the uploads directory.
6. **Clean Up**: Deletes the temporary `.raw` files from disk to free resources.
7. **Broadcast**: Inserts the new recording into the database and broadcasts the new record object to all participants in the channel so it immediately displays in their UI.
