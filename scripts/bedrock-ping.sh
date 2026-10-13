#!/usr/bin/env bash
# Day 1 exit check: list the Anthropic models this account can call in Bedrock,
# then get one reply from a Haiku-class model through the Converse API.
#
# Usage: scripts/bedrock-ping.sh [model-or-inference-profile-id]
# Env:   AWS_PROFILE (default shadow-home), AWS_REGION (default us-east-1)
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-shadow-home}"
export AWS_REGION="${AWS_REGION:-us-east-1}"

echo "Profile $AWS_PROFILE, region $AWS_REGION"
aws sts get-caller-identity --query Arn --output text

echo
echo "Anthropic inference profiles:"
profiles="$(aws bedrock list-inference-profiles \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId, 'anthropic')].inferenceProfileId" \
  --output text | tr '\t' '\n' | sort)"
if [ -z "$profiles" ]; then
  echo "  none. Submit the Anthropic first-use form in the Bedrock console, then retry." >&2
  exit 1
fi
printf '  %s\n' $profiles

model="${1:-$(printf '%s\n' $profiles | grep -i haiku | tail -1)}"
if [ -z "$model" ]; then
  echo "No Haiku profile found; pass a model ID as the first argument." >&2
  exit 1
fi

echo
echo "Converse with $model:"
start=$(date +%s)
aws bedrock-runtime converse \
  --model-id "$model" \
  --messages '[{"role":"user","content":[{"text":"Reply with exactly: Shadow Home is listening."}]}]' \
  --inference-config '{"maxTokens":30,"temperature":0}' \
  --query 'output.message.content[0].text' \
  --output text
echo "($(( $(date +%s) - start ))s)"
