# Rumba sandbox: the container where the agent CLI and URL checks run.
# Runs as any non-root uid (Rumba passes --user <uid>:<gid>), so HOME and the
# browser folder must be usable by every uid.
#
# Rumba always builds this file from its own package, never from a repository it
# works on. A rumba chooses only the Node major version, through NODE_VERSION.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm

ARG CLAUDE_CODE_VERSION=2.1.329
ARG GEMINI_CLI_VERSION=0.70.0
ARG PLAYWRIGHT_VERSION=1.65.1
# Only installed when the Node image has no corepack of its own (Node 25 and later).
ARG COREPACK_VERSION=0.36.0

ENV HOME=/home/rumba \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules \
    DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_store_dir=/home/rumba/.local/share/pnpm/store

RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
      "playwright@${PLAYWRIGHT_VERSION}" \
 && npm cache clean --force

# pnpm and yarn through corepack: each project gets the version its package.json pins.
# pnpm keeps its store under HOME (npm_config_store_dir above), never in the working
# copy, where Rumba would commit it.
RUN (command -v corepack >/dev/null || npm install -g "corepack@${COREPACK_VERSION}") \
 && corepack enable \
 && npm cache clean --force

RUN playwright install --with-deps chromium \
 && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
 && rm -rf /var/lib/apt/lists/*

# Last: the installs above ran as root and left caches under HOME that another
# uid cannot write (npm's ~/.npm, corepack's ~/.cache). Start HOME empty and
# writable by every uid, so npm, npx and corepack work for the agent.
RUN rm -rf "${HOME}" && mkdir -p "${HOME}" && chmod 1777 "${HOME}"

WORKDIR /work
