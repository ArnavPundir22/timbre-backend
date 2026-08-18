# Full Stack Assignment

We're not looking for perfection here — just a simple app that combines the
worlds of Elixir, Rust, React, and WASM, with a sprinkle of LLM magic thrown in
for fun. All we want to see is whether you can hack together something that
works.

We think this task is doable in about 4–5 hours for an expert and should take no
more than a day or two for a beginner. We don't care much about documentation or
error handling — just get it working! As for tests, do what you'd normally do in
production.

## Overview: Build a Voice Recorder

Create a system that mirrors a real invideo workflow:

1. **Record** → capture microphone audio in the browser and save the recording
   to the database
2. **Process voice** → apply audio effects / anonymization in-browser using WASM
3. **Merge audio** → several people join a shared link and their audio is mixed
   into one recording

**Tech Stack:** Elixir/Phoenix, React, Rust/WASM, (optional) LLM &
transcription APIs.

## Getting Started

You've been invited to your own private repository for this assignment — clone it
and push your work there. It's a working scaffold — Phoenix API (with a SQLite
database), React web app, and a Rust→WASM crate, all wired together so you can
start on the feature instead of the setup. See `README.md` to get it running.

## Scope

**Part 1 (record & save) is required.** Complete **at least one** of Part 2 or
Part 3. Doing all three earns bonus points. Pick the parts that best show how you
think.

## Part 1: Record & Save (Elixir/Phoenix + SQLite) — required

Build a simple recorder: capture audio in the browser and persist it.

Requirements:

- Record microphone audio in the browser.
- Upload it to the Phoenix API and save it to the database. The scaffold already
  has a SQLite-backed Ecto repo wired up — model the recording and store it.
- List saved recordings and play them back.

## Part 2: Voice Processing (Rust/WASM)

Build a WASM module that processes recorded audio in the browser. The crate at
`web/crates/timbre_kit` is where this goes.

Effects to implement (**choose any 3**):

- **Easy:** Gain / volume, Normalize, Silence trim, Mono mixdown
- **Medium:** Echo / reverb, Pitch shift, Low-pass / high-pass filter, Noise gate
- **Advanced (bonus):** Voice anonymizer (pitch + formant shift), Noise
  reduction, De-esser

## Part 3: Multiplayer + Merge Audio (Elixir/Phoenix)

Let several participants join a session through a shared link, and mix their
microphone audio into a single recording.

Requirements:

- Create a session and join it from multiple browser tabs/devices via one link.
- Stream each participant's mic audio in real time (Phoenix Channels / WebRTC —
  your call).
- Merge the streams into one mixed recording that can be saved and played back.

## Bonus: Transcribe & Summarize (LLM)

Turn a saved recording into a transcript and a short AI summary + title (Whisper,
ElevenLabs, or any provider you like).

## Overall Architecture

```
User flow
1. Record (Part 1)
   ├─ [Record] — capture mic audio
   ├─ Save the recording to the database
   └─ List saved recordings + playback
2. Process (Part 2)
   ├─ Pick effects / anonymize (WASM)
   └─ Before / after playback
3. Merge (Part 3)
   ├─ Share a session link
   ├─ Participants join from multiple tabs / devices
   └─ Streams mixed into one recording
Bonus
   └─ Transcript + AI summary
```

## What to Submit

1. **Your code** — pushed to the private repository you were invited to,
   organized clearly, with everything needed to run it locally.
2. **Deployed application (highly recommended)** — deploy the backend (Fly.io /
   Railway) and host the frontend (Vercel / Netlify if separate), and provide a
   working URL.
3. **Demo video or screenshots** — show the flow you built: record and save a
   clip, process the voice, and (if done) merge a multi-person session.

## Submission

Push your final work to the assignment repository you were invited to — that's
your submission. Make sure it's on `main` (or tell us the branch), include a
short note in the README on what you built and how to run it, and add the
deployed URL if you have one.
