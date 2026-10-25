#!/bin/sh
# Creates the Fly app and its data volume if they are missing. Safe to rerun.
# Needs FLY_API_TOKEN; FLY_APP and FLY_REGION default to the values in fly.toml.
set -eu
APP="${FLY_APP:-rsdp-poker-live}"
REGION="${FLY_REGION:-iad}"

flyctl auth whoami
if ! flyctl status --app "$APP" >/dev/null 2>&1; then
  flyctl apps create "$APP" --org personal
fi
if ! flyctl volumes list --app "$APP" --json | grep -q '"name": *"rsdp_data"'; then
  flyctl volumes create rsdp_data --app "$APP" --region "$REGION" --size 1 --yes
fi
flyctl volumes list --app "$APP"
