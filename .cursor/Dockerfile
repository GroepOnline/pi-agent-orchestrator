# Cursor Cloud base image for pi-agent-orchestrator.
#
# Debian bookworm + Node pinned to the repository's .nvmrc / package.json
# engines (22.22.3), so a compliant `node` is the default on PATH for every
# shell — including bare interactive shells, not just the cursor-cloud-* scripts.
# Debian-based per Cursor's computer-use requirement. Does not COPY the project;
# Cursor manages the workspace checkout.
#
# The base image is pinned by digest so rebuilds are reproducible: the digest
# fixes the exact Debian snapshot and the apt package set that goes with it.
# Apt packages are then installed from that frozen snapshot without further
# version pins (bookworm stable; pinning individual versions would be brittle
# across point releases and is unnecessary once the base digest is fixed).
FROM node:22.22.3-bookworm@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3

# Tools Cursor Cloud expects: git (repo clone), sudo, curl, CA certs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        sudo \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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
