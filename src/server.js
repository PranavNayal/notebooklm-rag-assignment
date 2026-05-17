import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import multer from "multer";
import pdf from "pdf-parse/lib/pdf-parse.js";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const uploadDir = path.join(rootDir, "uploads");

const PORT = process.env.PORT || 3000;
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini";
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

const app = express();
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ["application/pdf", "text/plain"];
    const allowedExtensions = [".pdf", ".txt"];
    const extension = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(extension)) {
      cb(null, true);
      return;
    }

    cb(new Error("Only PDF and plain text files are supported."));
  }
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "missing-key" });
const qdrant = new QdrantClient({
  url: QDRANT_URL,
  apiKey: QDRANT_API_KEY,
  checkCompatibility: false
});
const indexedDocuments = new Map();
const EMBEDDING_BATCH_SIZE = 64;
const UPSERT_BATCH_SIZE = 100;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(rootDir, "public")));

await fs.mkdir(uploadDir, { recursive: true });

async function loadFile(file) {
  const extension = path.extname(file.originalname).toLowerCase();

  if (file.mimetype === "application/pdf" || extension === ".pdf") {
    const buffer = await fs.readFile(file.path);
    try {
      const parsed = await pdf(buffer);
      return parsed.text;
    } catch (error) {
      const parseError = new Error(
        "This PDF could not be read. It may be corrupted, scanned, encrypted, or saved in a format this parser cannot process. Try opening it and choosing Print > Save as PDF, or upload a plain text version."
      );
      parseError.statusCode = 400;
      parseError.cause = error;
      throw parseError;
    }
  }

  return fs.readFile(file.path, "utf8");
}

function chunkText(text, chunkSize = 1000, chunkOverlap = 200) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    const maxEnd = Math.min(start + chunkSize, normalized.length);
    let end = maxEnd;

    if (maxEnd < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf("\n\n", maxEnd);
      const sentenceBreak = Math.max(
        normalized.lastIndexOf(". ", maxEnd),
        normalized.lastIndexOf("? ", maxEnd),
        normalized.lastIndexOf("! ", maxEnd)
      );
      const softBreak = Math.max(paragraphBreak, sentenceBreak);

      if (softBreak > start + chunkSize * 0.5) {
        end = softBreak + 1;
      }
    }

    const content = normalized.slice(start, end).trim();
    if (content) {
      chunks.push({ content, index: chunks.length });
    }

    if (end >= normalized.length) {
      break;
    }

    start = Math.max(0, end - chunkOverlap);
  }

  return chunks;
}

async function embedTexts(texts) {
  const embeddings = [];

  for (let index = 0; index < texts.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(index, index + EMBEDDING_BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch
    });

    embeddings.push(...response.data.map((item) => item.embedding));
  }

  return embeddings;
}

function formatContext(points) {
  return points
    .map(
      (point, index) =>
        `Source ${index + 1} | file: ${point.payload.filename} | chunk: ${point.payload.chunkIndex + 1}\n${point.payload.text}`
    )
    .join("\n\n---\n\n");
}

async function generateGroundedAnswer(question, context) {
  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.0,
    messages: [
      {
        role: "system",
        content: `You are a document question-answering assistant. Answer only from the provided context. Do not use outside knowledge or make guesses. If the context does not contain the answer, reply exactly: I could not find that in the uploaded document.`
      },
      {
        role: "user",
        content: `Context:\n${context}\n\nQuestion: ${question}`
      }
    ]
  });

  return completion.choices[0]?.message?.content?.trim() || "I could not find that in the uploaded document.";
}

async function verifyAndCorrectAnswer(question, answer, context) {
  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.0,
    messages: [
      {
        role: "system",
        content: `You are a factual verifier. Compare the answer to the context. Use only the context text. If the answer is fully supported by the context, return the same answer. If any part is unsupported, rewrite the answer using only supported context, or reply exactly: I could not find that in the uploaded document.`
      },
      {
        role: "user",
        content: `Context:\n${context}\n\nQuestion: ${question}\n\nCandidate answer: ${answer}`
      }
    ]
  });

  return completion.choices[0]?.message?.content?.trim() || "I could not find that in the uploaded document.";
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/upload", upload.single("document"), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Please upload a PDF or text file." });
      return;
    }

    if (!process.env.OPENAI_API_KEY) {
      res.status(500).json({ error: "OPENAI_API_KEY is not configured." });
      return;
    }

    const text = await loadFile(req.file);
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      res.status(400).json({ error: "No text could be extracted from this document." });
      return;
    }

    const documentId = crypto.randomUUID();
    const collectionName = `notebook_${documentId.replaceAll("-", "_")}`;

    const vectors = await embedTexts(chunks.map((chunk) => chunk.content));

    await qdrant.createCollection(collectionName, {
      vectors: {
        size: vectors[0].length,
        distance: "Cosine"
      }
    });

    const points = chunks.map((chunk, index) => ({
        id: crypto.randomUUID(),
        vector: vectors[index],
        payload: {
          text: chunk.content,
          chunkIndex: chunk.index,
          filename: req.file.originalname
        }
      }));

    for (let index = 0; index < points.length; index += UPSERT_BATCH_SIZE) {
      await qdrant.upsert(collectionName, {
        wait: true,
        points: points.slice(index, index + UPSERT_BATCH_SIZE)
      });
    }

    indexedDocuments.set(documentId, {
      collectionName,
      filename: req.file.originalname,
      chunks: chunks.length
    });

    res.json({
      documentId,
      filename: req.file.originalname,
      chunks: chunks.length,
      chunking: "Character chunking with paragraph/sentence-aware breaks, 1000 characters with 200 overlap"
    });
  } catch (error) {
    next(error);
  } finally {
    if (req.file?.path) {
      await fs.rm(req.file.path, { force: true }).catch(() => {});
    }
  }
});

app.post("/api/chat", async (req, res, next) => {
  try {
    const { documentId, question } = req.body;

    if (!documentId || !question?.trim()) {
      res.status(400).json({ error: "documentId and question are required." });
      return;
    }

    if (!process.env.OPENAI_API_KEY) {
      res.status(500).json({ error: "OPENAI_API_KEY is not configured." });
      return;
    }

    const document = indexedDocuments.get(documentId);
    if (!document) {
      res.status(404).json({ error: "Document not found. Please upload it again." });
      return;
    }

    const [queryVector] = await embedTexts([question]);
    const retrievedPoints = await qdrant.search(document.collectionName, {
      vector: queryVector,
      limit: 5,
      with_payload: true
    });
    const context = formatContext(retrievedPoints);

    const groundedAnswer = await generateGroundedAnswer(question, context);
    const finalAnswer = await verifyAndCorrectAnswer(question, groundedAnswer, context);

    res.json({
      answer: finalAnswer,
      sources: retrievedPoints.map((point, index) => ({
        source: index + 1,
        filename: point.payload.filename,
        chunk: point.payload.chunkIndex + 1,
        score: point.score,
        preview: point.payload.text.slice(0, 280)
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ error: error.message || "Something went wrong." });
});

app.listen(PORT, () => {
  console.log(`NotebookLM RAG app running on http://localhost:${PORT}`);
});
