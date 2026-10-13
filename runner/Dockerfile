FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep coreutils && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace
CMD ["sleep", "infinity"]
