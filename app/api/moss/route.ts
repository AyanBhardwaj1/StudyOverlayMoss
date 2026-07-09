import { NextRequest, NextResponse } from "next/server";
import { MossClient } from "@moss-dev/moss";

type SessionLike = {
  docCount?: number;
  addDocs: (docs: Array<{ id: string; text: string; metadata?: Record<string, string> }>) => Promise<unknown>;
  query: (query: string, options?: { topK?: number }) => Promise<{
    docs?: Array<{
      id: string;
      score?: number;
      text: string;
      metadata?: Record<string, string>;
    }>;
    timeTakenInMs?: number;
  }>;
};

const sessions = new Map<string, SessionLike>();
let runtimeCredentials: { projectId: string; projectKey: string } | null = null;
let runtimeLlmConfig: {
  provider: "openai" | "openrouter";
  apiKey: string;
  model: string;
} | null = null;

function getClient() {
  const projectId = runtimeCredentials?.projectId ?? process.env.MOSS_PROJECT_ID;
  const projectKey = runtimeCredentials?.projectKey ?? process.env.MOSS_PROJECT_KEY;

  if (!projectId || !projectKey) {
    return null;
  }

  return new MossClient(projectId, projectKey);
}

function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  let body: {
    action?: "status" | "configure" | "configureLlm" | "create" | "add" | "query" | "ask";
    projectId?: string;
    projectKey?: string;
    llmProvider?: "openai" | "openrouter";
    llmKey?: string;
    llmModel?: string;
    sessionName?: string;
    doc?: { id: string; text: string; metadata?: Record<string, string> };
    query?: string;
  };

  try {
    body = await request.json();
  } catch (error) {
    console.error("Moss API: failed to parse request JSON", error);
    return jsonError("Invalid request body", 400);
  }

  try {
    if (body.action === "status") {
      return NextResponse.json({
        configured: Boolean(runtimeCredentials || (process.env.MOSS_PROJECT_ID && process.env.MOSS_PROJECT_KEY)),
        llmConfigured: Boolean(runtimeLlmConfig || process.env.OPENAI_API_KEY),
        llmProvider: runtimeLlmConfig?.provider ?? (process.env.OPENAI_API_KEY ? "openai" : "none"),
        source: runtimeCredentials ? "runtime" : process.env.MOSS_PROJECT_ID && process.env.MOSS_PROJECT_KEY ? "env" : "none",
      });
    }

    if (body.action === "configure") {
      if (!body.projectId?.trim() || !body.projectKey?.trim()) {
        return jsonError("Missing Moss project ID or project key", 400);
      }

      runtimeCredentials = {
        projectId: body.projectId.trim(),
        projectKey: body.projectKey.trim(),
      };
      sessions.clear();

      return NextResponse.json({ configured: true, source: "runtime" });
    }

    if (body.action === "configureLlm") {
      if (!body.llmKey?.trim()) {
        return jsonError("Missing LLM API key", 400);
      }

      const provider = body.llmProvider === "openrouter" ? "openrouter" : "openai";
      runtimeLlmConfig = {
        provider,
        apiKey: body.llmKey.trim(),
        model: body.llmModel?.trim() || (provider === "openrouter" ? "openai/gpt-4o-mini" : "gpt-4.1-mini"),
      };
      return NextResponse.json({ llmConfigured: true, provider, model: runtimeLlmConfig.model });
    }

    if (body.action === "create") {
      const sessionName = body.sessionName ?? `call-${Date.now()}`;
      const client = getClient();
      if (!client) {
        return jsonError(
          "Moss credentials are not configured. Recording can continue locally, but Moss indexing/search is disabled until MOSS_PROJECT_ID and MOSS_PROJECT_KEY are added to .env.local.",
          503,
        );
      }
      const session = (await client.session(sessionName)) as SessionLike;
      sessions.set(sessionName, session);

      return NextResponse.json({
        sessionName,
        docCount: session.docCount ?? 0,
      });
    }

    if (!body.sessionName) {
      return jsonError("Missing sessionName", 400);
    }

    const session = sessions.get(body.sessionName);
    if (!session) {
      return jsonError("Moss session not found. Start a new recording session first.", 404);
    }

    if (body.action === "add") {
      if (!body.doc?.id || !body.doc.text.trim()) {
        return jsonError("Missing document id or text", 400);
      }

      await session.addDocs([body.doc]);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "query") {
      if (!body.query?.trim()) {
        return jsonError("Missing search query", 400);
      }

      const results = await session.query(body.query, { topK: 5 });
      return NextResponse.json({
        docs: (results.docs ?? []).slice(0, 5),
        timeTakenInMs: results.timeTakenInMs,
      });
    }

    if (body.action === "ask") {
      if (!body.query?.trim()) {
        return jsonError("Missing question", 400);
      }

      const results = await session.query(body.query, { topK: 6 });
      const docs = (results.docs ?? []).slice(0, 6);
      const llmConfig =
        runtimeLlmConfig ??
        (process.env.OPENAI_API_KEY
          ? { provider: "openai" as const, apiKey: process.env.OPENAI_API_KEY, model: "gpt-4.1-mini" }
          : null);

      if (!llmConfig) {
        return NextResponse.json({
          docs,
          answer: "LLM is not configured. Moss retrieved the most relevant transcript chunks below; add an LLM key to synthesize an answer.",
          llmUsed: false,
        });
      }

      const context = docs
        .map((doc, index) => `[${index + 1}] ${doc.metadata?.timestamp ?? "--:--"}\n${doc.text}`)
        .join("\n\n");
      const systemPrompt =
        "You are a meeting copilot. Answer only from the retrieved transcript chunks. Include the timestamp(s), identify the most relevant part, and summarize surrounding context. If the chunks do not answer, say that.";
      const userPrompt = `Question: ${body.query}\n\nRetrieved transcript chunks:\n${context}`;

      if (llmConfig.provider === "openrouter") {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${llmConfig.apiKey}`,
            "HTTP-Referer": "http://127.0.0.1:3000",
            "X-Title": "Moss Meeting Copilot",
          },
          body: JSON.stringify({
            model: llmConfig.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.2,
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          return jsonError(data.error?.message ?? "OpenRouter request failed", response.status);
        }

        return NextResponse.json({
          docs,
          answer: data.choices?.[0]?.message?.content ?? "",
          llmUsed: true,
          llmProvider: "openrouter",
          llmModel: llmConfig.model,
        });
      }

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: llmConfig.model,
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        return jsonError(data.error?.message ?? "OpenAI request failed", response.status);
      }

      const answer =
        data.output_text ??
        data.output?.flatMap((item: { content?: Array<{ text?: string }> }) => item.content ?? [])
          ?.map((content: { text?: string }) => content.text)
          ?.filter(Boolean)
          ?.join("\n") ??
        "";

      return NextResponse.json({ docs, answer, llmUsed: true, llmProvider: "openai", llmModel: llmConfig.model });
    }

    return jsonError("Unknown Moss action", 400);
  } catch (error) {
    console.error(`Moss API: ${body.action ?? "unknown"} failed`, error);
    return jsonError(error instanceof Error ? error.message : "Moss SDK call failed");
  }
}
