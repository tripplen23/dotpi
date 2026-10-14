# Pi environment keys.

# Web search
# Keep the PI_ prefix: exported vars beat a project's .env and would shadow it.
export PI_FIRECRAWL_API_KEY="fc-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export PI_EXA_API_KEY="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# Voice dictation (extensions/pi-talk)
export ELEVENLABS_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Triage (Laya / Jev). Both optional; also read from ~/.config/laya/env.
# OPENROUTER_API_KEY is not set here — pi keeps it in auth.json via /login.
export LAYA_URL="https://console.opscom.io/v1"
export LAYA_API_KEY="laya-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Google Vertex AI
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/gcloud-huggerhustle/huggerhustle-dev.json"
export GOOGLE_CLOUD_PROJECT="huggerhustle-apps"
export GOOGLE_CLOUD_LOCATION="global"
