# Wind-tunnel ad4m lane: a thin AD4M executor image around binaries built from
# an ad4m checkout (`build-exec-image.sh` stages them into .stage/).
#
# It reproduces the runtime half of ad4m's own Dockerfile (the entrypoint, the
# local bootstrap languages, multi-user + MCP through env) without its Rust,
# WE and Flux build stages, so a PR's executor can be tested in minutes once
# `cargo build --release` has run. The base must run the host-built binary:
# a binary built on Ubuntu 26.04 needs glibc 2.43, so the base is 26.04.
#
# Extra over ad4m's image: the server-link-language bundle at
# /opt/ad4m/server-link-language/bundle.js, which provision.mjs publishes and
# templates with the link-server's URL (Holochain stays off).

FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq gosu \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash ad4m && mkdir -p /data /opt/ad4m && chown ad4m:ad4m /data

COPY .stage/ad4m-executor /usr/local/bin/ad4m-executor
COPY .stage/ad4m /usr/local/bin/ad4m
COPY .stage/seed/docker_seed.json /opt/ad4m/docker_seed.json
COPY .stage/seed/languages/ /opt/ad4m/bootstrap-languages/
COPY .stage/seed/language-language-kv/ /opt/ad4m/language-language-kv/
COPY .stage/server-link-language/bundle.js /opt/ad4m/server-link-language/bundle.js
COPY --chmod=755 .stage/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY .stage/SOURCE /opt/ad4m/SOURCE

WORKDIR /data
EXPOSE 12000 3001
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=30 \
  CMD curl -sf http://localhost:12000/ || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
