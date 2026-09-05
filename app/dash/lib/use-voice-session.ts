"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TraceAnswerEvent,
  TraceClarificationEvent,
  TraceEvent,
} from "@/packages/shared/src";
import {
  buildAnswerToolOutput,
  buildClarificationToolOutput,
  buildErrorToolOutput,
  createNarrationTracker,
  describeTableEventForVoice,
  describeTraceEventForVoice,
} from "./voice-narration";

export type VoiceSessionStatus = "idle" | "connecting" | "live" | "error";

/** What the session is doing right now, for the waveform + status copy. */
export type VoiceActivity = "listening" | "thinking" | "responding";

export type VoiceTurnOutcome = Readonly<{
  answer?: TraceAnswerEvent;
  clarification?: TraceClarificationEvent;
  error?: string;
  stopped?: boolean;
}>;

export type VoiceTurnObserver = Readonly<{
  onEvent: (event: TraceEvent) => void;
  onDone: (outcome: VoiceTurnOutcome) => void;
}>;

type UseVoiceSessionOptions = Readonly<{
  /**
   * Starts a governed analysis turn (the normal chat pipeline) and reports
   * its trace events and final outcome back to the voice layer.
   */
  runAnalysis: (question: string, observer: VoiceTurnObserver) => void;
}>;

/** Below this RMS, treat the channel as quiet (matches dictation meter). */
const QUIET_THRESHOLD = 0.03;
const PROGRESS_PUMP_MS = 2_500;

function rmsOf(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(data);
  let sumSquares = 0;
  for (let index = 0; index < data.length; index += 1) {
    const centred = ((data[index] ?? 128) - 128) / 128;
    sumSquares += centred * centred;
  }
  const rms = Math.sqrt(sumSquares / data.length);
  return rms < QUIET_THRESHOLD ? 0 : Math.min(1, (rms - QUIET_THRESHOLD) / 0.22);
}

/**
 * A live speech conversation with Albert over OpenAI's Realtime API (WebRTC).
 *
 * The realtime model is the mouth and ears only: every business question is
 * routed through the governed codex pipeline via `runAnalysis`, and while a
 * turn runs the hook feeds the model short spoken progress updates derived
 * from the public trace stream. The model never sees raw runtime internals —
 * only the same owner-facing copy the trail renders.
 */
export function useVoiceSession(options: UseVoiceSessionOptions) {
  const [status, setStatus] = useState<VoiceSessionStatus>("idle");
  const [activity, setActivity] = useState<VoiceActivity>("listening");
  const [statusLine, setStatusLine] = useState("");
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const runAnalysisRef = useRef(options.runAnalysis);
  useEffect(() => {
    runAnalysisRef.current = options.runAnalysis;
  });

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const pumpRef = useRef<number | undefined>(undefined);
  const smoothedVolumeRef = useRef(0);

  const generationRef = useRef(0);
  const activeResponsesRef = useRef(0);
  const codexRunningRef = useRef(false);
  const activityRef = useRef<VoiceActivity>("listening");
  const callNamesRef = useRef(new Map<string, string>());
  const trackerRef = useRef(createNarrationTracker());

  const applyActivity = useCallback((next: VoiceActivity) => {
    activityRef.current = next;
    setActivity(next);
  }, []);

  const sendEvent = useCallback((event: Record<string, unknown>): boolean => {
    const channel = dcRef.current;
    if (!channel || channel.readyState !== "open") return false;
    try {
      channel.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }, []);

  const teardown = useCallback(() => {
    generationRef.current += 1;
    if (pumpRef.current !== undefined) {
      window.clearInterval(pumpRef.current);
      pumpRef.current = undefined;
    }
    if (rafRef.current !== undefined) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }
    smoothedVolumeRef.current = 0;
    setVolume(0);
    try {
      dcRef.current?.close();
    } catch {
      // Already closed.
    }
    dcRef.current = null;
    pcRef.current?.getSenders().forEach((sender) => sender.track?.stop());
    try {
      pcRef.current?.close();
    } catch {
      // Already closed.
    }
    pcRef.current = null;
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    if (audioElementRef.current) {
      audioElementRef.current.srcObject = null;
      audioElementRef.current = null;
    }
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    micAnalyserRef.current = null;
    remoteAnalyserRef.current = null;
    activeResponsesRef.current = 0;
    codexRunningRef.current = false;
    callNamesRef.current.clear();
    trackerRef.current.reset();
    setStatusLine("");
    applyActivity("listening");
  }, [applyActivity]);

  useEffect(() => () => {
    teardown();
  }, [teardown]);

  const stop = useCallback(() => {
    teardown();
    setStatus("idle");
    setError(null);
  }, [teardown]);

  const speakProgress = useCallback((line: string) => {
    sendEvent({
      type: "response.create",
      response: {
        conversation: "none",
        metadata: { topic: "albert_progress" },
        output_modalities: ["audio"],
        instructions: [
          `Relay this to the user in one short, casual sentence, like a colleague thinking aloud: ${line}.`,
          "Just the substance — no filler like 'hang tight' or 'bear with me', never promise when results will arrive, and don't say you're still working on it: the update itself shows that.",
          "Read any figures exactly as given; do not invent findings or numbers.",
        ].join(" "),
      },
    });
  }, [sendEvent]);

  const speakHeartbeat = useCallback(() => {
    sendEvent({
      type: "response.create",
      response: {
        conversation: "none",
        metadata: { topic: "albert_heartbeat" },
        output_modalities: ["audio"],
        instructions:
          "The analysis is still running with nothing new to report. Say only a brief, natural few-word check-in — vary it (for example 'Still on it.' or 'Still digging.'). No apologies, no promises, nothing else.",
      },
    });
  }, [sendEvent]);

  const deliverToolResult = useCallback((callId: string, output: string) => {
    sendEvent({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
    sendEvent({ type: "response.create" });
  }, [sendEvent]);

  const handleAskAlbert = useCallback((callId: string, rawArguments: string) => {
    let question = "";
    try {
      const parsed = JSON.parse(rawArguments) as { question?: unknown };
      if (typeof parsed.question === "string") question = parsed.question.trim();
    } catch {
      // Handled below as an empty question.
    }
    if (!question) {
      deliverToolResult(callId, buildErrorToolOutput("The question was empty — ask the user to rephrase."));
      return;
    }

    const generation = generationRef.current;
    codexRunningRef.current = true;
    trackerRef.current.reset();
    trackerRef.current.primeImmediate();
    applyActivity("thinking");
    setStatusLine("Working on it");
    // Real intermediate numbers beat "still working": read out the first
    // couple of completed governed tables as they stream in.
    let tableCallouts = 0;

    runAnalysisRef.current(question, {
      onEvent: (event) => {
        if (generationRef.current !== generation) return;
        if (event.type === "table") {
          if (tableCallouts >= 2) return;
          const headline = describeTableEventForVoice(event);
          if (!headline) return;
          tableCallouts += 1;
          trackerRef.current.note(headline);
          trackerRef.current.primeImmediate();
          setStatusLine("First numbers are in");
          return;
        }
        const line = describeTraceEventForVoice(event);
        if (!line) return;
        trackerRef.current.note(line);
        setStatusLine(line.charAt(0).toUpperCase() + line.slice(1));
      },
      onDone: (outcome) => {
        if (generationRef.current !== generation) return;
        codexRunningRef.current = false;
        if (activityRef.current === "thinking") applyActivity("listening");
        if (outcome.answer) {
          deliverToolResult(callId, buildAnswerToolOutput(outcome.answer));
        } else if (outcome.clarification) {
          deliverToolResult(callId, buildClarificationToolOutput(outcome.clarification));
        } else if (outcome.stopped) {
          deliverToolResult(callId, buildErrorToolOutput("The analysis was stopped before it finished."));
        } else {
          deliverToolResult(
            callId,
            buildErrorToolOutput(outcome.error ?? "The analysis did not finish."),
          );
        }
      },
    });
  }, [applyActivity, deliverToolResult]);

  const handleServerEvent = useCallback((raw: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof event.type === "string" ? event.type : "";

    switch (type) {
      case "session.created": {
        setStatus("live");
        applyActivity("listening");
        // A one-line spoken welcome so the user knows the mic is live.
        sendEvent({
          type: "response.create",
          response: {
            instructions:
              "Greet the user in one short sentence and invite them to ask anything about their business.",
          },
        });
        return;
      }
      case "input_audio_buffer.speech_started": {
        applyActivity("listening");
        return;
      }
      case "response.created": {
        activeResponsesRef.current += 1;
        return;
      }
      case "response.done": {
        activeResponsesRef.current = Math.max(0, activeResponsesRef.current - 1);
        if (activityRef.current === "responding") {
          applyActivity(codexRunningRef.current ? "thinking" : "listening");
        }
        return;
      }
      case "output_audio_buffer.started": {
        applyActivity("responding");
        return;
      }
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": {
        applyActivity(codexRunningRef.current ? "thinking" : "listening");
        return;
      }
      case "response.output_item.added": {
        const item = event.item as { type?: unknown; call_id?: unknown; name?: unknown } | undefined;
        if (
          item
          && item.type === "function_call"
          && typeof item.call_id === "string"
          && typeof item.name === "string"
        ) {
          callNamesRef.current.set(item.call_id, item.name);
        }
        return;
      }
      case "response.function_call_arguments.done": {
        const callId = typeof event.call_id === "string" ? event.call_id : "";
        const rawArguments = typeof event.arguments === "string" ? event.arguments : "";
        if (!callId) return;
        const name = callNamesRef.current.get(callId) ?? "ask_albert";
        if (name === "ask_albert") handleAskAlbert(callId, rawArguments);
        return;
      }
      case "error": {
        const detail = event.error as { message?: unknown } | undefined;
        const message = typeof detail?.message === "string" ? detail.message : "";
        // Non-fatal server errors (e.g. a rejected event) should not end the call.
        console.warn("voice session server error", message || event);
        return;
      }
      default:
    }
  }, [applyActivity, handleAskAlbert, sendEvent]);

  const startMeters = useCallback((micStream: MediaStream) => {
    const AudioContextCtor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const context = new AudioContextCtor();
    audioContextRef.current = context;

    const micAnalyser = context.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyser.smoothingTimeConstant = 0.8;
    context.createMediaStreamSource(micStream).connect(micAnalyser);
    micAnalyserRef.current = micAnalyser;

    const data = new Uint8Array(micAnalyser.fftSize);
    const tick = () => {
      const mic = micAnalyserRef.current;
      const remote = remoteAnalyserRef.current;
      if (!mic) return;
      // Show whichever side is talking: assistant audio while it responds,
      // the user's mic otherwise.
      const instant = activityRef.current === "responding" && remote
        ? rmsOf(remote, data)
        : rmsOf(mic, data);
      const previous = smoothedVolumeRef.current;
      const next = instant > previous
        ? previous * 0.35 + instant * 0.65
        : previous * 0.86 + instant * 0.14;
      smoothedVolumeRef.current = next;
      setVolume(next);
      rafRef.current = window.requestAnimationFrame(tick);
    };
    void context.resume().catch(() => undefined);
    rafRef.current = window.requestAnimationFrame(tick);
  }, []);

  const attachRemoteStream = useCallback((stream: MediaStream) => {
    const audioElement = new Audio();
    audioElement.autoplay = true;
    audioElement.srcObject = stream;
    audioElementRef.current = audioElement;
    void audioElement.play().catch(() => undefined);
    const context = audioContextRef.current;
    if (context) {
      const remoteAnalyser = context.createAnalyser();
      remoteAnalyser.fftSize = 512;
      remoteAnalyser.smoothingTimeConstant = 0.8;
      context.createMediaStreamSource(stream).connect(remoteAnalyser);
      remoteAnalyserRef.current = remoteAnalyser;
    }
  }, []);

  const start = useCallback(async () => {
    if (status === "connecting" || status === "live") return;
    setError(null);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Voice mode needs microphone access in this browser.");
      setStatus("error");
      return;
    }
    if (typeof RTCPeerConnection === "undefined") {
      setError("Voice mode is not supported in this browser.");
      setStatus("error");
      return;
    }

    setStatus("connecting");
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (generationRef.current !== generation) {
        micStream.getTracks().forEach((track) => track.stop());
        return;
      }
      micStreamRef.current = micStream;
      startMeters(micStream);

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      const [micTrack] = micStream.getAudioTracks();
      if (micTrack) pc.addTrack(micTrack, micStream);
      pc.ontrack = (trackEvent) => {
        const [stream] = trackEvent.streams;
        if (stream) attachRemoteStream(stream);
      };
      pc.onconnectionstatechange = () => {
        if (generationRef.current !== generation) return;
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          teardown();
          setStatus("error");
          setError("The voice connection dropped. Tap the voice button to reconnect.");
        }
      };

      const channel = pc.createDataChannel("oai-events");
      dcRef.current = channel;
      channel.addEventListener("message", (message) => {
        if (generationRef.current !== generation) return;
        handleServerEvent(String(message.data));
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // The SDP exchange is proxied through Albert (CSP keeps connect-src
      // 'self'; the ephemeral realtime key never reaches the browser). Audio
      // and events then flow directly to OpenAI over the peer connection.
      const sessionResponse = await fetch("/api/voice-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: offer.sdp ?? "" }),
        credentials: "same-origin",
      });
      const session = await sessionResponse.json().catch(() => null) as {
        sdp?: unknown;
        error?: unknown;
      } | null;
      if (!sessionResponse.ok || typeof session?.sdp !== "string") {
        throw new Error(
          typeof session?.error === "string" ? session.error : "Voice mode could not start.",
        );
      }
      if (generationRef.current !== generation) return;
      await pc.setRemoteDescription({ type: "answer", sdp: session.sdp });

      // Progress pump: while a governed turn runs, hand the model at most one
      // short update at a time, spaced by the narration tracker, and only when
      // it is not already speaking.
      pumpRef.current = window.setInterval(() => {
        if (!codexRunningRef.current) return;
        if (activeResponsesRef.current > 0) return;
        const taken = trackerRef.current.take(Date.now());
        if (!taken) return;
        if (taken.kind === "heartbeat") speakHeartbeat();
        else speakProgress(taken.line);
      }, PROGRESS_PUMP_MS);
    } catch (caught) {
      if (generationRef.current !== generation) return;
      teardown();
      const name = caught instanceof DOMException ? caught.name : "";
      if (name === "NotFoundError") {
        setError("No microphone was found on this device.");
      } else if (name === "NotReadableError") {
        setError("The microphone is busy in another app. Close it and try again.");
      } else if (name === "NotAllowedError") {
        setError("Microphone access was blocked. Allow the mic for this site, then try again.");
      } else {
        setError(caught instanceof Error && caught.message
          ? caught.message
          : "Voice mode could not start.");
      }
      setStatus("error");
    }
  }, [attachRemoteStream, handleServerEvent, speakHeartbeat, speakProgress, startMeters, status, teardown]);

  return {
    status,
    activity,
    statusLine,
    volume,
    error,
    start,
    stop,
    clearError: useCallback(() => setError(null), []),
  };
}
