/**
 * Audio utility functions for recording, VAD, and streaming.
 */


/* ────────────────────────────────────────────────────
 *  Continuous PCM16 streaming over WebSocket
 * ──────────────────────────────────────────────────── */

export interface StreamingMicHandle {
  stop: () => void;
}

interface StreamingMicOptions {
  /** RMS energy floor before dynamic calibration (default 0.01) */
  energyThreshold?: number;
  /** Trailing silence in ms before emitting speech_end (default 600) */
  silenceMs?: number;
  /** Called when VAD detects the user started speaking */
  onSpeechStart?: () => void;
  /** Called when VAD detects the user stopped speaking */
  onSpeechEnd?: () => void;
}

/**
 * Start streaming raw PCM16 audio to a WebSocket at 16 kHz in 20 ms frames
 * (320 samples per frame — required for server-side VAD).
 *
 * Built-in energy-based VAD automatically sends JSON
 * `{ "type": "speech_start" }` and `{ "type": "speech_end" }` messages
 * bracketing each utterance. PCM16 frames are streamed continuously.
 */
export const startStreamingMic = async (
  ws: WebSocket,
  onAudioLevel?: (level: number) => void,
  options: StreamingMicOptions = {},
): Promise<StreamingMicHandle> => {
  const {
    energyThreshold = 0.01,
    silenceMs = 600,
    onSpeechStart,
    onSpeechEnd,
  } = options;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioContextCtor = window.AudioContext ||
    (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const audioContext: AudioContext = new AudioContextCtor({ sampleRate: 48000 });

  // MUST resume after user gesture
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const workletSource = `
    class MicCaptureProcessor extends AudioWorkletProcessor {
      process(inputs, outputs) {
        const input = inputs[0]?.[0];
        if (input) {
          const samples = input.slice();
          this.port.postMessage(samples, [samples.buffer]);
        }

        for (const output of outputs) {
          for (const channel of output) channel.fill(0);
        }

        return true;
      }
    }

    registerProcessor('mic-capture-processor', MicCaptureProcessor);
  `;
  const workletUrl = URL.createObjectURL(
    new Blob([workletSource], { type: "application/javascript" }),
  );
  await audioContext.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  const processor = new AudioWorkletNode(audioContext, "mic-capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });

  // Connect the graph
  source.connect(processor);
  processor.connect(audioContext.destination);

  /* ── VAD state ── */
  let isSpeaking = false;
  let lastSpeechTs = 0;         // ms timestamp of last above-threshold frame
  let noiseSum = 0;
  let noiseCount = 0;
  const calibrationMs = 500;    // first 0.5 s used for noise-floor estimation
  const streamStartTime = performance.now();

  // AudioWorkletProcessor delivers fixed 128-sample render quanta, which
  // downsample to far fewer than FRAME_SIZE samples per callback. Accumulate
  // across callbacks so full 320-sample frames can still be emitted.
  const FRAME_SIZE = 320; // 20 ms @ 16 kHz
  let sampleBuffer = new Float32Array(0);

  processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    const input = event.data;

    // ── Downsample to 16 kHz ──
    const targetSampleRate = 16000;
    const ratio = audioContext.sampleRate / targetSampleRate;
    const newLength = Math.floor(input.length / ratio);
    const downsampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      downsampled[i] = input[Math.floor(i * ratio)];
    }

    // ── Compute RMS energy on downsampled buffer ──
    let energySum = 0;
    for (let i = 0; i < downsampled.length; i++) {
      energySum += downsampled[i] * downsampled[i];
    }
    const rms = Math.sqrt(energySum / downsampled.length);

    // ── Dynamic noise-floor calibration (first 0.5 s) ──
    const elapsed = performance.now() - streamStartTime;
    if (elapsed < calibrationMs) {
      noiseSum += rms;
      noiseCount += 1;
    }

    let threshold = energyThreshold;
    if (noiseCount > 0) {
      const estNoise = noiseSum / noiseCount;
      threshold = Math.max(energyThreshold, estNoise * 3.0);
    }

    // ── VAD decision ──
    const now = performance.now();

    if (rms >= threshold) {
      lastSpeechTs = now;

      if (!isSpeaking) {
        isSpeaking = true;
        ws.send(JSON.stringify({ type: "speech_start" }));
        if (typeof onSpeechStart === "function") onSpeechStart();
      }
    } else if (isSpeaking) {
      const silenceElapsed = now - lastSpeechTs;
      if (silenceElapsed >= silenceMs) {
        isSpeaking = false;
        ws.send(JSON.stringify({ type: "speech_end" }));
        if (typeof onSpeechEnd === "function") onSpeechEnd();
      }
    }

    // ── Accumulate downsampled samples across worklet callbacks ──
    const merged = new Float32Array(sampleBuffer.length + downsampled.length);
    merged.set(sampleBuffer);
    merged.set(downsampled, sampleBuffer.length);
    sampleBuffer = merged;

    // ── 20 ms frame chunking (REQUIRED FOR VAD) ──
    let offset = 0;
    while (sampleBuffer.length - offset >= FRAME_SIZE) {
      const pcm16 = new Int16Array(FRAME_SIZE);
      for (let i = 0; i < FRAME_SIZE; i++) {
        const s = Math.max(-1, Math.min(1, sampleBuffer[offset + i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(pcm16.buffer);
      offset += FRAME_SIZE;
    }
    sampleBuffer = sampleBuffer.slice(offset);

    // ── Optional audio level callback ──
    if (typeof onAudioLevel === "function") {
      onAudioLevel(Math.min(rms * 8, 1));
    }
  };

  return {
    stop: () => {
      // If still speaking when stopped, send a final speech_end
      if (isSpeaking && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "speech_end" }));
        if (typeof onSpeechEnd === "function") onSpeechEnd();
      }
      processor.port.close();
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      audioContext.close();
    },
  };
};
