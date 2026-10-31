#!/usr/bin/env bash
# تشغيل backend + frontend (مناسب للتشغيل من الـ startup)

SYSTEM_DIR="${SYSTEM_DIR:-$HOME/system}"
LOG="$HOME/system_startup.log"
exec >>"$LOG" 2>&1
echo "=== $(date) start ==="

# الـ startup مش بيقرأ .bashrc، فنحمّل nvm بإيدينا
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
command -v npm >/dev/null 2>&1 || { echo "❌ npm مش موجود"; exit 1; }

# MQTT broker
if command -v mosquitto >/dev/null 2>&1 && ! (ss -ltn 2>/dev/null | grep -q ':1883 '); then
  echo "تشغيل mosquitto..."
  mosquitto -d || echo "فشل تشغيل mosquitto"
fi

# Backend في الخلفية
cd "$SYSTEM_DIR/backend_filling_system" || { echo "❌ backend مش موجود"; exit 1; }
npm run dev &
BACK_PID=$!
trap 'kill $BACK_PID 2>/dev/null' EXIT

# Frontend
cd "$SYSTEM_DIR/frontend_filling_system" || { echo "❌ frontend مش موجود"; exit 1; }
npm run dev
