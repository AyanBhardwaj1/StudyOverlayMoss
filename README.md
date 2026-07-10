![Uploading Screenshot 2026-07-10 at 11.42.24 PM.png…]()
# StudyOverlay

StudyOverlay is a desktop overlay AI study assistant built with Python. It sits on top of whatever app, browser tab, PDF, quiz, or lecture material the user is viewing, captures the screen on demand, sends the screenshot to a vision-capable LLM through OpenRouter, and renders a tutor-style explanation inside a transparent glassmorphism overlay.

The assistant also uses Moss as a real-time semantic memory layer for the active study session. Each explanation is indexed into a Moss session after it is generated. Before the next response, StudyOverlay queries Moss for related earlier explanations and passes those memories back into the model prompt as session context.

In short: OpenRouter handles screen understanding, while Moss handles session recall.

## Features

- Always-on-top transparent desktop overlay using `pywebview`
- Screen capture with `mss` and Pillow
- Vision-capable chat completions through OpenRouter
- User prompt box for follow-up instructions like “solve this like the last one”
- Markdown rendering in the overlay with `marked`
- Math rendering with KaTeX auto-render
- Local settings screen for API keys
- Moss-powered semantic session memory
- Graceful fallback if Moss credentials are missing or invalid
- macOS and Windows/Linux hotkey support, with an on-screen `Ask` button as a fallback

## How It Works

StudyOverlay has four main steps:

1. **Capture**
   The app hides the overlay briefly, captures the current screen with `mss`, converts the raw pixels to PNG with Pillow, and base64-encodes the image.

2. **Retrieve Session Context**
   Before calling the LLM, the app queries Moss for the most semantically related explanations from the current `study-session`.

3. **Generate Explanation**
   The screenshot, optional user prompt, and retrieved Moss context are sent to OpenRouter. The model is instructed to explain visible content like a tutor and use KaTeX-compatible math delimiters.

4. **Remember**
   After the answer is generated, the explanation is added back into Moss with `addDocs()` so future questions can retrieve it.

This creates a simple memory loop:

```text
screen capture -> Moss retrieval -> LLM answer -> Moss indexing
```

## Moss Memory

Moss is used as a local semantic retrieval layer for the active study session.

The app creates a Moss session named:

```text
study-session
```

For every answer:

- The generated explanation is saved as a document in Moss.
- The document includes a short topic/title and the full explanation text.
- Future prompts query the Moss session for related prior explanations.
- The top related results are inserted into the LLM prompt as “related context from earlier in this session.”

This lets the assistant connect new questions to material it already explained. For example, if it explained the chain rule earlier, a later derivative problem can retrieve that prior explanation and answer in a more continuous, tutor-like way.

### Why There Is a Moss Sidecar

The Python overlay uses the official Moss JavaScript SDK through a small local sidecar process: [moss_sidecar.mjs](moss_sidecar.mjs).

The sidecar owns the Moss session and exposes these actions to Python over JSON-lines IPC:

- `init`
- `query`
- `add_docs`

This keeps the main app in Python while still using official Moss software for semantic memory. The Python Moss SDK remains available as a fallback path in [memory.py](memory.py).

## Project Structure

```text
.
├── main.py              # App entrypoint, pywebview window, hotkey, capture flow
├── capture.py           # mss screen capture and PNG/base64 conversion
├── ai.py                # OpenRouter vision chat integration
├── memory.py            # Moss memory wrapper and sidecar bridge
├── settings.py          # Local config loading/saving
├── moss_sidecar.mjs     # Official Moss JS SDK sidecar
├── overlay.html         # Overlay UI shell
├── overlay.css          # Glassmorphism styling
├── overlay.js           # UI logic, settings form, markdown + KaTeX rendering
├── requirements.txt     # Python dependencies
├── package.json         # JavaScript dependency for Moss sidecar
└── README.md
```

## Requirements

- Python 3.10+
- Node.js 18+ or newer
- `pnpm`
- OpenRouter API key
- Moss project ID and project key

On macOS, you may also need to grant:

- Screen Recording permission for screen capture
- Accessibility permission for the global hotkey

The app still works without the global hotkey because the overlay includes an `Ask` button.

## Setup

Clone the repo and install dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt
pnpm install
```

Run the app:

```bash
python main.py
```

On first launch, the overlay opens a settings view. Enter:

- `OPENROUTER_API_KEY`
- `MOSS_PROJECT_ID`
- `MOSS_PROJECT_KEY`

The values are saved locally in the app user data directory, not in the repository.

Moss credentials come from signing up at [moss.dev](https://moss.dev/). OpenRouter API keys come from [openrouter.ai](https://openrouter.ai/).

## Usage

Open the material you want help with, then use one of these:

- macOS hotkey: `Cmd+Shift+A`
- Windows/Linux hotkey: `Ctrl+Shift+A`
- Overlay button: `Ask`

You can also type extra instructions into the prompt box before pressing `Ask`, for example:

```text
solve this step by step
```

```text
this is like the last question, use the same method
```

```text
only give the final answer using the summation rule
```

The typed prompt is used both for the LLM instruction and for Moss retrieval, so specific prompts help the app recall the most relevant earlier explanation.

## Configuration

Credentials are managed inside the overlay settings screen. They are stored in a local `config.json` file under the app user data directory.

The exact path is shown in the settings view.

The repository `.gitignore` excludes:

```text
config.json
.env*.local
.venv/
venv/
__pycache__/
node_modules/
.pnpm-store/
```

No API keys or Moss credentials should be committed.

## Environment Variables

Most users do not need these, but they are available:

```bash
STUDYOVERLAY_NODE=/path/to/node
```

Use this if Node.js is not on your `PATH`.

```bash
STUDYOVERLAY_MOSS_BACKEND=js,python
```

Controls Moss backend preference. By default, the app uses the official Moss JavaScript SDK first and the Python SDK second.

## Troubleshooting

### Hotkey Does Not Work on macOS

macOS may block global keyboard monitoring until Accessibility permission is granted.

Open:

```text
System Settings -> Privacy & Security -> Accessibility
```

Then enable permission for the Python or Terminal process running the app. You can still use the on-screen `Ask` button without this permission.

### Screen Capture Does Not Work on macOS

Grant Screen Recording permission:

```text
System Settings -> Privacy & Security -> Screen Recording
```

Then restart the app.

### Moss Memory Is Disabled

Check that:

- `MOSS_PROJECT_ID` is saved in settings
- `MOSS_PROJECT_KEY` is saved in settings
- JavaScript dependencies were installed with `pnpm install`
- Node.js is available, or `STUDYOVERLAY_NODE` points to a valid Node binary

When Moss is working, startup logs should include:

```text
Moss memory enabled via moss-js.
```

### OpenRouter Request Fails

Check that:

- `OPENROUTER_API_KEY` is saved in settings
- The selected OpenRouter model supports vision input
- Your OpenRouter account has available credits

## Notes

- StudyOverlay stores session memory for the current study session, not permanent long-term user memory.
- The overlay sends screenshots to OpenRouter for model inference.
- Moss is used for semantic retrieval over prior generated explanations.
- KaTeX rendering supports inline `$...$` and block `$$...$$` math.

## License

No license has been added yet. Add one before publishing publicly if you want others to use, modify, or distribute the project.
