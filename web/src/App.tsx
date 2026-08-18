import { useEffect, useState, useRef } from 'react'
import init, { rms_level, apply_gain, normalize, low_pass_filter } from 'timbre_kit'
import { pipeline, env } from '@xenova/transformers'

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
  
  // WASM DSP parameters
  const [gain, setGain] = useState<number>(1.0)
  const [shouldNormalize, setShouldNormalize] = useState<boolean>(false)
  const [shouldLowPass, setShouldLowPass] = useState<boolean>(false)
  const [lowPassCutoff, setLowPassCutoff] = useState<number>(1000)
  
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

  // Check API & load recordings from Phoenix Backend
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
          if (fullText.trim()) {
            setTranscriptText((prev) => {
              const current = prev && !prev.includes('Voice audio captured') ? prev : ''
              return (current + ' ' + fullText.trim()).trim()
            })
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
        const text = output.text.trim()
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

  // Apply WASM DSP and generate audio file url
  useEffect(() => {
    if (!rawPCM) return

    // Convert original raw PCM to wav for 'before' preview
    const origWavBlob = bufferToWav(rawPCM, sampleRate)
    const origUrl = URL.createObjectURL(origWavBlob)
    setOriginalUrl(origUrl)

    // Copy original pcm to avoid mutating the source array
    const processed = new Float32Array(rawPCM)
    
    // Apply gain via Rust WASM
    if (gain !== 1.0) {
      apply_gain(processed, gain)
    }

    // Apply normalization via Rust WASM
    if (shouldNormalize) {
      normalize(processed)
    }

    // Apply lowpass filter via Rust WASM
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

    // Run same WASM DSP transformations
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
    const cleanTranscript = transcriptText.trim()
    const finalTranscript =
      cleanTranscript && !cleanTranscript.includes('Voice audio captured')
        ? cleanTranscript
        : analyzeSpeechFromPCM(rawPCM, sampleRate)

    formData.append('transcript', finalTranscript)

    const summaryText = `AI Voice Summary: "${finalTranscript.substring(0, 100)}${finalTranscript.length > 100 ? '...' : ''}" (WASM DSP: Gain ${gain}x, Normalized ${shouldNormalize ? 'Yes' : 'No'}, LowPass ${shouldLowPass ? lowPassCutoff + 'Hz' : 'Off'})`
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
        alert('Failed to upload recording to server.')
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
          Timbre Full-Stack Voice Recorder — Phoenix API + React Web + Rust WASM
        </div>
      </footer>
    </div>
  )
}
