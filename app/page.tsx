"use client";

import { FormEvent, PointerEvent, useEffect, useRef, useState } from "react";

type AudioMode = "mic" | "tab";
type RecordingState = "idle" | "recording" | "stopped";

type TranscriptEntry = {
  id: string;
  at: string;
  text: string;
  final: boolean;
};

type SearchResult = {
  id: string;
  text: string;
  score?: number;
  metadata?: Record<string, string>;
};

type AskResponse = {
  docs: SearchResult[];
  answer: string;
  llmUsed: boolean;
};

type TranscriptChunk = {
  id: string;
  text: string;
  metadata: Record<string, string>;
};

type CaptureKind = "mic-transcript" | "tab-recording";

type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: { transcript: string };
    };
  };
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

const CHUNK_INTERVAL_MS = 15000;

function formatElapsed(startedAt: number | null) {
  if (!startedAt) return "00:00";
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function compactSentences(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function splitCoherentChunk(text: string) {
  const normalized = compactSentences(text);
  if (normalized.length < 24) return { chunk: "", remainder: normalized };

  const sentenceBreak = Math.max(
    normalized.lastIndexOf(". "),
    normalized.lastIndexOf("? "),
    normalized.lastIndexOf("! "),
  );

  if (sentenceBreak > 40) {
    return {
      chunk: normalized.slice(0, sentenceBreak + 1),
      remainder: normalized.slice(sentenceBreak + 1).trim(),
    };
  }

  return { chunk: normalized, remainder: "" };
}

async function callMoss<T>(payload: Record<string, unknown>): Promise<T> {
  const result = await requestMoss<T>(payload);
  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.data;
}

async function requestMoss<T>(payload: Record<string, unknown>): Promise<
  | { ok: true; data: T }
  | { ok: false; error: string }
> {
  const response = await fetch("/api/moss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    return { ok: false, error: data.error ?? "Moss request failed" };
  }

  return { ok: true, data: data as T };
}

function searchLocalChunks(chunks: TranscriptChunk[], query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return chunks
    .map((chunk) => {
      const text = chunk.text.toLowerCase();
      const score = terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
      return { ...chunk, score };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function buildSearchCorpus(
  chunks: TranscriptChunk[],
  transcript: TranscriptEntry[],
  pending: string,
  interim: string,
) {
  const docs = new Map<string, TranscriptChunk>();

  chunks.forEach((chunk) => docs.set(chunk.id, chunk));
  transcript.forEach((entry) => {
    docs.set(`transcript-${entry.id}`, {
      id: `transcript-${entry.id}`,
      text: entry.text,
      metadata: { timestamp: entry.at, source: "visible-transcript" },
    });
  });

  const liveText = compactSentences(`${pending} ${interim}`);
  if (liveText) {
    docs.set("live-transcript", {
      id: "live-transcript",
      text: liveText,
      metadata: { timestamp: formatElapsed(null), source: "live-transcript" },
    });
  }

  return Array.from(docs.values());
}

function getKeywordTerms(query: string) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z0-9]/g, ""))
    .filter((term) => term.length > 2 && !["the", "where", "what", "when", "about", "part", "talked"].includes(term));
}

function makeSnippet(text: string, query: string) {
  const terms = getKeywordTerms(query);
  const lower = text.toLowerCase();
  const firstHit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - 90);
  const end = Math.min(text.length, firstHit + 210);
  return `${start > 0 ? "... " : ""}${text.slice(start, end)}${end < text.length ? " ..." : ""}`;
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  const terms = getKeywordTerms(query);
  if (terms.length === 0) return <>{text}</>;

  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, index) =>
        terms.includes(part.toLowerCase()) ? (
          <mark key={`${part}-${index}`} className="rounded bg-emerald-300/25 px-0.5 text-emerald-50">
            {part}
          </mark>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </>
  );
}

export default function Home() {
  const [mode, setMode] = useState<AudioMode>("mic");
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [expanded, setExpanded] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState("00:00");
  const [sessionName, setSessionName] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [interim, setInterim] = useState("");
  const [pendingChunk, setPendingChunk] = useState("");
  const [chunkCount, setChunkCount] = useState(0);
  const [localChunks, setLocalChunks] = useState<TranscriptChunk[]>([]);
  const [mossReady, setMossReady] = useState(false);
  const [mossConfigured, setMossConfigured] = useState(false);
  const [mossProjectId, setMossProjectId] = useState("");
  const [mossProjectKey, setMossProjectKey] = useState("");
  const [isConfiguringMoss, setIsConfiguringMoss] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [llmProvider, setLlmProvider] = useState<"openai" | "openrouter">("openai");
  const [llmKey, setLlmKey] = useState("");
  const [llmModel, setLlmModel] = useState("gpt-4.1-mini");
  const [isConfiguringLlm, setIsConfiguringLlm] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState("");
  const [captureKind, setCaptureKind] = useState<CaptureKind>("mic-transcript");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [answer, setAnswer] = useState("");
  const [answerMode, setAnswerMode] = useState<"none" | "moss" | "llm" | "local">("none");
  const [searched, setSearched] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [position, setPosition] = useState({ x: 32, y: 32 });
  const [speechSupported, setSpeechSupported] = useState(true);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const pendingRef = useRef("");
  const sessionRef = useRef("");
  const startedAtRef = useRef<number | null>(null);
  const modeRef = useRef<AudioMode>("mic");
  const recordingStateRef = useRef<RecordingState>("idle");
  const chunkCountRef = useRef(0);
  const localChunksRef = useRef<TranscriptChunk[]>([]);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const interimRef = useRef("");
  const mossReadyRef = useRef(false);
  const dragRef = useRef({ active: false, dx: 0, dy: 0 });
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSpeechSupported(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
    void refreshMossStatus();
  }, []);

  useEffect(() => {
    pendingRef.current = pendingChunk;
  }, [pendingChunk]);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    interimRef.current = interim;
  }, [interim]);

  useEffect(() => {
    sessionRef.current = sessionName;
  }, [sessionName]);

  useEffect(() => {
    startedAtRef.current = startedAt;
  }, [startedAt]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    recordingStateRef.current = recordingState;
  }, [recordingState]);

  useEffect(() => {
    mossReadyRef.current = mossReady;
  }, [mossReady]);

  async function refreshMossStatus() {
    try {
      const status = await requestMoss<{ configured: boolean; llmConfigured: boolean; llmProvider: "openai" | "openrouter" | "none"; source: string }>({ action: "status" });
      if (status.ok) {
        setMossConfigured(status.data.configured);
        setLlmConfigured(status.data.llmConfigured);
        if (status.data.llmProvider === "openai" || status.data.llmProvider === "openrouter") {
          setLlmProvider(status.data.llmProvider);
        }
      }
    } catch (statusError) {
      console.warn("Moss status check failed", statusError);
    }
  }

  async function activateLlm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setIsConfiguringLlm(true);

    try {
      const configured = await requestMoss<{ llmConfigured: boolean }>({
        action: "configureLlm",
        llmProvider,
        llmKey,
        llmModel,
      });

      if (!configured.ok) {
        throw new Error(configured.error);
      }

      setLlmConfigured(true);
      setLlmKey("");
      setNotice("LLM answers are active. Search now asks Moss first, then summarizes retrieved transcript context.");
    } catch (llmError) {
      console.error("LLM configuration failed", llmError);
      setError(llmError instanceof Error ? llmError.message : "Could not activate LLM answers");
    } finally {
      setIsConfiguringLlm(false);
    }
  }

  async function activateMoss(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setIsConfiguringMoss(true);

    try {
      const configured = await requestMoss<{ configured: boolean; source: string }>({
        action: "configure",
        projectId: mossProjectId,
        projectKey: mossProjectKey,
      });

      if (!configured.ok) {
        throw new Error(configured.error);
      }

      setMossConfigured(true);
      setMossProjectKey("");
      setNotice("Moss credentials loaded locally. Creating Moss session...");

      if (sessionRef.current) {
        const created = await requestMoss<{ sessionName: string; docCount: number }>({
          action: "create",
          sessionName: sessionRef.current,
        });

        if (!created.ok) {
          throw new Error(created.error);
        }

        setSessionName(created.data.sessionName);
        sessionRef.current = created.data.sessionName;
        setMossReady(true);
        mossReadyRef.current = true;
        setNotice(`Moss is active for ${created.data.sessionName}.`);

        const corpus = buildSearchCorpus(localChunksRef.current, transcriptRef.current, pendingRef.current, interimRef.current);
        for (const [index, doc] of corpus.entries()) {
          try {
            await callMoss({
              action: "add",
              sessionName: created.data.sessionName,
              doc: {
                id: `activation-${index}-${Date.now()}`,
                text: doc.text,
                metadata: doc.metadata,
              },
            });
          } catch (indexError) {
            console.error("Moss activation backfill failed", indexError);
            setError("Moss is active, but backfilling existing transcript text failed. New chunks will still try to index.");
            break;
          }
        }
      } else {
        setNotice("Moss is configured. Start Mic to create a Moss session.");
      }
    } catch (configError) {
      console.error("Moss configuration failed", configError);
      setMossReady(false);
      mossReadyRef.current = false;
      setError(configError instanceof Error ? configError.message : "Could not activate Moss");
    } finally {
      setIsConfiguringMoss(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(formatElapsed(startedAtRef.current)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    };
  }, [recordingUrl]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript, interim]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void flushChunk();
    }, CHUNK_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  async function flushChunk(force = false) {
    const session = sessionRef.current;
    const started = startedAtRef.current;
    const pending = pendingRef.current;

    if (!started || !pending.trim()) return;

    const { chunk, remainder } = splitCoherentChunk(pending);
    const textToIndex = force ? compactSentences(pending) : chunk;
    if (!textToIndex) return;

    const at = formatElapsed(started);
    const nextCount = chunkCountRef.current + 1;
    const doc = {
      id: `chunk-${nextCount}-${Date.now()}`,
      text: textToIndex,
      metadata: { timestamp: at, source: modeRef.current },
    };

    chunkCountRef.current = nextCount;
    localChunksRef.current = [...localChunksRef.current, doc];
    setLocalChunks(localChunksRef.current);
    setChunkCount(nextCount);
    setPendingChunk(force ? "" : remainder);

    if (!session || !mossReadyRef.current) {
      setNotice(`Saved locally ${at}. Add Moss credentials to enable semantic indexing.`);
      return;
    }

    try {
      await callMoss({
        action: "add",
        sessionName: session,
        doc,
      });
      setNotice(`Indexed in Moss ${at}`);
    } catch (mossError) {
      console.error("Moss addDocs failed", mossError);
      setMossReady(false);
      mossReadyRef.current = false;
      setError("Still recording locally. Moss indexing paused because addDocs failed.");
    }
  }

  function addFinalTranscript(text: string) {
    const clean = compactSentences(text);
    if (!clean) return;

    const at = formatElapsed(startedAtRef.current);
    setTranscript((items) => [
      ...items,
      { id: `${Date.now()}-${items.length}`, at, text: clean, final: true },
    ]);
    setPendingChunk((current) => compactSentences(`${current} ${clean}`));

    if (/[.!?]$/.test(clean) || clean.split(" ").length > 18) {
      window.setTimeout(() => void flushChunk(), 50);
    }
  }

  async function startRecording() {
    setError("");
    setNotice("");
    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl);
      setRecordingUrl("");
    }

    if (mode === "mic" && !speechSupported) {
      setError("This browser does not support the Web Speech API. Mic mode works best in Chrome.");
      return;
    }

    try {
      const name = `meeting-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const now = Date.now();

      if (mode === "mic") {
        await requestMicPermission();
      } else {
        await startTabRecording();
      }

      setSessionName(name);
      sessionRef.current = name;
      setStartedAt(now);
      startedAtRef.current = now;
      recordingStateRef.current = "recording";
      setRecordingState("recording");
      setTranscript([]);
      setResults([]);
      setAnswer("");
      setAnswerMode("none");
      setSearched(false);
      setPendingChunk("");
      setLocalChunks([]);
      localChunksRef.current = [];
      setChunkCount(0);
      chunkCountRef.current = 0;
      setMossReady(false);
      mossReadyRef.current = false;

      if (mode === "mic") {
        setCaptureKind("mic-transcript");
        startSpeechRecognition();
      } else {
        setCaptureKind("tab-recording");
        setNotice("Recording selected tab. Stop when done, then download the recording.");
      }

      const created = await requestMoss<{ sessionName: string; docCount: number }>({
        action: "create",
        sessionName: name,
      });

      if (created.ok) {
        setSessionName(created.data.sessionName);
        sessionRef.current = created.data.sessionName;
        setMossConfigured(true);
        setMossReady(true);
        mossReadyRef.current = true;
        setNotice(mode === "mic" ? `Recording. Moss session ready: ${created.data.sessionName}` : "Recording selected tab. Moss session is ready too.");
      } else if (mode === "mic") {
        setMossConfigured(false);
        setNotice("Recording locally. Activate Moss above to enable Moss indexing/search.");
      }
    } catch (startError) {
      console.error("Audio start failed", startError);
      setError(startError instanceof Error ? startError.message : "Could not start recording");
      stopRecording(false);
    }
  }

  async function requestMicPermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot request microphone access. Open the app in Chrome.");
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      throw new Error("Microphone is blocked. Click the site controls next to 127.0.0.1, allow Microphone, then reload.");
    }
  }

  function startSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("This browser does not support SpeechRecognition. Try Chrome for live mic transcription.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          addFinalTranscript(text);
        } else {
          interimText += text;
        }
      }
      setInterim(compactSentences(interimText));
    };

    recognition.onerror = (event) => {
      console.warn("SpeechRecognition failed", event);
      setError(`Speech recognition failed${event.error ? `: ${event.error}` : ""}`);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Microphone is blocked. Click the site controls next to 127.0.0.1, allow Microphone, then reload.");
        recordingStateRef.current = "stopped";
        setRecordingState("stopped");
        setStartedAt(null);
        startedAtRef.current = null;
        recognitionRef.current = null;
      }
    };

    recognition.onend = () => {
      if (startedAtRef.current && recordingStateRef.current === "recording") {
        try {
          recognition.start();
        } catch {
          setError("Speech recognition stopped. Press Stop, then Start to retry.");
        }
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  async function startTabRecording() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Tab recording needs getDisplayMedia support. Open this in Chrome.");
    }

    if (!window.MediaRecorder) {
      throw new Error("This browser does not support MediaRecorder for tab recording.");
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });

    recordedChunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm" });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || "video/webm" });
      setRecordingUrl(URL.createObjectURL(blob));
      recordedChunksRef.current = [];
    };
    stream.getTracks().forEach((track) => {
      track.onended = () => {
        if (recordingStateRef.current === "recording" && recorderRef.current?.state === "recording") {
          stopRecording();
        }
      };
    });

    streamRef.current = stream;
    recorderRef.current = recorder;
    recorder.onstart = () => {
      setNotice("Recording selected tab. Press Stop to finish and create the download.");
    };
    recorder.start(1000);
  }

  function stopRecording(flush = true) {
    if (flush) void flushChunk(true);
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setInterim("");
    recordingStateRef.current = recordingStateRef.current === "idle" ? "idle" : "stopped";
    setRecordingState((current) => (current === "idle" ? "idle" : "stopped"));
    setNotice(captureKind === "tab-recording" ? "Tab recording stopped. Preparing download..." : "Recording stopped.");
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionName || !search.trim()) return;

    setIsSearching(true);
    setError("");
    setSearched(true);
    setAnswer("");
    setAnswerMode("none");
    try {
      if (mossReadyRef.current) {
        const data = await callMoss<AskResponse>({
          action: "ask",
          sessionName,
          query: search,
        });
        setResults(data.docs ?? []);
        setAnswer(data.answer);
        setAnswerMode(data.llmUsed ? "llm" : "moss");
      } else {
        const corpus = buildSearchCorpus(localChunksRef.current, transcriptRef.current, pendingRef.current, interimRef.current);
        const localResults = searchLocalChunks(corpus, search);
        setResults(localResults);
        setAnswer(
          localResults.length > 0
            ? `Local transcript match: the closest part is around ${localResults[0].metadata?.timestamp ?? "--:--"}. ${makeSnippet(localResults[0].text, search)}`
            : "",
        );
        setAnswerMode("local");
        setNotice(corpus.length > 0 ? "Searched the local transcript. Moss semantic search is off until credentials are configured." : "No transcript text exists yet. Record mic transcription before searching words.");
      }
    } catch (searchError) {
      console.error("Moss query failed", searchError);
      setMossReady(false);
      mossReadyRef.current = false;
      const fallbackResults = searchLocalChunks(buildSearchCorpus(localChunksRef.current, transcriptRef.current, pendingRef.current, interimRef.current), search);
      setResults(fallbackResults);
      setAnswer(fallbackResults.length > 0 ? `Fallback local match around ${fallbackResults[0].metadata?.timestamp ?? "--:--"}. ${makeSnippet(fallbackResults[0].text, search)}` : "");
      setAnswerMode("local");
      setError("Moss query failed, so I searched the local transcript chunks instead.");
    } finally {
      setIsSearching(false);
    }
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button, input, form")) return;
    dragRef.current = {
      active: true,
      dx: event.clientX - position.x,
      dy: event.clientY - position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateDrag(event: PointerEvent<HTMLDivElement>) {
    if (!dragRef.current.active) return;
    setPosition({
      x: Math.max(8, event.clientX - dragRef.current.dx),
      y: Math.max(8, event.clientY - dragRef.current.dy),
    });
  }

  function endDrag() {
    dragRef.current.active = false;
  }

  const isRecording = recordingState === "recording";

  return (
    <main className="min-h-screen overflow-hidden p-4 text-white">
      <div className="fixed inset-0 pointer-events-none bg-[linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:48px_48px]" />

      <section
        className="fixed z-10 w-[min(420px,calc(100vw-24px))] select-none"
        style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
        onPointerDown={beginDrag}
        onPointerMove={updateDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {!expanded ? (
          <button
            className="flex h-14 items-center gap-3 rounded-full border border-white/15 bg-zinc-950/90 px-4 text-sm shadow-overlay backdrop-blur-xl"
            onClick={() => setExpanded(true)}
          >
            <span className={isRecording ? "h-2.5 w-2.5 rounded-full bg-red-400" : "h-2.5 w-2.5 rounded-full bg-zinc-500"} />
            <span>{isRecording ? "Recording" : recordingState === "stopped" ? "Stopped" : "Ready"}</span>
            <span className="font-mono text-zinc-300">{elapsed}</span>
            <span className="h-5 w-px bg-white/15" />
            <span className="flex items-center gap-2 rounded-full bg-white px-3 py-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.25)]">
              <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Built with</span>
              <img
                src="/moss_wordmark_dark.png"
                alt="Moss"
                className="h-5 w-[78px] object-contain"
              />
            </span>
          </button>
        ) : (
          <div className="overflow-hidden rounded-[1.4rem] border border-white/12 bg-zinc-950/88 shadow-overlay backdrop-blur-2xl">
            <header className="cursor-grab border-b border-white/10 active:cursor-grabbing">
              <div className="border-b border-white/10 bg-white px-4 py-3 text-zinc-950">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">Built with</p>
                    <img
                      src="/moss_wordmark_dark.png"
                      alt="Moss"
                      className="mt-1 h-10 w-[176px] object-contain object-left"
                    />
                  </div>
                  <div className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">
                    Moss-backed
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <span className={isRecording ? "h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_16px_rgba(248,113,113,0.85)]" : "h-2.5 w-2.5 rounded-full bg-zinc-500"} />
                    Meeting Copilot
                  </div>
                  <p className="mt-1 font-mono text-xs text-zinc-400">{elapsed} {sessionName ? `- ${sessionName}` : ""}</p>
                </div>
                <button
                  className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:bg-white/10"
                  onClick={() => setExpanded(false)}
                >
                  Minimize
                </button>
              </div>
            </header>

            <div className="space-y-3 p-4">
              <div className={`rounded-xl border px-3 py-2 ${mossReady ? "border-emerald-300/25 bg-emerald-300/10" : mossConfigured ? "border-amber-300/25 bg-amber-300/10" : "border-white/10 bg-white/5"}`}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-zinc-100">
                      {mossReady ? "Moss active" : mossConfigured ? "Moss configured" : "Moss inactive"}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-4 text-zinc-400">
                      {mossReady
                        ? "Transcript chunks are being indexed and queried through Moss."
                        : mossConfigured
                          ? "Start Mic to open a Moss session."
                          : "Paste credentials to make this demo use Moss now."}
                    </p>
                  </div>
                  <span className={`h-2.5 w-2.5 rounded-full ${mossReady ? "bg-emerald-300" : mossConfigured ? "bg-amber-300" : "bg-zinc-500"}`} />
                </div>

                {!mossReady && (
                  <form className="mt-3 grid gap-2" onSubmit={activateMoss}>
                    <input
                      className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white outline-none placeholder:text-zinc-500 focus:border-emerald-200/50"
                      value={mossProjectId}
                      placeholder="MOSS_PROJECT_ID"
                      autoComplete="off"
                      onChange={(event) => setMossProjectId(event.target.value)}
                    />
                    <input
                      className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white outline-none placeholder:text-zinc-500 focus:border-emerald-200/50"
                      value={mossProjectKey}
                      placeholder="MOSS_PROJECT_KEY"
                      type="password"
                      autoComplete="off"
                      onChange={(event) => setMossProjectKey(event.target.value)}
                    />
                    <button
                      className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-600 disabled:text-zinc-300"
                      disabled={!mossProjectId.trim() || !mossProjectKey.trim() || isConfiguringMoss}
                    >
                      {isConfiguringMoss ? "Activating..." : "Activate Moss"}
                    </button>
                  </form>
                )}

                {mossConfigured && (
                  <form className="mt-3 grid gap-2 border-t border-white/10 pt-3" onSubmit={activateLlm}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold text-zinc-100">
                          {llmConfigured ? "LLM answers active" : "LLM answers optional"}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-4 text-zinc-400">
                          Moss retrieves transcript chunks first; the LLM summarizes only that evidence.
                        </p>
                      </div>
                      <span className={`h-2.5 w-2.5 rounded-full ${llmConfigured ? "bg-emerald-300" : "bg-zinc-500"}`} />
                    </div>
                    {!llmConfigured && (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <select
                            className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white outline-none focus:border-emerald-200/50"
                            value={llmProvider}
                            onChange={(event) => {
                              const provider = event.target.value === "openrouter" ? "openrouter" : "openai";
                              setLlmProvider(provider);
                              setLlmModel(provider === "openrouter" ? "openai/gpt-4o-mini" : "gpt-4.1-mini");
                            }}
                          >
                            <option value="openai">OpenAI</option>
                            <option value="openrouter">OpenRouter</option>
                          </select>
                          <input
                            className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white outline-none placeholder:text-zinc-500 focus:border-emerald-200/50"
                            value={llmModel}
                            placeholder={llmProvider === "openrouter" ? "openai/gpt-4o-mini" : "gpt-4.1-mini"}
                            autoComplete="off"
                            onChange={(event) => setLlmModel(event.target.value)}
                          />
                        </div>
                        <input
                          className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white outline-none placeholder:text-zinc-500 focus:border-emerald-200/50"
                          value={llmKey}
                          placeholder={llmProvider === "openrouter" ? "OPENROUTER_API_KEY for answer summaries" : "OPENAI_API_KEY for answer summaries"}
                          type="password"
                          autoComplete="off"
                          onChange={(event) => setLlmKey(event.target.value)}
                        />
                        <button
                          className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-600 disabled:text-zinc-300"
                          disabled={!llmKey.trim() || !llmModel.trim() || isConfiguringLlm}
                        >
                          {isConfiguringLlm ? "Activating..." : `Activate ${llmProvider === "openrouter" ? "OpenRouter" : "OpenAI"} Answers`}
                        </button>
                      </>
                    )}
                  </form>
                )}
              </div>

              {!speechSupported && (
                <div className="rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs text-amber-100">
                  Web Speech API is unavailable. Mic transcription is Chrome-only.
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-red-300/25 bg-red-500/12 px-3 py-2 text-xs text-red-100">
                  {error}
                </div>
              )}

              {notice && !error && (
                <div className="rounded-lg border border-emerald-300/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-100">
                  {notice}
                </div>
              )}

              <div className="grid grid-cols-[1fr_auto] gap-2">
                <div className="grid grid-cols-2 rounded-full bg-white/8 p-1 text-xs">
                  {(["mic", "tab"] as AudioMode[]).map((item) => (
                    <button
                      key={item}
                      className={`rounded-full px-3 py-2 transition ${mode === item ? "bg-white text-zinc-950" : "text-zinc-300 hover:bg-white/10"}`}
                      disabled={isRecording}
                      onClick={() => setMode(item)}
                    >
                      {item === "mic" ? "Mic" : "Tab Audio"}
                    </button>
                  ))}
                </div>
                <button
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition ${isRecording ? "bg-red-400 text-zinc-950 hover:bg-red-300" : "bg-emerald-300 text-zinc-950 hover:bg-emerald-200"}`}
                  onClick={() => (isRecording ? stopRecording() : void startRecording())}
                >
                  {isRecording ? "Stop" : mode === "tab" ? "Record Tab" : "Start Mic"}
                </button>
              </div>

              {mode === "tab" && (
                <p className="text-xs leading-5 text-zinc-400">
                  Tab mode records the shared tab video/audio to a local WebM file. Pick the call tab in the browser share picker, then press Stop to get a download.
                </p>
              )}

              {mode === "mic" && error.includes("Microphone is blocked") && (
                <p className="text-xs leading-5 text-zinc-400">
                  In Chrome, click the icon beside the address, open site settings, set Microphone to Allow, then reload this page. In the Codex in-app browser, mic capture may stay blocked; open the same localhost URL in Chrome if that happens.
                </p>
              )}

              {recordingUrl && (
                <a
                  className="block rounded-lg border border-emerald-300/25 bg-emerald-300/10 px-3 py-2 text-center text-sm font-semibold text-emerald-100 hover:bg-emerald-300/15"
                  href={recordingUrl}
                  download={`moss-meeting-recording-${Date.now()}.webm`}
                >
                  Download tab recording
                </a>
              )}

              <div className="h-64 overflow-y-auto rounded-xl border border-white/10 bg-black/25 p-3">
                {transcript.length === 0 && !interim ? (
                  <p className="pt-20 text-center text-sm text-zinc-500">
                    {captureKind === "tab-recording"
                      ? isRecording
                        ? "Recording the selected tab. This creates a video/audio file, not a transcript."
                        : recordingUrl
                          ? "Tab recording is ready to download. Search needs mic transcript text."
                          : "Choose Record Tab to capture tab video/audio."
                      : "Live transcript will appear here."}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {transcript.map((entry) => (
                      <p key={entry.id} className="text-sm leading-6 text-zinc-100">
                        <span className="mr-2 font-mono text-xs text-emerald-200">{entry.at}</span>
                        {entry.text}
                      </p>
                    ))}
                    {interim && (
                      <p className="text-sm leading-6 text-zinc-400">
                        <span className="mr-2 font-mono text-xs text-zinc-500">{elapsed}</span>
                        {interim}
                      </p>
                    )}
                    <div ref={transcriptEndRef} />
                  </div>
                )}
              </div>

              <form className="flex gap-2" onSubmit={submitSearch}>
                <input
                  className="min-w-0 flex-1 rounded-full border border-white/10 bg-white/8 px-4 py-2 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-emerald-200/50"
                  value={search}
                  disabled={!sessionName}
                  placeholder={sessionName ? "Ask or search this call..." : "Start to create a Moss session"}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <button
                  className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-600 disabled:text-zinc-300"
                  disabled={!sessionName || !search.trim() || isSearching}
                >
                  {isSearching ? "..." : "Ask"}
                </button>
              </form>

              <div className="max-h-40 space-y-2 overflow-y-auto">
                {answer && (
                  <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-3 py-2">
                    <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-emerald-200">
                      {answerMode === "llm" ? "Moss + LLM answer" : answerMode === "moss" ? "Moss evidence" : "Local fallback"}
                    </p>
                    <p className="text-sm leading-5 text-emerald-50">{answer}</p>
                  </div>
                )}
                {results.map((result) => (
                  <div key={result.id} className="rounded-lg border border-white/10 bg-white/6 px-3 py-2">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-emerald-200">{result.metadata?.timestamp ?? "--:--"}</span>
                      {typeof result.score === "number" && (
                        <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-zinc-400">
                          score {result.score.toFixed ? result.score.toFixed(2) : result.score}
                        </span>
                      )}
                    </div>
                    <p className="text-sm leading-5 text-zinc-100">
                      <HighlightedSnippet text={makeSnippet(result.text, search)} query={search} />
                    </p>
                  </div>
                ))}
                {searched && search.trim() && results.length === 0 && (
                  <div className="rounded-lg border border-white/10 bg-white/6 px-3 py-2 text-sm text-zinc-400">
                    {buildSearchCorpus(localChunks, transcript, pendingChunk, interim).length === 0
                      ? "No transcript text has been captured yet. Tab recordings create a video file; Mic mode creates searchable transcript text."
                      : "No local transcript matches found."}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
