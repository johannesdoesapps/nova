"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/*
 * Voice input via the browser's Web Speech API (offered only where supported). In Chrome and Edge the audio is
 * sent to the browser maker's speech service; in Safari it goes to Apple's. Orbis never receives the audio, only
 * the words.
 */

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

const noSubscribe = () => () => {};
function speechCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function useSpeech(onText: (t: string) => void) {
  const supported = useSyncExternalStore(noSubscribe, () => !!speechCtor(), () => false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const cb = useRef(onText);
  useEffect(() => {
    cb.current = onText;
  });

  useEffect(() => () => rec.current?.stop(), []);

  const start = useCallback((base: string) => {
    const Ctor = speechCtor();
    if (!Ctor) return;
    setError(null);
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    const prefix = base.trim() ? `${base.trimEnd()} ` : "";
    r.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i]![0]!.transcript;
      cb.current(prefix + t.trim());
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(e.error === "not-allowed" || e.error === "service-not-allowed" ? "Microphone access is blocked for this site." : `Voice input stopped (${e.error}).`);
    };
    r.onend = () => setListening(false);
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      setError("Voice input could not start.");
    }
  }, []);

  const stop = useCallback(() => rec.current?.stop(), []);
  /** Stop without delivering anything more (the words heard so far were already passed on). */
  const cancel = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    r.onresult = null;
    r.abort();
  }, []);
  return { supported, listening, error, start, stop, cancel };
}
