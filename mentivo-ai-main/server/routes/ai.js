const express = require("express");
const router = express.Router();
const PptxGenJS = require("pptxgenjs");
const PDFDocument = require("pdfkit");
const { requireAuth } = require("../utils/auth");

const IDENTITY_REPLY = "I'm Mentivo AI, here to help you. How can I help you?";
const SYSTEM_PROMPT =
  "You are Mentivo AI, the AI assistant in the Mentivo AI tool. When asked who you are or what your name is, identify yourself as Mentivo AI. Never identify yourself as ChatGPT, OpenAI, or another AI model or product.";

function isIdentityQuestion(message) {
  return /\b(?:who are you|who is this|introduce yourself|what(?:'s| is) your name|tell me your name|what are you(?: called)?|what(?:'s| is) this (?:ai|assistant|tool) called|are you (?:chatgpt|an? ai)|which (?:ai|assistant|tool) are you|what(?:'s| is) the name of (?:this|your) (?:ai )?(?:tool|assistant))\b/i.test(String(message || ""));
}

// Every route here requires a signed-in user.
router.use(requireAuth);

/* -------------------------------------------------------------------------
   Shared helper: ask the configured LLM provider for text. OpenRouter is the
   preferred provider here, with Gemini kept as a fallback for backwards
   compatibility. If neither key is configured, the app gracefully falls back
   to a built-in offline response instead of failing silently.
------------------------------------------------------------------------- */
function buildOfflineReply(message) {
  const trimmed = String(message || "").trim();
  const lower = trimmed.toLowerCase();
  const detail = /\b(more|detailed|longer|expand|20[- ]?25|tell me more|give more|explain more)\b/i.test(lower);
  const para1 = detail
    ? "Here is a fuller explanation based on your request. I’ll keep it structured and useful so you can read it quickly while still covering the important details."
    : "Here’s a clear response based on your message so you can continue without waiting on a remote AI service.";

  const bullets = [
    "Start with the core idea or task you want to solve.",
    "Break the problem into simple steps instead of trying to do everything at once.",
    "Use examples or a small demonstration to validate the result.",
    "Check the output for accuracy, clarity, and any missing edge cases.",
    "If the request asks for more detail, expand the explanation with examples and next steps."
  ];

  const summary = detail
    ? `\n\n1. Understand the goal clearly.\n2. Outline the key actions in order.\n3. Add examples for confidence.\n4. Mention limitations or edge cases.\n5. End with the next best step or action plan.`
    : `\n\nCore idea: keep it simple, clear, and focused on one outcome at a time.\n\nAction plan: define the goal, gather the right inputs, produce the main answer, and check for gaps before finishing.`;

  return `${para1}\n\nYour message: "${trimmed || "(empty prompt)"}"\n\n${bullets.map((item, idx) => `${idx + 1}. ${item}`).join("\n")} ${summary}`;
}

async function askOpenRouter(history, maxTokens = 1024) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const lastUser = Array.isArray(history) ? [...history].reverse().find((m) => m.role === "user") : null;
  if (!apiKey) {
    return buildOfflineReply(lastUser?.content || "");
  }

  const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || ""),
      })),
    ],
    max_tokens: maxTokens,
    temperature: 0.7,
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "Mentivo AI",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || data?.message || `OpenRouter returned status ${res.status}.`;
    throw new Error(message);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text === "string" && text.trim()) return text.trim();
  if (Array.isArray(text)) {
    const combined = text.map((part) => (typeof part === "string" ? part : part?.text || "")).join("\n");
    if (combined.trim()) return combined.trim();
  }

  throw new Error("OpenRouter returned an empty response.");
}

async function askGemini(history, maxTokens = 1024) {
  const apiKey = process.env.GEMINI_API_KEY;
  const lastUser = Array.isArray(history) ? [...history].reverse().find((m) => m.role === "user") : null;
  if (!apiKey) {
    return buildOfflineReply(lastUser?.content || "");
  }

  const preferredModel = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const models = [...new Set([preferredModel, "gemini-3.6-flash", "gemini-2.0-flash", "gemini-1.5-flash"])];

  let lastError = null;
  for (const model of models) {
    try {
      const contents = history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            generationConfig: { maxOutputTokens: maxTokens },
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = data?.error?.message || `Gemini returned status ${res.status}.`;
        lastError = message;
        const canRetry = /429|RESOURCE_EXHAUSTED|RATE_LIMIT|high demand|try again later|temporarily|overloaded/i.test(message);
        if (!canRetry) throw new Error(message);
        continue;
      }

      const candidate = data.candidates && data.candidates[0];
      const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("\n");
      if (!text) {
        const reason = candidate?.finishReason;
        throw new Error(reason ? `Gemini returned no text (reason: ${reason}).` : "Gemini returned an empty response.");
      }
      return text;
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (/high demand|try again later|resource exhausted|rate limit|temporarily/i.test(message)) {
        lastError = message;
        continue;
      }
      throw err;
    }
  }

  if (lastError) {
    return buildOfflineReply(lastUser?.content || "");
  }

  return buildOfflineReply(lastUser?.content || "");
}

async function askAI(history, maxTokens = 1024) {
  const lastUser = Array.isArray(history) ? [...history].reverse().find((m) => m.role === "user") : null;
  if (isIdentityQuestion(lastUser?.content)) return IDENTITY_REPLY;

  if (process.env.OPENROUTER_API_KEY) {
    return askOpenRouter(history, maxTokens);
  }
  if (process.env.GEMINI_API_KEY) {
    return askGemini(history, maxTokens);
  }
  return buildOfflineReply(lastUser?.content || "");
}

/* ------------------------------- Chat Q&A ------------------------------- */
router.post("/chat", async (req, res) => {
  const { message, history } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: "Message is required." });

  const wantsDetail = /\b(more|detailed|longer|expand|20[- ]?25|tell me more|give more|explain more)\b/i.test(message);
  const promptText = wantsDetail
    ? `${message}\n\nPlease answer in a detailed way, around 20–25 lines when appropriate, with clear structure and extra examples if useful.`
    : message;

  const messages = Array.isArray(history) ? history.slice(-20) : [];
  messages.push({ role: "user", content: promptText });

  try {
    const reply = await askAI(messages, wantsDetail ? 1536 : 768);
    res.json({ reply });
  } catch (err) {
    const status = err.code === "NO_API_KEY" ? 501 : 502;
    res.status(status).json({ error: err.message });
  }
});

/* ----------------------------- Image generation -------------------------
   Uses Pixazo's unified free-tier gateway (Flux Schnell by default) — free
   account, free API key, no credit card. See https://www.pixazo.ai/api/free
   Requires PIXAZO_API_KEY in .env.

   Note: Pixazo's public docs describe the request shape (POST to
   gateway.pixazo.ai/<model>/<operation> with an Ocp-Apim-Subscription-Key
   header) but don't pin down the exact response field name for the image
   URL. This checks the common shapes such gateways use; if none match, the
   raw response is logged so the field name can be added in one place below.
------------------------------------------------------------------------- */
router.post("/image", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: "A prompt is required." });

  const apiKey = process.env.PIXAZO_API_KEY;
  if (!apiKey) {
    return res.status(501).json({
      error: "Image generation is unavailable right now. Please try again later.",
    });
  }

  const model = process.env.PIXAZO_MODEL || "flux";

  try {
    const pixazoRes = await fetch(`https://gateway.pixazo.ai/${model}/text-to-image`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": apiKey,
      },
      body: JSON.stringify({ prompt }),
    });
    const data = await pixazoRes.json().catch(() => ({}));

    if (!pixazoRes.ok) {
      throw new Error(data?.message || data?.error || `Pixazo returned an error (status ${pixazoRes.status}).`);
    }

    const imageUrl =
      data.url ||
      data.image_url ||
      data.imageUrl ||
      data.output ||
      (data.data && (data.data.url || data.data.image_url)) ||
      (Array.isArray(data.images) && data.images[0]) ||
      (Array.isArray(data.output) && data.output[0]);

    if (!imageUrl) {
      console.error("Pixazo image response didn't match any known field — raw response:", JSON.stringify(data));
      throw new Error(
        "Pixazo responded successfully, but this code didn't recognize the response shape (logged to the server console). Compare it against https://www.pixazo.ai/models/flux and add the correct field name in server/routes/ai.js's /image handler."
      );
    }

    res.json({ imageUrl });
  } catch (err) {
    console.error("Image generation failed:", err.message);
    res.status(502).json({ error: "Image generation is unavailable right now. Please try again later." });
  }
});

/* ----------------------------- Video generation --------------------------
   Uses Luma AI's Dream Machine API (https://docs.lumalabs.ai). Requires
   LUMA_API_KEY in .env. Video generation is asynchronous — this route
   submits the job, then polls until it's done (typically 30s–3min) before
   responding, so the request just takes a while rather than needing a
   separate "check back later" step.
------------------------------------------------------------------------- */
router.post("/video", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: "A prompt is required." });

  const apiKey = process.env.LUMA_API_KEY;
  if (!apiKey) {
    return res.status(501).json({
      error: "Video generation isn't configured yet. Add LUMA_API_KEY to your .env file (see .env.example), then restart the server.",
    });
  }

  try {
    const createRes = await fetch("https://api.lumalabs.ai/dream-machine/v1/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ prompt, model: "ray-2", resolution: "720p", duration: "5s" }),
    });
    const created = await createRes.json();
    if (!createRes.ok || !created.id) {
      throw new Error(created?.detail || created?.error || "Luma didn't accept the request.");
    }

    const generationId = created.id;
    const startedAt = Date.now();
    const TIMEOUT_MS = 4 * 60 * 1000; // Luma video generations can take a couple of minutes
    const POLL_INTERVAL_MS = 4000;

    let final = null;
    while (Date.now() - startedAt < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const pollRes = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${generationId}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      });
      const pollData = await pollRes.json();
      if (pollData.state === "completed") {
        final = pollData;
        break;
      }
      if (pollData.state === "failed") {
        throw new Error(pollData.failure_reason || "Luma reported the generation failed.");
      }
      // otherwise still "queued" / "dreaming" — keep polling
    }

    if (!final) {
      return res.status(504).json({
        error: `Still generating after ${Math.round(TIMEOUT_MS / 1000)}s. Luma generation id: ${generationId} — it may finish shortly; try again in a bit.`,
      });
    }

    const videoUrl = final.assets && final.assets.video;
    if (!videoUrl) throw new Error("Luma marked the generation complete but returned no video URL.");
    res.json({ videoUrl });
  } catch (err) {
    console.error("Video generation error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

/* -------------------------------- PPT export -----------------------------
   Builds a real .pptx file locally with pptxgenjs — no API required for the
   file itself. If GEMINI_API_KEY is set, Gemini drafts a slide outline
   first; otherwise your text is split into slides directly.
------------------------------------------------------------------------- */
router.post("/ppt", async (req, res) => {
  const { topic } = req.body || {};
  if (!topic || !topic.trim()) return res.status(400).json({ error: "A topic or outline is required." });

  try {
    let slides;
    if (process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY) {
      const raw = await askAI(
        [
          {
            role: "user",
            content: `Create a slide outline for a short presentation on: "${topic}".
Respond with ONLY valid JSON, no other text, no markdown fences, in this exact shape:
{"title":"Presentation title","slides":[{"title":"Slide title","bullets":["point 1","point 2","point 3"]}]}
Include 5 to 8 slides.`,
          },
        ],
        2000
      );
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      slides = parsed;
    } else {
      const lines = topic.split(/\n+/).filter(Boolean);
      slides = {
        title: lines[0] || topic,
        slides: lines.slice(1).map((line) => ({ title: line.slice(0, 60), bullets: [line] })),
      };
      if (slides.slides.length === 0) {
        slides.slides = [{ title: topic, bullets: ["Add your content here — set OPENROUTER_API_KEY or GEMINI_API_KEY for AI-written slides."] }];
      }
    }

    const pptx = new PptxGenJS();
    const titleSlide = pptx.addSlide();
    titleSlide.addText(slides.title || topic, { x: 0.5, y: 2.2, w: 9, h: 1.5, fontSize: 32, bold: true, align: "center" });

    (slides.slides || []).forEach((s) => {
      const slide = pptx.addSlide();
      slide.addText(s.title || "", { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24, bold: true });
      const bulletText = (s.bullets || []).map((b) => ({ text: b, options: { bullet: true, breakLine: true } }));
      if (bulletText.length) slide.addText(bulletText, { x: 0.5, y: 1.3, w: 9, h: 4.5, fontSize: 16 });
    });

    const buffer = await pptx.write({ outputType: "nodebuffer" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="mentivo-presentation.pptx"`);
    res.send(buffer);
  } catch (err) {
    console.error("PPT generation error:", err);
    res.status(502).json({ error: err.message || "Couldn't generate the presentation." });
  }
});

/* -------------------------------- PDF export -----------------------------
   Builds a real .pdf file locally with pdfkit — no API required for the
   file itself. If GEMINI_API_KEY is set, Gemini drafts the document text
   first; otherwise your text is used directly.
------------------------------------------------------------------------- */
router.post("/pdf", async (req, res) => {
  const { topic } = req.body || {};
  if (!topic || !topic.trim()) return res.status(400).json({ error: "A topic or text is required." });

  try {
    let title = topic.split(/\n+/)[0].slice(0, 80);
    let body = topic;

    if (process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY) {
      body = await askAI(
        [{ role: "user", content: `Write a clear, well-organized document (with a short title on the first line) about: "${topic}".` }],
        2000
      );
      title = body.split(/\n+/)[0].slice(0, 80);
    }

    const doc = new PDFDocument({ margin: 56 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    const donePromise = new Promise((resolve) => doc.on("end", resolve));

    doc.fontSize(20).font("Helvetica-Bold").text(title, { align: "left" });
    doc.moveDown();
    doc.fontSize(11).font("Helvetica").text(body, { align: "left", lineGap: 4 });
    doc.end();

    await donePromise;
    const buffer = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="mentivo-document.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error("PDF generation error:", err);
    res.status(502).json({ error: err.message || "Couldn't generate the PDF." });
  }
});

module.exports = router;
