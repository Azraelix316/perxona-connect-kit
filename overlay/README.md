# Perxona Desktop Avatar Overlay

A transparent, floating Electron window that displays an AI avatar assistant from the Perxona Connect Kit. The avatar can accept speech and text input, responds via LLM, and performs gestures. Perfect for an always-on-top assistant that works on top of any application.

## Features

- **Transparent Overlay Window** - Float above any application
- **Avatar Only** - No background scene, just the avatar on a transparent canvas
- **Speech Recognition** - Hold microphone button to speak (Web Speech API)
- **Text Input** - Type messages or paste text
- **LLM Integration** - Responses powered by Perxona chatbot
- **Gesture Support** - Avatar performs motions synchronized with speech
- **Window Controls** - Minimize and close buttons (no window frame)
- **Always On Top** - Stays visible above other applications
- **Draggable** - Move the window by dragging anywhere (except interactive elements)

## Prerequisites

### Backend Server (Required)

The Express backend server must be running on `http://localhost:8083`. See the main project's `samples/express/` directory.

```bash
cd samples/express
npm install
npm start
```

The backend provides:
- Avatar/Scene/Voice configuration
- Chatbot chat endpoint
- Connect API key for browser-side SDK

### System Requirements

- Node.js 14+ (for building)
- Electron 28.0+
- Chromium-based browser (for Web Speech API)
- Windows, macOS, or Linux

## Installation

```bash
cd overlay
npm install
```

## Running the App

```bash
npm start
```

The Electron window will open as a transparent overlay. Make sure the Express backend is running at `http://localhost:8083`.

## Project Structure

```
overlay/
├── main.js           # Electron main process - window creation and IPC
├── preload.js        # Security bridge between main and renderer
├── renderer.js       # Core logic - avatar SDK, speech, messaging
├── index.html        # UI layout - avatar container, controls
├── styles.css        # Styling - glassmorphism, animations
├── package.json      # Dependencies
└── README.md         # This file
```

## Architecture

```
┌─────────────────────────────────┐
│   Electron Overlay Window       │
│  ┌─────────────────────────────┐│
│  │   sv-presenter (Avatar)     ││
│  │   • No background scene     ││
│  │   • Transparent canvas      ││
│  └─────────────────────────────┘│
│  ┌─────────────────────────────┐│
│  │   Input Controls            ││
│  │   • Microphone (hold)       ││
│  │   • Text input + send       ││
│  │   • Status display          ││
│  └─────────────────────────────┘│
└─────────────────────────────────┘
           ↓ HTTP
┌─────────────────────────────────┐
│  Express Backend (localhost:8083)│
│  • /api/config                  │
│  • /api/connect-key             │
│  • /api/chatbots/{id}/chat      │
└─────────────────────────────────┘
           ↓ HTTP
┌─────────────────────────────────┐
│  Perxona Connect API            │
│  • Avatar/Scene/Voice catalog   │
│  • TTS & Presentation           │
└─────────────────────────────────┘
```

## Usage

### Starting the Avatar

1. Ensure the Express backend is running
2. Run `npm start` in this directory
3. Wait for "Avatar ready!" message
4. Start interacting:
   - **Hold microphone button** - Speak your message
   - **Type in text field** - Type or paste text
   - **Press Enter** - Send text message
   - **Drag window** - Move anywhere on screen
   - **Minimize/Close** - Use buttons in top-right

### Conversation Flow

```
User: "Hello, how are you?"
     ↓ (speech recognition or text input)
Backend: /api/chatbots/{id}/chat
     ↓
LLM Response: "I'm doing great, thanks for asking!"
     ↓
Avatar: Speaks response with synchronized gestures
```

## Configuration

The app reads configuration from the backend at startup:
- Avatar ID
- Voice ID
- Scene ID (set to null for transparent background)
- Chatbot ID
- Presenter SDK URL

To change these, modify `samples/express/.env` and restart the backend.

## Customization

### Window Size

Edit `main.js`:
```javascript
mainWindow = new BrowserWindow({
  width: 400,   // Change width
  height: 600,  // Change height
  ...
});
```

### Avatar Appearance

The avatar appearance is controlled by the backend configuration (`FIXED_TARGET` in `.env`). Edit the backend config to change avatar, voice, or scene.

### Styling

Modify `styles.css` to customize:
- Colors and transparency
- Button styles
- Input field appearance
- Animation speeds

### Speech Language

Edit `renderer.js`:
```javascript
recognition.lang = 'en-US';  // Change language
```

## Troubleshooting

### Avatar doesn't appear

**Check:**
1. Backend is running: `http://localhost:8083/api/config`
2. Check browser console in DevTools (uncomment line in `main.js`)
3. Look for "Presenter ready" message

**Enable DevTools:**
```javascript
// In main.js, uncomment:
mainWindow.webContents.openDevTools({ mode: 'detach' });
```

### Speech recognition doesn't work

- Grant microphone permissions when prompted
- Use Chromium-based Electron (included by default)
- Fall back to text input if speech doesn't work

### Audio doesn't play

- Check backend is running and has valid credentials
- Verify chatbot exists at `http://localhost:8083/demos/studio/`
- Check subscription status at `console.perxona.ai`

### Connection errors

- Ensure Express backend is running on `http://localhost:8083`
- Check firewall isn't blocking localhost
- Verify CDN access to `cdn.perxona.ai`

## API Integration

The app communicates with the backend via HTTP:

### GET /api/config
Returns configuration including:
- `presenterUrl` - SDK CDN URL
- `fixedTarget.avatarId` - Avatar ID
- `fixedTarget.voiceId` - Voice ID
- `chatbotId` - Chatbot ID

### GET /api/connect-key
Returns `connect_key` for SDK initialization (publishable key only, safe for client).

### POST /api/chatbots/{chatbotId}/chat
Sends messages and gets responses:
```json
{
  "messages": [
    { "role": "user", "parts": [{ "type": "text", "text": "..." }] }
  ]
}
```

Response:
```json
{
  "reply_text": "Avatar response here..."
}
```

## SDK Methods

The `<sv-presenter>` web component provides:

```javascript
// Initialize (done automatically)
await presenter.initializeWithConnectKey(key, options)

// Send message and play response
await presenter.present("Hello world!")

// Play specific motion
await presenter.playMotion(motionId)

// Control thinking indicator
presenter.setThinking(true/false)

// Unlock audio playback
await presenter.resumeAudioPlayback()

// Stop current performance
presenter.interruptPresentation()
```

## Security Notes

- The app uses Electron's context isolation (`contextIsolation: true`)
- Node integration is disabled (`nodeIntegration: false`)
- Only publishable API keys are used on the client
- Secret keys stay on the backend
- IPC communication is sandboxed

## Development

To enable debugging:

1. Uncomment DevTools in `main.js`:
```javascript
mainWindow.webContents.openDevTools({ mode: 'detach' });
```

2. Check browser console for errors
3. Monitor network requests in DevTools Network tab
4. Check backend logs at `http://localhost:8083`

## Deployment

To build a distributable app:

```bash
# Install additional build tools
npm install --save-dev @electron-builder/cli

# Build installer (customize in package.json)
npm run build
```

See Electron documentation for detailed build instructions.

## License

This project is part of the Perxona Connect Kit. See LICENSE file in the main project directory.

## Support

For issues:
1. Check the console logs (enable DevTools)
2. Verify backend is running
3. Check credentials at `console.perxona.ai`
4. Review main project documentation
