"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, AudioLines, Mic, OctagonX, Play, Sparkles, Wrench, X } from "lucide-react";
import { useMicrophone } from "voice-glow";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { useSpeech } from "@/hooks/use-speech";
import { END_OF_TURN_MS, isStopPhrase, QUIET_ROUND_MS, QUIET_ROUNDS, RELISTEN_DELAY_MS, shouldListen } from "@/lib/jarvis/conversation";
import { agentState, haltAgent, pairAgent, resumeAgent, unpairAgent, type AgentState } from "@/lib/jarvis/desktop-client";
import { executeStep, prepareStep } from "@/lib/jarvis/executors";
import { MissionRunner, newMission, stepFeedback, wantsFollowUp, type Mission } from "@/lib/jarvis/mission";
import { decide } from "@/lib/jarvis/permissions";
import { MAX_ROUNDS, type PlannedCall, type TraceRound } from "@/lib/jarvis/planner";
import { allSkills, findSkill, type SkillInput } from "@/lib/jarvis/skills";
import type { JarvisToolName } from "@/lib/jarvis/tools";
import {
  clearHistory,
  DEFAULT_SETTINGS,
  loadHalted,
  loadHistory,
  loadSettings,
  loadSkills,
  matchesShortcut,
  saveHalted,
  saveHistory,
  saveSettings,
  saveSkills,
  shortcutLabel,
  VOICE_PROFILES,
  type JarvisSettings,
} from "@/lib/jarvis/store";
import { cn } from "@/lib/utils";
import { CORE_LABEL, type CoreState } from "./jarvis-core";
import { OrbisAudioAnalyzer } from "./orbis/audio";
import { OrbisHero } from "./orbis/orbis-hero";
import { pulseOrbis, setOrbisState } from "./orbis/state";
import { DesktopPanel, HistoryPanel, MissionPanel, SettingsPanel, SkillsPanel } from "./jarvis-panels";

interface Turn {
  id: string;
  /** "activity": a tool Jarvis used along the way (shown small, never sent back as conversation). */
  role: "user" | "assistant" | "notice" | "activity";
  text: string;
  ok?: boolean;
}

interface TurnReply {
  say: string;
  calls: PlannedCall[];
  activity: { tool: JarvisToolName; summary: string; ok: boolean }[];
  /** Set when the browser's actions are waiting: send it back with their results to continue. */
  trace: TraceRound[] | null;
  model: { id: string } | null;
}

const QUICK: { label: string; request: string; desktop?: boolean }[] = [
  { label: "Research", request: "Research the best AI coding tools available right now and compare their pricing and features." },
  { label: "Organise Downloads", request: "Organise my Downloads folder by file type. Don't delete anything.", desktop: true },
  { label: "Look at my screen", request: "Look at my screen and tell me what's on it and anything that needs my attention." },
  { label: "Build a website", request: "Build me a website for my new business." },
  { label: "Check my computer", request: "How is my computer doing? Memory, disk space and battery.", desktop: true },
  { label: "Plan a project", request: "Help me plan a project: turn my goal into milestones and tasks." },
];

const uid = () => crypto.randomUUID();
/** iPhone and iPad: Safari may not let speech recognition share the microphone with a second capture. */
const isAppleTouch = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const subscribeNothing = () => () => {};

export function JarvisView() {
  const { user } = useApp();
  const mac = useSyncExternalStore(subscribeNothing, () => /Mac|iPhone|iPad/.test(navigator.platform), () => false);

  const [settings, setSettings] = useState<JarvisSettings>(DEFAULT_SETTINGS);
  const [halted, setHalted] = useState(false);
  const [history, setHistory] = useState<Mission[]>([]);
  const [agent, setAgent] = useState<AgentState>({ status: "checking" });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [mission, setMission] = useState<Mission | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(false);
  // Conversation mode: hands-free back-and-forth (see src/lib/jarvis/conversation.ts). Off on every visit.
  const [convo, setConvo] = useState(false);
  const [visible, setVisible] = useState(true);
  const [skills, setSkills] = useState<SkillInput[]>([]);
  // A skill the user chose for their next request.
  const [picked, setPicked] = useState<string | null>(null);

  // The latest values, for callbacks that outlive a render (the mission runner, key handlers).
  const settingsRef = useRef(settings);
  const haltedRef = useRef(halted);
  const agentRef = useRef(agent);
  const draftRef = useRef(draft);
  const turnsRef = useRef(turns);
  const convoRef = useRef(convo);
  const skillsRef = useRef(skills);
  const pickedRef = useRef(picked);
  useEffect(() => {
    settingsRef.current = settings;
    haltedRef.current = halted;
    agentRef.current = agent;
    draftRef.current = draft;
    turnsRef.current = turns;
    convoRef.current = convo;
    skillsRef.current = skills;
    pickedRef.current = picked;
  });

  const runner = useRef<MissionRunner | null>(null);
  const approval = useRef<((ok: boolean) => void) | null>(null);
  const turnAbort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Settings, history and the emergency stop live in this browser; read them once after hydration.
  useEffect(() => {
    const s = loadSettings();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser storage isn't readable on the server
    setSettings(s);
    setHalted(loadHalted());
    setHistory(loadHistory(s.keepDays));
    setSkills(loadSkills());
  }, []);

  const changeSettings = useCallback((s: JarvisSettings) => {
    setSettings(s);
    saveSettings(s);
    setHistory((h) => {
      saveHistory(h, s.keepDays);
      return h.slice(0, s.keepDays ? undefined : 0);
    });
  }, []);

  const refreshAgent = useCallback(async () => {
    try {
      setAgent(await agentState());
    } catch {
      setAgent({ status: "absent" });
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- asks the local agent; the state is set when it answers
    void refreshAgent();
    const onFocus = () => void refreshAgent();
    window.addEventListener("focus", onFocus);
    const t = setInterval(() => document.visibilityState === "visible" && void refreshAgent(), 20_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(t);
    };
  }, [refreshAgent]);

  const say = useCallback((role: Turn["role"], text: string, ok?: boolean) => setTurns((t) => [...t, { id: uid(), role, text, ok }].slice(-60)), []);

  /* Voice output ------------------------------------------------------------------------------------------- */

  const stopSpeaking = useCallback(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);
  const speak = useCallback((text: string) => {
    if (!settingsRef.current.speak || !("speechSynthesis" in window) || !text.trim()) return;
    const profile = VOICE_PROFILES.find((p) => p.id === settingsRef.current.voice) ?? VOICE_PROFILES[0];
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 1500));
    u.rate = profile.rate;
    u.pitch = profile.pitch;
    u.lang = navigator.language || "en-US";
    // The core pulses with each spoken word. Engines that don't report words get a steady pulse while speaking.
    let lastWord = 0;
    let beat: ReturnType<typeof setInterval> | undefined;
    u.onboundary = (e) => {
      if (e.name && e.name !== "word") return;
      lastWord = performance.now();
      pulseOrbis(0.75);
    };
    u.onstart = () => {
      setSpeaking(true);
      beat = setInterval(() => performance.now() - lastWord > 700 && pulseOrbis(0.45), 450);
    };
    u.onend = u.onerror = () => {
      clearInterval(beat);
      setSpeaking(false);
    };
    window.speechSynthesis.speak(u);
  }, []);
  useEffect(() => () => void ("speechSynthesis" in window && window.speechSynthesis.cancel()), []);
  // Leaving the page stops what Jarvis is doing: a mission left running here couldn't be paused or cancelled any
  // more, since coming back starts a fresh page that doesn't know about it.
  useEffect(
    () => () => {
      runner.current?.stop("interrupted");
      turnAbort.current?.abort();
    },
    [],
  );

  /* Turns and missions ------------------------------------------------------------------------------------- */

  const turn = useCallback(
    async (message: string, opts: { history?: Turn[]; skill?: string | null; trace?: TraceRound[]; modelId?: string } = {}): Promise<TurnReply> => {
      const s = settingsRef.current;
      const a = agentRef.current;
      const abort = new AbortController();
      turnAbort.current = abort;
      const res = await fetch("/api/jarvis/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({
          message: message.slice(0, 4000),
          history: (opts.history ?? turnsRef.current)
            .filter((t) => t.role === "user" || t.role === "assistant")
            .slice(-12)
            .map((t) => ({ role: t.role, text: t.text.slice(0, 4000) })),
          mode: s.mode,
          autonomy: s.autonomy,
          skills: skillsRef.current,
          ...(opts.skill ? { skill: opts.skill } : {}),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(opts.trace ? { trace: opts.trace } : {}),
          ...(opts.modelId ? { modelId: opts.modelId } : {}),
          style: VOICE_PROFILES.find((p) => p.id === s.voice)?.style,
          desktop: a.status === "connected" ? { connected: true, platform: a.info.platform, folders: a.info.folders } : { connected: false, folders: [] },
          requestId: uid(),
        }),
      });
      const j = (await res.json().catch(() => null)) as (Partial<TurnReply> & { error?: { message?: string } }) | null;
      if (!res.ok) throw new Error(j?.error?.message ?? `Jarvis couldn't answer (${res.status}).`);
      return { say: j?.say ?? "", calls: j?.calls ?? [], activity: j?.activity ?? [], trace: j?.trace ?? null, model: j?.model ?? null };
    },
    [],
  );

  const runMission = useCallback(
    async (request: string, calls: PlannedCall[]) => {
      const m = newMission(request, request.length > 90 ? `${request.slice(0, 88)}…` : request, calls);
      const r = new MissionRunner(m, {
        decide: (step, batchSize) =>
          decide(step.tool, { autonomy: settingsRef.current.autonomy, desktopConnected: agentRef.current.status === "connected", halted: haltedRef.current, batchSize }),
        prepare: prepareStep,
        execute: executeStep,
        approve: () => new Promise<boolean>((resolve) => (approval.current = resolve)),
        update: setMission,
        // Generous: looking at the screen waits for the user to pick one.
        timeoutMs: 120_000,
      });
      runner.current = r;
      setRunning(true);
      const done = await r.run().finally(() => setRunning(false));
      runner.current = null;
      approval.current = null;
      setMission(done);
      setHistory((h) => {
        const next = [done, ...h.filter((x) => x.id !== done.id)];
        saveHistory(next, settingsRef.current.keepDays);
        return settingsRef.current.keepDays ? next : [];
      });
      return done;
    },
    [],
  );

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || thinking || runner.current) return;
      stopSpeaking();
      setError(false);
      setDraft("");
      const before = turnsRef.current;
      // A chosen skill applies to this request (all its rounds), then the choice is cleared.
      const skill = pickedRef.current;
      setPicked(null);
      say("user", text);
      setThinking(true);
      try {
        let r = await turn(text, { history: before, skill });
        for (;;) {
          setThinking(false);
          for (const a of r.activity) say("activity", a.summary, a.ok);
          if (r.say) {
            say("assistant", r.say);
            speak(r.say);
          }
          if (!r.calls.length) return;
          const done = await runMission(text, r.calls);
          const pending = r.trace?.at(-1);
          // Jarvis continues from what its actions found (files, details, copied text), within the round limit;
          // otherwise the mission's own report is the answer.
          if (!r.trace || !pending || r.trace.length >= MAX_ROUNDS || haltedRef.current || !wantsFollowUp(done)) {
            if (done.summary) {
              say("assistant", done.summary);
              speak(done.summary);
            }
            return;
          }
          if (done.summary) say("activity", done.summary, done.status === "completed");
          // Steps are in the same order as the calls (newMission).
          const results = r.calls.flatMap((c, i) => (c.id && done.steps[i] ? [{ id: c.id, ...stepFeedback(done.steps[i]) }] : []));
          const trace = [...r.trace.slice(0, -1), { ...pending, results: [...pending.results, ...results] }];
          setThinking(true);
          r = await turn(text, { history: before, skill, trace, modelId: r.model?.id });
        }
      } catch (err) {
        setThinking(false);
        if ((err as Error)?.name === "AbortError") return;
        setError(true);
        say("notice", err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        turnAbort.current = null;
      }
    },
    [thinking, stopSpeaking, say, turn, speak, runMission],
  );

  /* Emergency stop --------------------------------------------------------------------------------------- */

  const emergencyStop = useCallback(() => {
    setHalted(true);
    saveHalted(true);
    setConvo(false);
    runner.current?.stop("interrupted");
    turnAbort.current?.abort();
    stopSpeaking();
    if (agentRef.current.status === "connected") void haltAgent().catch(() => {});
    say("notice", "Emergency stop: nothing new will run until you resume. Anything already finished stays done.");
  }, [stopSpeaking, say]);

  const resume = useCallback(() => {
    setHalted(false);
    saveHalted(false);
    if (agentRef.current.status === "connected") void resumeAgent().catch(() => {});
    say("notice", "Automation resumed.");
  }, [say]);

  /* Push to talk ------------------------------------------------------------------------------------------ */

  const speech = useSpeech(setDraft);
  // The microphone level for the core while talking (the same approach as the chat composer's glow).
  const mic = useMicrophone();
  const { start: startMic, stop: stopMic, stream: micStream } = mic;
  const analyzer = useRef<OrbisAudioAnalyzer | null>(null);
  useEffect(() => {
    analyzer.current ??= new OrbisAudioAnalyzer();
    analyzer.current.connect(micStream ?? null);
  }, [micStream]);
  useEffect(() => () => analyzer.current?.disconnect(), []);
  useEffect(() => {
    if (!speech.listening) stopMic();
  }, [speech.listening, stopMic]);
  const audioLevel = useCallback(() => analyzer.current?.level() ?? 0, []);
  // Who is listening right now (null once stopped by us); `via` remembers it until recognition has ended.
  const ptt = useRef<"key" | "button" | "convo" | null>(null);
  const via = useRef<"key" | "button" | "convo" | null>(null);
  const submitOnEnd = useRef(false);
  const wasListening = useRef(false);
  const quietRounds = useRef(0);

  const startListening = useCallback(
    (from: "key" | "button" | "convo") => {
      if (!speech.supported || speech.listening) return;
      // Push to talk interrupts Jarvis; conversation mode only starts once Jarvis has finished speaking.
      if (from !== "convo") stopSpeaking();
      setDraft("");
      ptt.current = from;
      via.current = from;
      submitOnEnd.current = false;
      speech.start("");
      if (!isAppleTouch()) void startMic().catch(() => {});
    },
    [speech, stopSpeaking, startMic],
  );
  const stopListening = useCallback(
    (send: boolean) => {
      if (!ptt.current) return;
      ptt.current = null;
      if (send) {
        submitOnEnd.current = true;
        speech.stop();
      } else {
        submitOnEnd.current = false;
        speech.cancel();
        setDraft("");
      }
    },
    [speech],
  );

  const startConversation = useCallback(() => {
    quietRounds.current = 0;
    setConvo(true);
    say("notice", "Conversation on. Just talk; Jarvis listens again after each reply. Say “stop” or press Esc to end it.");
  }, [say]);
  const endConversation = useCallback(
    (why: string) => {
      if (!convoRef.current) return;
      convoRef.current = false;
      setConvo(false);
      say("notice", why);
    },
    [say],
  );

  // Recognition delivers its last words before it ends; send them then.
  useEffect(() => {
    if (wasListening.current && !speech.listening) {
      const from = via.current;
      // Still set: recognition ended by itself (silence, or a quiet round), not because we stopped it.
      const endedItself = ptt.current !== null;
      ptt.current = null;
      via.current = null;
      const text = draftRef.current;
      if (from === "convo" && convoRef.current && (submitOnEnd.current || endedItself)) {
        submitOnEnd.current = false;
        if (!text.trim()) {
          if (++quietRounds.current >= QUIET_ROUNDS) endConversation("Conversation ended: I didn't hear anything for a while.");
        } else if (isStopPhrase(text)) {
          setDraft("");
          endConversation("Conversation ended.");
        } else {
          quietRounds.current = 0;
          void submit(text);
        }
      } else if (submitOnEnd.current) {
        submitOnEnd.current = false;
        void submit(text);
      }
    }
    wasListening.current = speech.listening;
  }, [speech.listening, submit, endConversation]);

  /* Conversation mode ------------------------------------------------------------------------------------- */

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // Stop listening when the conversation ends or the tab goes to the background (nothing is heard unseen).
  useEffect(() => {
    if ((!convo || !visible) && ptt.current === "convo") stopListening(false);
  }, [convo, visible, stopListening]);
  // Blocked microphone or a broken speech service: end rather than retry forever.
  useEffect(() => {
    if (speech.error) endConversation(`Conversation ended: ${speech.error}`);
  }, [speech.error, endConversation]);

  // Stable handles for the timers below, so a re-render doesn't restart them.
  const listenRef = useRef(startListening);
  const stopRef = useRef(stopListening);
  const { stop: stopSpeech } = speech;
  useEffect(() => {
    listenRef.current = startListening;
    stopRef.current = stopListening;
  });

  const listenNow = shouldListen({
    on: convo,
    supported: speech.supported,
    listening: speech.listening,
    busy: thinking || running,
    speaking,
    visible,
    typing: !!draft.trim(),
  });
  // Listen again once Jarvis is idle and its voice has finished (speech output can start a moment after the reply).
  useEffect(() => {
    if (!listenNow) return;
    const t = setInterval(() => {
      if ("speechSynthesis" in window && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) return;
      clearInterval(t);
      listenRef.current("convo");
    }, RELISTEN_DELAY_MS);
    return () => clearInterval(t);
  }, [listenNow]);
  // Your turn ends after a short pause following your last word.
  useEffect(() => {
    if (!speech.listening || ptt.current !== "convo" || !draft.trim()) return;
    const t = setTimeout(() => stopRef.current(true), END_OF_TURN_MS);
    return () => clearTimeout(t);
  }, [draft, speech.listening]);
  // A round with no words at all ends after a while; a couple of those end the conversation.
  const heardNothing = !draft.trim();
  useEffect(() => {
    if (!speech.listening || ptt.current !== "convo" || !heardNothing) return;
    const t = setTimeout(stopSpeech, QUIET_ROUND_MS);
    return () => clearTimeout(t);
  }, [speech.listening, heardNothing, stopSpeech]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (convoRef.current) {
          e.preventDefault();
          stopSpeaking();
          stopListening(false);
          endConversation("Conversation ended.");
          return;
        }
        if (ptt.current) {
          e.preventDefault();
          stopListening(false);
        } else stopSpeaking();
        return;
      }
      if (!e.repeat && matchesShortcut(e, settingsRef.current.shortcut)) {
        e.preventDefault();
        startListening("key");
      }
    };
    const up = (e: KeyboardEvent) => {
      if (ptt.current !== "key") return;
      const s = settingsRef.current.shortcut;
      const released = e.key.toLowerCase() === s.key.toLowerCase() || /^Key[A-Z]$/.test(e.code) && e.code.slice(3).toLowerCase() === s.key || (s.ctrl && e.key === "Control") || (s.alt && e.key === "Alt") || (s.shift && e.key === "Shift") || (s.meta && e.key === "Meta");
      if (released) stopListening(true);
    };
    const blur = () => ptt.current === "key" && stopListening(true);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [startListening, stopListening, stopSpeaking, endConversation]);

  /* State ------------------------------------------------------------------------------------------------- */

  const core: CoreState = halted
    ? "stopped"
    : speech.listening
      ? "listening"
      : mission?.status === "waiting_approval"
        ? "approval"
        : mission && (mission.status === "running" || mission.status === "paused" || mission.status === "preparing")
          ? "working"
          : thinking
            ? "thinking"
            : speaking
              ? "speaking"
              : error
                ? "error"
                : "idle";
  // The ORBIS core shows what Jarvis is really doing.
  useEffect(() => setOrbisState(core), [core]);
  const busy = thinking || running;
  const connected = agent.status === "connected";
  const key = shortcutLabel(settings.shortcut, mac);
  const pickedSkill = picked ? findSkill(picked, allSkills(skills)) : null;

  const header = (
    <StudioHeader
      actions={
        <button
          type="button"
          aria-label={halted ? "Resume automation" : "Emergency stop"}
          onClick={halted ? resume : emergencyStop}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12.5px] font-medium transition",
            halted ? "border border-s-line text-s-ink-2 hover:text-s-ink" : "bg-s-danger text-s-danger-ink hover:brightness-110",
          )}
        >
          {halted ? <Play className="h-3.5 w-3.5" aria-hidden /> : <OctagonX className="h-3.5 w-3.5" aria-hidden />}
          <span className="sm:hidden">{halted ? "Resume" : "Stop"}</span>
          <span className="hidden sm:inline">{halted ? "Resume automation" : "Emergency stop"}</span>
        </button>
      }
    >
      <h1 className="sr-only text-[14px] font-medium text-s-ink-2 sm:not-sr-only">Jarvis</h1>
    </StudioHeader>
  );

  if (!user)
    return (
      <>
        {header}
        <div className="mx-auto w-full max-w-[720px] px-4 py-10 sm:px-8">
          <section className="glass rounded-[22px] p-5 text-[14px] text-s-ink-2">
            <Link href="/login?next=/jarvis" className="text-s-accent underline-offset-4 hover:underline">
              Sign in
            </Link>{" "}
            to use Jarvis.
          </section>
        </div>
      </>
    );

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1240px] gap-5 px-4 pb-24 pt-2 sm:px-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="lg:col-span-2">
            <OrbisHero vault={!!user} terminals={connected} pointer={settings.corePointer} audioLevel={audioLevel} />
          </div>
          <div className="min-w-0">
            {halted && (
              <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-s-danger/50 bg-s-danger/5 p-3 text-[13px] text-s-ink-2">
                <OctagonX className="h-4 w-4 text-s-danger" aria-hidden />
                <span className="flex-1">Automation is stopped. Jarvis can still talk, but every action is refused until you resume.</span>
                <button type="button" onClick={resume} className="inline-flex h-8 items-center rounded-full border border-s-line px-3 text-[12.5px] hover:text-s-ink">
                  Resume automation
                </button>
              </div>
            )}

            <section aria-label="Jarvis status" className="text-center">
              <p className="text-[15px] text-s-ink">{CORE_LABEL[core]}</p>
              <p className="mt-0.5 text-[12.5px] text-s-ink-3">
                {!speech.supported
                  ? "Voice input isn't available in this browser; type your request."
                  : convo
                    ? "Conversation on: just talk, and pause when you're done. Jarvis doesn't listen while it speaks or works. Say “stop” or press Esc to end."
                    : `Hold ${key} or the microphone, speak, let go. Or type, or start a conversation.`}
                {!connected && !convo && " Connect the Desktop Agent to let Jarvis work on this computer."}
              </p>
              {speech.supported && (
                <button
                  type="button"
                  aria-pressed={convo}
                  onClick={() => (convo ? endConversation("Conversation ended.") : startConversation())}
                  className={cn(
                    "mt-3 inline-flex h-9 items-center gap-2 rounded-full border px-4 text-[13px] font-medium transition",
                    convo ? "border-transparent bg-s-ink text-s-bg hover:opacity-90" : "border-s-line text-s-ink-2 hover:border-s-line-strong hover:text-s-ink",
                  )}
                >
                  <AudioLines className={cn("h-4 w-4", convo && speech.listening && "motion-safe:animate-pulse")} aria-hidden />
                  {convo ? "End conversation" : "Start a conversation"}
                </button>
              )}
            </section>

            <section aria-label="Conversation" className="mt-5 space-y-2.5">
              {!turns.length && (
                <p className="text-center text-[13.5px] text-s-ink-3">Try: “Research the best AI tools right now”, “Organise my Downloads by type”, or “Look at my screen and explain this error”.</p>
              )}
              {turns.map((t) =>
                t.role === "activity" ? (
                  <p key={t.id} className={cn("flex max-w-[85%] items-start gap-1.5 px-1 text-[12.5px]", t.ok === false ? "text-s-danger" : "text-s-ink-3")}>
                    <Wrench className="mt-[3px] h-3 w-3 shrink-0" aria-hidden />
                    <span>{t.text}</span>
                  </p>
                ) : (
                  <div
                    key={t.id}
                    className={cn(
                      "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed",
                      t.role === "user" ? "ml-auto bg-s-hover text-s-ink" : t.role === "notice" ? "mx-auto border border-s-line text-[13px] text-s-ink-2" : "glass text-s-ink",
                    )}
                  >
                    {t.text}
                  </div>
                ),
              )}
              {thinking && (
                <p data-pending className="glass max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] text-s-ink-3">
                  Thinking…
                </p>
              )}
            </section>

            <div className="mt-4 flex flex-wrap gap-1.5">
              {QUICK.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  disabled={busy || (q.desktop && !connected)}
                  title={q.desktop && !connected ? "Connect the Desktop Agent first" : q.request}
                  onClick={() => void submit(q.request)}
                  className="inline-flex h-8 items-center rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 transition hover:border-s-line-strong hover:text-s-ink disabled:opacity-45"
                >
                  {q.label}
                </button>
              ))}
            </div>

            {pickedSkill && (
              <div className="mt-3 flex items-center gap-1.5 text-[12.5px] text-s-ink-2">
                <Sparkles className="h-3.5 w-3.5 text-s-accent" aria-hidden />
                <span>
                  Using the <span className="text-s-ink">{pickedSkill.name}</span> skill for your next request
                </span>
                <button type="button" aria-label="Don't use this skill" onClick={() => setPicked(null)} className="grid h-6 w-6 place-items-center rounded-full text-s-ink-3 hover:bg-s-hover hover:text-s-ink">
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            )}
            <form
              className="glass mt-3 flex items-end gap-2 rounded-[22px] p-2"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(draft);
              }}
            >
              <label htmlFor="jarvis-input" className="sr-only">
                Tell Jarvis what to do
              </label>
              <textarea
                id="jarvis-input"
                ref={input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submit(draft);
                  }
                }}
                rows={2}
                maxLength={4000}
                placeholder={speech.listening ? "Listening…" : "Tell Jarvis what to do…"}
                className="min-h-[48px] flex-1 resize-none bg-transparent px-2.5 py-2 text-[15px] text-s-ink placeholder:text-s-ink-3 focus:outline-none"
              />
              <button
                type="button"
                disabled={!speech.supported || busy}
                aria-pressed={speech.listening}
                aria-label={speech.listening ? "Release to send" : `Hold to talk (${key})`}
                title={speech.supported ? `Hold to talk, or press ${key}` : "Voice input isn't available in this browser"}
                onPointerDown={(e) => {
                  e.preventDefault();
                  startListening("button");
                }}
                onPointerUp={() => ptt.current === "button" && stopListening(true)}
                onPointerLeave={() => ptt.current === "button" && stopListening(true)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
                    e.preventDefault();
                    if (speech.listening) stopListening(true);
                    else startListening("button");
                  }
                }}
                className={cn(
                  "grid h-10 w-10 shrink-0 place-items-center rounded-full transition disabled:opacity-40",
                  speech.listening ? "bg-sky-500 text-white" : "text-s-ink-2 hover:bg-s-hover hover:text-s-ink",
                )}
              >
                <Mic className="h-5 w-5" aria-hidden />
              </button>
              <button type="submit" disabled={!draft.trim() || busy} aria-label="Send" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-s-ink text-s-bg disabled:opacity-40">
                <ArrowUp className="h-5 w-5" aria-hidden />
              </button>
            </form>
            {speech.error && (
              <p role="alert" className="mt-2 text-[12.5px] text-s-danger">
                {speech.error}
              </p>
            )}
          </div>

          <aside className="min-w-0 space-y-4" aria-label="Jarvis controls">
            <MissionPanel
              mission={mission}
              onApprove={(ok) => {
                approval.current?.(ok);
                approval.current = null;
              }}
              onPause={() => runner.current?.pause()}
              onResume={() => runner.current?.resume()}
              onCancel={() => runner.current?.stop("cancelled")}
            />
            <DesktopPanel
              agent={agent}
              onRefresh={() => void refreshAgent()}
              onPair={async (code) => {
                try {
                  const info = await pairAgent(code);
                  setAgent({ status: "connected", info });
                  if (haltedRef.current) void haltAgent().catch(() => {});
                  return null;
                } catch (err) {
                  return err instanceof Error ? err.message : "Pairing failed.";
                }
              }}
              onUnpair={() => void unpairAgent().finally(refreshAgent)}
            />
            <SkillsPanel
              skills={skills}
              connected={connected}
              picked={picked}
              onPick={(id) => {
                setPicked(id);
                if (id) input.current?.focus();
              }}
              onChange={(list) => {
                setSkills(list);
                saveSkills(list);
              }}
            />
            <SettingsPanel settings={settings} onChange={changeSettings} mac={mac} />
            <HistoryPanel
              history={history}
              onClear={() => {
                clearHistory();
                setHistory([]);
              }}
            />
          </aside>
        </div>
      </div>
    </>
  );
}
