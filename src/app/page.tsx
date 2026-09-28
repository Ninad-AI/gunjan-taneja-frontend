"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { startStreamingMic, type StreamingMicHandle } from "./utils/audioUtils";
import VoiceSessionUI from "../components/VoiceSessionUI";
import Aurora from "../components/ui/Aurora";
import { PROFILE } from "@/lib/profile";

type FlowState = "idle" | "active";
type CallPhase = "connecting" | "listening" | "speaking";

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://localhost:8000/ws/audio/gunjan";

const SESSION_MINUTES = 15;
  
export default function Home() {
  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [timeLeft, setTimeLeft] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [callPhase, setCallPhase] = useState<CallPhase>("connecting");
  const [isVisible, setIsVisible] = useState(false);

  const mousePosRef = useRef({ x: 0, y: 0 });
  const mouseTargetRef = useRef({ x: 0, y: 0 });
  const avatarRefs = useRef<(HTMLDivElement | null)[]>([]);

  /* ── Audio streaming refs ── */
  const wsRef = useRef<WebSocket | null>(null);
  const micControllerRef = useRef<StreamingMicHandle | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const playHeadRef = useRef(0);
  const sourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const sourceEndPromisesRef = useRef<Promise<void>[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ttsActiveRef = useRef(false);

  /* ── Entrance animation + mouse-follow parallax ── */
  useEffect(() => {
    const timeout = setTimeout(() => setIsVisible(true), 100);

    const handleMouseMove = (e: MouseEvent) => {
      mouseTargetRef.current = {
        x: (e.clientX / window.innerWidth - 0.5) * 20,
        y: (e.clientY / window.innerHeight - 0.5) * 20,
      };
    };

    let frameId: number;
    const animate = () => {
      mousePosRef.current.x +=
        (mouseTargetRef.current.x - mousePosRef.current.x) * 0.1;
      mousePosRef.current.y +=
        (mouseTargetRef.current.y - mousePosRef.current.y) * 0.1;

      avatarRefs.current.forEach((el, i) => {
        if (!el) return;
        const m = i === 0 ? 0.5 : -1;
        el.style.transform = `translate3d(${mousePosRef.current.x * m}px, ${mousePosRef.current.y * m}px, 0)`;
      });

      frameId = requestAnimationFrame(animate);
    };

    window.addEventListener("mousemove", handleMouseMove);
    animate();

    return () => {
      clearTimeout(timeout);
      window.removeEventListener("mousemove", handleMouseMove);
      cancelAnimationFrame(frameId);
    };
  }, []);

  /* ── Audio context helpers ── */
  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextCtor();
      playHeadRef.current = audioContextRef.current.currentTime;
      sourceEndPromisesRef.current = [];
    }
    return audioContextRef.current;
  }, []);

  const scheduleBuffer = useCallback(
    (buffer: AudioBuffer) => {
      const audioCtx = getAudioContext();
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(audioCtx.destination);

      const endPromise = new Promise<void>((resolve) => {
        src.onended = () => {
          sourceNodesRef.current = sourceNodesRef.current.filter((node) => node !== src);
          resolve();
        };
      });
      sourceEndPromisesRef.current.push(endPromise);
      sourceNodesRef.current.push(src);

      if (playHeadRef.current < audioCtx.currentTime) {
        playHeadRef.current = audioCtx.currentTime;
      }

      src.start(playHeadRef.current);
      playHeadRef.current += buffer.duration;
    },
    [getAudioContext],
  );

  const stopPlaybackImmediately = useCallback(() => {
    sourceNodesRef.current.forEach((node) => {
      try {
        node.stop(0);
      } catch {
        // ignore nodes already ended/stopped
      }
    });
    sourceNodesRef.current = [];
    sourceEndPromisesRef.current = [];

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    playHeadRef.current = 0;
  }, []);

  const processBinaryChunk = useCallback(
    (arrayBuffer: ArrayBuffer) => {
      // Backend sends PCM16 (Int16)
      const int16 = new Int16Array(arrayBuffer);

      // Convert Int16 → Float32 for Web Audio API
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      const sampleRate = 16000; // Must match backend TTS
      const audioCtx = getAudioContext();
      const buffer = audioCtx.createBuffer(1, float32.length, sampleRate);
      buffer.copyToChannel(float32, 0, 0);

      scheduleBuffer(buffer);
    },
    [getAudioContext, scheduleBuffer],
  );

  /* ── WebSocket audio streaming when active ── */
  useEffect(() => {
    if (flowState !== "active") return;

    setIsSpeaking(false);
    setCallPhase("connecting");

    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = async () => {
      setCallPhase("listening");
      ttsActiveRef.current = false;
      try {
        const controller = await startStreamingMic(ws, () => {
          // Mic level callback intentionally ignored for now.
        }, {
          energyThreshold: 0.01,
          silenceMs: 600,
          onSpeechStart: () => {
            // Only update when model is NOT speaking (prevents echo triggering)
            if (!ttsActiveRef.current) {
              setCallPhase("listening");
            }
          },
          onSpeechEnd: () => {
            // User stopped speaking; stay on "listening" until model responds
            // Only update when model is NOT speaking (prevents echo triggering)
            if (!ttsActiveRef.current) {
              setCallPhase("listening");
            }
          },
        });
        micControllerRef.current = controller;
      } catch (err) {
        // mic start failed
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        ttsActiveRef.current = true;
        setIsSpeaking(true);
        setCallPhase("speaking");
        processBinaryChunk(event.data);
      } else {
        // JSON control messages (tts_start, tts_end, etc.)
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "tts_start") {
            ttsActiveRef.current = true;
            setIsSpeaking(true);
            setCallPhase("speaking");
          }
          if (msg.type === "tts_end") {
            // Wait for all scheduled audio buffers to finish playing
            // before transitioning back to listening
            const pendingPromises = [...sourceEndPromisesRef.current];
            if (pendingPromises.length > 0) {
              Promise.all(pendingPromises).then(() => {
                ttsActiveRef.current = false;
                setIsSpeaking(false);
                setCallPhase("listening");
              });
            } else {
              ttsActiveRef.current = false;
              setIsSpeaking(false);
              setCallPhase("listening");
            }
          }
        } catch {
          /* ignore non-JSON */
        }
      }
    };

    ws.onerror = () => {
      setCallPhase("connecting");
    };

    ws.onclose = () => {
      setIsSpeaking(false);
      setCallPhase("connecting");
    };

    return () => {
      // Cleanup on flowState change / unmount
      if (micControllerRef.current) {
        micControllerRef.current.stop();
        micControllerRef.current = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      wsRef.current = null;
      ttsActiveRef.current = false;
      stopPlaybackImmediately();
    };
  }, [flowState, processBinaryChunk, stopPlaybackImmediately]);

  const handleStartTalking = () => {
    setTimeLeft(SESSION_MINUTES * 60);
    setFlowState("active");
  };

  const handleEndCall = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);

    // Stop mic streaming
    if (micControllerRef.current) {
      micControllerRef.current.stop();
      micControllerRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      wsRef.current.close();
      wsRef.current = null;
    }

    stopPlaybackImmediately();
    ttsActiveRef.current = false;

    setFlowState("idle");
    setTimeLeft(0);
    setIsSpeaking(false);
    setCallPhase("connecting");
  }, [stopPlaybackImmediately]);

  /* ── Countdown timer ── */
  useEffect(() => {
    if (flowState !== "active" || timeLeft <= 0) return;

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          handleEndCall();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [flowState, timeLeft, handleEndCall]);

  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-[#0F0F13] text-white font-sans selection:bg-rose-500/30">
      {/* ── Background Aurora ── */}
      <div className="absolute inset-0 pointer-events-none">
        <Aurora
          colorStops={["#0B132B", "#6366f1", "#ec4899"]}
          blend={0.5}
          amplitude={flowState === "active" ? 0.6 : 1.0}
          speed={0.5}
        />
      </div>

      {/* ── Content ── */}
      <div
        className={`
          relative z-10 w-full min-h-screen flex flex-col items-center justify-center px-6 sm:px-10 py-16 sm:py-20
          transition-all duration-700 ease-out
          ${isVisible ? "opacity-100 scale-100" : "opacity-0 scale-95"}
        `}
      >
        {flowState === "active" ? (
            <VoiceSessionUI
              isSpeaking={isSpeaking}
              callPhase={callPhase}
              timeLeft={timeLeft}
              totalTime={SESSION_MINUTES * 60}
              onEndCall={handleEndCall}
              creatorName={PROFILE.name}
              creatorImage={PROFILE.image}
            />
          ) : (
          /* ── Idle Hero ── */
          <div className="relative w-full max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-center md:justify-between gap-6 md:gap-16">
            {/* Text Content */}
            <div className="relative z-20 flex flex-col items-center md:items-start text-center md:text-left">
              <h2 className="text-[10px] sm:text-sm md:text-base text-rose-300 font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase mb-2 sm:mb-4 animate-fade-in-up">
                • {PROFILE.role}
              </h2>
              <br />

<h1 className="text-[2.6rem] xs:text-[3.2rem] sm:text-6xl md:text-8xl font-black tracking-[0.012em] sm:tracking-[0.015em] md:tracking-[0.02em] leading-[1.22] md:leading-[1.18] pb-3 md:pb-4 mix-blend-exclusion mt-2 overflow-visible">
  <span className="block pb-[0.08em] text-transparent bg-clip-text bg-linear-to-r from-white to-white/50">
    {PROFILE.name}
  </span>
</h1>

              <br />
              <br />

              {/* Desktop CTA */}
              <div className="animate-fade-in-up mt-8 shrink-0 hidden md:block">
                <button
                  onClick={handleStartTalking}
                  className="group relative inline-flex items-center justify-center rounded-full bg-white text-black font-bold text-sm sm:text-base tracking-wide w-55 h-14 sm:h-16 shadow-[0_0_40px_rgba(255,255,255,0.3)] hover:shadow-[0_0_60px_rgba(255,255,255,0.5)] hover:scale-105 transition-all duration-300"
                >
                  <span className="flex items-center gap-3">
                    Start Session
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 transition-transform duration-300 group-hover:translate-x-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
                    </svg>
                  </span>
                </button>
              </div>
            </div>

            {/* Image */}
            <div className="relative w-50 h-50 xs:w-60 xs:h-60 sm:w-75 sm:h-75 md:w-125 md:h-150 shrink-0">
              <div
                ref={(el) => { avatarRefs.current[1] = el; }}
                className="relative w-full h-full overflow-hidden shadow-2xl hover:scale-[1.02] transition-transform duration-700 will-change-transform"
                style={{ borderRadius: "30% 70% 70% 30% / 30% 30% 70% 70%" }}
              >
                  <Image
                  src={PROFILE.image}
                  alt={PROFILE.name}
                  fill
                  sizes="(min-width: 768px) 500px, (min-width: 640px) 300px, (min-width: 475px) 240px, 200px"
                  className="object-cover scale-110"
                  priority
                />
                <div className="absolute inset-0 bg-linear-to-t from-black/50 via-transparent to-transparent opacity-60" />
              </div>

              {/* Floating Decorative Elements — clipped so they don't overflow on tiny screens */}
              <div
                className="absolute -top-6 -right-6 sm:-top-12 sm:-right-12 w-12 h-12 sm:w-24 sm:h-24 bg-white/10 backdrop-blur-md border border-white/20 z-20 animate-float"
                style={{ borderRadius: "50%" }}
              />
              <div
                className="absolute bottom-16 -left-4 sm:-left-16 w-14 h-14 sm:w-32 sm:h-32 bg-rose-500/20 backdrop-blur-md border border-rose-500/20 z-20 animate-float animation-delay-2000"
                style={{ borderRadius: "60% 40% 30% 70% / 60% 30% 70% 40%" }}
              />
            </div>

            {/* Mobile CTA */}
            <div className="animate-fade-in-up mt-6 md:hidden w-full flex justify-center z-30">
              <button
                onClick={handleStartTalking}
                className="group relative inline-flex items-center justify-center gap-3 rounded-full bg-white text-black font-bold text-sm tracking-wide w-45 xs:w-50 h-13 sm:h-16 shadow-[0_0_40px_rgba(255,255,255,0.3)] hover:shadow-[0_0_60px_rgba(255,255,255,0.5)] hover:scale-105 transition-all duration-300"
              >
                Start Session
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 transition-transform duration-300 group-hover:translate-x-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
