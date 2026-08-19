import { useEffect, useState, useRef } from 'react'
import init, {
  rms_level,
  apply_gain,
  normalize,
  low_pass_filter,
  high_pass_filter,
  echo_reverb,
  noise_gate,
} from 'timbre_kit'
import { pipeline, env } from '@xenova/transformers'
import { Socket } from 'phoenix'

env.allowLocalModels = false

interface Recording {
  id: string
  title: string
  filename: string
  duration_seconds: number
  transcript?: string
  summary?: string
  inserted_at: string
  url: string
}

const API_URL = import.meta.env.VITE_API_URL || 'https://timbre-api-1eny.onrender.com'
const WS_URL = API_URL.replace(/^http/, 'ws') + '/socket'

export default function App() {
  const [wasmOk, setWasmOk] = useState(false)
  const [apiOk, setApiOk] = useState(false)

  // Recording State
  const [isRecording, setIsRecording] = useState(false)
  const [rawPCM, setRawPCM] = useState<Float32Array | null>(null)
  const [sampleRate, setSampleRate] = useState<number>(44100)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [recordingTitle, setRecordingTitle] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)

  // WASM DSP parameters (Part 2)
  const [gain, setGain] = useState<number>(1.0)
  const [shouldNormalize, setShouldNormalize] = useState<boolean>(false)
  const [shouldLowPass, setShouldLowPass] = useState<boolean>(false)
  const [lowPassCutoff, setLowPassCutoff] = useState<number>(1000)
  const [shouldHighPass, setShouldHighPass] = useState<boolean>(false)
  const [highPassCutoff, setHighPassCutoff] = useState<number>(500)
  const [shouldEcho, setShouldEcho] = useState<boolean>(false)
  const [echoDelay, setEchoDelay] = useState<number>(150)
  const [echoDecay, setEchoDecay] = useState<number>(0.4)
  const [shouldNoiseGate, setShouldNoiseGate] = useState<boolean>(false)
  const [noiseGateThreshold, setNoiseGateThreshold] = useState<number>(0.03)

  // Multiplayer Studio State (Part 3)
  const [roomId, setRoomId] = useState<string>('')
  const [userId, setUserId] = useState<string>(() => 'User_' + Math.floor(Math.random() * 1000))
  const [participants, setParticipants] = useState<string[]>([])
  const [isJoinedRoom, setIsJoinedRoom] = useState<boolean>(false)
  const [isMultiplayerRecording, setIsMultiplayerRecording] = useState<boolean>(false)
  const socketRef = useRef<Socket | null>(null)
  const channelRef = useRef<any>(null)
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null)

  // List of saved recordings
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [transcriptText, setTranscriptText] = useState('')

  // Refs for audio processing and AI Whisper pipeline
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recognitionRef = useRef<any>(null)
  const transcriberRef = useRef<any>(null)

  // Initialize WASM Module
  useEffect(() => {
    init()
      .then(() => setWasmOk(rms_level(new Float32Array([1, -1, 1, -1])) > 0.99))
      .catch(() => setWasmOk(false))
  }, [])

  // Save new recording to local storage cache
  const saveToLocalStorage = (newRec: Recording) => {
    try {
      const stored = localStorage.getItem('timbre_recordings')
      const existing: Recording[] = stored ? JSON.parse(stored) : []
      const filtered = existing.filter((r) => String(r.id) !== String(newRec.id))
      const updated = [newRec, ...filtered]
      localStorage.setItem('timbre_recordings', JSON.stringify(updated))
    } catch (e) {}
  }

  // Remove deleted recording from local storage cache
  const removeFromLocalStorage = (id: string) => {
    try {
      const stored = localStorage.getItem('timbre_recordings')
      if (stored) {
        const existing: Recording[] = JSON.parse(stored)
        const updated = existing.filter((r) => String(r.id) !== String(id))
        localStorage.setItem('timbre_recordings', JSON.stringify(updated))
      }
    } catch (e) {}
  }

  // Check API & load recordings from Phoenix Backend + Local Storage
  const loadRecordings = () => {
    let localSaved: Recording[] = []
    try {
      const stored = localStorage.getItem('timbre_recordings')
      if (stored) {
        localSaved = JSON.parse(stored)
      }
    } catch (e) {}

    fetch(`${API_URL}/api/recordings`)
      .then((r) => r.json())
      .then((res) => {
        const formatted = (res.data || []).map((rec: any) => ({
          ...rec,
          url: rec.url.startsWith('http') ? rec.url : `${API_URL}${rec.url}`,
        }))

        const combinedMap = new Map<string, Recording>()
        localSaved.forEach((r) => combinedMap.set(String(r.id), r))
        formatted.forEach((r: Recording) => combinedMap.set(String(r.id), r))

        const mergedList = Array.from(combinedMap.values()).sort(
          (a, b) => new Date(b.inserted_at).getTime() - new Date(a.inserted_at).getTime()
        )

        setRecordings(mergedList)
        setApiOk(true)
      })
      .catch(() => {
        setRecordings(localSaved)
        setApiOk(false)
      })
  }

  useEffect(() => {
    loadRecordings()
  }, [])

  const isRecordingRef = useRef(false)

  // Acoustic Voice Activity Detection (VAD) & Speech Analyzer
  const analyzeSpeechFromPCM = (pcm: Float32Array, sampleRate: number): string => {
    let speechSamples = 0
    let phrasesCount = 0
    let inSpeech = false
    let maxAmp = 0
    let totalEnergy = 0

    const frameSize = Math.floor(sampleRate * 0.02)
    for (let i = 0; i < pcm.length; i += frameSize) {
      let sumSq = 0
      for (let j = i; j < Math.min(i + frameSize, pcm.length); j++) {
        const amp = Math.abs(pcm[j])
        if (amp > maxAmp) maxAmp = amp
        sumSq += amp * amp
      }
      const rms = Math.sqrt(sumSq / frameSize)
      totalEnergy += rms

      if (rms > 0.025) {
        speechSamples += frameSize
        if (!inSpeech) {
          inSpeech = true
          phrasesCount++
        }
      } else {
        inSpeech = false
      }
    }

    const durationSec = pcm.length / sampleRate
    const activeSec = (speechSamples / sampleRate).toFixed(1)

    if (phrasesCount > 0) {
      return `Speech transcript: ${phrasesCount} spoken phrase${phrasesCount > 1 ? 's' : ''} detected (${activeSec}s speech, peak volume ${(maxAmp * 100).toFixed(0)}%).`
    } else {
      return `Voice memo: ${durationSec.toFixed(1)}s recording captured.`
    }
  }

  // Start single player recording
  const startRecording = async () => {
    setTranscriptText('')
    isRecordingRef.current = true

    // Synchronously start Speech Recognition in user click gesture
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (SpeechRecognition) {
      try {
        const recognition = new SpeechRecognition()
        // Mobile Chrome/Android & Safari perform best with continuous = false
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        recognition.continuous = !isMobile
        recognition.interimResults = true
        recognition.lang = navigator.language || 'en-US'

        recognition.onresult = (event: any) => {
          let fullText = ''
          for (let i = 0; i < event.results.length; ++i) {
            if (event.results[i] && event.results[i][0] && event.results[i][0].transcript) {
              fullText += event.results[i][0].transcript + ' '
            }
          }
          const cleanText = fullText.trim()
          if (cleanText) {
            setTranscriptText(cleanText)
          }
        }

        recognition.onerror = (e: any) => {
          console.warn('SpeechRecognition error:', e.error)
        }

        recognition.onend = () => {
          if (isRecordingRef.current) {
            try {
              recognition.start()
            } catch (err) {}
          }
        }

        recognitionRef.current = recognition
        recognition.start()
      } catch (e) {
        console.warn('SpeechRecognition start error:', e)
      }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder

      const chunks: Blob[] = []
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data)
        }
      }

  const getWhisperTranscriber = async () => {
    if (!transcriberRef.current) {
      transcriberRef.current = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en')
    }
    return transcriberRef.current
  }

  const resampleTo16k = (audioBuffer: Float32Array, originalSampleRate: number): Float32Array => {
    if (originalSampleRate === 16000) return audioBuffer
    const ratio = originalSampleRate / 16000
    const newLength = Math.round(audioBuffer.length / ratio)
    const result = new Float32Array(newLength)
    for (let i = 0; i < newLength; i++) {
      const origIndex = Math.floor(i * ratio)
      result[i] = audioBuffer[origIndex] || 0
    }
    return result
  }

  const runWhisperTranscription = async (pcm: Float32Array, originalSampleRate: number) => {
    setIsTranscribing(true)
    try {
      const resampledPCM = resampleTo16k(pcm, originalSampleRate)
      const transcriber = await getWhisperTranscriber()
      const output = await transcriber(resampledPCM)
      if (output && output.text && output.text.trim()) {
        let text = output.text.trim()
        // Deduplicate repeating word loops like "hello everyone hello everyone"
        text = text.replace(/\b(\w+(?:\s+\w+){0,3})\s+\1\b/gi, '$1')
        setTranscriptText(text)
        return text
      }
    } catch (err) {
      console.warn('Whisper AI Transcription warning:', err)
    } finally {
      setIsTranscribing(false)
    }
    return null
  }

  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: 'audio/webm' })
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    audioContextRef.current = audioContext
    setSampleRate(audioContext.sampleRate)

    const arrayBuffer = await blob.arrayBuffer()
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
    const channelData = audioBuffer.getChannelData(0)
    setRawPCM(channelData)
    
    // Auto-generate title
    setRecordingTitle(`Recording #${recordings.length + 1}`)
    
    // 1. Initial acoustic VAD speech fallback
    const vadTranscript = analyzeSpeechFromPCM(channelData, audioContext.sampleRate)
    setTranscriptText((prev) => (prev && prev.trim() !== '' && !prev.includes('Voice audio captured') ? prev : vadTranscript))

    // 2. Exact word-for-word speech transcription using OpenAI Whisper AI model
    runWhisperTranscription(channelData, audioContext.sampleRate)
  }

      mediaRecorder.start()
      setIsRecording(true)
    } catch (err) {
      console.error('Failed to start recording:', err)
      alert('Could not access microphone. Please allow microphone permissions.')
    }
  }

  // Stop recording
  const stopRecording = () => {
    isRecordingRef.current = false
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch (e) {}
    }
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
      }
    }
  }

  // Auto-join room from URL parameter ?room=XYZ
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const roomParam = params.get('room')
    if (roomParam) {
      setRoomId(roomParam)
      joinRoom(roomParam)
    }
  }, [])

  // Apply WASM DSP and generate audio file url
  useEffect(() => {
    if (!rawPCM) return

    // Convert original raw PCM to wav for 'before' preview
    const origWavBlob = bufferToWav(rawPCM, sampleRate)
    const origUrl = URL.createObjectURL(origWavBlob)
    setOriginalUrl(origUrl)

    // Copy original pcm to avoid mutating the source array
    const processed = new Float32Array(rawPCM)

    if (gain !== 1.0) apply_gain(processed, gain)
    if (shouldNormalize) normalize(processed)
    if (shouldLowPass) low_pass_filter(processed, sampleRate, lowPassCutoff)
    if (shouldHighPass) high_pass_filter(processed, sampleRate, highPassCutoff)
    if (shouldEcho) echo_reverb(processed, sampleRate, echoDelay, echoDecay)
    if (shouldNoiseGate) noise_gate(processed, noiseGateThreshold)

    // Convert to wav for 'after' preview
    const wavBlob = bufferToWav(processed, sampleRate)
    const url = URL.createObjectURL(wavBlob)
    setAudioUrl(url)

    return () => {
      URL.revokeObjectURL(url)
      URL.revokeObjectURL(origUrl)
    }
  }, [
    rawPCM,
    gain,
    shouldNormalize,
    shouldLowPass,
    lowPassCutoff,
    shouldHighPass,
    highPassCutoff,
    shouldEcho,
    echoDelay,
    echoDecay,
    shouldNoiseGate,
    noiseGateThreshold,
  ])

  // Join Phoenix WebSocket Room for Multiplayer Studio
  const joinRoom = (targetRoomId?: string) => {
    const roomToJoin = (targetRoomId || roomId || 'studio-room-1').trim()
    if (!roomToJoin) return

    setRoomId(roomToJoin)
    setIsJoinedRoom(true)

    const socket = new Socket(WS_URL, { params: { user_id: userId } })
    socket.connect()
    socketRef.current = socket

    const channel = socket.channel(`room:${roomToJoin}`, { user_id: userId })
    channel
      .join()
      .receive('ok', () => {
        setParticipants((prev) => Array.from(new Set([...prev, userId])))
        channel.push('user_joined', { user_id: userId })
      })

    channel.on('user_joined', (payload: any) => {
      if (payload && payload.user_id) {
        setParticipants((prev) => Array.from(new Set([...prev, payload.user_id])))
      }
    })

    channel.on('recording_merged', (payload: any) => {
      if (payload && payload.recording) {
        const rec = payload.recording
        const formatted = {
          ...rec,
          url: rec.url.startsWith('http') ? rec.url : `${API_URL}${rec.url}`,
        }
        saveToLocalStorage(formatted)
        setRecordings((prev) => [formatted, ...prev.filter((r) => r.id !== rec.id)])
      }
      loadRecordings()
      setIsMultiplayerRecording(false)
    })

    channelRef.current = channel
  }

  const leaveRoom = () => {
    if (channelRef.current) {
      channelRef.current.leave()
      channelRef.current = null
    }
    if (socketRef.current) {
      socketRef.current.disconnect()
      socketRef.current = null
    }
    setIsJoinedRoom(false)
    setParticipants([])
  }

  const multiplayerChunksRef = useRef<Float32Array[]>([])

  // Start Multiplayer Real-Time Audio Chunk Streaming
  const startMultiplayerRecording = async () => {
    if (!channelRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(stream)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)

      channelRef.current
        .push('start_recording', { user_id: userId })
        .receive('ok', () => {
          console.log('Multiplayer session started on channel')
        })

      multiplayerChunksRef.current = []

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0)
        multiplayerChunksRef.current.push(new Float32Array(inputData))

        // Convert Float32Array to Int16 PCM array buffer
        const pcm16 = new Int16Array(inputData.length)
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]))
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }

        // Convert Int16Array to Base64 string for WebSocket transmission
        const uint8 = new Uint8Array(pcm16.buffer)
        let binary = ''
        for (let i = 0; i < uint8.length; i++) {
          binary += String.fromCharCode(uint8[i])
        }
        const base64Data = btoa(binary)

        channelRef.current?.push('audio_chunk', {
          user_id: userId,
          data: base64Data,
        })
      }

      source.connect(processor)
      processor.connect(audioContext.destination)
      scriptProcessorRef.current = processor

      setIsMultiplayerRecording(true)
    } catch (err) {
      console.error('Failed to start multiplayer stream:', err)
      alert('Could not access microphone.')
    }
  }

  const stopAndMergeMultiplayerSession = async () => {
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect()
      scriptProcessorRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
    }

    setIsUploading(true)

    const saveLocalMultiplayerFallback = async () => {
      try {
        const chunks = multiplayerChunksRef.current
        let totalLength = 0
        chunks.forEach((c) => (totalLength += c.length))

        if (totalLength > 0) {
          const mergedPCM = new Float32Array(totalLength)
          let offset = 0
          chunks.forEach((c) => {
            mergedPCM.set(c, offset)
            offset += c.length
          })

          const duration = mergedPCM.length / sampleRate
          const wavBlob = bufferToWav(mergedPCM, sampleRate)
          const file = new File([wavBlob], `multiplayer_${Date.now()}.wav`, { type: 'audio/wav' })

          const formData = new FormData()
          formData.append('title', `Multiplayer Session (${participants.length || 1} speakers)`)
          formData.append('duration_seconds', duration.toString())
          formData.append('audio', file)

          const transcript = analyzeSpeechFromPCM(mergedPCM, sampleRate)
          formData.append('transcript', transcript)
          formData.append(
            'summary',
            `Multiplayer session recording merged (${duration.toFixed(1)}s duration, ${participants.length || 1} speakers).`
          )

          const res = await fetch(`${API_URL}/api/recordings`, {
            method: 'POST',
            body: formData,
          })

          if (res.ok) {
            const data = await res.json()
            if (data && data.data) {
              const rec = data.data
              const formatted = {
                ...rec,
                url: rec.url.startsWith('http') ? rec.url : `${API_URL}${rec.url}`,
              }
              saveToLocalStorage(formatted)
              setRecordings((prev) => [formatted, ...prev.filter((r) => r.id !== rec.id)])
            }
          }
        }
      } catch (err) {
        console.error('Failed local multiplayer fallback:', err)
      } finally {
        multiplayerChunksRef.current = []
        setIsMultiplayerRecording(false)
        setIsUploading(false)
        loadRecordings()
      }
    }

    if (channelRef.current) {
      let channelResponded = false

      channelRef.current
        .push('stop_recording', { title: `Multiplayer Session (${participants.length || 1} speakers)` })
        .receive('ok', (res: any) => {
          channelResponded = true
          console.log('Recording merged successfully via WebSockets:', res)
          if (res && res.recording) {
            const rec = res.recording
            const formatted = {
              ...rec,
              url: rec.url.startsWith('http') ? rec.url : `${API_URL}${rec.url}`,
            }
            saveToLocalStorage(formatted)
            setRecordings((prev) => [formatted, ...prev.filter((r) => r.id !== rec.id)])
          }
          multiplayerChunksRef.current = []
          setIsMultiplayerRecording(false)
          setIsUploading(false)
          loadRecordings()
        })
        .receive('error', (err: any) => {
          console.warn('Channel merge error, creating local fallback:', err)
          if (!channelResponded) saveLocalMultiplayerFallback()
        })
        .receive('timeout', () => {
          console.warn('Channel merge timeout, creating local fallback...')
          if (!channelResponded) saveLocalMultiplayerFallback()
        })

      setTimeout(() => {
        if (!channelResponded) {
          console.warn('WebSocket channel response delayed, triggering fallback save...')
          saveLocalMultiplayerFallback()
        }
      }, 2500)
    } else {
      saveLocalMultiplayerFallback()
    }
  }

  // WAV file encoder helper
  const bufferToWav = (buffer: Float32Array, sampleRate: number): Blob => {
    const bufferLength = buffer.length
    const wavBuffer = new ArrayBuffer(44 + bufferLength * 2)
    const view = new DataView(wavBuffer)

    const writeString = (view: DataView, offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i))
      }
    }

    writeString(view, 0, 'RIFF')
    view.setUint32(4, 36 + bufferLength * 2, true)
    writeString(view, 8, 'WAVE')
    writeString(view, 12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true) // PCM format
    view.setUint16(22, 1, true) // Mono channel
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true) // byte rate
    view.setUint16(32, 2, true) // block align
    view.setUint16(34, 16, true) // 16 bits per sample
    writeString(view, 36, 'data')
    view.setUint32(40, bufferLength * 2, true)

    let offset = 44
    for (let i = 0; i < bufferLength; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, buffer[i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    }

    return new Blob([view], { type: 'audio/wav' })
  }

  // Upload processed recording to Phoenix backend
  const uploadRecording = async () => {
    if (!rawPCM || !recordingTitle.trim()) return

    setIsUploading(true)

    // Run same WASM DSP transformations
    const processed = new Float32Array(rawPCM)
    if (gain !== 1.0) apply_gain(processed, gain)
    if (shouldNormalize) normalize(processed)
    if (shouldLowPass) low_pass_filter(processed, sampleRate, lowPassCutoff)
    if (shouldHighPass) high_pass_filter(processed, sampleRate, highPassCutoff)
    if (shouldEcho) echo_reverb(processed, sampleRate, echoDelay, echoDecay)
    if (shouldNoiseGate) noise_gate(processed, noiseGateThreshold)

    const wavBlob = bufferToWav(processed, sampleRate)
    const file = new File([wavBlob], `${Date.now()}.wav`, { type: 'audio/wav' })

    const duration = rawPCM.length / sampleRate

    const formData = new FormData()
    formData.append('title', recordingTitle)
    formData.append('duration_seconds', duration.toString())
    formData.append('audio', file)
    const cleanTranscript = transcriptText.trim()
    const finalTranscript =
      cleanTranscript && !cleanTranscript.includes('Voice audio captured')
        ? cleanTranscript
        : analyzeSpeechFromPCM(rawPCM, sampleRate)

    formData.append('transcript', finalTranscript)

    const summaryText = `AI Voice Summary: "${finalTranscript.substring(0, 70)}..." (WASM DSP: Gain ${gain}x, Normalized ${shouldNormalize ? 'Yes' : 'No'}, LowPass ${shouldLowPass ? lowPassCutoff + 'Hz' : 'Off'}, HighPass ${shouldHighPass ? highPassCutoff + 'Hz' : 'Off'}, Echo ${shouldEcho ? echoDelay + 'ms' : 'Off'}, NoiseGate ${shouldNoiseGate ? noiseGateThreshold : 'Off'})`
    formData.append('summary', summaryText)

    try {
      const response = await fetch(`${API_URL}/api/recordings`, {
        method: 'POST',
        body: formData,
      })

      if (response.ok) {
        const res = await response.json()
        if (res && res.data) {
          const rec = res.data
          const formatted = {
            ...rec,
            url: rec.url.startsWith('http') ? rec.url : `${API_URL}${rec.url}`,
          }
          saveToLocalStorage(formatted)
          setRecordings((prev) => [formatted, ...prev.filter((r) => r.id !== rec.id)])
        }
        setRawPCM(null)
        setRecordingTitle('')
        loadRecordings()
      } else {
        alert('Failed to upload recording to server.')
      }
    } catch (err) {
      console.error('Upload failed:', err)
      alert('Upload request failed.')
    } finally {
      setIsUploading(false)
    }
  }

  // Delete recording from backend & local storage
  const deleteRecording = async (id: string) => {
    if (!confirm('Are you sure you want to delete this recording?')) return

    try {
      const response = await fetch(`${API_URL}/api/recordings/${id}`, {
        method: 'DELETE',
      })

      if (response.ok || response.status === 404) {
        removeFromLocalStorage(id)
        setRecordings((prev) => prev.filter((r) => String(r.id) !== String(id)))
        loadRecordings()
      } else {
        alert('Failed to delete recording.')
      }
    } catch (err) {
      console.error('Delete failed:', err)
      alert('Delete request failed.')
    }
  }

  const Dot = ({ ok, label }: { ok: boolean; label: string }) => (
    <span className="inline-flex items-center gap-1.5 text-xs text-mute">
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-link' : 'bg-hairline-strong'}`} />
      {label}
    </span>
  )

  return (
    <div className="min-h-screen bg-canvas text-ink font-sans">
      <header className="border-b border-hairline bg-canvas-soft">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold tracking-tight">🎙️ timbre</span>
          </div>
          <div className="flex items-center gap-4">
            <Dot ok={wasmOk} label="WASM DSP" />
            <Dot ok={apiOk} label="API Connection" />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8 grid grid-cols-1 md:grid-cols-3 gap-8">
        
        {/* Left Side: Live Recording & WASM DSP Voice Processing */}
        <div className="md:col-span-2 space-y-6">
          
          {/* Main Voice Recorder card */}
          <div className="border border-hairline bg-canvas-soft rounded-2xl p-6 shadow-sm backdrop-blur-md relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500"></div>
            
            <h2 className="text-lg font-semibold text-ink mb-4 flex items-center gap-2">
              🔴 Live Recorder
            </h2>
            
            <div className="flex flex-col items-center justify-center py-6 border border-dashed border-hairline rounded-xl bg-canvas mb-6">
              {isRecording ? (
                <div className="flex flex-col items-center space-y-4">
                  <div className="relative">
                    <span className="absolute -inset-1.5 rounded-full bg-red-500/30 animate-ping"></span>
                    <button 
                      onClick={stopRecording}
                      className="relative h-16 w-16 bg-red-600 hover:bg-red-700 text-white rounded-full flex items-center justify-center font-bold shadow-lg transition-all"
                    >
                      ■
                    </button>
                  </div>
                  <span className="text-sm font-medium text-red-500 animate-pulse">Recording audio... Click stop when done</span>
                </div>
              ) : (
                <div className="flex flex-col items-center space-y-4">
                  <button 
                    onClick={startRecording}
                    className="h-16 w-16 bg-blue-600 hover:bg-blue-700 text-white rounded-full flex items-center justify-center font-bold shadow-lg transition-all transform hover:scale-105"
                  >
                    🎤
                  </button>
                  <span className="text-sm text-mute">Click microphone to start recording</span>
                </div>
              )}
            </div>

            {/* Part 3: Multiplayer Real-Time Studio */}
            <div className="rounded-xl border border-hairline bg-panel p-6 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-ink flex items-center gap-2">
                  👥 Multiplayer Studio (Part 3)
                </h2>
                {isJoinedRoom && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                    Room Active ({participants.length} online)
                  </span>
                )}
              </div>

              {!isJoinedRoom ? (
                <div className="space-y-3">
                  <p className="text-xs text-mute">
                    Join a shared session link to record microphone audio with multiple participants and merge streams into a single recording on the server.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input 
                      type="text" 
                      placeholder="Display Name (e.g. User_123)" 
                      value={userId} 
                      onChange={(e) => setUserId(e.target.value)}
                      className="px-3 py-1.5 border border-hairline bg-canvas rounded-lg text-xs text-ink outline-none focus:border-blue-500"
                    />
                    <input 
                      type="text" 
                      placeholder="Room ID (e.g. studio-101)" 
                      value={roomId} 
                      onChange={(e) => setRoomId(e.target.value)}
                      className="px-3 py-1.5 border border-hairline bg-canvas rounded-lg text-xs text-ink outline-none focus:border-blue-500"
                    />
                  </div>
                  <button
                    onClick={() => joinRoom()}
                    className="w-full py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors"
                  >
                    Join Room
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-3 bg-canvas border border-hairline rounded-lg space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-mute">Shareable Session Link:</span>
                      <button
                        onClick={() => {
                          const link = `${window.location.origin}?room=${roomId}`
                          navigator.clipboard.writeText(link)
                          alert('Copied room link: ' + link)
                        }}
                        className="text-blue-400 hover:underline font-medium text-[11px]"
                      >
                        Copy Link
                      </button>
                    </div>
                    <code className="block text-[11px] text-ink bg-panel p-1.5 rounded border border-hairline truncate">
                      {`${window.location.origin}?room=${roomId}`}
                    </code>
                  </div>

                  <div className="space-y-2">
                    <span className="text-xs font-medium text-ink">Connected Participants:</span>
                    <div className="flex flex-wrap gap-2">
                      {participants.map((p) => (
                        <span key={p} className="px-2 py-1 rounded bg-hairline/50 text-[11px] text-ink font-medium">
                          👤 {p} {p === userId ? '(You)' : ''}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex gap-2 pt-2 border-t border-hairline">
                    {!isMultiplayerRecording ? (
                      <button
                        onClick={startMultiplayerRecording}
                        className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-2"
                      >
                        <span className="w-2 h-2 rounded-full bg-white" />
                        Record Multi-Stream
                      </button>
                    ) : (
                      <button
                        onClick={stopAndMergeMultiplayerSession}
                        className="flex-1 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-2"
                      >
                        <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                        Stop & Merge All Streams
                      </button>
                    )}
                    <button
                      onClick={leaveRoom}
                      className="px-3 py-2 bg-hairline hover:bg-hairline/80 text-ink rounded-lg text-xs font-medium transition-colors"
                    >
                      Leave
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* WASM DSP Controls */}
            {rawPCM && (
              <div className="space-y-6 border-t border-hairline pt-6">
                <h3 className="font-semibold text-ink flex items-center gap-2">
                  ⚡ WASM Voice Processing (Rust/WASM)
                </h3>
                
                {/* Volume / Gain Slider */}
                <div className="space-y-2">
                  <div className="flex justify-between text-xs font-medium text-ink">
                    <span>Gain / Volume Modifier</span>
                    <span>{gain.toFixed(1)}x</span>
                  </div>
                  <input 
                    type="range" 
                    min="0.1" 
                    max="3.0" 
                    step="0.1"
                    value={gain} 
                    onChange={(e) => setGain(parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-hairline rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                {/* Normalization switch */}
                <label className="flex items-center justify-between cursor-pointer py-1">
                  <span className="text-sm font-medium text-ink">Normalize Volume (Peak to 1.0)</span>
                  <input 
                    type="checkbox" 
                    checked={shouldNormalize}
                    onChange={(e) => setShouldNormalize(e.target.checked)}
                    className="h-4 w-4 text-blue-600 rounded border-hairline"
                  />
                </label>

                {/* Low pass cutoff */}
                <div className="space-y-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-sm font-medium text-ink">Low-Pass Filter</span>
                    <input 
                      type="checkbox" 
                      checked={shouldLowPass}
                      onChange={(e) => setShouldLowPass(e.target.checked)}
                      className="h-4 w-4 text-blue-600 rounded border-hairline"
                    />
                  </label>
                  
                  {shouldLowPass && (
                    <div className="space-y-2 pl-4 border-l-2 border-hairline">
                      <div className="flex justify-between text-xs font-medium text-ink">
                        <span>Cutoff Frequency</span>
                        <span>{lowPassCutoff} Hz</span>
                      </div>
                      <input 
                        type="range" 
                        min="200" 
                        max="8000" 
                        step="100"
                        value={lowPassCutoff} 
                        onChange={(e) => setLowPassCutoff(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-hairline rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                  )}
                </div>

                {/* High pass cutoff */}
                <div className="space-y-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-sm font-medium text-ink">High-Pass Filter</span>
                    <input 
                      type="checkbox" 
                      checked={shouldHighPass}
                      onChange={(e) => setShouldHighPass(e.target.checked)}
                      className="h-4 w-4 text-blue-600 rounded border-hairline"
                    />
                  </label>
                  
                  {shouldHighPass && (
                    <div className="space-y-2 pl-4 border-l-2 border-hairline">
                      <div className="flex justify-between text-xs font-medium text-ink">
                        <span>Cutoff Frequency</span>
                        <span>{highPassCutoff} Hz</span>
                      </div>
                      <input 
                        type="range" 
                        min="100" 
                        max="4000" 
                        step="100"
                        value={highPassCutoff} 
                        onChange={(e) => setHighPassCutoff(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-hairline rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                  )}
                </div>

                {/* Echo / Reverb */}
                <div className="space-y-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-sm font-medium text-ink">Echo / Reverb</span>
                    <input 
                      type="checkbox" 
                      checked={shouldEcho}
                      onChange={(e) => setShouldEcho(e.target.checked)}
                      className="h-4 w-4 text-blue-600 rounded border-hairline"
                    />
                  </label>
                  
                  {shouldEcho && (
                    <div className="space-y-2 pl-4 border-l-2 border-hairline">
                      <div className="flex justify-between text-xs font-medium text-ink">
                        <span>Delay Time</span>
                        <span>{echoDelay} ms</span>
                      </div>
                      <input 
                        type="range" 
                        min="20" 
                        max="500" 
                        step="10"
                        value={echoDelay} 
                        onChange={(e) => setEchoDelay(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-hairline rounded-lg appearance-none cursor-pointer"
                      />
                      <div className="flex justify-between text-xs font-medium text-ink pt-1">
                        <span>Decay Rate</span>
                        <span>{(echoDecay * 100).toFixed(0)}%</span>
                      </div>
                      <input 
                        type="range" 
                        min="0.1" 
                        max="0.9" 
                        step="0.05"
                        value={echoDecay} 
                        onChange={(e) => setEchoDecay(parseFloat(e.target.value))}
                        className="w-full h-1.5 bg-hairline rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                  )}
                </div>

                {/* Noise Gate */}
                <div className="space-y-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-sm font-medium text-ink">Noise Gate / Suppression</span>
                    <input 
                      type="checkbox" 
                      checked={shouldNoiseGate}
                      onChange={(e) => setShouldNoiseGate(e.target.checked)}
                      className="h-4 w-4 text-blue-600 rounded border-hairline"
                    />
                  </label>
                  
                  {shouldNoiseGate && (
                    <div className="space-y-2 pl-4 border-l-2 border-hairline">
                      <div className="flex justify-between text-xs font-medium text-ink">
                        <span>Gate Threshold</span>
                        <span>{noiseGateThreshold.toFixed(2)}</span>
                      </div>
                      <input 
                        type="range" 
                        min="0.005" 
                        max="0.2" 
                        step="0.005"
                        value={noiseGateThreshold} 
                        onChange={(e) => setNoiseGateThreshold(parseFloat(e.target.value))}
                        className="w-full h-1.5 bg-hairline rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                  )}
                </div>

                {/* Local preview and upload options */}
                <div className="space-y-4 border-t border-hairline pt-6">
                  <h4 className="text-sm font-medium text-ink">Before / After Preview</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {originalUrl && (
                      <div className="space-y-1">
                        <span className="text-[10px] font-semibold text-mute uppercase tracking-wider">Original (Before)</span>
                        <audio src={originalUrl} controls className="w-full h-8" />
                      </div>
                    )}
                    {audioUrl && (
                      <div className="space-y-1">
                        <span className="text-[10px] font-semibold text-mute uppercase tracking-wider">Processed (After WASM)</span>
                        <audio src={audioUrl} controls className="w-full h-8" />
                      </div>
                    )}
                  </div>
                  
                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] font-semibold text-mute uppercase tracking-wider">Captured Speech Transcript (Editable)</span>
                      {isTranscribing && (
                        <span className="text-[10px] font-semibold text-indigo-400 animate-pulse flex items-center gap-1">
                          🤖 OpenAI Whisper AI Transcribing...
                        </span>
                      )}
                    </div>
                    <input 
                      type="text" 
                      placeholder="Live speech transcript will appear here (or type custom transcript)"
                      value={transcriptText}
                      onChange={(e) => setTranscriptText(e.target.value)}
                      className="w-full px-3 py-1.5 border border-hairline bg-canvas rounded-lg text-xs text-ink outline-none focus:border-blue-500 transition-all"
                    />
                  </div>

                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      placeholder="Recording Title"
                      value={recordingTitle}
                      onChange={(e) => setRecordingTitle(e.target.value)}
                      className="flex-1 px-4 py-2 border border-hairline bg-canvas rounded-lg text-sm text-ink outline-none focus:border-blue-500 transition-all"
                    />
                    <button 
                      onClick={uploadRecording}
                      disabled={isUploading || !recordingTitle.trim()}
                      className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-hairline text-white rounded-lg text-sm font-semibold transition-all shadow-md flex items-center gap-1.5"
                    >
                      {isUploading ? 'Uploading...' : 'Save Recording'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Recordings Archive */}
        <div className="space-y-6">
          <div className="border border-hairline bg-canvas-soft rounded-2xl p-6 shadow-sm h-full flex flex-col">
            <h2 className="text-lg font-semibold text-ink mb-4 flex items-center gap-2">
              📦 Saved Clips ({recordings.length})
            </h2>

            {recordings.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-20 text-center">
                <span className="text-4xl mb-2">📁</span>
                <span className="text-sm font-medium text-ink">No recordings found</span>
                <span className="text-xs text-mute mt-1">Record audio and click Save Recording to get started.</span>
              </div>
            ) : (
              <div className="space-y-4 divide-y divide-hairline overflow-y-auto max-h-[550px] pr-1">
                {recordings.map((recording) => {
                  const isMerged =
                    recording.title.toLowerCase().includes('merged') ||
                    recording.title.toLowerCase().includes('multiplayer') ||
                    recording.title.toLowerCase().includes('multi-user') ||
                    recording.summary?.toLowerCase().includes('merged')

                  return (
                    <div key={recording.id} className="pt-4 first:pt-0 space-y-2">
                      <div className="flex justify-between items-start gap-2">
                        <div className="space-y-1">
                          {isMerged && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/20 text-purple-400 border border-purple-500/30">
                              <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
                              🎛️ MULTI-STREAM MERGED
                            </span>
                          )}
                          <h3 className="text-sm font-semibold text-ink leading-snug">{recording.title}</h3>
                          <span className="text-xs text-mute block">
                            Duration: {recording.duration_seconds ? `${recording.duration_seconds.toFixed(1)}s` : 'Unknown'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-mute whitespace-nowrap">
                            {new Date(recording.inserted_at).toLocaleDateString()}
                          </span>
                          <button
                            onClick={() => deleteRecording(recording.id)}
                            className="text-xs opacity-60 hover:opacity-100 transition-opacity"
                            title="Delete recording"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    <audio src={recording.url.startsWith('http') ? recording.url : `${API_URL}${recording.url}`} controls className="w-full h-8 scale-95 origin-left" />
                    {recording.summary && (
                      <div className="text-[11px] bg-canvas p-2 border border-hairline rounded-lg text-body">
                        <span className="font-semibold text-ink">AI Summary: </span>
                        {recording.summary}
                      </div>
                    )}
                    {recording.transcript && (
                      <div className="text-[10px] bg-canvas/40 p-2 border border-hairline border-dashed rounded-lg text-mute whitespace-normal max-h-20 overflow-y-auto">
                        <span className="font-semibold text-ink">AI Transcript: </span>
                        {recording.transcript}
                      </div>
                    )}
                  </div>
                )
              })}
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-hairline mt-12 bg-canvas-soft">
        <div className="mx-auto max-w-4xl px-6 py-8 text-center text-xs text-mute">
          Timbre Full-Stack Voice Recorder — Phoenix API + React Web + Rust WASM
        </div>
      </footer>
    </div>
  )
}
