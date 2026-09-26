FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG CODEX_VERSION=0.156.1
ARG CLAUDE_CODE_VERSION=2.1.283
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
WORKDIR /app
COPY agent.mjs ./agent.mjs
RUN install -d -m 0700 -o node -g node /data /data/codex /data/claude /data/runs /workspace
USER node
# Docker provides isolation; no nested namespace privileges are required.
ENV CODEX_HOME=/data/codex CLAUDE_CONFIG_DIR=/data/claude DATA_DIR=/data WORKSPACE=/workspace SANDBOX=container
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/app/agent.mjs", "healthcheck"]
# tini forwards signals; flock execs Node without forking and prevents two owners of the same volume.
ENTRYPOINT ["tini", "--", "flock", "--no-fork", "-n", "/data/agent.lock", "node", "/app/agent.mjs"]
