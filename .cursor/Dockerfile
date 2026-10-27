# Cursor Cloud base image for pi-agent-orchestrator.
#
# Debian bookworm + Node pinned to the repository's .nvmrc / package.json
# engines (22.22.3), so a compliant `node` is the default on PATH for every
# shell — including bare interactive shells, not just the cursor-cloud-* scripts.
# Debian-based per Cursor's computer-use requirement. Does not COPY the project;
# Cursor manages the workspace checkout.
#
# The base image is pinned by digest so rebuilds are reproducible for the Node
# toolchain. At image-build time we still `apt-get update && apt-get upgrade`
# and install the current Google Chrome stable so system packages and the
# computer-use browser are fresh for each environment build.
FROM node:22.22.3-bookworm@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3

# Refresh Debian packages, then install Cloud + computer-use dependencies
# (git/sudo/curl/CA certs) and the newest Google Chrome stable.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        fonts-liberation \
        git \
        gnupg \
        sudo \
        wget \
        xdg-utils \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl --retry 3 --retry-delay 5 -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && chmod a+r /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Pi.dev host CLI on PATH for smoke tests and manual extension loading.
# --ignore-scripts matches the official pi.dev install guidance. The install
# script later re-aligns this to the repo's locked @earendil-works/pi-coding-agent.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
    && command -v pi \
    && pi --version

# Non-root user Cursor Cloud runs as, with passwordless sudo. The official node
# image already uses uid 1000 for its `node` user, so `ubuntu` takes the next id.
RUN id -u ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu \
    && groupadd -f docker && usermod -aG docker ubuntu \
    && usermod -aG sudo ubuntu \
    && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu \
    && chmod 0440 /etc/sudoers.d/ubuntu

# This is a Cursor Cloud dev-workspace base image, not a long-running service, so
# there is nothing to health-check; Cursor manages the container lifecycle.
# Declare HEALTHCHECK NONE explicitly (satisfies Trivy DS-0026) to document that
# the absence of a health check is intentional rather than an oversight.
HEALTHCHECK NONE

USER ubuntu
