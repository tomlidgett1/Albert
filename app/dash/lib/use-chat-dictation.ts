"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DictationStatus = "idle" | "recording" | "transcribing";

/** Below this RMS, treat the mic as quiet. */
const QUIET_THRESHOLD = 0.03;

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function mergeTranscript(existing: string, transcript: string): string {
  const next = transcript.trim();
  if (!next) return existing;
  const current = existing.trimEnd();
  if (!current) return next;
  const needsSpace = !/\s$/u.test(current);
  return `${current}${needsSpace ? " " : ""}${next}`;
}

export function useChatDictation() {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const smoothedVolumeRef = useRef(0);
  const sendAfterStopRef = useRef(false);
  const stoppingRef = useRef(false);

  const clearMeter = useCallback(() => {
    if (rafRef.current !== undefined) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }
    smoothedVolumeRef.current = 0;
    setVolume(0);
  }, []);

  const releaseMedia = useCallback(() => {
    clearMeter();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already stopped.
      }
    }
    mediaRecorderRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    analyserRef.current = null;
    chunksRef.current = [];
  }, [clearMeter]);

  useEffect(() => () => {
    releaseMedia();
  }, [releaseMedia]);

  const startMeter = useCallback((stream: MediaStream) => {
    const AudioContextCtor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    // Match common voice-UI analysers: smooth enough to avoid jitter, fast enough to feel live.
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    audioContextRef.current = context;
    analyserRef.current = analyser;
    smoothedVolumeRef.current = 0;
    setVolume(0);

    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      const node = analyserRef.current;
      if (!node) return;
      node.getByteTimeDomainData(data);

      let sumSquares = 0;
      for (let index = 0; index < data.length; index += 1) {
        const centred = ((data[index] ?? 128) - 128) / 128;
        sumSquares += centred * centred;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      const instant = rms < QUIET_THRESHOLD
        ? 0
        : Math.min(1, (rms - QUIET_THRESHOLD) / 0.22);

      // Attack fast, release slower so bars swell with speech and ease back.
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

  const transcribeBlob = useCallback(async (blob: Blob): Promise<string> => {
    const form = new FormData();
    const extension = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
    form.append("audio", blob, `dictation.${extension}`);
    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
    if (!response.ok) {
      const message = typeof payload?.error === "string"
        ? payload.error
        : "Could not transcribe that recording.";
      throw new Error(message);
    }
    return typeof payload?.text === "string" ? payload.text : "";
  }, []);

  const finishRecording = useCallback(async (
    draft: string,
    onDraftChange: (next: string) => void,
    onSend?: (text: string) => void,
  ) => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    sendAfterStopRef.current = Boolean(onSend);

    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      stoppingRef.current = false;
      setStatus("idle");
      releaseMedia();
      return;
    }

    setStatus("transcribing");
    clearMeter();

    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.addEventListener("stop", () => {
        const type = recorder.mimeType || "audio/webm";
        resolve(new Blob(chunksRef.current, { type }));
      }, { once: true });
      recorder.addEventListener("error", () => {
        reject(new Error("Recording failed."));
      }, { once: true });
      try {
        recorder.stop();
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Recording failed."));
      }
    }).finally(() => {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      void audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = null;
      analyserRef.current = null;
      mediaRecorderRef.current = null;
    });

    try {
      if (blob.size < 1) {
        throw new Error("The recording was empty.");
      }
      const transcript = await transcribeBlob(blob);
      const merged = mergeTranscript(draft, transcript);
      onDraftChange(merged);
      if (sendAfterStopRef.current && merged.trim()) {
        onSend?.(merged.trim());
      }
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not transcribe that recording.");
    } finally {
      chunksRef.current = [];
      stoppingRef.current = false;
      sendAfterStopRef.current = false;
      setStatus("idle");
    }
  }, [clearMeter, releaseMedia, transcribeBlob]);

  const start = useCallback(async () => {
    if (status !== "idle") return;
    setError(null);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Dictation needs microphone access in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      chunksRef.current = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      startMeter(stream);
      recorder.start(120);
      setStatus("recording");
    } catch (error) {
      releaseMedia();
      setStatus("idle");
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotFoundError") {
        setError("No microphone was found on this device.");
      } else if (name === "NotReadableError") {
        setError("The microphone is busy in another app. Close it and try again.");
      } else if (name === "SecurityError") {
        setError("This page is not allowed to use the microphone. Hard-refresh after the latest deploy, or open Albert in a normal browser tab.");
      } else if (name === "NotAllowedError") {
        setError("Microphone access was blocked. Allow the mic for this site in the browser address bar, then try again.");
      } else {
        setError("Microphone permission is required for dictation.");
      }
    }
  }, [releaseMedia, startMeter, status]);

  const stop = useCallback(async (
    draft: string,
    onDraftChange: (next: string) => void,
  ) => {
    if (status !== "recording") return;
    await finishRecording(draft, onDraftChange);
  }, [finishRecording, status]);

  const stopAndSend = useCallback(async (
    draft: string,
    onDraftChange: (next: string) => void,
    onSend: (text: string) => void,
  ) => {
    if (status !== "recording") return;
    await finishRecording(draft, onDraftChange, onSend);
  }, [finishRecording, status]);

  const cancel = useCallback(() => {
    stoppingRef.current = false;
    sendAfterStopRef.current = false;
    releaseMedia();
    setStatus("idle");
  }, [releaseMedia]);

  return {
    status,
    volume,
    error,
    start,
    stop,
    stopAndSend,
    cancel,
    clearError: () => setError(null),
  };
}
