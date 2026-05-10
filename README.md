# NotebookLM RAG Assignment

A simple Google NotebookLM-style RAG application. Upload a PDF or plain text file, index it into Qdrant, and ask questions that are answered only from retrieved document context.

## Features

- Upload PDF or `.txt` files
- Load document text from PDF and text files
- Chunk document text using `RecursiveCharacterTextSplitter`
- Embed chunks with OpenAI embeddings
- Store and retrieve vectors with Qdrant
- Generate grounded answers with an OpenAI chat model
- Simple web interface for upload and chat

## RAG Pipeline

1. **Ingestion**: The server receives a PDF or text file through `/api/upload`.
2. **Loading**: `pdf-parse` extracts PDF text and Node.js reads text files directly.
3. **Chunking**: A paragraph/sentence-aware character chunker creates chunks of 1000 characters with 200 characters of overlap. This keeps chunks small enough for precise retrieval while preserving surrounding context across chunk boundaries.
4. **Embedding**: Each chunk is embedded with `text-embedding-3-small` by default.
5. **Vector storage**: Chunks and metadata are stored in a Qdrant collection.
6. **Retrieval**: For each user question, the app retrieves the top 5 most relevant chunks.
7. **Generation**: The LLM receives only the retrieved chunks as context and is instructed to say when the document does not contain the answer.

## Local Setup

Install dependencies:

```bash
npm install
```

Create `.env`:

```bash
cp .env.example .env
```

Set these required values:

```bash
OPENAI_API_KEY=...
QDRANT_URL=...
QDRANT_API_KEY=...
```

For local Qdrant, you can run:

```bash
docker run -p 6333:6333 qdrant/qdrant
```

Then use:

```bash
QDRANT_URL=http://localhost:6333
```

Start the app:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Deployment

Deploy this repository to Render, Railway, or any Node.js hosting provider.

Set environment variables in the hosting dashboard:

- `OPENAI_API_KEY`
- `QDRANT_URL`
- `QDRANT_API_KEY`
- `OPENAI_CHAT_MODEL` optional, defaults to `gpt-4.1-mini`
- `OPENAI_EMBEDDING_MODEL` optional, defaults to `text-embedding-3-small`

Use these commands:

- Build command: `npm install`
- Start command: `npm start`

## Grounding Rule

The answer prompt tells the model:

- Use only the retrieved document context.
- Do not use outside knowledge.
- If the answer is not in the document, say so clearly.

This keeps answers grounded in the uploaded file instead of general model memory.
