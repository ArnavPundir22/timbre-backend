import { useEffect, useState, useRef } from 'react'
import init, { rms_level, apply_gain, normalize, low_pass_filter } from 'timbre_kit'
import { Socket, Channel } from 'phoenix'

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
const WS_URL = import.meta.env.VITE_WS_URL || 'wss://timbre-api-1eny.onrender.com/socket'

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
  
  // DSP parameters
  const [gain, setGain] = useState<number>(1.0)
  const [shouldNormalize, setShouldNormalize] = useState<boolean>(false)
  const [shouldLowPass, setShouldLowPass] = useState<boolean>(false)
  const [lowPassCutoff, setLowPassCutoff] = useState<number>(1000)
  
  // List of saved recordings
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [transcriptText, setTranscriptText] = useState('')
  const recognitionRef = useRef<any>(null)

  // Multiplayer room state
  const [roomId, setRoomId] = useState<string>('')
  const [userId, setUserId] = useState<string>('')
  const [inRoom, setInRoom] = useState(false)
  const [multiplayerParticipants, setMultiplayerParticipants] = useState<string[]>([])
  const [multiplayerStatus, setMultiplayerStatus] = useState<string>('idle')
  const socketErrorShown = useRef(false)

  // Refs for audio processing
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const channelRef = useRef<Channel | null>(null)
  const userIdRef = useRef<string>('')

  // Initialize WASM
  useEffect(() => {
    init()
      .then(() => setWasmOk(rms_level(new Float32Array([1, -1, 1, -1])) > 0.99))
      .catch(() => setWasmOk(false))
  }, [])

  // Check API & load recordings
  const loadRecordings = () => {
    fetch(`${API_URL}/api/recordings`)
      .then((r) => r.json())
      .then((res) => {
        const formatted = (res.data || []).map((rec: any) => ({
          ...rec,
          url: rec.url.startsWith('http') ? rec.url : `${API_URL}${rec.url}`
        }))
        setRecordings(formatted)
        setApiOk(true)
      })
      .catch(() => setApiOk(false))
  }

  useEffect(() => {
    loadRecordings()
  }, [])

  // Check URL parameters for multiplayer room join
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const room = params.get('room')
    if (room) {
      setRoomId(room)
      joinMultiplayerRoom(room)
    }
  }, [])

  // Start single player recording
  const startRecording = async () => {
    setTranscriptText('')
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

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
        audioContextRef.current = audioContext
        setSampleRate(audioContext.sampleRate)

        const arrayBuffer = await blob.arrayBuffer()
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
        const channelData = audioBuffer.getChannelData(0)
        setRawPCM(channelData)
        
        // Auto-generate a title
        setRecordingTitle(`Recording #${recordings.length + 1}`)
      }

      // Speech Recognition
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition()
        recognition.continuous = true
        recognition.interimResults = false
        recognition.lang = 'en-US'

        let localTranscript = ''
        recognition.onresult = (event: any) => {
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              localTranscript += event.results[i][0].transcript + ' '
            }
          }
          setTranscriptText(localTranscript.trim())
        }

        recognitionRef.current = recognition
        recognition.start()
      }

      mediaRecorder.start()
      setIsRecording(true)
    } catch (err) {
      console.error('Failed to start recording:', err)
      alert('Could not access microphone.')
    }
  }

  // Stop recording
  const stopRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
      }
    }
  }

  // Apply WASM DSP and generate audio file url
  useEffect(() => {
    if (!rawPCM) return

    // Convert original raw PCM to wav for 'before' preview
    const origWavBlob = bufferToWav(rawPCM, sampleRate)
    const origUrl = URL.createObjectURL(origWavBlob)
    setOriginalUrl(origUrl)

    // Copy original pcm to avoid mutating the source array
    const processed = new Float32Array(rawPCM)
    
    // Apply gain
    if (gain !== 1.0) {
      apply_gain(processed, gain)
    }

    // Apply normalization
    if (shouldNormalize) {
      normalize(processed)
    }

    // Apply lowpass filter
    if (shouldLowPass) {
      low_pass_filter(processed, sampleRate, lowPassCutoff)
    }

    // Convert to wav for 'after' preview
    const wavBlob = bufferToWav(processed, sampleRate)
    const url = URL.createObjectURL(wavBlob)
    setAudioUrl(url)

    return () => {
      URL.revokeObjectURL(url)
      URL.revokeObjectURL(origUrl)
    }
  }, [rawPCM, gain, shouldNormalize, shouldLowPass, lowPassCutoff])

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

    // Run same DSP transformations
    const processed = new Float32Array(rawPCM)
    if (gain !== 1.0) apply_gain(processed, gain)
    if (shouldNormalize) normalize(processed)
    if (shouldLowPass) low_pass_filter(processed, sampleRate, lowPassCutoff)

    const wavBlob = bufferToWav(processed, sampleRate)
    const file = new File([wavBlob], `${Date.now()}.wav`, { type: 'audio/wav' })

    const duration = rawPCM.length / sampleRate

    const formData = new FormData()
    formData.append('title', recordingTitle)
    formData.append('duration_seconds', duration.toString())
    formData.append('audio', file)
    formData.append('transcript', transcriptText || 'No speech detected.')
    
    const summaryText = transcriptText.trim()
      ? `Voice memo: "${transcriptText.substring(0, 100)}${transcriptText.length > 100 ? '...' : ''}"`
      : `Voice clip titled "${recordingTitle}" with no speech detected.`
    formData.append('summary', summaryText)

    try {
      const response = await fetch(`${API_URL}/api/recordings`, {
        method: 'POST',
        body: formData,
      })

      if (response.ok) {
        setRawPCM(null)
        setRecordingTitle('')
        loadRecordings()
      } else {
        alert('Failed to upload recording.')
      }
    } catch (err) {
      console.error('Upload failed:', err)
      alert('Upload request failed.')
    } finally {
      setIsUploading(false)
    }
  }

  // Delete recording from backend
  const deleteRecording = async (id: string) => {
    if (!confirm('Are you sure you want to delete this recording?')) return

    try {
      const response = await fetch(`${API_URL}/api/recordings/${id}`, {
        method: 'DELETE',
      })

      if (response.ok) {
        loadRecordings()
      } else {
        alert('Failed to delete recording.')
      }
    } catch (err) {
      console.error('Delete failed:', err)
      alert('Delete request failed.')
    }
  }

  // Multiplayer: Create and join a room
  const createRoom = () => {
    const randomRoomId = Math.random().toString(36).substring(2, 9)
    window.history.pushState({}, '', `?room=${randomRoomId}`)
    setRoomId(randomRoomId)
    joinMultiplayerRoom(randomRoomId)
  }

  const joinMultiplayerRoom = (targetRoomId: string) => {
    const randomUserId = `User_${Math.random().toString(36).substring(2, 6)}`
    userIdRef.current = randomUserId
    setUserId(randomUserId)

    // Connect to Phoenix Socket with reconnect strategy
    const socket = new Socket(WS_URL, {
      reconnectAfterMs: (tries: number) => [1000, 2000, 5000, 10000][tries - 1] || 10000,
    })
    socketRef.current = socket

    socket.onError(() => {
      console.error('WebSocket connection error - backend may be waking up')
      if (!socketErrorShown.current) {
        socketErrorShown.current = true
        setMultiplayerStatus('waking')
      }
    })

    socket.onOpen(() => {
      socketErrorShown.current = false
      setMultiplayerStatus('idle')
    })

    socket.connect()

    // Join room channel
    const channel = socket.channel(`room:${targetRoomId}`, {})
    channelRef.current = channel

    channel.join()
      .receive('ok', () => {
        setInRoom(true)
        setMultiplayerParticipants([randomUserId])
        channel.push('user_joined', { user_id: randomUserId })
      })
      .receive('error', (resp: any) => {
        console.error('Failed to join channel:', resp)
        alert('Could not join multiplayer room. Backend may be starting up — try again in 20 seconds.')
      })

    // Listen for room updates
    channel.on('user_joined', (msg: any) => {
      setMultiplayerParticipants((prev) => Array.from(new Set([...prev, msg.user_id])))
      if (msg.user_id !== userIdRef.current && userIdRef.current) {
        channel.push('user_joined', { user_id: userIdRef.current })
      }
    })

    channel.on('recording_started', (msg: any) => {
      setMultiplayerParticipants((prev) => Array.from(new Set([...prev, msg.user_id])))
      setMultiplayerStatus('recording')
    })

    channel.on('recording_merged', (msg: any) => {
      setMultiplayerStatus('idle')
      loadRecordings()
      alert(`New merged recording "${msg.recording.title}" is ready!`)
    })
  }

  // Start multiplayer streaming recording
  const startMultiplayerRecording = async () => {
    if (!channelRef.current) return

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(stream)
      
      // ScriptProcessorNode for chunking audio raw PCM
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      processorNodeRef.current = processor

      const activeUserId = userIdRef.current || userId

      // Tell backend we are starting
      channelRef.current.push('start_recording', { user_id: activeUserId })

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0)
        
        // Convert Float32 to 16-bit PCM Buffer
        const buffer = new ArrayBuffer(input.length * 2)
        const view = new DataView(buffer)
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]))
          view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
        }
        
        // Ultra-fast zero-lag Base64 encoding
        const bytes = new Uint8Array(buffer)
        let binary = ''
        const chunkSize = 0x8000
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as any)
        }
        const base64 = btoa(binary)
        channelRef.current?.push('audio_chunk', { user_id: activeUserId, data: base64 })
      }

      // Speech Recognition for real-time multiplayer transcripts
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      if (SpeechRecognition) {
        try {
          const recognition = new SpeechRecognition()
          recognition.continuous = true
          recognition.interimResults = false
          recognition.lang = 'en-US'

          let localTranscript = ''
          recognition.onresult = (event: any) => {
            for (let i = event.resultIndex; i < event.results.length; ++i) {
              if (event.results[i].isFinal) {
                localTranscript += event.results[i][0].transcript + ' '
              }
            }
            const text = localTranscript.trim()
            setTranscriptText(text)
            // Stream transcript to server in real-time
            channelRef.current?.push('submit_transcript', { transcript: text })
          }

          recognitionRef.current = recognition
          recognition.start()
        } catch (recErr) {
          console.warn('SpeechRecognition warning:', recErr)
        }
      }

      const gainNode = audioContext.createGain()
      gainNode.gain.value = 0

      source.connect(processor)
      processor.connect(gainNode)
      gainNode.connect(audioContext.destination)
      setMultiplayerStatus('recording')
    } catch (err) {
      console.error('Multiplayer recording failed:', err)
      alert('Could not start multiplayer recording.')
    }
  }

  // Stop multiplayer session and merge audio files
  const stopAndMergeMultiplayer = () => {
    if (!channelRef.current || !roomId) return

    // Stop local SpeechRecognition safely
    try {
      if (recognitionRef.current) {
        recognitionRef.current.stop()
      }
    } catch (e) {
      console.warn('SpeechRecognition stop:', e)
    }

    // Stop local processor and media tracks safely
    try {
      if (processorNodeRef.current) {
        processorNodeRef.current.disconnect()
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
      }
    } catch (e) {
      console.warn('MediaStream stop:', e)
    }

    const sessionTitle = `Merged Session #${recordings.length + 1}`
    
    // Request server to merge the tracked user audio raw streams
    channelRef.current.push('stop_recording', {
      user_ids: multiplayerParticipants,
      title: sessionTitle
    })
    .receive('ok', (resp: any) => {
      setMultiplayerStatus('idle')
      loadRecordings()
      alert(`Session merged successfully: "${resp.recording.title}"`)
    })
    .receive('error', (err: any) => {
      console.error('Merge error:', err)
      alert(`Failed to merge recording: ${err.message || 'Unknown error'}`)
    })
  }

  const Dot = ({ ok, label }: { ok: boolean; label: string }) => (
    <span className="inline-flex items-center gap-1.5 text-xs text-mute">
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-link' : 'bg-hairline-strong'}`} />
      {label}
    </span>
  )

  return (
    <div className="min-h-screen bg-canvas text-body">
      <header className="sticky top-0 z-10 border-b border-hairline bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <span className="text-xl font-bold tracking-tight text-ink flex items-center gap-2">
            🎙️ timbre
          </span>
          <div className="flex items-center gap-4">
            <Dot ok={wasmOk} label="WASM DSP" />
            <Dot ok={apiOk} label="API Connection" />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8 grid grid-cols-1 md:grid-cols-3 gap-8">
        
        {/* Left Side: Recording and Voice Processing */}
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
                  <span className="text-sm font-medium text-red-500 animate-pulse">Recording audio...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center space-y-4">
                  <button 
                    onClick={startRecording}
                    className="h-16 w-16 bg-blue-600 hover:bg-blue-700 text-white rounded-full flex items-center justify-center font-bold shadow-lg transition-all transform hover:scale-105"
                  >
                    🎤
                  </button>
                  <span className="text-sm text-mute">Click to start recording</span>
                </div>
              )}
            </div>

            {/* DSP Controls */}
            {rawPCM && (
              <div className="space-y-6 border-t border-hairline pt-6">
                <h3 className="font-semibold text-ink flex items-center gap-2">
                  ⚡ WASM DSP Effects (In-Browser)
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
                        <span className="text-[10px] font-semibold text-mute uppercase tracking-wider">Processed (After)</span>
                        <audio src={audioUrl} controls className="w-full h-8" />
                      </div>
                    )}
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

          {/* Multiplayer Panel */}
          <div className="border border-hairline bg-canvas-soft rounded-2xl p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-ink mb-4 flex items-center gap-2">
              👥 Multiplayer Studio
            </h2>

            {!inRoom ? (
              <div className="space-y-4">
                <p className="text-sm text-mute">Join a multiplayer session to record audio collaboratively with peers and mix your streams into one file.</p>
                {multiplayerStatus === 'waking' && (
                  <div className="flex items-center gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg text-xs text-yellow-400 animate-pulse">
                    ⏳ Backend is waking up on Render free tier… this takes 15–30 seconds. Will connect automatically.
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={createRoom}
                    className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-semibold transition-all shadow-md"
                  >
                    Create New Session
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-3 bg-canvas border border-hairline rounded-lg space-y-2">
                  <span className="text-xs font-semibold text-ink uppercase tracking-wider">Share Link</span>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      readOnly 
                      value={window.location.href}
                      className="flex-1 bg-canvas-soft border border-hairline px-3 py-1.5 rounded text-xs text-mute outline-none"
                    />
                    <button 
                      onClick={() => {
                        navigator.clipboard.writeText(window.location.href)
                        alert('Copied room link!')
                      }}
                      className="px-3 bg-hairline hover:bg-hairline-strong text-ink rounded text-xs font-medium transition-all"
                    >
                      Copy
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-xs font-semibold text-ink uppercase tracking-wider">Participants ({multiplayerParticipants.length})</span>
                  <div className="flex flex-wrap gap-1.5">
                    {multiplayerParticipants.map((uid) => (
                      <span key={uid} className="px-2 py-1 bg-indigo-100 text-indigo-800 text-xs rounded-full font-medium">
                        👤 {uid} {uid === userId ? '(You)' : ''}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 border-t border-hairline pt-4">
                  {multiplayerStatus === 'recording' ? (
                    <button 
                      onClick={stopAndMergeMultiplayer}
                      className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition-all shadow-md"
                    >
                      Stop & Merge Session
                    </button>
                  ) : (
                    <button 
                      onClick={startMultiplayerRecording}
                      className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition-all shadow-md"
                    >
                      Record Multi-Stream
                    </button>
                  )}
                  <button 
                    onClick={() => {
                      window.history.pushState({}, '', window.location.pathname)
                      window.location.reload()
                    }}
                    className="px-4 py-2 border border-hairline text-ink rounded-lg text-sm font-medium hover:bg-hairline transition-all"
                  >
                    Leave
                  </button>
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
                <span className="text-xs text-mute mt-1">Upload a recording to get started.</span>
              </div>
            ) : (
              <div className="space-y-4 divide-y divide-hairline overflow-y-auto max-h-[500px] pr-1">
                 {recordings.map((recording) => (
                  <div key={recording.id} className="pt-4 first:pt-0 space-y-2">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="text-sm font-semibold text-ink line-clamp-1">{recording.title}</h3>
                        <span className="text-xs text-mute">
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
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-hairline mt-12 bg-canvas-soft">
        <div className="mx-auto max-w-4xl px-6 py-8 text-center text-xs text-mute">
          Timbre Full-Stack Voice Recorder — Phoenix + React + Rust WASM
        </div>
      </footer>
    </div>
  )
}
