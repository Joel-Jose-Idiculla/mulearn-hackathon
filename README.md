# AI WhatsApp Bodyguard

## Setup

1. Install dependencies:
   npm install
2. Create .env from .env.example and add your Gemini key.
3. Start server:
   npm start
4. Open http://localhost:3000 and scan QR.

## Notes

- Uses whatsapp-web.js LocalAuth to persist login.
- Uses Gemini 1.5 Flash to classify scam-like messages.
- Replies automatically when a scam is detected.
