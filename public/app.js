const uploadForm = document.querySelector("#upload-form");
const chatForm = document.querySelector("#chat-form");
const statusEl = document.querySelector("#status");
const messagesEl = document.querySelector("#messages");
const questionInput = document.querySelector("#question");
const askButton = document.querySelector("#ask-button");

let activeDocumentId = null;

function setStatus(message) {
  statusEl.textContent = message;
}

function addMessage(role, content, sources = []) {
  const message = document.createElement("div");
  message.className = `message ${role}`;

  const paragraph = document.createElement("p");
  paragraph.textContent = content;
  message.append(paragraph);

  if (sources.length > 0) {
    const sourceBlock = document.createElement("div");
    sourceBlock.className = "sources";
    sourceBlock.textContent = sources
      .map((source) => `Source ${source.source}${source.chunk ? `, chunk ${source.chunk}` : ""}: ${source.preview}`)
      .join("\n\n");
    message.append(sourceBlock);
  }

  messagesEl.append(message);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(uploadForm);
  const submitButton = uploadForm.querySelector("button");

  submitButton.disabled = true;
  questionInput.disabled = true;
  askButton.disabled = true;
  setStatus("Indexing document...");

  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Upload failed.");
    }

    activeDocumentId = data.documentId;
    questionInput.disabled = false;
    askButton.disabled = false;
    setStatus(`${data.filename} indexed into ${data.chunks} chunks.`);
    addMessage("assistant", `Document ready: ${data.filename}\n${data.chunking}`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();

  if (!activeDocumentId || !question) {
    return;
  }

  questionInput.value = "";
  questionInput.disabled = true;
  askButton.disabled = true;
  addMessage("user", question);
  setStatus("Retrieving relevant chunks and generating answer...");

  try {
    const data = await postJson("/api/chat", {
      documentId: activeDocumentId,
      question
    });

    addMessage("assistant", data.answer, data.sources);
    setStatus("Ready for the next question.");
  } catch (error) {
    addMessage("assistant", error.message);
    setStatus(error.message);
  } finally {
    questionInput.disabled = false;
    askButton.disabled = false;
    questionInput.focus();
  }
});
