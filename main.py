from pathlib import Path

from flask import Flask, jsonify, request
from google import genai
from google.genai import types
import yaml


CONFIG_PATH = Path(__file__).with_name("config.yaml")
DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant. Keep answers clear and concise."


def resolve_active_profile(config_path: Path) -> dict:
    config = load_config(config_path)
    llm_config = config.get("llm") or {}
    profiles = llm_config.get("profiles") or {}
    active = (llm_config.get("active") or "").strip()

    if not active:
        raise ValueError(f"Missing 'llm.active' in {config_path}.")

    profile = profiles.get(active)
    if not isinstance(profile, dict):
        raise ValueError(f"LLM profile '{active}' not found in {config_path}.")

    provider = (profile.get("provider") or "").strip()
    if provider != "google":
        raise ValueError(
            f"Python main.py only supports the 'google' provider, got '{provider or 'unknown'}'."
        )

    model_name = (profile.get("model") or "").strip()
    if not model_name:
        raise ValueError(f"Missing 'model' for llm profile '{active}' in {config_path}.")

    system_prompt = (
        (profile.get("system_prompt") or "").strip()
        or (llm_config.get("system_prompt") or "").strip()
        or DEFAULT_SYSTEM_PROMPT
    )

    return {
        "name": active,
        "model": model_name,
        "system_prompt": system_prompt,
        "api": profile.get("api"),
    }


def load_api_key(config_path: Path) -> str:
    profile = resolve_active_profile(config_path)
    api_value = profile.get("api")
    if isinstance(api_value, list):
        api_list = [str(item).strip() for item in api_value if str(item).strip()]
    elif isinstance(api_value, str):
        api_list = [api_value.strip()] if api_value.strip() else []
    else:
        api_list = []

    api_key = api_list[-1] if api_list else None
    if not api_key:
        raise ValueError(f"Missing 'api' in {config_path}.")

    return api_key


def load_config(config_path: Path) -> dict:
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}.")

    with config_path.open("r", encoding="utf-8") as file:
        return yaml.safe_load(file) or {}


def load_system_prompt(config_path: Path) -> str:
    profile = resolve_active_profile(config_path)
    return str(profile["system_prompt"])


def build_prompt(history: list[dict[str, str]], prompt: str) -> str:
    lines = ["Continue the conversation naturally and answer the latest user message."]

    for item in history:
        role = (item.get("role") or "").strip()
        text = (item.get("text") or "").strip()
        if not text or role not in {"user", "assistant"}:
            continue
        speaker = "User" if role == "user" else "Gemini"
        lines.append(f"{speaker}: {text}")

    lines.append(f"User: {prompt}")
    lines.append("Gemini:")
    return "\n".join(lines)


ACTIVE_PROFILE = resolve_active_profile(CONFIG_PATH)
MODEL_NAME = str(ACTIVE_PROFILE["model"])
client = genai.Client(api_key=load_api_key(CONFIG_PATH))
SYSTEM_PROMPT = load_system_prompt(CONFIG_PATH)
app = Flask(__name__)


HTML_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gemini Chat</title>
  <style>
    :root {
      --card: rgba(255, 250, 242, 0.92);
      --text: #1c1917;
      --muted: #57534e;
      --accent: #0f766e;
      --accent-hover: #115e59;
      --border: #d6d3d1;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, #d9f99d 0, transparent 28%),
        radial-gradient(circle at top right, #99f6e4 0, transparent 25%),
        linear-gradient(135deg, #f4efe6, #e7e5e4);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .panel {
      width: min(920px, 100%);
      background: var(--card);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(214, 211, 209, 0.85);
      border-radius: 24px;
      box-shadow: 0 24px 60px rgba(28, 25, 23, 0.12);
      overflow: hidden;
    }
    .header {
      padding: 28px 28px 12px;
    }
    .header h1 {
      margin: 0 0 8px;
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1;
    }
    .header p {
      margin: 0;
      color: var(--muted);
    }
    .body {
      padding: 20px 28px 28px;
      display: grid;
      gap: 16px;
    }
    .chat-log {
      min-height: 380px;
      max-height: 56vh;
      overflow-y: auto;
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: 22px;
      background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(250,250,249,0.95));
      display: grid;
      gap: 14px;
      align-content: start;
    }
    .message {
      max-width: 82%;
      padding: 14px 16px;
      border-radius: 20px;
      white-space: pre-wrap;
      line-height: 1.6;
      box-shadow: 0 10px 24px rgba(28, 25, 23, 0.08);
    }
    .message.user {
      justify-self: end;
      background: #115e59;
      color: #f0fdfa;
      border-bottom-right-radius: 8px;
    }
    .message.assistant {
      justify-self: start;
      background: #ffffff;
      color: var(--text);
      border: 1px solid #d6d3d1;
      border-bottom-left-radius: 8px;
    }
    .message-label {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.72;
    }
    textarea {
      width: 100%;
      min-height: 110px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 16px;
      font: inherit;
      color: var(--text);
      background: #fff;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 14px 22px;
      font: inherit;
      font-weight: 700;
      color: #fff;
      background: var(--accent);
      cursor: pointer;
      transition: background 0.2s ease;
    }
    button:hover { background: var(--accent-hover); }
    button:disabled {
      cursor: wait;
      opacity: 0.7;
    }
    .meta {
      color: var(--muted);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <main class="panel">
    <section class="header">
      <h1>Gemini Chat</h1>
      <p>The page keeps the full conversation history and shows every Gemini reply.</p>
    </section>
    <section class="body">
      <div class="chat-log" id="chatLog">
        <div class="message assistant">
          <span class="message-label">Gemini</span>
          Full chat history will appear here. Send your first message to begin.
        </div>
      </div>
      <textarea id="prompt" placeholder="Example: Explain artificial intelligence in simple words."></textarea>
      <div>
        <button id="send">Send</button>
      </div>
      <div class="meta" id="status">Waiting for input</div>
    </section>
  </main>

  <script>
    const sendButton = document.getElementById("send");
    const promptInput = document.getElementById("prompt");
    const statusText = document.getElementById("status");
    const chatLog = document.getElementById("chatLog");
    const history = [];

    function renderMessage(role, text) {
      const item = document.createElement("div");
      item.className = "message " + role;

      const label = document.createElement("span");
      label.className = "message-label";
      label.textContent = role === "user" ? "You" : "Gemini";

      const content = document.createElement("div");
      content.textContent = text;

      item.appendChild(label);
      item.appendChild(content);
      chatLog.appendChild(item);
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    function clearPlaceholderIfNeeded() {
      if (history.length === 0) {
        chatLog.innerHTML = "";
      }
    }

    function restorePlaceholderIfNeeded() {
      if (history.length === 0) {
        chatLog.innerHTML = '<div class="message assistant"><span class="message-label">Gemini</span>Full chat history will appear here. Send your first message to begin.</div>';
      }
    }

    async function sendMessage() {
      const prompt = promptInput.value.trim();
      if (!prompt) {
        statusText.textContent = "Please enter a message.";
        return;
      }

      clearPlaceholderIfNeeded();
      history.push({ role: "user", text: prompt });
      renderMessage("user", prompt);
      promptInput.value = "";
      sendButton.disabled = true;
      statusText.textContent = "Gemini is generating...";

      try {
        const result = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, history: history.slice(0, -1) })
        });

        const data = await result.json();
        if (!result.ok) {
          throw new Error(data.error || "Request failed");
        }

        history.push({ role: "assistant", text: data.message });
        renderMessage("assistant", data.message);
        statusText.textContent = "Gemini reply received.";
      } catch (error) {
        history.pop();
        if (chatLog.lastElementChild) {
          chatLog.removeChild(chatLog.lastElementChild);
        }
        restorePlaceholderIfNeeded();
        promptInput.value = prompt;
        statusText.textContent = "Request failed: " + error.message;
      } finally {
        sendButton.disabled = false;
      }
    }

    sendButton.addEventListener("click", sendMessage);
    promptInput.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        sendMessage();
      }
    });
  </script>
</body>
</html>
"""


@app.get("/")
def index():
    return HTML_PAGE


@app.post("/api/chat")
def chat():
    data = request.get_json(silent=True) or {}
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400

    history = data.get("history") or []
    contents = build_prompt(history, prompt)

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
            ),
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({"message": response.text or ""})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
