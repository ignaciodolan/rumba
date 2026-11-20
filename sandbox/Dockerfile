# Rumba sandbox: the container where the agent CLI and URL checks run.
# Runs as any non-root uid (Rumba passes --user <uid>:<gid>), so HOME and the
# browser folder must be usable by every uid.
FROM node:22-bookworm

ARG CLAUDE_CODE_VERSION=2.1.329
ARG GEMINI_CLI_VERSION=0.70.0
ARG PLAYWRIGHT_VERSION=1.65.1

ENV HOME=/home/rumba \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules \
    DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
      "playwright@${PLAYWRIGHT_VERSION}" \
 && npm cache clean --force

RUN playwright install --with-deps chromium \
 && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "${HOME}" && chmod 1777 "${HOME}"

WORKDIR /work
